# AI Challenge Platform - Current Project State

## 1. Current checkpoint
- Last completed sprint: SPRINT_00
- Date: 2026-09-15
- Branch: main
- Commit/working tree status: initial commit after bootstrap
- Overall state: green

## 2. Implemented capabilities
- Repository skeleton: `plans/`, `docs/`, `.env.example`, `.gitignore`, `.editorconfig`, `README.md`
- 6 canonical docs được tạo với baseline từ `plans/01_MASTER_CONTEXT.md` và `plans/02_ARCHITECTURE_CONTRACTS.md`
- 7 quyết định kiến trúc ghi trong `docs/DECISIONS.md`
- Environment contract trong `.env.example` (placeholder only)

## 3. Not implemented yet
- Mọi chức năng nghiệp vụ: login/session, competitions, memberships, content, submissions, scoring, leaderboard, export
- Frontend app, backend app, Nginx config, Docker Compose (Sprint 01)
- Production deployment (Sprint 08)

## 4. Repository structure that matters
- `plans/`: sprint plan pack (00-04 là docs định hướng, `sprints/` là chi tiết từng sprint)
- `docs/`: canonical docs — nguồn sự thật về state/contracts
- `.env.example`: environment contract với placeholder
- `README.md`: mục đích, architecture, trạng thái hiện tại

Chưa có `frontend/`, `backend/`, `nginx/`, `scripts/`, `docker-compose.yml` — sẽ tạo ở Sprint 01 khi có nội dung thật (không tạo folder rỗng).

## 5. Runtime/services
- web: planned — Nginx serve React static + proxy `/api` (Sprint 01)
- api: planned — FastAPI container (Sprint 01)
- mongo: planned — MongoDB container (Sprint 01)
- cloudflared: planned — Cloudflare Tunnel (Sprint 08)

## 6. Current API contract summary
Chưa có endpoint nào implemented. Baseline planned: xem `docs/API_CONTRACT.md`.

## 7. Current data model and indexes
Chưa có collection nào implemented. Baseline planned: xem `docs/DATA_MODEL.md`.

## 8. Environment variables in use
Định nghĩa trong `.env.example`; chưa có code nào đọc chúng (Sprint 01+).
- APP_ENV, APP_NAME: môi trường/tên app — secret: no
- MONGO_HOST/PORT/DATABASE/USER/PASSWORD: kết nối MongoDB — secret: USER, PASSWORD yes
- SESSION_SECRET/LIFETIME_HOURS/COOKIE_NAME/COOKIE_SECURE/COOKIE_SAMESITE: session — secret: SESSION_SECRET yes
- MAX_UPLOAD_MB: giới hạn upload CSV — secret: no
- DATA_DIR: thư mục dữ liệu trên disk — secret: no
- CLOUDFLARE_TUNNEL_TOKEN: production only — secret: yes

## 9. Commands verified
### Local startup
Chưa có runtime. Kế hoạch Sprint 01: `docker compose up --build`.
### Tests
Chưa có test suite.
### Build
Chưa có build step.

## 10. Tests currently passing
- backend: chưa có
- frontend: chưa có
- integration/smoke: chưa có

## 11. Known issues / technical debt
- Không có. Repo mới bootstrap.

## 12. Decisions made this sprint
- ADR-001 đến ADR-007 trong `docs/DECISIONS.md`

## 13. Preconditions for next sprint
- Repo structure và docs đã sẵn sàng (đạt)
- Sprint 01 sẽ khởi tạo: Docker Compose stack (FastAPI + MongoDB + Nginx), React + Vite + TypeScript frontend shell với strict mode, `GET /api/health`

## 14. Exact next sprint
- `plans/sprints/SPRINT_01_LOCAL_STACK_AND_APP_SHELL.md`

## 15. Handoff notes for the next AI agent
- Architecture đã khóa trong `plans/01_MASTER_CONTEXT.md` mục 3 — không đổi nếu chưa hỏi người dùng.
- Nguồn sự thật khi mâu thuẫn: code trong repo > PROJECT_STATE.md > DECISIONS.md > API/DATA contracts > file sprint hiện tại.
- Chưa có code frontend/backend — Sprint 01 tự do chọn cấu trúc bên trong miễn giữ stack đã khóa.
- `.env.example` là environment contract; thêm biến mới phải cập nhật file này và mục 8 của doc này.
- Không hard-code tên competition nào vào logic.
- Cuối mỗi sprint cập nhật doc này + contracts liên quan; không tự chạy sprint kế tiếp.

---

Rules:
- Không ghi suy đoán.
- Không ghi secret.
- Nếu một chức năng đang partial, nói rõ partial ở đâu.
- Mỗi endpoint/schema đã thay đổi phải đồng bộ sang contract file.
