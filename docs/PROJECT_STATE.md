# AI Challenge Platform - Current Project State

## 1. Current checkpoint
- Last completed sprint: SPRINT_02
- Date: 2026-09-15
- Branch: main
- Commit/working tree status: sprint 02 (auth/accounts/sessions) đã commit
- Overall state: green — 30 backend tests + 7 frontend tests pass; end-to-end qua Docker vẫn chưa verify được (user nkd thiếu group docker, xem mục 11)

## 2. Implemented capabilities
- Sprint 01 (giữ nguyên): FastAPI skeleton, `GET /api/health`, React shell strict TS, Nginx, Docker Compose web/api/mongo
- Auth: `POST /api/auth/login` (Argon2id verify, generic 401, disabled account → 403 ACCOUNT_DISABLED), `POST /api/auth/logout` (idempotent, delete session + clear cookie), `GET /api/auth/me`
- Session: opaque token `secrets.token_urlsafe(32)`, DB lưu sha256(token) làm `_id`, TTL index `expires_at`, check expiry + account active mỗi request (middleware gắn `request.state.account`)
- Cookie: `aic_session`, HttpOnly, Path=/, SameSite=lax (configurable strict), Secure=auto (true khi production)
- Admin accounts API: `GET /api/admin/accounts` (search q, phân trang limit/offset), `POST /api/admin/accounts` (409 duplicate, validate role/password), `POST /api/admin/accounts/{id}/reset-password`, `PATCH /api/admin/accounts/{id}` (enable/disable, chặn self-disable)
- Bootstrap scripts: `backend/scripts/create_admin.py` (idempotent, không ghi đè), `backend/scripts/import_accounts.py` (CSV email,name,password; duplicate báo rõ không im lặng; password policy check)
- Frontend auth: AuthContext (bootstrap `/auth/me`), LoginPage thật (error/loading states), RequireAuth/RequireAdmin (redirect `/login`), header hiển thị user + role badge + logout, admin-only nav, trang AdminAccountsPage (search/tạo/reset/disable với modal)
- Password policy: tối thiểu 10 ký tự, không space đầu/cuối
- Error contract: mọi HTTP exception trả `{"error":{"code","message"}}`; 422 RequestValidationError → VALIDATION_ERROR

## 3. Not implemented yet
- Competitions, memberships, Markdown content (Sprint 03-04)
- Submissions, scoring, leaderboard, export (Sprint 05-06)
- Login rate limiting — defer Sprint 07 (sprint file cho phép nếu phức tạp)
- Hardening, production deploy (Sprint 07-08)

## 4. Repository structure that matters
- `backend/app/auth/`: `passwords.py` (hash/verify/policy), `sessions.py` (create/resolve/delete, ensure_indexes), `dependencies.py` (get_current_account, get_current_admin, set_session_cookie), `router.py` (login/logout/me)
- `backend/app/accounts/`: `service.py` (create/find/ensure_indexes/public_account), `admin_router.py` (list/create/reset/disable)
- `backend/scripts/`: `create_admin.py`, `import_accounts.py`
- `backend/tests/`: `conftest.py` (mongomock-motor + app fixture), `test_passwords.py` (4), `test_auth.py` (10), `test_admin_accounts.py` (12), `test_health.py` (4)
- `frontend/src/auth/`: `AuthContext.tsx` (AuthProvider, useAuth), `RequireAuth.tsx` (RequireAuth, RequireAdmin)
- `frontend/src/pages/`: `LoginPage.tsx` (thật), `AdminAccountsPage.tsx` (thật), `Placeholders.tsx` (dashboard empty-state, competition 404), `HealthPage.tsx`
- `frontend/src/api/client.ts`: thêm `api.patch`

## 5. Runtime/services
- web/api/mongo như Sprint 01; không đổi compose
- cloudflared: planned (Sprint 08)

## 6. Current API contract summary
- `GET /api/health`: implemented (Sprint 01)
- `POST /api/auth/login|logout`, `GET /api/auth/me`: implemented
- `GET|POST /api/admin/accounts`, `POST /api/admin/accounts/{id}/reset-password`, `PATCH /api/admin/accounts/{id}`: implemented
- Chi tiết: `docs/API_CONTRACT.md`

## 7. Current data model and indexes
- `accounts`: implemented — fields email (unique index, lowercase), name, password_hash (Argon2id), role (admin|participant), active, created_at, updated_at
- `sessions`: implemented — `_id` = sha256(raw token), account_id (ObjectId), created_at, expires_at; TTL index expires_at, index account_id
- Chi tiết: `docs/DATA_MODEL.md`

## 8. Environment variables in use
- Code backend đọc: APP_ENV, APP_NAME, MONGO_HOST/PORT/DATABASE/USER/PASSWORD, MAX_UPLOAD_MB, DATA_DIR + MỚI: SESSION_SECRET (định nghĩa, chưa dùng — token opaque không cần ký), SESSION_LIFETIME_HOURS, SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE (auto|true|false), SESSION_COOKIE_SAMESITE (lax|strict)
- Chưa đọc: CLOUDFLARE_TUNNEL_TOKEN (Sprint 08)

## 9. Commands verified
### Local startup
- `docker compose config --quiet` — pass
- `docker compose up` — vẫn blocked: user nkd không có group docker (từ Sprint 01)
### Bootstrap (cần Mongo chạy)
- `cd backend && .venv/bin/python scripts/create_admin.py <email> <name> <password>`
- `cd backend && .venv/bin/python scripts/import_accounts.py <file.csv>` — CSV header `email,name,password`
- Verify: usage error + connection-refused path đã chạy thật; tạo account thật chưa chạy (cần Mongo)
### Tests
- `cd backend && .venv/bin/pytest` — 30 passed
- `cd frontend && npm test` — 7 passed (vitest + testing-library)
### Build
- `cd frontend && npm run build` — pass; `npm run lint` — pass (warnings fast-refresh + fetch-in-effect, không lỗi)

## 10. Tests currently passing
- backend: 30 (health 4, passwords 4, auth 10, admin accounts 12)
- frontend: 7 (login form error/loading/no-register 3, protected routes 4)
- integration qua Nginx: chưa chạy được (Docker permission)

## 11. Known issues / technical debt
- Docker permission trên máy dev (Sprint 01): chưa verify `docker compose up`, login qua Nginx với Mongo thật, bootstrap scripts với Mongo thật. Cần `sudo usermod -aG docker nkd` + re-login.
- Login rate limiting defer Sprint 07 (sprint file cho phép).
- `SESSION_SECRET` không dùng (token opaque); giữ trong `.env.example` cho tương lai nếu cần ký.
- Mongo root==app user debt (Sprint 01) vẫn còn — tách ở Sprint 07/08.
- Test frontend dùng `vi.stubGlobal("fetch")` — đủ cho Sprint 02; nếu thêm nhiều trang nên cân nhắc MSW.

## 12. Decisions made this sprint
- Ghi trong `docs/DECISIONS.md` ADR-008 (session lưu sha256 token, ObjectId account_id; bootstrap qua `/auth/me` mỗi request resolve session).

## 13. Preconditions for next sprint
- Sprint 03 (competitions admin) cần: admin account thật (chạy create_admin khi Mongo lên), verify `docker compose up` end-to-end trước khi vào nếu có thể.

## 14. Exact next sprint
- `plans/sprints/SPRINT_03_COMPETITIONS_ADMIN.md`

## 15. Handoff notes for the next AI agent
- Auth pattern: dependency `AdminAccount` (dependencies.py) cho mọi route admin mới; `request.state.account` đã có sẵn từ middleware.
- Account lookup: luôn qua `find_account_by_email` (đã lowercase); tạo account qua `create_account` service.
- Frontend: trang admin mới theo pattern `AdminAccountsPage` (table + toolbar + modal); route admin bọc `<RequireAdmin>`.
- Test backend: dùng fixture `client` (conftest) — app thật + mongomock-motor, seed admin@vku.vn/thi.sinh@vku.vn sẵn.
- Login identifier: email, normalize strip+lowercase cả 2 phía.

---
Rules:
- Không ghi suy đoán.
- Không ghi secret.
- Nếu một chức năng đang partial, nói rõ partial ở đâu.
- Mỗi endpoint/schema đã thay đổi phải đồng bộ sang contract file.
