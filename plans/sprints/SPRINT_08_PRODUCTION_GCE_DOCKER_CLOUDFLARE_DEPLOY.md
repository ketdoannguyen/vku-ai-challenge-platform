# SPRINT 08 - Production Deployment on Google Compute Engine + Docker + Cloudflare

## Mục tiêu
Deploy release candidate lên 01 Google Compute Engine VM và công khai qua Cloudflare Tunnel trên domain thật.

Sprint này có external credentials. AI phải DỪNG tại điểm thiếu thông tin và hỏi cụ thể, không đoán.

## Điều kiện bắt đầu
Sprint 07 release candidate green.
Người dùng cần cung cấp/xác nhận khi tới bước liên quan:
- Google Cloud project/billing đã sẵn sàng
- VM region/zone hoặc cho phép chọn
- domain/hostname muốn dùng
- Cloudflare account/domain có quyền tạo Tunnel/DNS
- repo access trên VM

## Phase A - Production architecture verification
Trước khi deploy, xác nhận stack:

Internet -> Cloudflare -> Tunnel -> `web:80`

Trong Docker network:
- web -> api:8000
- api -> mongo:27017
- api -> mounted `/data`

Không public Mongo/API port ra Internet.

## Phase B - GCE VM provisioning
Tạo/xác nhận VM baseline:
- Ubuntu Server LTS
- initial 2 vCPU / 4 GB RAM
- ~40-50 GB persistent disk baseline
- SSH administration
- timezone system có thể UTC; app timestamps UTC

Security:
- không cần mở 80/443 nếu Cloudflare Tunnel outbound-only
- Mongo 27017 closed
- chỉ mở SSH theo cách quản trị được chấp nhận

Nếu người dùng muốn static external IP, ghi rõ lý do; Tunnel không bắt buộc web public IP.

## Phase C - Host setup
Cài:
- Docker Engine
- Docker Compose plugin
- Git
- basic tools needed for backup/ops

Tạo deploy path rõ, ví dụ:
`/opt/ai-challenge`

Tạo persistent data path với permission phù hợp:
`/opt/ai-challenge-data` hoặc theo compose contract.

Không chmod 777 để giải quyết permission.

## Phase D - Production configuration
- Clone/pull exact release commit.
- Tạo `.env` production trên VM từ `.env.example`.
- Generate strong Mongo/app/session secrets.
- Không paste secrets vào docs/git/log.
- Set cookie Secure=true.
- Set APP_ENV=production.
- Mount data persistent path.
- Compose restart policies.

Nếu dùng `docker-compose.prod.yml`, giữ override nhỏ và rõ.

## Phase E - Database bootstrap
- Start Mongo securely.
- Ensure indexes/bootstrap idempotently.
- Create initial admin qua script/command.
- Verify no default weak credentials.

Không tạo participant fake trong production trừ khi pilot plan cần.

## Phase F - Cloudflare Tunnel
Tạo Tunnel/hostname theo domain được cung cấp.

Cloudflared container:
- token/config từ production env/secure file
- origin target `http://web:80`
- restart policy

DNS/hostname:
`challenge.<domain>` hoặc hostname người dùng chốt.

Verify:
- HTTPS valid
- no direct private service exposure
- original VM ports as intended

## Phase G - Deploy
Commands/process phải reproducible:
- pull exact commit
- build images
- `docker compose ... up -d`
- health check
- logs

Tạo `scripts/deploy.sh` chỉ nếu nó thật sự làm quy trình gọn và an toàn. Script không tự xóa volume/data.

## Phase H - Production smoke test
Bắt buộc test trên domain:
1. website loads HTTPS
2. admin login
3. create pilot competition draft
4. upload Markdown
5. publish
6. participant/pilot account login
7. join
8. read Markdown
9. submit known CSV fixture
10. verify expected metrics
11. My Submissions
12. Leaderboard
13. Excel export
14. logout/session

Không dùng ground truth production thật nếu chưa sẵn sàng; có thể tạo pilot competition test riêng.

## Phase I - Operational commands
`docs/DEPLOYMENT.md` phải có exact:
- deploy/update
- status
- logs web/api/mongo/cloudflared
- restart one service
- rollback code commit without deleting data
- where production `.env` lives
- where persistent data lives

## Acceptance criteria
1. Domain HTTPS truy cập được qua Cloudflare Tunnel.
2. web/api/mongo/cloudflared healthy/restarting correctly.
3. Mongo/API không public trực tiếp.
4. Production smoke flow pass.
5. Persistent data tồn tại sau container restart/recreate.
6. Secrets not committed.
7. Deployment doc chính xác với server thực tế.
8. State ghi exact release commit/domain non-secret info.

## Dừng và hỏi nếu
- Thiếu GCP/domain/Cloudflare credential.
- Cần destructive change VM/disk/volume.
- Existing server có service/data có nguy cơ conflict.
- DNS/domain đang phục vụ hệ thống khác.
- Permission GCP không đủ.

## Handoff
Ghi:
- VM non-sensitive spec/region
- deploy path
- public hostname
- compose production command
- smoke result
- persistent paths
- known ops issue
- next sprint = Sprint 09

### Kết quả triển khai pilot - 2026-09-18

**Trạng thái: CHƯA đạt Sprint 08.** Stack đã chạy public và pass smoke flow, nhưng đi qua Quick Tunnel
chứ chưa có domain thật, nên Acceptance #1 và phần domain của #8 không thoả. Không đánh dấu sprint
hoàn tất; xem lý do và việc cần làm ở cuối mục này.

- **VM**: GCE `e2-standard-2`, Ubuntu 24.04.4 LTS, zone `us-central1-b`, 2 vCPU / 7.7 GiB RAM /
  boot disk 67 GiB. Host chỉ mở SSH; trên host chỉ cài Docker Engine 29.8.1 + Compose v5.5.1,
  không cài Python/Node/Nginx/cloudflared (tất cả chạy trong container).
- **Release đang chạy**: `10365f3e59014f5ef0877417ef4122f83daf3ad6`, checkout detached, tree sạch.
  Commit bổ sung `4f07466` (sửa runbook) chưa lên VPS — không ảnh hưởng runtime vì `docs/` không vào image.
- **Deploy path**: `/srv/vku-ai-challenge/repo`; dữ liệu `/srv/vku-ai-challenge/data`; backup
  `/srv/vku-ai-challenge/backups`; env `/srv/vku-ai-challenge/.env` (mode 0600, root).
- **Lệnh compose**: `sudo docker compose --env-file /srv/vku-ai-challenge/.env -f /srv/vku-ai-challenge/repo/docker-compose.prod.yml <cmd>`
- **Public hostname**: Quick Tunnel `*.trycloudflare.com`, **đổi mỗi lần `cloudflared` restart** — đã
  quan sát trực tiếp trong đợt này (restart đổi sang tên khác, URL cũ trả Cloudflare 530/1033).
- **Smoke Phase H**: 20/20 PASS qua HTTPS công khai (admin login → tạo draft → upload Markdown →
  scoring + ground truth → publish → participant join → đọc Markdown → nộp CSV fixture →
  F1/Precision/Recall = 0.5 → My Submissions → Leaderboard → export.xlsx → logout/session).
  Dữ liệu pilot đã xoá cascade; DB về `accounts=1`, các collection khác `0`, session test đã xoá.
- **Gate tại release SHA**: backend 194 passed; frontend 306 passed; build production cho ra đúng
  asset hash đang phục vụ (`index-yEn6qAyE.js`, `index-Dv3oUVWa.css`); lint 0 error / 22 warning có sẵn.
- **Persistent data (#5)**: restart lần lượt `mongo` → `api` → `web`+`cloudflared`, tất cả healthy;
  session cấp **trước** restart vẫn xác thực được sau restart (session nằm trong Mongo, không phải RAM).
- **Backup**: `vku-backup.timer` đã bật (03:17 UTC + jitter 5 phút); chạy tay thành công, retention
  xoá đúng thư mục cũ; diễn tập restore vào database tạm khớp số document từng collection rồi drop.
- **Acceptance**: #2 #3 #4 #5 #6 đạt; #7 đạt sau commit `4f07466`; **#1 và phần domain của #8 chưa đạt**.
- **Known ops issues**: Quick Tunnel chập chờn (gặp lẻ tẻ `SSL unexpected eof` / HTTP 000, tự khỏi,
  không phải lỗi ứng dụng); dữ liệu + backup cùng một boot disk nên không chống mất disk/VM; giới hạn
  đăng nhập 10 lần/15 phút là bộ đếm trong RAM nên restart `api` xoá bộ đếm.
- **Việc còn lại để đạt Sprint 08**: có domain thật trong Cloudflare → chuyển sang named tunnel
  (`CLOUDFLARE_TUNNEL_TOKEN`, command `tunnel --no-autoupdate run`) → chạy lại toàn bộ smoke gate
  HTTPS/auth; và chọn một trong: GCE snapshot schedule, backup ra object storage, hoặc persistent disk riêng.

## Ngoài phạm vi
- HA/multi-VM.
- Autoscaling.
- CI/CD pipeline phức tạp.

