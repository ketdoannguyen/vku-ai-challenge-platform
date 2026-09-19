# Deployment - AI Challenge Platform

Status: **Sprint 08** - backend/MongoDB/Nginx chạy trên GCE bằng `docker-compose.prod.yml`, public
tạm qua Cloudflare **Quick Tunnel**; frontend đã có thêm public entry trên **Cloudflare Workers
Static Assets** (ADR-025). Đường deploy tự động (`release` → Actions deploy Worker + timer kéo về VM,
ADR-026) đã có code và test nhưng **chưa bật trên production** - xem §5-§7.

## 1. Kiến trúc và nguyên tắc same-origin

### Đang chạy (fallback, luôn giữ được)

```
USER → https://<random>.trycloudflare.com   (Quick Tunnel, URL đổi mỗi lần restart)
       └→ cloudflared → web:80 (Nginx) ─┬→ /            → React SPA (static + SPA fallback)
                                        └→ /api/*       → api:8000 (FastAPI) → mongo:27017
```

### Sau khi rollout Workers (ADR-025)

```
USER → Cloudflare Worker `vku-ai-challenge-platform`   (workers.dev hoặc custom domain)
       ├→ /api/*  → Worker proxy → API_ORIGIN
       │            = https://origin-api.<DOMAIN>  (Named Tunnel)
       │            → cloudflared → web:80 (Nginx) → api:8000 → mongo:27017
       └→ còn lại → Static Assets trên Cloudflare CDN (+ SPA fallback cho route con)
```

Nguyên tắc bắt buộc - đổi kiến trúc nào cũng phải giữ:

- Browser chỉ thấy **một** origin. Frontend luôn gọi `` fetch(`/api${path}`, { credentials: "same-origin" }) ``;
  không có URL tuyệt đối, không `credentials: "include"`, không CORS, không JWT, không token trong
  `localStorage`.
- Cookie phiên `aic_session` là **host-only** (`HttpOnly`, `Secure` ở production, `SameSite=Lax`,
  không có thuộc tính `Domain`). Hệ quả: session gắn với đúng hostname đã đăng nhập - đổi public
  origin là phải đăng nhập lại, và chỉ nên có một public origin cho người dùng thật tại một thời điểm.
- `API_ORIGIN` là **runtime variable của Worker**, không phải biến `VITE_*`: nó chỉ tồn tại ở phía
  server Worker. Tuyệt đối không đặt `API_ORIGIN` bằng public hostname của chính app (proxy loop).
- `origin-api.<DOMAIN>` trỏ vào `web:80` (Nginx) chứ không vào `api:8000`: giữ nguyên giới hạn body
  12m, header bảo mật và hành vi cookie hiện có của Nginx.

## 2. Provision VM (một lần)

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

Không cần cài Python, pip, Node, Nginx hay cloudflared trên host - tất cả chạy trong container.

Layout trên VM:

```
/srv/vku-ai-challenge/
├── .env          # secret thật, mode 0600
├── repo/         # checkout detached tại release SHA
├── data/app/     # upload của app (mount vào /data của api)
├── data/mongo/   # dbpath (mount vào /data/db của mongo)
└── backups/      # backup hằng ngày, mode 0700
```

## 3. Cấu hình env

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
| `CLOUDFLARE_TUNNEL_TOKEN` | Chỉ dùng khi chạy kèm `deploy/docker-compose.tunnel.named.yml` (§6). Để trống với Quick Tunnel |

`APP_ENV=production`, `DATA_DIR=/data` và `MONGO_HOST=mongo` do compose đặt cứng, không khai trong `.env`.
`SESSION_SECRET` trong `.env.example` là config chết (ADR-008) - không dùng, không cần sinh.

`.env` chỉ vào Compose qua `--env-file`, **không** mount vào container. Settings của backend bỏ qua
khoá lạ, nên `env_file:` sẽ không làm API chết; lý do không dùng là quyền tối thiểu - `.env` chứa
credential của thành phần khác (`MONGO_*`, `CLOUDFLARE_TUNNEL_TOKEN`) và biến chỉ dành cho Compose,
không nên có mặt trong tiến trình API. Vì vậy `TUNNEL_TOKEN` chỉ được truyền cho service `cloudflared`
trong file override, không truyền cho `api`.

Kiểm tra cú pháp compose mà không in secret:

```bash
cd /srv/vku-ai-challenge/repo
sudo docker compose --env-file /srv/vku-ai-challenge/.env \
  -f docker-compose.prod.yml config --quiet && echo OK
```

Không chạy `docker compose config` rồi lưu/chia sẻ output đầy đủ - kết quả nội suy có chứa secret.

## 4. Phát triển và kiểm thử ở local

### Frontend

```bash
cd frontend
npm ci
npm run lint          # oxlint
npm test              # vitest (jsdom)
npm run build         # tsc -b && vite build -> dist/
npm run cf:dry-run    # wrangler deploy --dry-run, phải chạy SAU npm run build
```

`npm run cf:dry-run` cần `dist/` tồn tại vì `wrangler.jsonc` đặt `assets.directory: ./dist`; chạy
trước `npm run build` sẽ báo không tìm thấy thư mục assets.

`npm test` chạy song song nhiều worker; nếu thấy test flake ở `CompetitionDetailPage.test.tsx`,
chạy lại tuần tự để có kết quả xác định:

```bash
npx vitest run --maxWorkers 1
```

Dev server (giữ nguyên như trước, không liên quan Workers):

```bash
npm run dev           # Vite :5173, proxy /api -> http://localhost:8080 (Nginx của compose dev)
```

Muốn chạy thử chính Worker ở local: build `dist/` trước, tạo `frontend/.dev.vars` (đã ignore, không
commit) với `API_ORIGIN=http://localhost:8080`, rồi:

```bash
npx wrangler dev
```

### Backend

```bash
cd backend
uv run pytest
```

### Bất biến phải giữ khi sửa frontend

- `src/api/client.ts` không đổi: URL tương đối `/api...`, `credentials: "same-origin"`.
- Không thêm biến `VITE_*` nào chứa địa chỉ backend.
- `src/markdown/resolveMarkdownAssetUrl.ts` trả path tương đối `/api/competitions/...` - giữ nguyên.

## 5. Deploy frontend lên Cloudflare Workers

### 5.1 Deploy tự động bằng GitHub Actions

`.github/workflows/deploy-worker.yml` là **cơ chế deploy Worker duy nhất** (ADR-026). **Không** bật
thêm Workers Builds trong Dashboard: hai đường deploy cùng ghi vào một Worker sẽ tranh nhau version và
làm mất provenance của Git SHA.

| Trigger | Điều kiện | Kết quả |
|---|---|---|
| `push` vào `release` | có file đổi trong `frontend/**` hoặc chính file workflow | chạy gate frontend rồi deploy |
| `workflow_dispatch` | bấm tay trên nhánh bất kỳ | deploy lại đúng commit đang có (break-glass) |
| PR vào `release` | mọi PR | **chỉ** chạy `release-gate`; không deploy |

Trình tự trong job deploy: kiểm tra cấu hình (thiếu secret thì fail **trước** khi đụng production) →
`npm ci` → `lint` → `vitest` → `build` → đọc version đang nhận traffic → `wrangler deploy --keep-vars
--tag release-<sha12> --message "release <sha>"` → smoke tĩnh → rollback nếu smoke tĩnh fail. Gate được
lặp lại ngay trước deploy vì push thẳng vào `release` không đi qua PR.

Cấu hình một lần trên GitHub (Settings → Environments → `production`):

| Loại | Tên | Giá trị |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Token tối thiểu quyền **Workers Scripts: Edit** (My Profile → API Tokens) |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | `793cbf09a7355d16f35bac9abccd5fc4` |
| Variable | `WORKER_URL` | `https://vku-ai-challenge-platform.ketdoannguyen.workers.dev` |

- Giới hạn deployment branch của environment `production` là `release` để secret không dùng được từ
  nhánh khác.
- Branch protection của `release` đặt required check `release-gate / frontend`, `release-gate / backend`
  và `release-gate / deploy-script`. Đổi `name:` của workflow hoặc của job sẽ làm check cũ không bao giờ
  xanh lại và **chặn mọi PR vào `release`** - đổi tên thì phải cập nhật branch protection cùng lúc.
- Access policy của Worker phải **OFF**: bật Cloudflare Access sẽ chặn cả người dùng cuối.
- Token **không** bao giờ dán vào chat/log/issue. Nghi ngờ lộ thì thu hồi ngay (My Profile → API
  Tokens → Revoke) rồi tạo token mới - token cũ đã lộ thì mọi thứ khác đều vô nghĩa.

Smoke tĩnh của workflow chỉ kiểm `/` và một deep link SPA phải trả `200` + `text/html`. `/api/health`
trong workflow chỉ là **diagnostic**: `API_ORIGIN` đi qua tunnel nên tunnel chết làm API lỗi trong khi
static vẫn khoẻ, và rollback Worker không sửa được tunnel - vì vậy nó không bao giờ được dùng để quyết
định rollback.

### 5.2 Runtime variable `API_ORIGIN`

Dashboard → Worker → Settings → Variables and Secrets → **Plaintext**:

| Tên | Giá trị |
|---|---|
| `API_ORIGIN` | `https://origin-api.<DOMAIN>` - hostname Named Tunnel ở §6, KHÔNG có `/api`, KHÔNG có dấu `/` cuối |

Quy tắc:

- Đây là **runtime variable**, không phải build variable và không phải `VITE_*`. Giá trị chỉ được
  Worker đọc ở phía server nên browser không bao giờ thấy địa chỉ backend.
- Không khai `API_ORIGIN` trong `wrangler.jsonc`: biến trong file sẽ ghi đè giá trị đặt ngoài file ở
  mỗi lần deploy. `keep_vars: true` trong file giữ nguyên runtime variable qua các lần deploy - **đã
  kiểm chứng thật**: deploy lại bằng `npx wrangler deploy` không kèm `--var`, `/api/health` vẫn `200`
  (nếu binding mất, Worker sẽ fail closed và trả `500`). Lưu ý `keep_vars` **không** làm điều đó thành
  vĩnh viễn: nó chỉ giữ biến không bị xoá khi deploy; vẫn nên đặt qua Dashboard để có chỗ xem lại.
- Cách đặt nhanh không cần Dashboard (dùng khi CI/CLI):
  `npx wrangler deploy --var API_ORIGIN:https://origin-api.<DOMAIN>`; các lần deploy sau không cần lặp
  lại `--var` nhờ `keep_vars`.
- **Không** đặt bằng public hostname của chính app (ví dụ `https://app.example.com`) - Worker sẽ gọi
  lại chính nó và tạo vòng lặp proxy. Worker chủ động từ chối cấu hình này (trả `500`).
- Trong lúc chưa có domain, có thể dùng tạm hostname Quick Tunnel (`https://<random>.trycloudflare.com`)
  làm `API_ORIGIN`. Nhược điểm: URL này **đổi mỗi lần `cloudflared` restart**, khi đó phải sửa lại
  runtime variable và chờ deploy mới nhất áp dụng (không cần build lại).
- Thiếu hoặc sai `API_ORIGIN` thì Worker trả `500` với body `{"error":{"code":"INTERNAL_ERROR",...}}`
  và **không** gọi upstream - fail closed, không lộ giá trị cấu hình.

### 5.3 Deploy thủ công (break-glass)

```bash
cd frontend
npm ci
npm run build
npm run cf:dry-run        # bắt buộc: kiểm tra config + assets trước khi đẩy thật
npx wrangler login        # hoặc export CLOUDFLARE_API_TOKEN (token KHÔNG commit, KHÔNG dán vào chat)
npx wrangler deploy
```

Lần deploy **đầu tiên** sẽ tạo Worker nếu tài khoản chưa có Worker tên đó (`wrangler deploy` không
hỏi lại); các lần sau cập nhật đúng Worker đang có. Nhờ `keep_vars: true` và việc `API_ORIGIN` chỉ
nằm ngoài `wrangler.jsonc`, deploy không ghi đè origin.

### 5.4 Kiểm tra sau deploy

```bash
curl -sI https://<public-host>/            # 200 + 5 header bảo mật ở §8.5
curl -fsS https://<public-host>/api/health # {"status":"ok","mongo":"reachable"}
curl -sI https://<public-host>/assets/<tên-file-có-hash>.js  # Cache-Control: immutable
```

Kết quả của bản deploy đã chạy (để đối chiếu khi lần sau lệch):

| Kiểm tra | Kết quả đúng |
|---|---|
| `/` | `200`, đủ 5 header bảo mật |
| `/competitions/<slug>` (deep link SPA) | `200` + `index.html`, không phải `404` |
| `/api/health` | `200` `{"status":"ok","mongo":"reachable"}` |
| `/api/auth/me` khi chưa đăng nhập | `401` `{"error":{"code":"UNAUTHORIZED",...}}` |
| `/api/khong-ton-tai` | `404` JSON của FastAPI, **không** phải HTML của SPA |
| `/assets/<hash>.js` | `Cache-Control: public, max-age=31536000, immutable` |
| `/data/bat-ky` | `200` + HTML của SPA - đúng như ADR-025 mô tả, không phải rò rỉ dữ liệu |

`_headers` được Wrangler **đọc làm cấu hình**, không được upload như một asset: `--dry-run` liệt kê
`dist/_headers` trong input nhưng danh sách asset đẩy lên không có nó, còn response thật thì có đủ 5
header. Đừng đi tìm `_headers` trong danh sách file đã upload - không thấy là đúng.

## 6. Cloudflare Tunnel: Quick → Named

Chỉ đổi tầng tunnel trên VM, không đụng tới Worker, backend hay dữ liệu. Base stack Quick Tunnel
không bị sửa nên luôn quay lại được.

**Điều kiện:** đã có domain trong Cloudflare (nameserver do Cloudflare quản lý).

1. Zero Trust Dashboard → Networks → Tunnels → **Create a tunnel** → chọn `Cloudflared` → đặt tên
   (ví dụ `vku-challenge-prod`) → copy **token** ở bước Install connector.
2. Trong tunnel vừa tạo, thêm **Public Hostname**: subdomain `origin-api`, domain `<DOMAIN>`, service
   `http://web:80`. Không bật Access cho hostname này (Worker gọi vào bằng HTTP, không qua browser).
3. Trên VM, thêm token vào `.env` (file đã `chmod 600`, không commit):

```bash
sudo nano /srv/vku-ai-challenge/.env      # CLOUDFLARE_TUNNEL_TOKEN=<token>
```

4. Chạy lại **chỉ** service `cloudflared` với override additive:

```bash
cd /srv/vku-ai-challenge/repo
sudo docker compose --env-file /srv/vku-ai-challenge/.env \
  -f docker-compose.prod.yml -f deploy/docker-compose.tunnel.named.yml \
  up -d cloudflared
```

Override thay **toàn bộ** `command` (bỏ `--url http://web:80` vì ingress giờ do Dashboard quản lý),
giữ `--metrics 127.0.0.1:20241` nên healthcheck kế thừa từ base vẫn dùng được. Token chỉ được truyền
cho `cloudflared`, không truyền cho `api`.

5. Kiểm tra:

```bash
sudo docker compose --env-file /srv/vku-ai-challenge/.env \
  -f docker-compose.prod.yml -f deploy/docker-compose.tunnel.named.yml ps   # cloudflared healthy
curl -fsS https://origin-api.<DOMAIN>/api/health             # {"status":"ok",...}
curl -sI  https://origin-api.<DOMAIN>/ | head -n 8           # 5 header bảo mật
```

6. Cập nhật `API_ORIGIN` của Worker thành `https://origin-api.<DOMAIN>` (§5.2) rồi chạy lại §8.
7. Quay về Quick Tunnel: chạy `up -d cloudflared` chỉ với `docker-compose.prod.yml`, rồi trỏ
   `API_ORIGIN` về hostname trycloudflare mới.

Đổi public origin làm cookie phiên cũ vô hiệu (cookie host-only): mọi người dùng phải đăng nhập lại,
đó là hành vi mong đợi chứ không phải lỗi.

## 7. Deploy một release (backend + Nginx)

### 7.1 Đường tự động: push vào `release`

`release` là cổng duy nhất: push vào `release` nghĩa là "đưa commit này lên production". Một lần push
cập nhật **cả hai phía**, và hai phía deploy độc lập chứ không phải một giao dịch nguyên tử - Worker
thường lên trước vì build image chậm hơn. Hợp đồng same-origin `/api` là thứ giữ cho khoảng lệch đó vô
hại; thay đổi API phá vỡ tương thích ngược phải tách thành hai lần release.

Luồng thường ngày: PR `main` → `release` (chờ `release-gate` xanh) → merge → Actions deploy Worker,
timer trên VM kéo commit về trong khoảng 1 phút.

**VM: cài đặt một lần**

```bash
# Trên VM, từ commit đã duyệt trên nhánh release
cd /srv/vku-ai-challenge/repo
sudo git fetch origin release && sudo git checkout --detach origin/release
sudo git status --short                       # phải trống
sudo deploy/vps/install-auto-deploy.sh        # copy deployer + unit, KHÔNG bật timer
sudo /usr/local/sbin/vku-auto-deploy --bootstrap-current   # ghi mốc SHA đang chạy
sudo /usr/local/sbin/vku-auto-deploy --dry-run             # xem sẽ deploy gì, không đổi gì
sudo systemctl enable --now vku-deploy.timer               # bật
```

`--bootstrap-current` bắt buộc chạy trước: chưa có mốc thì deployer từ chối deploy để không build lại
toàn bộ stack ngoài kế hoạch.

**VM: vận hành**

```bash
systemctl list-timers vku-deploy.timer     # lần chạy kế tiếp
systemctl status vku-deploy.service        # lượt gần nhất
journalctl -u vku-deploy.service -n 100 --no-pager
sudo systemctl stop vku-deploy.timer       # tạm dừng auto-deploy
sudo systemctl start vku-deploy.service    # chạy một lượt ngay
cat /var/lib/vku-deploy/history.log        # lịch sử mọi lượt (SHA, kết quả, service)
```

Deployer giữ state ở `/var/lib/vku-deploy` (quyền `0700`): `last-success-sha`, `last-failed-sha`,
`history.log`, `last-failure.txt`, `quick-tunnel-url` và hai file override sinh tự động. **Không sửa state bằng tay** -
muốn thử lại một SHA đã lỗi thì push commit mới (mỗi SHA lỗi chỉ thử một lần để timer không quay lại
build cùng một commit hỏng mỗi phút).

Một điểm cần biết trước: `last-success-sha` là mốc **state**, không phải bằng chứng có image trên máy.
Commit chỉ đổi `docs/` tiến mốc mà không build image nào, nên ngay sau đó có thể **không có image để
rollback**. Gặp trường hợp đó deployer **từ chối rollback** và báo `không có image của <sha>` - cố ý,
vì `docker compose up` tự build khi image vắng mặt, và build lúc này là build **source mới** dưới tag
của SHA cũ, tạo ra một container mang nhãn bản cũ nhưng chạy code mới. Khi thấy thông báo đó: dừng
timer, deploy lại commit trước bằng đường thủ công (§7.2).

Commit chỉ đổi `docs/`, `.github/`, `plans/`, `scripts/` không chạm container: deployer chỉ tiến mốc
state rồi thoát, không build. Đường dẫn chưa được phân loại thì deployer **dừng và báo tên file** -
đó là chủ ý, để thêm một thư mục mới là quyết định có ý thức chứ không phải mặc định.

Vì production đang chạy **Quick Tunnel** (§6 mục điều kiện), mỗi lượt deployer còn đọc log container
`cloudflared` để phát hiện hostname `*.trycloudflare.com` thay đổi. Hostname đó đổi mỗi khi container
`cloudflared` khởi động lại (VPS reboot, Docker daemon restart), và lúc đó `API_ORIGIN` của Worker trỏ
vào URL đã chết ⇒ mọi `/api/*` trả `502`. Deployer **chỉ báo, không tự sửa**: nó ghi ra
`CẢNH BÁO: Quick Tunnel URL đã đổi` kèm URL cũ, URL mới và đường dẫn Dashboard cần sửa, đồng thời ghi
một dòng `result=tunnel-url-changed` vào `history.log`. Tự sửa đòi hỏi một token quản trị Worker
thường trú trên VPS - nhân bản quyền Cloudflare sang máy thứ hai chỉ để phục vụ một sự kiện hiếm, nên
đây là chủ ý. Đọc log là thao tác chỉ đọc: watchdog không bao giờ đổi trạng thái `cloudflared`.

Sửa deployer trong repo **không** tự áp dụng lên VM: phải chạy lại `install-auto-deploy.sh` từ commit
đã duyệt. Bản chạy thật là copy root-owned ở `/usr/local/sbin/vku-auto-deploy`, không phải file trong
repo - một commit xấu không được phép tự thay cơ chế recovery của chính nó.

### 7.2 Đường thủ công (break-glass)

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

Đặt `COMPOSE=...` cho gọn tay (thêm `-f deploy/docker-compose.tunnel.named.yml` khi đã bật named tunnel):

```bash
alias dcp='sudo docker compose --env-file /srv/vku-ai-challenge/.env -f /srv/vku-ai-challenge/repo/docker-compose.prod.yml'
```

## 8. Smoke test sau deploy

### 8.1 SPA và deep link (trên public hostname của Worker)

```bash
HOST=https://<public-host>

curl -sI $HOST/ | head -n 1                    # 200
curl -s  $HOST/competitions/ai-challenge-2026 | grep -c '<div id="root"'   # 1 -> SPA fallback OK
curl -s  $HOST/ho-tro                          | grep -c '<div id="root"'   # 1
```

### 8.2 API qua Worker

```bash
curl -fsS $HOST/api/health                                  # {"status":"ok","mongo":"reachable"}
curl -sI  $HOST/api/auth/me | head -n 1                     # 401 (chưa đăng nhập)
curl -s   $HOST/api/khong-ton-tai | head -c 120             # JSON 404 của FastAPI, KHÔNG phải HTML của SPA
```

### 8.3 Phiên đăng nhập: cookie, giữ phiên, logout

Không dán mật khẩu hay token vào dòng lệnh (lộ trong `ps`/history) - dùng file tạm quyền 600 và
cookie jar:

```bash
umask 077
# Trường định danh của `/api/auth/login` tên là `identifier` (KHÔNG phải `email`); gửi sai tên
# trường sẽ bị FastAPI trả 422 VALIDATION_ERROR trước khi tới bước kiểm tra mật khẩu.
printf '{"identifier":"%s","password":"%s"}' '<email>' '<password>' > /tmp/aic-login.json

curl -si -c /tmp/aic.jar -o /dev/null $HOST/api/auth/login \
  -H 'Content-Type: application/json' -d @/tmp/aic-login.json | grep -i '^HTTP/'

grep aic_session /tmp/aic.jar            # cookie được lưu, KHÔNG có cột domain
curl -s -b /tmp/aic.jar $HOST/api/auth/me | head -c 200          # 200, đúng tài khoản

curl -si -X POST -b /tmp/aic.jar $HOST/api/auth/logout | grep -i '^HTTP/\|^set-cookie'
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/aic.jar $HOST/api/auth/me   # 401 sau logout

rm -f /tmp/aic.jar /tmp/aic-login.json
```

Kiểm tra thêm bằng mắt trên DevTools → Application → Cookies: `aic_session` phải có `HttpOnly`,
`Secure`, `SameSite=Lax` và **không** có `Domain`.

### 8.4 Upload, asset Markdown, download

```bash
# multipart CSV -> body phải đi nguyên trạng qua Worker
curl -s -b /tmp/aic.jar -F 'file=@/tmp/accounts.csv' \
  $HOST/api/admin/competitions/<id>/accounts/import | head -c 200

# asset Markdown: path tương đối /api/competitions/<slug>/assets/<file>
curl -sI $HOST/api/competitions/<slug>/assets/<file>.png | head -n 1

# download: Content-Disposition và Content-Type phải giữ nguyên qua proxy
curl -sI -b /tmp/aic.jar $HOST/api/admin/competitions/<id>/export.xlsx \
  | grep -i 'content-disposition\|content-type'
```

### 8.5 Header bảo mật

```bash
for u in $HOST/ $HOST/api/health; do
  echo "== $u"
  curl -sI "$u" | grep -iE 'x-content-type-options|x-frame-options|referrer-policy|permissions-policy|content-security-policy-report-only'
done
```

Static lấy header từ `_headers`; `/api/*` lấy từ Nginx - cả hai đều phải đủ 5 header.

### 8.6 Những thứ chỉ đúng trên origin (Nginx), không có trên Workers

```bash
ORIGIN=https://origin-api.<DOMAIN>

curl -sI $ORIGIN/data/bat-ky | head -n 1        # 404 - Nginx chặn /data/
curl -s  $ORIGIN/healthz                        # ok
curl -sI $ORIGIN/api/health | head -n 1         # 200
```

Trên hostname Workers, `/data/x` trả `index.html` (SPA fallback) - đúng thiết kế và không lộ file,
nên đừng dùng hostname Workers để kiểm tra `/data/`.

### 8.7 Không lộ port trên VM

```bash
ss -lntp     # chỉ thấy sshd; không có 80, 8000 hay 27017
```

## 9. Admin và tài khoản

```bash
# Mật khẩu nhập ở prompt ẩn - KHÔNG truyền qua tham số dòng lệnh (lộ trong ps/history)
dcp exec api python scripts/create_admin.py admin@vku.udn.vn "ADMIN NKD"
```

Đăng nhập sai quá 10 lần cho cùng một email sẽ bị khoá 15 phút (`429 RATE_LIMITED`). Bộ đếm nằm
trong RAM của tiến trình API, không lưu vào Mongo, nên restart `api` sẽ xoá bộ đếm.

Script idempotent: email đã tồn tại thì thoát code 1 và không ghi đè. Import thí sinh hàng loạt bằng
`dcp exec api python scripts/import_accounts.py <file.csv>` (header `email,name,password`, policy ≥10 ký tự);
copy CSV vào container bằng `docker compose cp` rồi xoá file tạm sau khi import.

## 10. Backup và restore

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
`docker compose exec`: thiếu `-T`, Docker mở TTY và `exec` sẽ đọc hết stdin còn lại - nếu script được
pipe qua `ssh 'bash -s'`, mọi lệnh phía sau bị nuốt mất và script dừng giữa chừng mà không báo lỗi.

## 11. Cảnh báo và giới hạn

- **Quick Tunnel chỉ để pilot.** URL `*.trycloudflare.com` đổi mỗi lần `cloudflared` restart, giới hạn
  200 kết nối đồng thời, không SLA, Cloudflare xếp là công cụ test. Muốn production thật phải có domain
  trong Cloudflare → chuyển sang named tunnel (§6).
- **Dữ liệu và backup cùng một boot disk** (`/srv/vku-ai-challenge`). Backup chỉ cứu được lỗi thao tác
  (xoá nhầm, migrate hỏng), **không** cứu được khi mất disk/VM. Cần một trong: snapshot schedule của GCE,
  copy sang object storage, hoặc persistent disk riêng.
- Không chạy `docker compose down -v`; không xoá `/srv/vku-ai-challenge/data`.
- Cookie `Secure` bật khi `APP_ENV=production`, nên **không thể** kiểm thử đăng nhập qua HTTP thuần -
  mọi smoke test auth phải đi qua URL HTTPS.
- **Header bảo mật nằm ở hai nơi**: `frontend/nginx.conf` (cho `/api/*`) và `frontend/public/_headers`
  (cho static). Đổi một nơi phải đổi nơi còn lại; `_headers` **không** áp dụng cho response do Worker sinh.
- **`/data/` chỉ bị chặn ở Nginx.** Trên hostname Workers, `/data/<x>` rơi vào SPA fallback và trả
  `index.html` - không lộ dữ liệu nhưng đừng nhầm là đã chặn.
- **Một public origin tại một thời điểm.** Cookie phiên là host-only nên session của hostname Workers và
  của hostname tunnel là hai cookie jar độc lập; đổi origin là toàn bộ người dùng phải đăng nhập lại.
- **`client_max_body_size 12m` của Nginx vẫn là giới hạn body hiệu lực.** Workers không cấu hình body
  limit trong `wrangler.jsonc`; vượt ngưỡng thì lỗi là `413` từ Nginx.
- **`npm ci` của frontend kéo thêm `wrangler` + `workerd`** (~100 MB) vào stage build của image `web`,
  nên build trên VM lâu hơn một chút. Runtime không đổi: chỉ `dist/` được copy sang stage Nginx.
- Ngoài scope, không thêm: Redis, queue, Kubernetes, Terraform, R2, D1, Durable Objects.

## 12. Rollback

Từng tầng rollback độc lập:

**Worker (frontend):** Dashboard → Workers & Pages → `vku-ai-challenge-platform` → Deployments → chọn
bản deploy trước → **Rollback**. Không cần đụng tới VPS và không ảnh hưởng API. Workflow deploy cũng
tự rollback khi smoke tĩnh fail; rollback bằng tay cần thiết khi lỗi chỉ lộ ra sau khi smoke đã qua.

Revert frontend bằng Git cũng là một đường rollback hợp lệ và để lại dấu vết: `git revert <sha>` rồi
merge vào `release`; Actions deploy lại bản đã revert.

**`API_ORIGIN`:** nếu origin mới lỗi, sửa runtime variable về giá trị cũ (ví dụ hostname Quick Tunnel)
trong Settings → Variables and Secrets. Đổi biến không cần build lại.

**Tunnel:** bỏ file override để quay về Quick Tunnel:

```bash
sudo docker compose --env-file /srv/vku-ai-challenge/.env \
  -f docker-compose.prod.yml up -d cloudflared
```

**Backend/Nginx (đường tự động):** deployer tự rollback trong lượt deploy hỏng - nó đưa container về
**image cũ đã build** của SHA trước, không build lại source cũ (build lại là phép toán không xác định
đúng lúc production đang lỗi). Mọi lệnh `up` đều có `--no-build` và rollback kiểm tra image cũ tồn tại
trước khi đụng vào container, nên không có đường nào dựng lại source mới dưới nhãn SHA cũ. Rollback chỉ
được coi là xong sau khi deployer đã xác minh label revision của container khớp SHA cũ, nên "rollback
thành công" là trạng thái đã kiểm chứng, không phải suy đoán.

Khi deployer báo **rollback cũng thất bại**, phải can thiệp tay: xem `last-failure.txt` và
`history.log` trong `/var/lib/vku-deploy`, rồi deploy lại commit trước bằng đường thủ công ở §7.2.
Dừng timer (`systemctl stop vku-deploy.timer`) trước khi sửa tay để timer không giành quyền chạy.

**Backend/Nginx (thủ công):**

```bash
cd /srv/vku-ai-challenge/repo
sudo git checkout --detach <sha-truoc>
sudo COMPOSE_PARALLEL_LIMIT=1 docker compose ... build && sudo docker compose ... up -d
```

Dữ liệu nằm ở bind mount ngoài repo nên rollback code không đụng tới dữ liệu; **không** rollback
database và không sửa trực tiếp dữ liệu để "ép chạy". Chạy backup thành công **trước** mỗi lần đổi code.

## 13. Troubleshooting

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `/api/*` trả `500` `INTERNAL_ERROR` | Thiếu/sai `API_ORIGIN`, hoặc giá trị trùng host của request public | Kiểm runtime variable ở §5.2; giá trị phải là origin thuần, không `/api`, không dấu `/` cuối |
| `/api/*` trả `502` | Worker không gọi được origin: cloudflared chết, ingress sai, service `web` down | `dcp ps`, `dcp logs cloudflared`, `curl -fsS https://origin-api.<DOMAIN>/api/health` |
| Trình duyệt báo vòng lặp redirect / lỗi 5xx lạ | `API_ORIGIN` trỏ về chính public hostname của app | Đổi về hostname tunnel, không dùng public hostname |
| `413` khi upload | Vượt `client_max_body_size 12m` (Nginx) hoặc `MAX_UPLOAD_MB` của backend | Giảm kích thước file; nâng giới hạn thì phải sửa cả hai nơi |
| Đăng nhập xong vẫn bị coi là chưa đăng nhập | Cookie `Secure` + đang truy cập HTTP; hoặc vừa đổi hostname | Dùng đúng HTTPS của public origin hiện hành, đăng nhập lại |
| Cookie không có `Secure`/`HttpOnly` | `SESSION_COOKIE_SECURE`/`APP_ENV` sai trên VM | `APP_ENV=production` do compose đặt cứng; kiểm `.env` và `dcp config --quiet` |
| Route con của SPA trả 404 | Mất `not_found_handling: single-page-application` trong `wrangler.jsonc` | Khôi phục cấu hình rồi deploy lại |
| `/api` (không có dấu `/`) trả HTML của SPA | Đúng thiết kế: `run_worker_first: ["/api/*"]` chỉ bắt `/api/...` | Không cần xử lý; client không bao giờ gọi path này |
| Redirect `307` trỏ về hostname origin | Client gọi path có dấu `/` cuối bị FastAPI redirect | Gọi đúng `/api/...` không dấu `/` cuối |
| Static thiếu header bảo mật | `dist/_headers` không có trong bundle đã deploy | Chạy `npm run build` rồi kiểm `dist/_headers`, sau đó deploy lại |
| Asset cũ vẫn được phục vụ | Cache `immutable` cho file **không** có hash | Chỉ đặt cache immutable cho `/assets/*`; file trong `public/` phải có hash hoặc không cache |
| Deploy Worker fail ngay ở bước "Kiểm tra cấu hình" | Thiếu secret/variable ở environment `production`, hoặc `WORKER_URL` không phải `https://...` | Đối chiếu bảng ở §5.1; đây là fail có chủ ý để production chưa bị đụng tới |
| Push vào `release` mà VPS không cập nhật | Timer bị dừng, hoặc SHA đó đã lỗi một lần nên bị bỏ qua | `systemctl status vku-deploy.timer`; xem `history.log`; SHA lỗi thì push commit mới |
| Deployer báo "working tree production đang bẩn" | Có ai đó sửa trực tiếp file trong `/srv/vku-ai-challenge/repo` | Sửa bằng commit rồi `git checkout --detach origin/release`, không sửa tay trên VM |
| Deployer báo đường dẫn "chưa được phân loại" | Commit đổi thư mục mà deployer chưa biết nên map vào service nào | Thêm vào `map_changed_paths` trong `auto-deploy.sh` rồi chạy lại `install-auto-deploy.sh`; deployer dừng là đúng, không phải lỗi |
| Deployer báo rollback cũng thất bại | Cả bản mới lẫn bản cũ đều không lên được | Dừng timer, đọc `last-failure.txt`, deploy lại commit trước bằng đường thủ công (§7.2) |
| `/api/*` trả `502` sau khi VPS reboot | Quick Tunnel cấp hostname mới, `API_ORIGIN` của Worker vẫn trỏ URL cũ | `journalctl -u vku-deploy.service \| grep 'CẢNH BÁO'` để lấy URL mới, sửa `API_ORIGIN` (§5.2). Đăng nhập lại vì cookie host-only không còn khớp origin |

Không bao giờ dán `CLOUDFLARE_TUNNEL_TOKEN`, mật khẩu Mongo, mật khẩu admin hay session token vào
chat/log/issue.

## Vận hành thường ngày

```bash
dcp ps                     # trạng thái + health
dcp logs -f api            # log API (đã bật json-file rotation 10m x 3)
dcp logs --tail=50 cloudflared
dcp restart web            # restart một service
df -h /                    # backup cùng disk nên phải theo dõi dung lượng
```

Theo dõi thêm trên Cloudflare: Workers → Metrics (số request, lỗi 5xx) và Deployments (lịch sử build).
