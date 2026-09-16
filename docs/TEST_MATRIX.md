# Test Matrix - AI Challenge Platform

Ma trận test theo chức năng. `Status`: `planned` (chưa có test), `passing` (test tồn tại và pass), `failing` (test tồn tại nhưng fail). Cập nhật cuối mỗi sprint.

## 1. Bootstrap / repo hygiene (Sprint 00)

| Check | Status | Cách verify |
|---|---|---|
| Không có secret/credential hard-code trong repo | passing | `grep -rIiE "(password|secret|token|api[_-]?key)\s*[:=]\s*['\"]?[A-Za-z0-9+/]{16,}" --exclude-dir=plans --exclude-dir=.git .` không match giá trị thật |
| `.env` bị gitignore, `.env.example` không chứa secret thật | passing | `git check-ignore .env` + review `.env.example` |
| Docs links/paths hợp lệ | passing | Review thủ công các tham chiếu `plans/...`, `docs/...` |

## 2. Health / local stack (Sprint 01)

| Check | Status | Cách verify |
|---|---|---|
| `GET /api/health` trả 200 khi Mongo reachable | passing | `backend/tests/test_health.py` (TestClient, mock ping) |
| Health degraded 503 khi Mongo unreachable | passing | `backend/tests/test_health.py` |
| 404 API trả error format contract | passing | `backend/tests/test_health.py` |
| Frontend build thành công (strict TS) | passing | `cd frontend && npm run build` |
| `docker compose config` hợp lệ | passing | `docker compose config --quiet` |
| `docker compose up` chạy web+api+mongo | passing | `docker compose up -d --no-deps --force-recreate api web`; Mongo container healthy |
| curl `/api/health` qua Nginx same-origin | passing | `curl --fail http://localhost:8080/api/health` → `status=ok`, Mongo reachable |
| Mongo không publish public | passing | `docker-compose.yml`: mongo chỉ `expose 27017`, không có `ports` |
| Nginx không serve `/data` | passing | `frontend/nginx.conf`: `location /data/ { return 404; }` |

## 3. Auth & accounts (Sprint 02)

| Check | Status | Cách verify |
|---|---|---|
| Login đúng → cookie + `/auth/me` safe fields | passing | `backend/tests/test_auth.py` (mongomock-motor) |
| Login sai → 401 generic, sai email/sai password trả cùng response | passing | `backend/tests/test_auth.py` |
| Disabled account: login 403 + session hiện có bị từ chối | passing | `backend/tests/test_auth.py` |
| Logout hủy session server-side, idempotent | passing | `backend/tests/test_auth.py` |
| Session hết hạn bị từ chối (kể cả khi doc còn trong DB) | passing | `backend/tests/test_auth.py` |
| Argon2id hash password, không plaintext; verify đúng/sai; malformed hash không crash | passing | `backend/tests/test_passwords.py` |
| DB lưu sha256(token), không lưu raw token | passing | `backend/tests/test_auth.py::test_db_stores_token_hash_not_raw_token` |
| Admin API role guard: 401 chưa login, 403 participant | passing | `backend/tests/test_admin_accounts.py` |
| Admin create/duplicate 409/weak password 422/invalid role 422 | passing | `backend/tests/test_admin_accounts.py` |
| Admin reset password: mật khẩu cũ hết dùng, mới login được | passing | `backend/tests/test_admin_accounts.py` |
| Admin disable: session chết ngay + login bị chặn; không tự disable chính mình | passing | `backend/tests/test_admin_accounts.py` |
| Password policy (≥10 ký tự, không space đầu/cuối) | passing | `backend/tests/test_passwords.py` |
| Login form: error message, loading state, không có link đăng ký | passing | `frontend/src/pages/LoginPage.test.tsx` (vitest) |
| Protected routes: chưa login → /login; participant → không vào admin | passing | `frontend/src/auth/RequireAuth.test.tsx` |
| Login end-to-end qua Nginx với Mongo thật + cookie | passing | Sprint 05 isolated smoke đăng nhập admin + participant và gọi API authenticated qua Nginx |
| Bootstrap scripts tạo admin/import thật với Mongo | planned | Docker hoạt động; script bootstrap không được chạy lại trong Sprint 05 |
| Login rate limiting | planned | Defer Sprint 07 (sprint file cho phép) |

## 4. Competition core & admin (Sprint 03)

| Check | Status | Cách verify |
|---|---|---|
| Admin competition API role guard: 401 chưa login, 403 participant | passing | `backend/tests/test_competitions_admin.py` |
| Create: defaults draft, created_by, validation slug/dates/metric/quota/join_mode/name | passing | `backend/tests/test_competitions_admin.py` |
| Slug unique: 409 SLUG_EXISTS | passing | `backend/tests/test_competitions_admin.py` |
| List admin gồm cả draft; detail by id; 404 unknown id | passing | `backend/tests/test_competitions_admin.py` |
| Edit rules: draft sửa được, slug/status immutable; published khóa primary_metric; closed từ chối | passing | `backend/tests/test_competitions_admin.py` |
| Publish/close transition đúng; sai trạng thái 422 INVALID_TRANSITION | passing | `backend/tests/test_competitions_admin.py` |
| Clone: copy config, draft mới, slug -copy, không copy status/submissions | passing | `backend/tests/test_competitions_admin.py` |
| Participant list chỉ thấy published/closed, không lộ join_code | passing | `backend/tests/test_competitions_public.py` |
| Draft detail → 404 như không tồn tại | passing | `backend/tests/test_competitions_public.py` |
| Public API yêu cầu đăng nhập (401) | passing | `backend/tests/test_competitions_public.py` |
| Dashboard render từ API, empty state, error state | passing | `frontend/src/pages/DashboardPage.test.tsx` |
| Competition detail load theo slug động; content/submit enabled, các tab Sprint 06 disabled aria-disabled | passing | `frontend/src/pages/CompetitionDetailPage.test.tsx` |
| Admin form: validate required, slug khóa khi edit, metric khóa khi published | passing | `frontend/src/pages/AdminCompetitionsPage.test.tsx` |
| Admin UI end-to-end qua Nginx (tạo/publish/clone thật) | planned | API create/publish đã smoke qua Nginx; thao tác browser và clone chưa chạy lại |

## 5. Markdown content & membership (Sprint 04)

| Check | Status | Cách verify |
|---|---|---|
| Render GFM (heading/table/code/link/image) + sanitize script/iframe/onerror/javascript: | passing | `frontend/src/markdown/MarkdownView.test.tsx` |
| Ảnh chỉ từ approved assets; external/data image bị loại; link ngoài rel safety | passing | `frontend/src/markdown/MarkdownView.test.tsx` |
| Path traversal/absolute/symlink escape bị chặn (content + asset) | passing | `backend/tests/test_content_storage.py`, `backend/tests/test_contents_public.py` |
| Atomic write không để temp file; UTF-8 round-trip | passing | `backend/tests/test_content_storage.py` |
| Join mode open/code/invite_only đúng policy; draft 404; closed 422 | passing | `backend/tests/test_memberships.py` |
| Join code: sai/thiếu cùng 403 generic; đúng hash verify; không lộ raw/hash | passing | `backend/tests/test_memberships.py` |
| Join idempotent; membership isolation giữa competitions | passing | `backend/tests/test_memberships.py` |
| Membership inactive không tự join lại; admin reactivate giữ joined_at | passing | `backend/tests/test_memberships.py` |
| Publish mode code chưa có code → 422 JOIN_CODE_REQUIRED | passing | `backend/tests/test_memberships.py` |
| Admin member add/list/deactivate/reactivate; chỉ participant active | passing | `backend/tests/test_memberships.py` |
| Content CRUD/reorder/upload/delete; slug collision 409; validation | passing | `backend/tests/test_contents_admin.py` |
| Upload .md guards: extension/rỗng/UTF-8/size 413; filename không thành path | passing | `backend/tests/test_contents_admin.py` |
| Asset upload sniff magic bytes; SVG/txt/fake → 422; size 413 | passing | `backend/tests/test_contents_admin.py` |
| Content visibility public/members; closed readable; draft 404 | passing | `backend/tests/test_contents_public.py` |
| Asset serve: nosniff + private cache; symlink/traversal 404 | passing | `backend/tests/test_contents_public.py` |
| Missing markdown file → 404 CONTENT_FILE_MISSING ổn định | passing | `backend/tests/test_contents_public.py` |
| Join UX states (open/code dialog/invite_only/joined/inactive/closed) | passing | `frontend/src/components/JoinControl.test.tsx` |
| Sidebar content theo order; deep-link content/:contentSlug | passing | `frontend/src/pages/CompetitionDetailPage.test.tsx` |
| Dashboard membership states từ API | passing | `frontend/src/pages/DashboardPage.test.tsx` |
| Admin content/member UI: table, actions, join code không hiện trong DOM | passing | `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |
| Upload/render E2E qua Nginx với file thật | passing | User verify thủ công: upload ảnh + `.md`, tham chiếu `assets/<name>` render thành ảnh trên participant UI |

## 6. Submission & scoring (Sprint 05) — passing

| Check | Status | Cách verify |
|---|---|---|
| Validate: empty/UTF-8, extension, cột, duplicate ID, missing/extra ID, null/invalid prediction | passing | `backend/tests/test_scoring.py`, `backend/tests/test_submissions.py` |
| F1/Precision/Recall đúng: binary perfect=1; FP/FN=0.5; macro fixture=0.5; zero-division không warning | passing | `backend/tests/test_scoring.py` (23 pure tests, scikit-learn, zero_division=0) |
| Align theo ID; reorder giữ nguyên score | passing | `backend/tests/test_scoring.py`, `backend/tests/test_submissions.py` |
| Auth + active membership + published/start/deadline enforce backend | passing | `backend/tests/test_submissions.py` |
| Quota completed/ngày UTC + quota_remaining | passing | `backend/tests/test_submissions.py` |
| Upload size dùng global `MAX_UPLOAD_MB`; filename không thành path | passing | `backend/tests/test_submissions.py` |
| Validation reject không lưu record/file | passing | `backend/tests/test_submissions.py` |
| Ground truth/config admin validate, metadata safe, lock sau score/closed | passing | `backend/tests/test_scoring_admin.py` |
| Ground truth không có public route; competition isolation | passing | `backend/tests/test_scoring_admin.py`, `backend/tests/test_submissions.py` |
| Admin UI scoring readiness/config/upload/locked | passing | `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |
| Participant UI file/rules/loading/result/error/member/readiness | passing | `frontend/src/pages/SubmissionPage.test.tsx` |
| Live API flow qua Nginx + Mongo + filesystem thật | passing | Isolated smoke: admin config/upload/publish; participant join; invalid không persist; valid reordered score 1.0; config lock; public ground truth 404; cleanup artifacts |

## 7. Leaderboard/history/export (Sprint 06) — passing

| Check | Status | Cách verify |
|---|---|---|
| My Submissions chỉ có current account/current competition, newest first, pagination và không lộ path/account id | passing | `backend/tests/test_results.py::test_my_submissions_is_scoped_paginated_newest_first_and_hides_paths` |
| Optional failed/rejected reason được serialize an toàn, không đổi policy reject của Sprint 05 | passing | `backend/tests/test_results.py::test_my_submissions_returns_safe_reason_for_compatible_failed_record` |
| Best completed submission mỗi account; competition isolation | passing | `backend/tests/test_results.py::test_leaderboard_uses_each_accounts_best_score_and_earlier_best_time` |
| Tie-break score DESC → best time ASC deterministic; current-user marker, không lộ email/account id | passing | `backend/tests/test_results.py::test_leaderboard_uses_each_accounts_best_score_and_earlier_best_time` |
| Hidden participant leaderboard trả 403 không data; admin vẫn xem được | passing | `backend/tests/test_results.py::test_hidden_leaderboard_denies_participant_but_admin_can_view` |
| Admin submission list scope competition, filter team/status, không lộ server path | passing | `backend/tests/test_results.py::test_admin_submission_list_filters_and_never_exposes_server_path` |
| XLSX mở được, đúng columns/rank/metrics/count; không email/formula/control-char crash | passing | `backend/tests/test_results.py::test_admin_xlsx_export_has_rank_values_counts_and_formula_safe_names` |
| Participant My Submissions loading/data/failed reason/empty/error UI | passing | `frontend/src/pages/MySubmissionsPage.test.tsx` |
| Participant leaderboard visible/hidden/empty + current-user highlight | passing | `frontend/src/pages/LeaderboardPage.test.tsx` |
| Competition nav routes và admin ranking/submission filter/export UI | passing | `frontend/src/pages/CompetitionDetailPage.test.tsx`, `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |

## 8. Hardening (Sprint 07) — planned

| Check | Status |
|---|---|
| Security headers cơ bản qua Nginx | planned |
| Log không chứa password/cookie/secret/ground truth | planned |
| Mongo không expose public | planned |

## 9. Production deploy (Sprint 08) — planned

| Check | Status |
|---|---|
| Docker Compose prod chạy trên GCE | planned |
| Cloudflare Tunnel serve HTTPS | planned |
| Smoke test production | planned |

## 10. Backup/restore & pilot (Sprint 09) — planned

| Check | Status |
|---|---|
| Backup + restore Mongo + /data | planned |
| Runbook pilot | planned |
