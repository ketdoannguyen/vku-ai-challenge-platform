# Deployment - AI Challenge Platform

Status: **local stack implemented, release candidate** — Docker Compose chạy được local (web/api/mongo); production trên GCE triển khai ở Sprint 08.

## Target architecture (locked)

- 01 Google Compute Engine VM, Ubuntu Server LTS
- Docker Compose điều phối: web (Nginx), api (FastAPI), mongo, cloudflared (production)
- Public qua Cloudflare Tunnel; không mở port Mongo ra public
- Persistent disk cho `/data/` (Markdown, assets, ground truth, submissions, backups)

## Prerequisites (chuẩn bị trước khi chạy Sprint 08)

1. GCE VM (Ubuntu Server LTS) + persistent disk mount `/data`.
2. Docker + Docker Compose plugin trên VM.
3. Domain đã trỏ về Cloudflare; Cloudflare Tunnel token (`cloudflared tunnel create`).
4. Git access repo (SSH key hoặc HTTPS token trên VM).
5. Đã chạy đủ test local theo `docs/PROJECT_STATE.md` §9 (release candidate gate).

## Production environment variables

Tạo `.env` trên server theo `.env.example` với giá trị production:

| Biến | Giá trị production |
|---|---|
| `APP_ENV` | `production` (bật cookie `Secure` qua `SESSION_COOKIE_SECURE=auto`) |
| `APP_NAME` | Tên hiển thị của platform |
| `WEB_PORT` | Port Nginx expose trên host (thường để mặc định/tunneled) |
| `MONGO_HOST` | `mongo` (tên container) |
| `MONGO_PORT` | `27017` |
| `MONGO_DATABASE` | Tên database, ví dụ `ai_challenge` |
| `MONGO_USER` / `MONGO_PASSWORD` | Credential Mongo mạnh, sinh ngẫu nhiên |
| `SESSION_SECRET` | Random string dài (dự phòng; hiện chưa dùng — ADR-008) |
| `SESSION_LIFETIME_HOURS` | Ví dụ `24` |
| `SESSION_COOKIE_NAME` | `aic_session` |
| `SESSION_COOKIE_SECURE` | `auto` |
| `SESSION_COOKIE_SAMESITE` | `lax` (hoặc `strict` nếu chỉ same-site) |
| `MAX_UPLOAD_MB` | `10` |
| `MAX_CONTENT_MB` | `2` |
| `MAX_ASSET_MB` | `2` |
| `DATA_DIR` | `/data` |
| `CLOUDFLARE_TUNNEL_TOKEN` | Token tunnel Cloudflare |

Lưu ý: compose hiện chỉ truyền một số env vào `api` (`APP_ENV`, Mongo, upload limits, `DATA_DIR`). Các biến session khác có thể được truyền thêm khi Sprint 08 chốt cấu hình prod; hiện backend dùng giá trị mặc định an toàn (`SESSION_COOKIE_SECURE=auto` theo `APP_ENV=production`).

## Deployment steps (planned — điền thật ở Sprint 08)

1. Provision GCE VM + persistent disk, mount `/data`.
2. Cài Docker + Docker Compose.
3. Clone repo, tạo `.env` production theo bảng trên.
4. Up stack production (compose override/prod file sẽ được tạo ở Sprint 08 nếu cần — hiện repo chỉ có `docker-compose.yml`).
5. Cấu hình Cloudflare Tunnel token, verify HTTPS + `/api/health`.
6. Tạo admin account đầu tiên:
   ```bash
   docker compose exec -T api python scripts/create_admin.py <email> <name> <password>
   ```
   Import thí sinh hàng loạt:
   ```bash
   docker compose exec -T api python scripts/import_accounts.py <file.csv>
   ```
   (CSV header `email,name,password`; password policy ≥10 ký tự.)

## Operations (planned — điền thật ở Sprint 09)

- Backup: Mongo dump + rsync `/data/` → `/data/backups/` hoặc vị trí offsite.
- Restore: verify từ backup test.
- Monitoring/log cơ bản (`docker compose logs api`).
