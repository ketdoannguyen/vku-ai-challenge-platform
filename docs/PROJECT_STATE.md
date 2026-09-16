# AI Challenge Platform - Current Project State

## 1. Current checkpoint
- Last completed sprint: SPRINT_07
- Date: 2026-09-16
- Branch: main
- Commit/working tree status: Sprint 06 đã commit tại `e06f2ea`; Sprint 07 implemented trong working tree, chưa commit/push
- Overall state: **release candidate** — 133 backend tests + 53 frontend tests pass; frontend production build + lint, Compose config, Docker image build pass; full E2E local MVP/security smoke qua Nginx/Mongo/filesystem thật pass (xem Commands verified)

## 2. Implemented capabilities
- Sprint 01-06: local Compose stack, auth Argon2id + server-side session, admin accounts, competition lifecycle, membership/join modes, safe Markdown content/assets, participant portal, scoring + ground truth private, submission policy/quota, my submissions, leaderboard, XLSX export
- Sprint 07 hardening:
  - Login abuse control: limiter in-process `app/auth/rate_limit.py` — 10 lần sai/15 phút theo identifier đã normalize, vượt → 429 `RATE_LIMITED` + `Retry-After`; login đúng reset counter; state process-local, bounded 10.000 identifiers (ADR-013)
  - Error contract ổn định: unhandled exception → 500 `INTERNAL_ERROR` generic không lộ traceback/detail; 405 → `METHOD_NOT_ALLOWED`; non-dict 4xx → `HTTP_ERROR`; HTTPException giữ header (Retry-After)
  - Logging đầy đủ và an toàn: join completed/reused, content/asset upload + delete, submission reject theo stable code, submission scoring failure (log exception riêng), export, health degraded; log chỉ chứa ID/email/code/bytes — không password/cookie/join code/ground truth/CSV values
  - Nginx: thêm `Permissions-Policy` + `Content-Security-Policy-Report-Only` same-origin; giữ nosniff/X-Frame-Options DENY/Referrer-Policy; `/data/` 404 tường minh
- Sprint 07 admin/UX completion:
  - Admin competition detail có khối "Thông tin chung" (status/dates/join mode/metric/quota)
  - Accounts + members admin tải `limit=200` (đủ 40-80 đội; tổng hiển thị)
  - Confirm destructive: xóa content, xóa asset, đổi mã tham gia, member active toggle, account active toggle, thay ground truth khi đã có file
  - Mã tham gia input `type=password`; đặt mã lần đầu không cần confirm, đổi mã có confirm và refetch trạng thái configured
  - Account create/reset password dùng `type=password` + `minLength=10` + `autoComplete=new-password`; busy labels nhất quán
  - Closed competition không cho mở form Sửa (disabled + title lý do); client validate `end_at > start_at` trước khi gửi
  - SubmissionPage derive lý do "chưa mở nhận bài"/"đã hết hạn" từ `start_at`/`end_at` (backend vẫn là nguồn enforce)
  - ResultsPanel loading/error nhất quán (loading state, không render table trống khi lỗi)
  - Modal/ConfirmModal dùng chung `components/Modal.tsx`: portal ra body, focus vào input đầu tiên khi mở, restore focus + Escape đóng

## 3. Not implemented yet (đúng kế hoạch)
- Production deploy (GCE, Cloudflare Tunnel, compose prod, HSTS, CSP enforce, edge/IP-based rate limit) — Sprint 08
- Backup/restore/pilot — Sprint 09

## 4. Repository structure that matters
- `backend/app/auth/rate_limit.py`: FailedLoginLimiter process-local (fixed window, thread-safe, bounded)
- `backend/app/main.py`: error handlers (HTTPException với headers, RequestValidationError, unhandled 500), health degraded log
- `backend/app/auth/router.py`, `memberships/router.py`, `content/admin_router.py`, `submissions/router.py`, `submissions/admin_router.py`: limiter hook + safe event logs
- `frontend/src/components/Modal.tsx`: Modal + ConfirmModal dùng chung (portal, focus, Escape)
- `frontend/src/pages/AdminAccountsPage.tsx` + test mới (2), `AdminCompetitionDetailPage.tsx` + test, `AdminCompetitionsPage.tsx` + test, `SubmissionPage.tsx` + test
- `frontend/nginx.conf`: security headers + CSP Report-Only
- `backend/tests/test_auth.py` (+4 tests), `backend/tests/test_health.py` (+2), `backend/tests/test_submissions.py` (+1), `backend/tests/conftest.py` (autouse reset limiter)

## 5. Runtime/services
- Kiến trước web/api/mongo và volume `/data` giữ nguyên; không dependency mới ở Sprint 07
- Limiter state nằm trong process API (1 uvicorn worker) — restart API reset

## 6. Current API contract summary
- `POST /api/auth/login` thêm hành vi 429 `RATE_LIMITED` + `Retry-After` sau 10 lần sai/15 phút (ADR-013)
- Error codes mới: `RATE_LIMITED` (429), `METHOD_NOT_ALLOWED` (405), `HTTP_ERROR` (generic 4xx), `INTERNAL_ERROR` (500)
- Không endpoint/schema nào khác thay đổi
- Chi tiết: `docs/API_CONTRACT.md`

## 7. Current data model and indexes
- Không thay đổi collection/field/index ở Sprint 07
- Chi tiết: `docs/DATA_MODEL.md`

## 8. Environment variables in use
- Không env mới; toàn bộ config limiter hiện là hằng số trong `rate_limit.py` (10 lần/15 phút) — nâng env khi Sprint 08 cần tune
- Lưu ý: docker-compose hiện chỉ truyền các env cần thiết cho API; `SESSION_SECRET` trong `.env.example` vẫn không được dùng (ADR-008)

## 9. Commands verified
- `cd backend && .venv/bin/pytest` — 133 passed
- `cd frontend && npm test` — 53 passed (13 files)
- `cd frontend && npm run build` — pass (strict TS + Vite production build)
- `cd frontend && npm run lint` — exit 0, chỉ warnings pattern cũ (set-state-in-effect/Fast Refresh)
- `docker compose config --quiet` — pass
- `docker compose build` + `docker compose up -d` — pass
- Sprint 07 live smoke qua Nginx (2026-09-16): headers (nosniff/DENY/Referrer-Policy/Permissions-Policy/CSP-Report-Only) trên `/`; `/data/` 404; unknown ground-truth route 404; admin API 401 khi unauth; Mongo không publish
- Full E2E RC smoke (isolated, qua Nginx + Mongo thật): seed admin/participant → tạo competition → scoring config + ground truth → upload Markdown malicious (`<script>`, `javascript:` link) → publish → participant join → admin API 403 với participant → content API trả markdown thô (frontend sanitize đã test riêng) → submission sai ID 422 không persist → submission đúng score 1.0 → vượt quota 429 → history/leaderboard đúng → export.xlsx là file xlsx hợp lệ → dọn sạch data + file
- Rate limit live smoke: 10 lần sai → 429 `RATE_LIMITED` + `Retry-After` qua Nginx
- Log review qua `docker compose logs api`: login/join/content/submission/export events có đủ, không có secret

## 10. Tests currently passing
- Backend: 133 (Sprint 02-06: 126; Sprint 07 thêm 7: rate limit ×2, cookie flags, log redaction ×2, 500 envelope, 405, submission reject log)
- Frontend: 53 (Sprint 06: 48; Sprint 07 thêm 5: accounts ×2, closed-edit + date-order, member confirm, deadline gating)

## 11. Known issues / technical debt (non-blocking)
- Limiter key theo email: kẻ xấu biết email có thể gây lockout 15 phút cho chủ email (trade-off MVP, đã ghi ADR-013); cần IP companion khi có Cloudflare trusted headers
- Limiter state process-local: chỉ đúng khi API chạy 1 worker; multi-worker/distributed cần external store
- Limit 200 cho admin accounts/members: quá 200 dòng sẽ truncate (hiện thị total); thêm pagination khi quy mô vượt
- Join code không rate limit (chỉ Argon2 verify chậm) — cân nhắc ở Sprint 08 cùng edge limit
- CSP chỉ Report-Only; enforce + HSTS chờ domain/HTTPS thật (Sprint 08)
- Quota check count-then-insert vẫn không transaction (debt Sprint 05); scoring synchronous đọc lại ground truth mỗi lần; leaderboard aggregate in-memory — giữ nguyên, đo trước khi scale
- Modal chưa có focus trap đầy đủ (chỉ focus ban đầu + Escape + restore); tab keyboard arrows chưa implement — polish sau nếu cần
- Deadline gating frontend chỉ re-evaluate khi re-render (tab để qua deadline cần refresh)
- `SESSION_SECRET` trong `.env.example` không dùng (ADR-008) — giữ nguyên để tránh đổi env khi cần ký sau này
- dev_up.sh default passwords `1` (user-mandated local dev); override bằng env khi cần policy mạnh hơn
- Lint warnings set-state-in-effect/Fast Refresh là pattern hiện có, thêm admin pages cũ; không có lint error

## 12. Decisions made this sprint
- ADR-013: login limiter in-process theo identifier, 429 `RATE_LIMITED` + `Retry-After`; CSP Report-Only + Permissions-Policy; error envelope 500/405 ổn định

## 13. Preconditions for next sprint
- Sprint 08 có stable RC local stack + docs đồng bộ
- Cần chuẩn bị trước Sprint 08: GCE VM, domain, Cloudflare Tunnel token, production `.env` (danh sách trong `docs/DEPLOYMENT.md`)

## 14. Exact next sprint
- `plans/sprints/SPRINT_08_PRODUCTION_GCE_DOCKER_CLOUDFLARE_DEPLOY.md`

## 15. Handoff notes for the next AI agent
- Giữ limiter theo ADR-013; nếu Sprint 08 chạy nhiều API worker hoặc cần IP-key, phải quyết định lại (external store hoặc Nginx/Cloudflare edge)
- CSP Report-Only: khi enforce ở Sprint 08, kiểm tra console violations trên domain thật trước; HSTS bật sau khi HTTPS ổn định
- Không expose thêm participant data; mọi error mới phải vào `docs/API_CONTRACT.md` §6
- Dev-up passwords yếu là chủ đích local; không "fix" mà không hỏi user

---

Rules:
- Không ghi suy đoán.
- Không ghi secret.
- Nếu một chức năng đang partial, nói rõ partial ở đâu.
- Mỗi endpoint/schema đã thay đổi phải đồng bộ sang contract file.
