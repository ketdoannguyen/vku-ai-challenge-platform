# AI Challenge Platform - Current Project State

## 1. Current checkpoint
- Last completed sprint: SPRINT_01
- Date: 2026-09-15
- Branch: main
- Commit/working tree status: sprint 01 commit (backend/frontend/nginx/compose)
- Overall state: green — code + tests pass; `docker compose up` chưa verify được trên máy dev (user nkd không có group docker), xem mục 11

## 2. Implemented capabilities
- Backend skeleton: FastAPI app `backend/app/main.py` với lifespan connect/close Mongo (motor), config từ env (`app/core/config.py`), error helper theo contract (`app/core/errors.py`), logging cơ bản
- `GET /api/health`: 200 `{"status":"ok","mongo":"reachable"}` / 503 `{"status":"degraded","mongo":"unreachable"}`; 4 unit tests (TestClient, không cần Mongo thật)
- 404 handler trả format `{"error":{"code","message"}}` cho mọi route `/api` không tồn tại
- Frontend shell: React 19 + Vite + TypeScript strict (`frontend/`), react-router, app shell (header/nav/page container), design tokens CSS thuần (một accent, status colors), component Loading/ErrorBox/Placeholder
- Placeholder routes: `/login`, `/` (dashboard), `/competitions/:slug/*`, `/admin/*`, `/health` (gọi thật `/api/health`), 404 — mọi placeholder ghi rõ "chưa có chức năng", không fake data
- API client `frontend/src/api/client.ts`: fetch relative `/api`, parse error format thống nhất, throw `ApiClientError`
- Nginx `frontend/nginx.conf`: serve SPA + fallback, proxy `/api/` → `api:8000`, security headers cơ bản, `client_max_body_size 12m`, `/data/` return 404
- Docker: `backend/Dockerfile`, `frontend/Dockerfile` (multi-stage: npm build → nginx), `docker-compose.yml` với services `web`/`api`/`mongo`, volumes `mongo_data` + `data`

## 3. Not implemented yet
- Auth/login/session (Sprint 02), accounts admin
- Competitions, memberships, Markdown content (Sprint 03-04)
- Submissions, scoring, leaderboard, export (Sprint 05-06)
- Hardening, production deploy (Sprint 07-08)

## 4. Repository structure that matters
- `backend/app/`: `main.py` (app + health + 404), `core/config.py` (Settings), `core/database.py` (MongoContext), `core/errors.py`
- `backend/tests/`: `test_health.py` (4 tests)
- `frontend/src/`: `App.tsx` (router), `api/client.ts`, `components/ui.tsx`, `pages/` (HealthPage, Placeholders), `index.css` (design tokens)
- `frontend/nginx.conf`: chạy trong container web
- `docker-compose.yml`: web (port `${WEB_PORT:-8080}`), api (internal 8000), mongo (internal 27017, healthcheck mongosh)

## 5. Runtime/services
- web: implemented — Nginx 1.27 serve React static + proxy `/api` (chưa verify end-to-end qua container — xem mục 11)
- api: implemented — FastAPI + uvicorn, port 8000 internal only
- mongo: implemented trong compose — Mongo 7, auth root qua MONGO_INITDB_ROOT_*, volume `mongo_data`, không publish ra host
- cloudflared: planned (Sprint 08)

## 6. Current API contract summary
- `GET /api/health`: implemented — 200/503 như mục 2. Chi tiết: `docs/API_CONTRACT.md`

## 7. Current data model and indexes
- Chưa có collection nào được code tạo/dùng. Health chỉ ping admin command. Baseline planned: `docs/DATA_MODEL.md`

## 8. Environment variables in use
- Code backend đọc: APP_ENV, APP_NAME, MONGO_HOST/PORT/DATABASE/USER/PASSWORD, MAX_UPLOAD_MB, DATA_DIR (Settings defaults hợp lệ cho local không env)
- docker-compose.yml đọc thêm: WEB_PORT (mặc định 8080)
- Chưa đọc (định nghĩa sẵn cho sprint sau): SESSION_*, CLOUDFLARE_TUNNEL_TOKEN
- Secret: MONGO_USER/MONGO_PASSWORD, SESSION_SECRET, CLOUDFLARE_TUNNEL_TOKEN
- Định nghĩa đầy đủ trong `.env.example` (đã thêm WEB_PORT)

## 9. Commands verified
### Local startup
- `docker compose config --quiet` — pass (cấu hình hợp lệ)
- `docker compose up --build` — CHƯA chạy được trên máy dev này: user nkd không thuộc group `docker`, socket `/var/run/docker.sock` từ chối, sudo cần password. Cần `sudo usermod -aG docker nkd` + re-login rồi verify lại.
### Tests
- `cd backend && .venv/bin/pytest` — 4 passed (test health + error format + ping fail)
- Cài môi trường: `uv venv .venv && uv pip install -e . --group dev` (máy không có python3-venv/pip, dùng uv)
### Build
- `cd frontend && npm run build` — pass (tsc strict + vite build)

## 10. Tests currently passing
- backend: 4 passed (`backend/tests/test_health.py`)
- frontend: typecheck strict + production build pass (chưa có test UI — chưa có logic đáng test)
- integration/smoke qua Nginx: chưa chạy được vì Docker permission (xem mục 9)

## 11. Known issues / technical debt
- Docker permission trên máy dev: user `nkd` không có group `docker` → chưa verify `docker compose up`, curl qua Nginx, health với Mongo thật. Đây là việc verify còn thiếu của Sprint 01, không phải bug code.
- Mongo dùng chung root user làm app user (MONGO_USER/MONGO_PASSWORD set cho cả MONGO_INITDB_ROOT và api). Chấp nhận cho local dev; tách app user riêng + quyền tối thiểu khi hardening (Sprint 07/08).
- `client_max_body_size 12m` là baseline cố định, chưa sync động với MAX_UPLOAD_MB — ghi debt, sẽ chốt khi Sprint 05 làm upload thật.
- `AI_Challenge_Sprint_Plan_v1.zip` đã bị xóa khỏi working tree (nội dung đầy đủ đã có trong `plans/`); việc xóa được commit cùng sprint này.

## 12. Decisions made this sprint
- Không có ADR mới. Chọn giữ `MONGO_USER/MONGO_PASSWORD` (đã chốt ở `.env.example` Sprint 00) thay vì `MONGO_APP_USER/MONGO_APP_PASSWORD` trong sprint file — truth hierarchy: `.env.example`/PROJECT_STATE > sprint file.
- Mongo + api không publish port ra host; mọi truy cập đi qua Nginx (`WEB_PORT`, mặc định 8080; host không dùng 80 vì có thể cần quyền riêng).

## 13. Preconditions for next sprint
- Sprint 02 (auth & accounts) cần: backend có Mongo reachable khi chạy (đã có compose), session collection + Argon2id. Nên verify `docker compose up` end-to-end trước khi vào Sprint 02 (xem mục 11).

## 14. Exact next sprint
- `plans/sprints/SPRINT_02_AUTH_ACCOUNTS_SESSIONS.md`

## 15. Handoff notes for the next AI agent
- Backend pattern: config qua `app/core/config.py` (pydantic-settings, lru_cache `get_settings()`), Mongo qua `app.state.mongo` (MongoContext), error dùng `api_error()` hoặc `error_response()` — endpoint mới theo pattern này.
- Frontend pattern: gọi API qua `api.get/post` (`src/api/client.ts`), catch `ApiClientError`; trang mới đặt trong `src/pages/`, route trong `App.tsx`.
- compose: api chỉ `expose 8000` — không thêm `ports` cho api/mongo; web là entry duy nhất.
- Nginx nằm trong `frontend/nginx.conf` (được copy vào container web), không phải folder `nginx/` riêng.
- Session/auth chưa có — cookie config (SESSION_*) định nghĩa trong `.env.example` nhưng chưa được code đọc.

---
Rules:
- Không ghi suy đoán.
- Không ghi secret.
- Nếu một chức năng đang partial, nói rõ partial ở đâu.
- Mỗi endpoint/schema đã thay đổi phải đồng bộ sang contract file.
