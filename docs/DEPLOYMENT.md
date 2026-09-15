# Deployment - AI Challenge Platform

Status: **planned** — chưa có runtime. Hoàn thiện dần theo sprint.

## Target architecture (locked)

- 01 Google Compute Engine VM, Ubuntu Server LTS
- Docker Compose điều phối: web (Nginx), api (FastAPI), mongo, cloudflared (production)
- Public qua Cloudflare Tunnel; không mở port Mongo ra public
- Persistent disk cho `/data/` (Markdown, assets, ground truth, submissions, backups)

## Environment

Xem `.env.example`. Production secret nằm trong `.env` trên server hoặc secret mechanism phù hợp; repo không chứa secret.

## Deployment steps (planned — điền thật ở Sprint 08)

1. Provision GCE VM + persistent disk, mount `/data`.
2. Cài Docker + Docker Compose.
3. Clone repo, tạo `.env` production.
4. `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`.
5. Cấu hình Cloudflare Tunnel token, verify HTTPS + `/api/health`.
6. Tạo admin account đầu tiên (bootstrap command/script).

## Operations (planned — điền thật ở Sprint 09)

- Backup: Mongo dump + rsync `/data/` → `/data/backups/` hoặc vị trí offsite.
- Restore: verify từ backup test.
- Monitoring/log cơ bản.
