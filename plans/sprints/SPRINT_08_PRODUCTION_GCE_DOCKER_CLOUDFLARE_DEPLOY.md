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

## Ngoài phạm vi
- HA/multi-VM.
- Autoscaling.
- CI/CD pipeline phức tạp.

