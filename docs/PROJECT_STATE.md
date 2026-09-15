# AI Challenge Platform - Current Project State

## 1. Current checkpoint
- Last completed sprint: SPRINT_03
- Date: 2026-09-15
- Branch: main
- Commit/working tree status: sprint 03 (competition core & admin) chuẩn bị commit
- Overall state: green — 48 backend tests + 16 frontend tests pass; end-to-end qua Docker vẫn chưa verify được (user nkd thiếu group docker, xem mục 11)

## 2. Implemented capabilities
- Sprint 01 (giữ nguyên): FastAPI skeleton, `GET /api/health`, React shell strict TS, Nginx, Docker Compose web/api/mongo
- Sprint 02 (giữ nguyên): auth Argon2id + session server-side, admin accounts API + UI, bootstrap scripts
- Competition model: collection `competitions`, unique slug (`[a-z0-9-]` ≤64, immutable), status `draft|published|closed`, join_mode, primary_metric f1/precision/recall, quota 0-1000, leaderboard_visible, created_by, timestamps UTC
- Lifecycle (ADR-009): create → draft; draft → published; published → closed (terminal, không reopen). Sai transition → 422 `INVALID_TRANSITION`
- Edit rules (ADR-009): draft sửa mọi config field; published khóa `primary_metric`; closed read-only; slug/status/created_by luôn immutable
- Admin competitions API: list (gồm draft), create (409 SLUG_EXISTS, validate đầy đủ), detail by id, edit, publish, close, clone (copy config → draft mới, slug tự sinh `-copy`, KHÔNG copy status/dates/submissions/memberships)
- Participant competitions API: list published+closed (sort name), detail by slug; draft → 404 như không tồn tại; yêu cầu đăng nhập
- Frontend: Dashboard thật (comp card grid: tên, mô tả, status badge, ngày local, CTA "Vào cuộc thi"), CompetitionDetailPage shell theo slug (header meta + tab nav Tổng quan active; Đề bài/Rules/Nộp bài/Submissions/Leaderboard disabled với aria-disabled), AdminCompetitionsPage (table + create/edit modal chung, publish/close confirm modal, clone; slug khóa khi edit, metric khóa khi published)
- Admin nav: "Quản trị" (/admin/competitions) + "Tài khoản" (/admin/accounts); /admin redirect competitions
- Validation date: UI dùng datetime-local (giờ local ↔ ISO UTC qua helper); backend validate start < end

## 3. Not implemented yet
- Membership/join (POST /join), Markdown content upload/render — Sprint 04
- Submissions, scoring, leaderboard — Sprint 05-06
- Login rate limiting — defer Sprint 07
- Hardening, production deploy — Sprint 07-08

## 4. Repository structure that matters
- `backend/app/competitions/`: `service.py` (model, validate_create/validate_update, public_competition, ISO helpers), `admin_router.py` (list/create/detail/edit/publish/close/clone), `router.py` (participant list/detail)
- `backend/tests/`: mới `test_competitions_admin.py` (13), `test_competitions_public.py` (5)
- `frontend/src/api/competitions.ts`: types Competition + labels (STATUS/JOIN_MODE/METRIC) + formatLocal/isoToLocalInput/localInputToIso/statusClass
- `frontend/src/pages/`: mới `DashboardPage.tsx`, `CompetitionDetailPage.tsx`, `AdminCompetitionsPage.tsx` (+ 3 file test tương ứng); `Placeholders.tsx` chỉ còn NotFoundPage
- CSS mới trong `index.css`: .comp-list/.comp-card*/.comp-meta*/.comp-header*/.tab-nav/.tab-link(.disabled)/.comp-body, .status-badge.closed, .btn-danger, .modal-lg, .checkbox-field/.checkbox-label, .form-field-wide, .slug-cell, .back-link, .text-muted
- `frontend/src/components/ui.tsx`: bỏ Placeholder component (không còn dùng)

## 5. Runtime/services
- web/api/mongo như Sprint 01-02; không đổi compose

## 6. Current API contract summary
- `GET /api/competitions`, `GET /api/competitions/{slug}`: implemented (Sprint 03)
- `GET|POST /api/admin/competitions`, `GET|PATCH /api/admin/competitions/{id}`, `POST /api/admin/competitions/{id}/publish|close|clone`: implemented (Sprint 03)
- Auth + admin accounts như Sprint 02. Chi tiết: `docs/API_CONTRACT.md`

## 7. Current data model and indexes
- `competitions`: implemented — unique slug, status, join_mode, join_code_hash (None Sprint 03), primary_metric, quota_per_day, leaderboard_visible, created_by, timestamps. Chi tiết: `docs/DATA_MODEL.md` §3
- accounts/sessions như Sprint 02

## 8. Environment variables in use
- Không đổi so với Sprint 02 (APP_ENV, MONGO_*, MAX_UPLOAD_MB, DATA_DIR, SESSION_*)

## 9. Commands verified
- `cd backend && .venv/bin/pytest` — 48 passed
- `cd frontend && npm test` — 16 passed; `npm run build` — pass (strict TS); `npm run lint` — pass (warnings cosmetic: fast-refresh, set-state-in-effect pattern fetch-on-mount)
- `docker compose config --quiet` — pass

## 10. Tests currently passing
- backend: 48 (health 4, passwords 4, auth 10, admin accounts 12, competitions admin 13, competitions public 5)
- frontend: 16 (login 3, protected routes 4, dashboard 3, competition detail 3, admin competitions 3)
- integration qua Nginx: chưa chạy được (Docker permission)

## 11. Known issues / technical debt
- Docker permission máy dev: end-to-end qua Nginx (tạo competition thật, publish, participant thấy) chưa verify — chạy `./scripts/dev_up.sh` từ terminal user
- Lint warnings set-state-in-effect: pattern fetch-on-mount tiêu chuẩn, chỉ là cảnh báo static analysis của oxlint
- Admin list competitions chưa phân trang (số lượng kỳ thi nhỏ, ~vài chục — đủ cho MVP; thêm khi cần)
- clone endpoint dùng `service._SLUG_MAX` (private) — chấp nhận trong cùng package

## 12. Decisions made this sprint
- ADR-009 (docs/DECISIONS.md): competition lifecycle draft→published→closed terminal; edit rules theo status; clone copy config only; participant không thấy draft (404)

## 13. Preconditions for next sprint
- Sprint 04 (content & membership) cần: competition core stable (đã có); tạo dữ liệu competition thật qua admin UI hoặc API khi stack lên

## 14. Exact next sprint
- `plans/sprints/SPRINT_04_MARKDOWN_CONTENT_AND_JOIN.md`

## 15. Handoff notes for the next AI agent
- Competition access pattern: participant qua `find_competition_by_slug` + check status; admin qua `_get_competition_or_404(db, id)` trong `admin_router.py`
- Validation: dùng `service.validate_create`/`validate_update` (raise ValueError → router map 422 VALIDATION_ERROR với message tiếng Việt)
- Representation API: mọi response competition qua `service.public_competition` — không bao giờ lộ join_code_hash
- Frontend: datetime form dùng `isoToLocalInput`/`localInputToIso` từ `api/competitions.ts`; status badge qua `statusClass` (published=success, closed=muted, draft=warning)
- Tab disabled ở CompetitionDetailPage là `<span role="tab" aria-disabled>` — khi Sprint 04/05 thêm nội dung, đổi thành NavLink + route con dưới `/competitions/:slug/*`
- Test backend: fixture `client` seed sẵn admin@vku.vn + thi.sinh@vku.vn; pattern tạo competition trong test: POST /api/admin/competitions với `_body()`

---

Rules:
- Không ghi suy đoán.
- Không ghi secret.
- Nếu một chức năng đang partial, nói rõ partial ở đâu.
- Mỗi endpoint/schema đã thay đổi phải đồng bộ sang contract file.
