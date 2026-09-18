# Deployment - AI Challenge Platform

Status: **pilot public trên GCE (Sprint 08)** — stack production chạy bằng `docker-compose.prod.yml`,
public tạm qua Cloudflare **Quick Tunnel**. Chưa phải production ổn định: xem §7.

## Kiến trúc đang chạy

- 01 GCE VM (Ubuntu LTS), Docker Engine + Compose plugin.
- Compose stack `mongo → api → web → cloudflared`; **không** service nào publish port ra host —
  host chỉ lắng nghe SSH. `cloudflared` vào `web:80` qua Docker network.
- Dữ liệu bind mount ngoài repo tại `/srv/vku-ai-challenge/data` (theo yêu cầu dùng boot disk;
  xem rủi ro ở §7).
- Public qua Cloudflare Quick Tunnel; Mongo không bao giờ ra public.

Layout trên VM:

```
/srv/vku-ai-challenge/
├── .env          # secret thật, mode 0600
├── repo/         # checkout detached tại release SHA
├── data/app/     # upload của app (mount vào /data của api)
├── data/mongo/   # dbpath (mount vào /data/db của mongo)
└── backups/      # backup hằng ngày, mode 0700
```

## 1. Provision VM (một lần)

```bash
# Trên VM, qua SSH key-only (tài khoản có NOPASSWD sudo, KHÔNG thêm vào group docker).
sudo apt-get update && sudo apt-get -y upgrade
sudo reboot   # bắt buộc nếu apt báo libc6/reboot-required

# Docker Engine + Compose plugin từ repo chính thức
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo mkdir -p /srv/vku-ai-challenge/{repo,data/app,data/mongo,backups}
sudo chown -R 999:999 /srv/vku-ai-challenge/data/mongo   # UID của user mongodb trong image
sudo chmod 700 /srv/vku-ai-challenge/backups
```

Không cần cài Python, pip, Node, Nginx hay cloudflared trên host — tất cả chạy trong container.

## 2. Cấu hình env

```bash
sudo install -m 600 -o root -g root \
  /srv/vku-ai-challenge/repo/deploy/production.env.example /srv/vku-ai-challenge/.env
sudo nano /srv/vku-ai-challenge/.env
```

Sinh secret (không dán vào chat/log/repo):

```bash
openssl rand -hex 24    # -> MONGO_PASSWORD
```

| Biến | Ý nghĩa |
|---|---|
| `PROD_DATA_ROOT` | Thư mục dữ liệu trên host (`/srv/vku-ai-challenge/data`) |
| `MONGO_USER` / `MONGO_PASSWORD` | Credential Mongo; compose fail-fast nếu thiếu |
| `MONGO_DATABASE` | Mặc định `ai_challenge` |
| `SESSION_LIFETIME_HOURS` / `SESSION_COOKIE_NAME` | Vòng đời và tên cookie phiên |
| `SESSION_COOKIE_SECURE` / `SESSION_COOKIE_SAMESITE` | `auto` + `lax`; `auto` bật `Secure` khi `APP_ENV=production` |
| `MAX_UPLOAD_MB` / `MAX_CONTENT_MB` / `MAX_ASSET_MB` | Giới hạn dung lượng |
| `APP_NAME` | Tên hiển thị |

`APP_ENV=production`, `DATA_DIR=/data` và `MONGO_HOST=mongo` do compose đặt cứng, không khai trong `.env`.
`SESSION_SECRET` trong `.env.example` là config chết (ADR-008) — không dùng, không cần sinh.

`.env` chỉ vào Compose qua `--env-file`, **không** mount vào container: Settings của backend đặt
`extra="forbid"` nên biến chỉ dành cho Compose sẽ làm API chết lúc khởi động.

## 3. Deploy một release

Nguyên tắc: chỉ deploy một commit đã qua release gate, không build từ working tree bẩn.

```bash
# Trên máy dev: tạo bundle từ commit release rồi chuyển sang VM
git bundle create /tmp/vku-release.bundle <release-sha>
scp /tmp/vku-release.bundle nkd@<vm>:/tmp/

# Trên VM
cd /srv/vku-ai-challenge/repo
sudo git fetch /tmp/vku-release.bundle <release-sha>
sudo git checkout --detach <release-sha>
sudo git status --short          # phải trống
sudo rm -f /tmp/vku-release.bundle

# Build (tuần tự để giảm peak RAM) rồi mới up
sudo COMPOSE_PARALLEL_LIMIT=1 docker compose --env-file /srv/vku-ai-challenge/.env \
     -f docker-compose.prod.yml build
sudo docker compose --env-file /srv/vku-ai-challenge/.env \
     -f docker-compose.prod.yml up -d
```

Đặt `COMPOSE=...` cho gọn tay:

```bash
alias dcp='sudo docker compose --env-file /srv/vku-ai-challenge/.env -f /srv/vku-ai-challenge/repo/docker-compose.prod.yml'
```

## 4. Smoke test sau deploy

```bash
dcp ps                              # cả 4 service phải running/healthy
dcp logs --tail=50 cloudflared      # đọc URL https://<random>.trycloudflare.com
curl -fsS https://<url>/api/health  # {"status":"ok","mongo":"reachable"}
curl -sI https://<url>/data/x       # 404
ss -lntp                            # chỉ thấy sshd, không có 8000/27017/80
```

Trong container `api` không có công cụ HTTP ngoài Python stdlib; kiểm tra nội bộ bằng:

```bash
dcp exec api python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8000/api/health').status)"
```

## 5. Admin và tài khoản

```bash
# Mật khẩu nhập ở prompt ẩn — KHÔNG truyền qua tham số dòng lệnh (lộ trong ps/history)
dcp exec api python scripts/create_admin.py admin@vku.udn.vn "ADMIN NKD"
```

Đăng nhập sai quá 10 lần cho cùng một email sẽ bị khoá 15 phút (`429 RATE_LIMITED`). Bộ đếm nằm
trong RAM của tiến trình API, không lưu vào Mongo, nên restart `api` sẽ xoá bộ đếm.

Script idempotent: email đã tồn tại thì thoát code 1 và không ghi đè. Import thí sinh hàng loạt bằng
`dcp exec api python scripts/import_accounts.py <file.csv>` (header `email,name,password`, policy ≥10 ký tự);
copy CSV vào container bằng `docker compose cp` rồi xoá file tạm sau khi import.

## 6. Backup và restore

Timer systemd chạy `scripts/backup_prod.sh` mỗi ngày (xem `deploy/vku-backup.timer`):

```bash
sudo install -m 644 /srv/vku-ai-challenge/repo/deploy/vku-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now vku-backup.timer
systemctl list-timers vku-backup.timer
sudo /srv/vku-ai-challenge/repo/scripts/backup_prod.sh   # chạy tay để kiểm tra
```

Mỗi lần chạy tạo `/srv/vku-ai-challenge/backups/<UTC-timestamp>/` gồm `mongo.archive.gz`,
`app-data.tar.gz`, `MANIFEST.txt` (kích thước + sha256). Script chỉ dọn backup cũ hơn
`RETENTION_DAYS` (mặc định 14) sau khi backup mới đã qua kiểm tra.

Diễn tập restore vào database tạm (làm trước khi cần thật, không chờ sự cố):

```bash
TS=20260918T031700Z   # thư mục backup muốn kiểm tra
dcp cp /srv/vku-ai-challenge/backups/$TS/mongo.archive.gz mongo:/tmp/restore-check.gz

# Biến này được container mở rộng, nên mật khẩu không đi qua argv của tiến trình trên host
MONGO_AUTH='--username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'

dcp exec mongo sh -c "mongorestore --host 127.0.0.1 $MONGO_AUTH \
  --archive=/tmp/restore-check.gz --gzip --nsFrom 'ai_challenge.*' --nsTo 'restore_check.*'"
dcp exec mongo sh -c "mongosh --quiet $MONGO_AUTH --eval 'db.getSiblingDB(\"restore_check\").submissions.countDocuments()'"
dcp exec mongo sh -c "mongosh --quiet $MONGO_AUTH --eval 'db.getSiblingDB(\"ai_challenge\").submissions.countDocuments()'"

# Đối chiếu hai số trên khớp nhau, rồi dọn database tạm và file tạm trong container
dcp exec mongo sh -c "mongosh --quiet $MONGO_AUTH --eval 'db.getSiblingDB(\"restore_check\").dropDatabase()'"
dcp exec mongo rm -f /tmp/restore-check.gz
```

Không bao giờ restore đè lên database đang chạy. Lưu ý đã kiểm chứng: `mongorestore --nsFrom/--nsTo`
**treo khi đọc archive từ stdin**, nên phải copy file vào container rồi dùng `--archive=/path`.

Khi chạy các lệnh trên trong script/CI (không phải gõ tay), thêm `-T` và `</dev/null` cho mỗi
`docker compose exec`: thiếu `-T`, Docker mở TTY và `exec` sẽ đọc hết stdin còn lại — nếu script được
pipe qua `ssh 'bash -s'`, mọi lệnh phía sau bị nuốt mất và script dừng giữa chừng mà không báo lỗi.

## 7. Cảnh báo và giới hạn

- **Quick Tunnel chỉ để pilot.** URL `*.trycloudflare.com` đổi mỗi lần `cloudflared` restart, giới hạn
  200 kết nối đồng thời, không SLA, Cloudflare xếp là công cụ test. Muốn production thật phải có domain
  trong Cloudflare → chuyển sang named tunnel (thêm `CLOUDFLARE_TUNNEL_TOKEN`, đổi command thành
  `tunnel --no-autoupdate run`) rồi chạy lại toàn bộ smoke gate HTTPS/auth.
- **Dữ liệu và backup cùng một boot disk** (`/srv/vku-ai-challenge`). Backup chỉ cứu được lỗi thao tác
  (xoá nhầm, migrate hỏng), **không** cứu được khi mất disk/VM. Cần một trong: snapshot schedule của GCE,
  copy sang object storage, hoặc persistent disk riêng.
- Không chạy `docker compose down -v`; không xoá `/srv/vku-ai-challenge/data`.
- Cookie `Secure` bật khi `APP_ENV=production`, nên **không thể** kiểm thử đăng nhập qua HTTP thuần —
  mọi smoke test auth phải đi qua URL HTTPS của tunnel.

## 8. Rollback

```bash
cd /srv/vku-ai-challenge/repo
sudo git checkout --detach <sha-truoc>
sudo COMPOSE_PARALLEL_LIMIT=1 docker compose ... build && sudo docker compose ... up -d
```

Dữ liệu nằm ở bind mount ngoài repo nên rollback code không đụng tới dữ liệu. Nếu release mới không
healthy: giữ nguyên stack cũ (compose chỉ thay container khi image mới build xong), không sửa trực tiếp
dữ liệu để "ép chạy". Chạy backup thành công **trước** mỗi lần đổi code.

## Vận hành thường ngày

```bash
dcp ps                     # trạng thái + health
dcp logs -f api            # log API (đã bật json-file rotation 10m x 3)
dcp restart web            # restart một service
df -h /                    # backup cùng disk nên phải theo dõi dung lượng
```
