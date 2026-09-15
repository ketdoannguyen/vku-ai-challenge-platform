# AI Challenge Platform - Current Project State

## 1. Current checkpoint
- Last completed sprint: SPRINT_04
- Date: 2026-09-15
- Branch: main
- Commit/working tree status: Sprint 04 implementation complete; xem git history để biết commit SHA
- Overall state: green — 77 backend tests + 33 frontend tests pass; user đã verify thủ công upload asset + Markdown render ảnh qua UI/Nginx; full E2E cả 3 join mode chưa chạy

## 2. Implemented capabilities
- Sprint 01-03 (giữ nguyên): auth Argon2id + session server-side, admin accounts, competition CRUD/lifecycle/clone, dashboard/detail/admin UI
- Membership/join (ADR-010): `competition_memberships` unique `(competition_id, account_id)`; join modes open (idempotent)/code (Argon2id verify)/invite_only; draft 404, closed 422 JOIN_CLOSED; membership inactive chỉ admin kích hoạt lại (giữ joined_at); thiếu/sai code cùng 403 generic
- Join code: `PUT /api/admin/competitions/{id}/join-code` (8-128 ký tự, hash Argon2id, không trả raw); publish mode code chưa có code → 422 JOIN_CODE_REQUIRED
- Competition API giờ trả `membership {active, joined_at}` (batch 1 query cho list) + `join_code_configured` bool
- Admin members: list (search + pagination), add by email (idempotent, reactivate), set active
- Content: `competition_contents` metadata (title/slug/order/visibility public|members); file `<DATA_DIR>/competitions/<cid>/content/<content_id>.md` atomic write (temp+fsync+replace); read qua resolve+containment+O_NOFOLLOW; upload .md chỉ UTF-8 ≤2 MiB
- Assets: PNG/JPEG/GIF/WebP ≤2 MiB sniff magic bytes (không SVG), tên uuid4.<ext>, không DB collection; serve `/api/competitions/{slug}/assets/{name}` có authz + nosniff + private cache
- Participant content API: list sort order (lọc theo visibility), detail trả markdown inline, assets serving; closed readable; mọi endpoint yêu cầu đăng nhập
- Frontend Markdown: `react-markdown` + `remark-gfm` + `rehype-sanitize` (không rehype-raw); ảnh chỉ relative `assets/...` → `/api/...` endpoint; link ngoài noopener noreferrer
- Frontend portal: CompetitionDetailPage thành layout (header + JoinControl + tab nav + content sidebar theo order + Outlet); route `/competitions/:slug` (index overview) + `content/:contentSlug`; Dashboard card dùng JoinControl (cập nhật local sau join, không reload)
- Admin UI: `/admin/competitions/:id` 3 tab — Nội dung (table, thêm/sửa modal, upload/thay .md, ↑↓ reorder, xóa), Assets (upload, copy tham chiếu, xóa), Thành viên & mã tham gia (đặt/đổi code — chỉ hiện trạng thái, thêm member, toggle active); nút "Quản lý" từ list
- ErrorBox bugfix (trước sprint 04, cùng tree): trả null khi error null — hết alert "Đã xảy ra lỗi không xác định." trên mọi trang

## 3. Not implemented yet
- Submissions/scoring/leaderboard/export — Sprint 05-06
- Login rate limiting — defer Sprint 07
- Hardening, production deploy — Sprint 07-08
- Clone competition không copy content/assets/memberships (tiếp tục defer, ghi trong ADR-010)

## 4. Repository structure that matters
- `backend/app/memberships/`: `service.py` (collection, ensure/get/batch/ensure_membership idempotent/set_active, public_membership, member_view), `router.py` (POST join), `admin_router.py` (join-code, members CRUD)
- `backend/app/content/`: `storage.py` (paths, ensure_within, write_atomic, read_bytes, validate_asset magic bytes), `service.py` (metadata CRUD + validate + reorder body), `admin_router.py` (contents + assets endpoints), `router.py` (participant contents/assets)
- `backend/app/core/slugs.py`: slug regex dùng chung competitions + content
- `backend/tests/`: mới `test_memberships.py` (11), `test_content_storage.py` (6), `test_contents_admin.py` (6), `test_contents_public.py` (6)
- `frontend/src/markdown/`: `MarkdownView.tsx` + test (4)
- `frontend/src/api/contents.ts`: ContentSummary/Detail + fetch helpers
- `frontend/src/api/client.ts`: thêm `del`, `put`, `upload` (PUT multipart), `postFile` (POST multipart)
- `frontend/src/components/JoinControl.tsx` + test (6): 5 trạng thái + code dialog
- `frontend/src/pages/`: `CompetitionContentPanel.tsx` (Overview + ContentPanel), `AdminCompetitionDetailPage.tsx` + test (4); CompetitionDetailPage/DashboardPage rewrite
- CSS mới: `.content-layout/.content-sidebar/.content-nav-item/.markdown-body/...`, `.join-state`, `.comp-header-join`, `:focus-visible`
- `.env.example`/`docker-compose.yml`: thêm `MAX_CONTENT_MB=2`, `MAX_ASSET_MB=2`

## 5. Runtime/services
- web/api/mongo như cũ; volume `data:/data` đã có sẵn từ Sprint 01 (DATA_DIR=/data trong container api)

## 6. Current API contract summary
- Participant: `GET /api/competitions`, `GET /api/competitions/{slug}`, `POST /api/competitions/{slug}/join`, `GET .../contents`, `GET .../contents/{content_slug}`, `GET .../assets/{name}` — implemented
- Admin: competitions (Sprint 03) + `PUT .../join-code`, `GET|POST .../members`, `PATCH .../members/{account_id}`, contents CRUD + `/file` + `/reorder`, assets `GET|POST|DELETE` — implemented
- Chi tiết: `docs/API_CONTRACT.md`

## 7. Current data model and indexes
- `competition_memberships`: implemented — unique compound `(competition_id, account_id)` + `account_id`
- `competition_contents`: implemented — unique `(competition_id, slug)` + `(competition_id, order)`; `markdown_path` relative, `size_bytes` nullable
- Assets: filesystem-only (không collection)
- competitions thêm `join_code_updated_at`
- Chi tiết: `docs/DATA_MODEL.md`

## 8. Environment variables in use
- Mới Sprint 04: `MAX_CONTENT_MB` (default 2), `MAX_ASSET_MB` (default 2) — `.env.example` + compose đã có
- Còn lại như Sprint 02 (APP_ENV, MONGO_*, MAX_UPLOAD_MB, DATA_DIR, SESSION_*)

## 9. Commands verified
- `cd backend && .venv/bin/pytest` — 77 passed
- `cd frontend && npm test` — 33 passed (9 files); `npm run build` — pass (strict TS); `npm run lint` — pass (warnings cosmetic set-state-in-effect/fast-refresh)
- `docker compose config --quiet` — pass

## 10. Tests currently passing
- backend: 77 (health 4, passwords 4, auth 10, admin accounts 12, competitions admin 13, competitions public 5, memberships 11, content storage 6, contents admin 6, contents public 6)
- frontend: 33 (login 3, protected routes 4, dashboard 3, competition detail 4, admin competitions 3, markdown 4, JoinControl 6, ui/ErrorBox 2, admin competition detail 4)
- integration qua Nginx: user đã verify upload ảnh + `.md` và render ảnh trên participant UI; full flow cả 3 join mode chưa verify

## 11. Known issues / technical debt
- Full E2E open/code/invite_only qua Nginx chưa verify; riêng upload ảnh + `.md` và render ảnh đã được user kiểm tra thành công
- Lint warnings set-state-in-effect: pattern fetch-on-mount, cosmetic
- Asset list đọc directory mỗi request (số lượng nhỏ MVP — chấp nhận; thêm collection nếu phình)
- Join code không có rate limit (defer Sprint 07 như login)
- Reorder tuần tự update_one không transaction (single-writer admin, chấp nhận — ghi trong ADR-010)

## 12. Decisions made this sprint
- ADR-010 (docs/DECISIONS.md): slug participant routes, join policies (closed/inactive/idempotent/generic 403), Argon2id join code, authenticated-only "public" visibility, atomic storage + path guards, raster-only assets ≤2 MiB, react-markdown+sanitize stack (không rehype-raw), clone vẫn không copy content

## 13. Preconditions for next sprint
- Sprint 05 (submissions/scoring) cần: competition có membership + content hoạt động (đã có); ground truth + scoring config là việc của Sprint 05

## 14. Exact next sprint
- `plans/sprints/SPRINT_05_SUBMISSION_VALIDATION_AND_SCORING.md`

## 15. Handoff notes for the next AI agent
- Join policy hoàn toàn ở `memberships/router.py::join_competition` — mọi thay đổi policy sửa ở đó + test
- Content path luôn qua `storage.ensure_within`; không bao giờ nối chuỗi path từ input user
- `markdown_path` trong DB là relative; resolve tại thời điểm đọc với `get_settings().data_dir` (test dùng fixture `isolated_data_dir` monkeypatch DATA_DIR + `get_settings.cache_clear()`)
- Multipart upload: `api.upload` (PUT .md file) và `api.postFile` (POST asset) trong client.ts
- Tab disabled còn lại ở CompetitionDetailPage: Nộp bài/Submissions (Sprint 05), Leaderboard (Sprint 06) — đổi thành NavLink khi có route con
- JoinControl dùng chung Dashboard card + CompetitionDetailPage header; trạng thái derive từ `competition.membership` + `join_mode` + `status`
- ErrorBox đã có null guard — không render khi không có lỗi

---

Rules:
- Không ghi suy đoán.
- Không ghi secret.
- Nếu một chức năng đang partial, nói rõ partial ở đâu.
- Mỗi endpoint/schema đã thay đổi phải đồng bộ sang contract file.
