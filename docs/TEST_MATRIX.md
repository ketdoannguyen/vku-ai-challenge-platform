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
| `scripts/dev_up.sh` smoke auth thật: login `-c` cookie jar → `/auth/me` 200 + role `admin` → `/api/admin/accounts?limit=1` 200, login sai 401 với message generic; bất kỳ lệch nào làm script exit non-zero | passing | Live run trên stack Compose; kiểm negative: bỏ cookie khỏi request → script fail (`/auth/me` 401, admin accounts 401) |
| Vite dev server proxy `/api` về Nginx (`VITE_API_PROXY_TARGET`, mặc định `http://localhost:8080`) | passing | `npm run dev`: `/api/health` 200 và login + `/auth/me` 200 qua origin Vite; đặt target sai → 502 |

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
| Admin accounts query bounds: `limit` 0/-1/201 và `offset` -1 → 422; `limit` 1/200 + offset hợp lệ → 200 | passing | `backend/tests/test_admin_accounts.py` |
| Admin accounts global stats: `stats.total/admin/participant/active` đúng, không đổi theo `q`/`limit`, cập nhật sau create/disable, account thiếu `active` tính là hoạt động | passing | `backend/tests/test_admin_accounts.py` |
| Password policy (≥10 ký tự, không space đầu/cuối) | passing | `backend/tests/test_passwords.py` |
| Login form: error message, loading state, không có link đăng ký | passing | `frontend/src/pages/LoginPage.test.tsx` (vitest) |
| Protected routes: chưa login → /login; participant → không vào admin | passing | `frontend/src/auth/RequireAuth.test.tsx` |
| Login end-to-end qua Nginx với Mongo thật + cookie | passing | Sprint 05 isolated smoke đăng nhập admin + participant và gọi API authenticated qua Nginx |
| Bootstrap scripts tạo admin/import thật với Mongo | planned | Docker hoạt động; script bootstrap không được chạy lại trong Sprint 05 |
| Login rate limiting | passing | `backend/tests/test_auth.py`: 10 lần sai/15 phút theo normalized identifier, lần tiếp theo 429 `RATE_LIMITED` + `Retry-After`, login đúng reset counter; live Nginx/API smoke pass |

## 4. Competition core & admin (Sprint 03)

| Check | Status | Cách verify |
|---|---|---|
| Admin competition API role guard: 401 chưa login, 403 participant | passing | `backend/tests/test_competitions_admin.py` |
| Create: defaults draft, created_by, validation slug/dates/metric/quota/join_mode/name | passing | `backend/tests/test_competitions_admin.py` |
| Slug unique: 409 SLUG_EXISTS | passing | `backend/tests/test_competitions_admin.py` |
| List admin gồm cả draft; detail by id; 404 unknown id | passing | `backend/tests/test_competitions_admin.py` |
| Edit rules: draft sửa được, slug/status immutable; published khóa primary_metric; closed từ chối | passing | `backend/tests/test_competitions_admin.py` |
| Publish/close/reopen transition đúng; draft→close, published→publish/reopen, closed→publish/close đều 422 INVALID_TRANSITION | passing | `backend/tests/test_competitions_admin.py` |
| Reopen là hoàn tác: quyền sửa quay lại nhưng chỉ ở mức published (primary_metric vẫn khoá), và cuộc thi nhận bài trở lại chứ không chỉ đổi status | passing | `backend/tests/test_competitions_admin.py`, `backend/tests/test_submissions.py` |
| Clone: copy config, draft mới, slug -copy, không copy status/submissions | passing | `backend/tests/test_competitions_admin.py` |
| Participant list chỉ thấy published/closed, không lộ join_code | passing | `backend/tests/test_competitions_public.py` |
| Draft detail → 404 như không tồn tại | passing | `backend/tests/test_competitions_public.py` |
| Khách chưa đăng nhập đọc được list/detail, draft vẫn 404, không lộ join_code (ADR-014) | passing | `backend/tests/test_competitions_public.py` |
| Dashboard render từ API, empty state, error state | passing | `frontend/src/pages/DashboardPage.test.tsx` |
| Khách: ẩn ô "Đã tham gia", thẻ mời đăng nhập thay cho nút Tham gia | passing | `frontend/src/pages/DashboardPage.test.tsx` |
| Khách vào `/` và `/competitions/:slug` không bị đẩy về login; nút quay lại ở `/login` về được dashboard; `/submit` vẫn chặn | passing | `frontend/src/App.test.tsx` |
| Competition detail load theo slug động; đầy đủ tab Tổng quan/Nộp bài/Bài đã nộp/Bảng xếp hạng | passing | `frontend/src/pages/CompetitionDetailPage.test.tsx` |
| Admin form: validate required, slug khóa khi edit, metric khóa khi published; closed không cho sửa; client validate end > start | passing | `frontend/src/pages/AdminCompetitionsPage.test.tsx` |
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
| Khách chỉ thấy content `public`, content `members` 404; content của competition draft 404 (ADR-014) | passing | `backend/tests/test_contents_public.py` |
| Asset serve: nosniff + private cache; symlink/traversal 404 | passing | `backend/tests/test_contents_public.py` |
| Missing markdown file → 404 CONTENT_FILE_MISSING ổn định | passing | `backend/tests/test_contents_public.py` |
| Join UX states (open/code dialog/invite_only/joined/inactive/closed) | passing | `frontend/src/components/JoinControl.test.tsx` |
| Khách thấy CTA "Đăng nhập để tham gia" kèm `state.from`, không bắn POST join | passing | `frontend/src/components/JoinControl.test.tsx` |
| Sidebar content theo order; deep-link content/:contentSlug | passing | `frontend/src/pages/CompetitionDetailPage.test.tsx` |
| Tổng quan là trang thật: dừng ở `/competitions/:slug`, không tự chuyển sang tài liệu đầu tiên | passing | `frontend/src/pages/CompetitionDetailPage.test.tsx`, `frontend/src/pages/CompetitionOverview.test.tsx` |
| Tổng quan: thể lệ, quy cách bài nộp, danh sách tài liệu; lỗi mục lục chỉ hỏng khối tài liệu và có retry | passing | `frontend/src/pages/CompetitionOverview.test.tsx` |
| `submission_config` null → "Chưa cấu hình"; `pos_label` không được tiết lộ thì bỏ dòng | passing | `frontend/src/pages/CompetitionOverview.test.tsx` |
| Outline Tổng quan đúng bậc `h1 → h2 → h3×3`; landmark `nav[label="Tài liệu cuộc thi"]` | passing | Chromium headless 1280px trên `/competitions/:slug` |
| Keyboard tới được link tài liệu và cả hai CTA trong khối Tổng quan, focus ring đủ | passing | Chromium headless 1440px: Tab ×24, 0 phần tử thiếu focus ring |
| 4 route (`/`, `/competitions/:slug`, `/admin/competitions`, `/admin/competitions/:id`) không tràn body ở 375/768/1280/1440px | passing | Chromium headless: `documentElement.scrollWidth == clientWidth` ở cả 16 tổ hợp; bảng admin cuộn trong `.ac-table-scroll` |
| Trạng thái loading có `role="status"` + `aria-busy` | passing | Chromium headless, chặn API 1.5s tại `/competitions/:slug` |
| Dashboard membership states từ API | passing | `frontend/src/pages/DashboardPage.test.tsx` |
| Admin content/member UI: table, actions, join code không hiện trong DOM | passing | `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |
| Upload/render E2E qua Nginx với file thật | passing | User verify thủ công: upload ảnh + `.md`, tham chiếu `assets/<name>` render thành ảnh trên participant UI |

## 6. Submission & scoring (Sprint 05) - passing

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

## 7. Leaderboard/history/export (Sprint 06) - passing

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
| Submit disabled + lý do rõ trước giờ mở/sau deadline (frontend derive, backend vẫn enforce) | passing | `frontend/src/pages/SubmissionPage.test.tsx` |
| Admin confirm destructive actions: xóa content/asset, đổi mã tham gia, member/account active toggle, thay ground truth | passing | `frontend/src/pages/AdminCompetitionDetailPage.test.tsx`, `frontend/src/pages/AdminAccountsPage.test.tsx` |
| Admin members tải đến 200 dòng (limit=200) + thông tin chung cuộc thi ở detail | passing | `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |
| Password admin UI: type=password, minLength 10, autoComplete new-password (create + reset) | passing | `frontend/src/pages/AdminAccountsPage.test.tsx` |
| Admin accounts phân trang thật: mock >200 dòng, Trang sau/trước đổi `offset` và chặn ở biên, tài khoản thứ 201+ tới được bằng UI, đổi từ khóa reset `offset=0`, response trang cũ không ghi đè kết quả mới, trang cuối rỗng thì lùi về trang còn dữ liệu | passing | `frontend/src/pages/AdminAccountsPage.test.tsx` |
| Admin accounts UI: bốn ô thống kê đọc `stats` toàn hệ thống (không lấy 50 dòng của page đầu) và không đổi khi tìm kiếm; bảng giữ đủ 5 cột trong vùng cuộn focus được; vai trò/trạng thái luôn có nhãn chữ; admin không tự vô hiệu hóa được (nút khóa, `aria-describedby` tới lý do, không phát PATCH) | passing | `frontend/src/pages/AdminAccountsPage.test.tsx` |
| Trần upload động: admin detail + mọi response mutate trả `upload_limits`, list/public không có; env override phản ánh trong response; UI thiếu field thì rơi về `DEFAULT_UPLOAD_LIMITS`; file quá trần bị chặn ở client và không phát request | passing | `backend/tests/test_competitions_admin.py`, `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |

## 8. Hardening (Sprint 07) - passing

| Check | Status | Cách verify |
|---|---|---|
| Cookie production flags: HttpOnly, Secure (APP_ENV=production), SameSite, Path, Max-Age | passing | `backend/tests/test_auth.py::test_production_login_cookie_has_required_flags` |
| Login rate limiting (xem §3) | passing | `backend/tests/test_auth.py` + live Nginx/API smoke |
| Unhandled exception trả 500 INTERNAL_ERROR generic, không lộ traceback/detail | passing | `backend/tests/test_health.py::test_unhandled_exception_returns_safe_contract_error_without_traceback` |
| 405/404 về error envelope ổn định (METHOD_NOT_ALLOWED/NOT_FOUND) | passing | `backend/tests/test_health.py` |
| Session expired/logout/disabled/admin guard (Sprint 02 giữ nguyên) | passing | `backend/tests/test_auth.py`, `backend/tests/test_admin_accounts.py` |
| Log không chứa password/session token | passing | `backend/tests/test_auth.py::test_login_logs_do_not_include_password_or_session_token` |
| Log submission reject có stable code, không chứa giá trị CSV | passing | `backend/tests/test_submissions.py::test_rejected_submission_log_contains_code_but_not_uploaded_values` |
| Admin lifecycle/content upload/join/export đều có log an toàn (ID/email/code) | passing | Live Sprint 07 smoke log review qua `docker compose logs api` |
| Participant gọi admin API → 403; unauth → 401 | passing | `backend/tests/test_admin_accounts.py` + live smoke 403/401 |
| Cross-competition isolation (membership, ground truth, submissions) | passing | `backend/tests/test_submissions.py`, `backend/tests/test_results.py` (Sprint 05-06 giữ pass) |
| Upload guards: extension/magic bytes/size 413/filename không thành path/symlink | passing | `backend/tests/test_contents_admin.py`, `backend/tests/test_content_storage.py`, `backend/tests/test_submissions.py` (giữ pass Sprint 04-05) |
| Markdown malicious fixture không execute (script/javascript link) | passing | `frontend/src/markdown/MarkdownView.test.tsx` + live smoke: payload `<script>` render an toàn qua API |
| Security headers qua Nginx: nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, CSP Report-Only | passing | Live Sprint 07 smoke: `curl -I http://localhost:8080/` từng header |
| `/data/` không được Nginx serve; Mongo không publish public | passing | Live Sprint 07 smoke: `/data/` 404, `docker compose port mongo 27017` rỗng |
| Private ground truth không reachable qua Nginx/participant API | passing | `backend/tests/test_scoring_admin.py` + live smoke: traversal asset path và unknown ground-truth route đều 404 |
| Full E2E local MVP flow (login→create→config→GT→content→publish→join→submit→reject→quota→history→leaderboard→export) | passing | Isolated live smoke Sprint 07 qua Nginx + Mongo thật, cleanup sau chạy (xem PROJECT_STATE Commands verified) |

## 9. Vận hành cuộc thi: resources, lifecycle, privacy, UX

| Check | Status | Cách verify |
|---|---|---|
| Normalize/validate link Drive: tối đa 10 mục, label ≤120, url ≤2048, bắt buộc https, chặn host lạ/credentials | passing | `backend/tests/test_competitions_admin.py` |
| Create/edit/clear (`resources: []`)/clone resources; document legacy thiếu field trả `[]`, không cần migration | passing | `backend/tests/test_competitions_{admin,public}.py` |
| Admin detail có 6 tab theo thứ tự Nội dung → Hình ảnh → Tài nguyên → Chấm điểm → Kết quả → Thành viên; tab Tài nguyên dùng PATCH hiện tại, validate Drive/Docs, clear `[]`, giới hạn 10, giữ draft khi lỗi và khóa khi competition `closed`; dialog chỉ nhập tài nguyên khi tạo mới | passing | `frontend/src/pages/AdminCompetitionDetailPage.test.tsx`, `frontend/src/components/AdminCompetitionManagement.test.tsx`, `frontend/src/lib/competitionResources.test.ts` |
| Block "Tài nguyên tải về" nằm SAU "Mục lục nội dung" theo DOM; dùng cùng card shell VKU, badge số lượng và format đánh số; ẩn khi rỗng; link ngoài có `rel="noopener noreferrer nofollow"`; URL không hợp lệ bị FE lọc bỏ | passing | `frontend/src/pages/CompetitionDetailPage.test.tsx` |
| Payload public không có `created_by`; `pos_label` chỉ với thành viên active (guest/non-member/inactive không có key); admin vẫn nhận `created_by` | passing | `backend/tests/test_competitions_public.py` |
| Datetime naive/aware cùng instant normalize giống nhau; PATCH chỉ `start_at` hoặc chỉ `end_at` lệch thứ tự → 422 chứ không 500 | passing | `backend/tests/test_datetimes.py`, `backend/tests/test_competitions_admin.py` |
| Publish readiness: thiếu config / config invalid / thiếu ground truth / file hỏng / config+GT hợp lệ | passing | `backend/tests/test_scoring_admin.py`, `backend/tests/test_competitions_admin.py` |
| Publish thất bại giữ nguyên `draft`; join-code thiếu thắng readiness khi cả hai cùng thiếu; publish xong thì submission fixture chấm được | passing | `backend/tests/test_competitions_admin.py`, `backend/tests/test_submissions.py` |
| Admin detail trả `publish_ready`/`publish_blocked_reason`; banner + disable Publish; 422 vẫn hiện trong modal | passing | `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |
| Cổng publish không lệch nhau: detail trả `JOIN_CODE_REQUIRED` khi `join_mode=code` chưa có mã, đặt mã xong rơi xuống `SCORING_CONFIG_REQUIRED` | passing | `backend/tests/test_competitions_admin.py` |
| Upload ground truth xong banner publish biến mất + nút Publish mở khóa; banner chặn vì mã tham gia mở tab Thành viên | passing | `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |
| Join: trước `start_at` thành công; non-member sau `end_at` → `JOIN_DEADLINE_PASSED` và không tạo membership; active member sau deadline/closed vẫn idempotent; inactive vẫn 403; closed thắng deadline | passing | `backend/tests/test_memberships.py`, `frontend/src/components/JoinControl.test.tsx` |
| Quota: đúng trước/sau khi nộp, `resets_at` ISO `Z`, loại bài của ngày hôm trước, quota 0; không có key quota trên guest/non-member/inactive/list | passing | `backend/tests/test_competitions_public.py`, `backend/tests/test_submissions.py` |
| UI quota: hiện "Còn X/Y lượt", khoá form khi remaining=0, nộp xong refetch detail | passing | `frontend/src/pages/{CompetitionDetailPage,SubmissionPage}.test.tsx` |
| Leaderboard: phân trang giữ rank toàn cục, `has_more`, tham số sai → 422; `me` đúng khi ngoài page, `null` khi chưa có bài completed, không chứa account id; admin/export vẫn full list | passing | `backend/tests/test_results.py` |
| UI leaderboard: paging gửi đúng params, disable nút ở biên, card hạng `#x/y`, highlight row của mình khi nằm trong page | passing | `frontend/src/pages/LeaderboardPage.test.tsx` |
| Leave: active/inactive/chưa join/draft; bài nộp + rank còn nguyên; `joined_at` giữ khi admin reactivate | passing | `backend/tests/test_memberships.py` |
| Hard-delete member: chưa nộp → xoá và dọn file; đã có bài completed → 409 và Mongo/file/membership đều còn | passing | `backend/tests/test_memberships.py` |
| Đếm thành viên: `active_total` tách khỏi `total` (kể cả document legacy thiếu `active`) | passing | `backend/tests/test_memberships.py`, `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |
| Delete competition: thiếu/sai `confirm_slug` không xoá gì; published → 409; draft và closed cascade sạch 4 collection + 2 thư mục, không đụng competition khác/accounts/sessions; lỗi dở đường giữ competition để retry | passing | `backend/tests/test_competitions_delete.py` |
| UI xoá competition: draft và closed có action, published thì không, modal bắt gõ đúng slug, 409 hiện trong modal, xoá từ detail thì về danh sách | passing | `frontend/src/pages/{AdminCompetitionsPage,AdminCompetitionDetailPage}.test.tsx` |
| UI mở lại: chỉ closed có nút/menu Mở lại, modal xác nhận gọi POST `/reopen` (chưa bấm xác nhận thì chưa gọi), Sửa vẫn khoá khi đang closed | passing | `frontend/src/pages/{AdminCompetitionsPage,AdminCompetitionDetailPage}.test.tsx` |
| Countdown sống: nhãn ngày/`HH:MM:SS`, mốc đúng biên 1 ngày, hết hạn trả null, dọn timer khi unmount, resync khi tab visible, clock dùng chung lấy nhịp theo deadline gần nhất | passing | `frontend/src/lib/countdown.test.ts`, `frontend/src/hooks/useCountdown.test.tsx` |
| Dashboard/chi tiết: mọi thẻ đang mở cùng nhảy nhãn theo clock cấp trang; thẻ hết hạn vẫn hiện nhưng không còn chip | passing | `frontend/src/pages/{DashboardPage,CompetitionDetailPage}.test.tsx` |

## 9b. Dashboard VKU: theme theo vị trí, thống kê động, responsive

Contract đầy đủ ở `DESIGN.md`. Quy tắc gốc: màu thẻ theo **vị trí trong lưới đang render**
(`index % 3`), không theo trạng thái cuộc thi.

| Check | Status | Nguồn |
|---|---|---|
| Theme xoay vòng theo index render: `blue,red,yellow,blue,red`; 5 cuộc thi → đúng 5 card, không filler | passing | `frontend/src/pages/DashboardPage.test.tsx` |
| Theme độc lập status: cuộc thi `closed` ở index 1 vẫn `data-theme="red"`; root card không mang class trạng thái; badge vẫn `closed` + nhãn "Đã kết thúc" | passing | `frontend/src/pages/DashboardPage.test.tsx` |
| Search/filter còn 1 kết quả → theme tính lại theo vị trí mới (xanh); count theo `filtered.length` | passing | `frontend/src/pages/DashboardPage.test.tsx` |
| Vùng thống kê `aria-label="Thống kê cuộc thi"` lấy số từ dữ liệu API; khách ẩn ô "Đã tham gia" | passing | `frontend/src/pages/DashboardPage.test.tsx` |
| Outline tiêu đề: một `h1`, section `h2`, tiêu đề thẻ `h3`; trạng thái rỗng không sinh `article` | passing | `frontend/src/pages/DashboardPage.test.tsx` |
| Responsive 1/2/3 cột tại 375/768/1200/1440/1920; hàng 2 chỉ 2 card (ô 6 trống); không tràn ngang; card ≥ 285px; footer căn đáy | passing | Chromium headless, `/tmp/uiverify/vku-dash-verify.mjs` |
| Card `closed` ở cột 2: header vẫn gradient đỏ `rgb(211,11,35)`, badge nền `#F1F5F9` chữ `#475569` | passing | Chromium headless |
| Focus ring 2px trên search/link/CTA; touch target 44px; reduced-motion tắt translate; hover thường `translateY(-2px)`; `color-scheme: light` | passing | Chromium headless |
| Navbar: logo `/vku-logo.png` đúng tỉ lệ 58×30, header cao đúng 64px, nav active xanh VKU; route khác vẫn trần 1280px | passing | Chromium headless |
| Danh sách không có nút "Rời cuộc thi": thẻ đã tham gia chỉ còn "Đã tham gia" + link "Vào cuộc thi" (`showLeave={false}`); trang chi tiết giữ nút rời dạng danger-ghost đỏ và modal xác nhận danger | passing | `frontend/src/pages/{DashboardPage,CompetitionDetailPage}.test.tsx`, `frontend/src/components/JoinControl.test.tsx` |
| Hàng toolbar giãn hết bề ngang panel từ 48rem: mép phải ba nút lọc trùng mép phải ô thống kê "Đã tham gia" ở 375/768/1024/1200/1440/1920, không tràn ngang | passing | Chromium headless, `/tmp/uiverify/vku-toolbar.mjs` |

## 9c. Remediation audit 2026-09-17 (P0/P1/P2)

Nguồn finding và thứ tự wave: `.claude/plans/2026-09-17-remediation-audit-p0-p1-p2.md`. Mỗi dòng là một finding đã
sửa, kèm cả test tự động và (khi hành vi chỉ chứng minh được trên trình duyệt thật) oracle headless.

| Check | Status | Nguồn |
|---|---|---|
| Drawer mobile là modal thật: `role="dialog"` + `aria-modal`, `#root` inert, khóa/khôi phục scroll body, trap Tab/Shift+Tab, Escape/overlay/close trả focus về hamburger; link điều hướng đóng drawer rồi route-focus tiếp quản | passing | `frontend/src/App.test.tsx` + Chromium headless 375px `/tmp/uiverify/w1-3-browser.mjs` (Tab ×20 không thoát drawer) |
| Bốn upload picker dùng được bằng bàn phím: nút native focusable + `input[type=file]` ẩn; chọn lại cùng file vẫn chạy; disabled/busy áp cho cả nút và input; validation cũ không đổi | passing | `frontend/src/pages/{SubmissionPage,AdminCompetitionDetailPage}.test.tsx` |
| Clone slug luôn hợp lệ, ≤64 ký tự, không trùng nguồn; `DuplicateKeyError` retry có bound rồi trả 409 `SLUG_EXISTS` thay vì 500 | passing | `backend/tests/test_competitions_admin.py` |
| Export XLSX qua `api.download`: object URL được revoke trong `finally`, filename lấy từ `Content-Disposition`; 401/404/500 ở lại SPA và hiện lỗi, không điều hướng tới JSON, không tải JSON dưới đuôi `.xlsx` | passing | `frontend/src/api/client.test.ts`, `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |
| Return-to giữ nguyên path + query + hash; `//host`, `https://…`, rỗng hoặc không phải string đều về `/` (không open redirect) | passing | `frontend/src/auth/returnTo.test.ts`, `{LoginPage,RequireAuth}.test.tsx` |
| Phân trang my submissions/leaderboard giữ bảng và pager khi tải trang mới (`aria-busy` + live status), không reset scroll hay làm rơi focus, response cũ không ghi đè kết quả mới | passing | `frontend/src/pages/{MySubmissionsPage,LeaderboardPage}.test.tsx` |
| Admin tabs theo APG manual activation: đúng một `tabIndex=0`, Arrow/Home/End đổi focus, Enter/Space mới đổi panel, chỉ tab đang chọn có `aria-controls` (không dangling), `aria-orientation` theo rail | passing | `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |
| Modal mở từ row menu trả focus về đúng nút "Thao tác cho …" khi hủy và khi Escape | passing | `frontend/src/pages/AdminCompetitionsPage.test.tsx` |
| Route change: focus `main` sau PUSH/REPLACE, không cướp focus khi tải đầu, POP hoặc có hash | passing | `frontend/src/App.test.tsx` |
| Title theo route (kể cả nested content) và đúng một H1 ở trang lỗi; Markdown hạ cấp heading tác giả để không sinh H1 thứ hai | passing | `frontend/src/pages/*.test.tsx`, `frontend/src/markdown/MarkdownView.test.tsx` |
| Trang lỗi end-user không hiện raw error code; copy submission ID có phản hồi thành công/thất bại mà không unmount bảng | passing | `frontend/src/pages/{DashboardPage,MySubmissionsPage}.test.tsx` |
| Bảng ngang có vùng cuộn focusable `role="region"` + tên, cuộn được bằng bàn phím, `overscroll-behavior-x: contain`, không sinh tràn ngang body | passing | Chromium headless 375/768/1280 `/tmp/uiverify/w4-targets.mjs` |
| Touch target đo được: `.app-menu-toggle` 44×44, `.app-brand` 58×44 ở 375; không chồng lấn, header không đổi chiều cao | passing | Chromium headless 375/768/1280 `/tmp/uiverify/w4-targets.mjs` |
| Admin detail ở ≤767px: khối tiêu đề bám nội dung thay vì độn theo flex-basis 24rem (khoảng trống ~384px trước nhóm nút đã hết) | passing | Chromium headless 375/414/640/767/768/1280/1440 `/tmp/uiverify/w7-heading-gap.mjs` |
| Tách `react-markdown`/`remark-gfm`/`rehype-sanitize` khỏi entry bundle: entry 597 kB → 437 kB, chunk `MarkdownView` riêng, nội dung vẫn render đúng sau Suspense | passing | `npm run build` + Chromium headless 375/1440 `/tmp/uiverify/w6-shots.mjs` |

## 9d. Trang Hỗ trợ & Liên hệ (ADR-022, bố cục hai hàng theo ADR-024)

Contract trình bày ở `SUPPORT_PAGE_DESIGN.md` (điều chỉnh của repo ghi ở §79); quyết định ở ADR-022 và
ADR-024 (`docs/DECISIONS.md`). Nguồn sự thật cho wording và dữ liệu liên hệ vẫn là
`frontend/src/pages/SupportPage.tsx` và `frontend/src/lib/vkuInfo.ts`.

| Check | Status | Nguồn |
|---|---|---|
| Outline: đúng một `h1`, ba `h2` theo thứ tự `Các bước tham gia` → `Liên hệ` → `Câu hỏi thường gặp`; bước và FAQ dùng `h3` | passing | `frontend/src/pages/SupportPage.test.tsx` |
| Hàng 1 là `Các bước tham gia` chiếm trọn bề ngang (1376px@1440, bằng đúng bề ngang lưới); sáu bước trải thành lưới ô 1/2/3 cột theo mức màn, hàng cuối không hở ô | passing | `frontend/src/pages/SupportPage.test.tsx`, Chromium headless `/tmp/uv2/verify.mjs` |
| Lưới sáu bước đủ và đúng thứ tự (`Đăng nhập`, `Chọn cuộc thi`, `Tham gia cuộc thi`, `Đọc đề bài`, `Nộp bài`, `Theo dõi kết quả`); bước 2 vẫn là link nội bộ về `/` | passing | `frontend/src/pages/SupportPage.test.tsx` |
| Nhịp màu số bước `data-tone` xoay vòng `blue,red,yellow` ×2 và chỉ mang tính trang trí, không suy ra trạng thái nghiệp vụ | passing | `frontend/src/pages/SupportPage.test.tsx`, Chromium headless `/tmp/uiverify/support-verify.mjs` (`rgb(9,105,232)｜rgb(211,11,35)｜rgb(245,184,0)`) |
| Đường nối dọc giữa các marker đã bị bỏ cùng timeline: không còn pseudo-element `.support-step-marker::after` nào vẽ đường nối trong lưới bước | passing | `frontend/src/index.css`, Chromium headless `/tmp/uv2/verify.mjs` |
| FAQ đủ 9 câu hỏi nguyên văn; panel cuối vẫn nội suy tên đơn vị từ `vkuInfo.ts` | passing | `frontend/src/pages/SupportPage.test.tsx` |
| Accordion: 9 trigger là `button` native, mặc định `aria-expanded="false"`, `aria-controls` trỏ tới panel tồn tại, panel có `aria-labelledby` ngược lại và mang thuộc tính `hidden` | passing | `frontend/src/pages/SupportPage.test.tsx` |
| Accordion single-open: mở mục khác thì mục cũ đóng, bấm lại thì đóng hết; Enter/Space hoạt động; đóng/mở lại đúng trên trình duyệt thật | passing | `frontend/src/pages/SupportPage.test.tsx`, Chromium headless `/tmp/uiverify/support-verify.mjs` |
| Ba tầng liên hệ đúng thứ tự VKU → Phòng KHCN-HTQT → Hỗ trợ kỹ thuật, đúng `mailto:`/`tel:` và công khai đầu mối được uỷ quyền (Nguyễn Kết Đoàn) | passing | `frontend/src/pages/SupportPage.test.tsx` |
| `mailto:`/`tel:` không mở tab mới; hai link website giữ `target="_blank"` + `rel="noopener noreferrer nofollow"` | passing | `frontend/src/pages/SupportPage.test.tsx`, Chromium headless `/tmp/uiverify/support-verify.mjs` |
| Không còn block `Nguồn thông tin`, `Danh mục hỗ trợ`, `Cần hỗ trợ thêm?`; không `form`/`input`/`textarea`/`aside`/`nav` phụ; trang tĩnh không gọi API | passing | `frontend/src/pages/SupportPage.test.tsx`, Chromium headless `/tmp/uiverify/support-verify.mjs` |
| Sau ADR-024 `/ho-tro` là trang thứ hai không còn khối `Nguồn thông tin`: nhãn nguồn `Giới thiệu Trường` và câu `truy cập ngày` không xuất hiện ở bất kỳ đâu trên trang | passing | `frontend/src/pages/SupportPage.test.tsx` |
| Shell 1440px `.app-main-support` chỉ gắn cho đúng route `/ho-tro`; route khác không thừa hưởng | passing | `frontend/src/App.test.tsx` |
| `/ho-tro/khong-co` vẫn rơi vào 404 (không có route con) | passing | `frontend/src/App.test.tsx`, Chromium headless `/tmp/uiverify/support-verify.mjs` |
| Thứ tự responsive: dưới 1200px Hướng dẫn → Liên hệ → FAQ xếp dọc; từ 1200px hàng 1 là `Các bước tham gia` full-width, hàng 2 là `Liên hệ` (trái) ｜ `Câu hỏi thường gặp` (phải); không tràn ngang ở 375/640/768/1024/1199/1200/1440 | passing | Chromium headless `/tmp/uv2/verify.mjs` |
| Hàng 2 chia **đôi đều nhau** (`repeat(2, minmax(0, 1fr))`): đo được 556px ｜ 556px @1200 và 676px ｜ 676px @1440, lệch 0px; chiều cao hai khối 634px ｜ 611px @1440 | passing | Chromium headless `/tmp/uv2/verify.mjs` |
| Hero không bị fixed header che ở mọi breakpoint (đỉnh hero 84px > đáy header 64px) | passing | Chromium headless `/tmp/uiverify/support-verify.mjs` |
| Focus ring 2px `solid` khi điều hướng bằng bàn phím; vùng chạm trigger FAQ và chip liên hệ ≥44px | passing | Chromium headless `/tmp/uiverify/support-verify.mjs` |
| Regression: `/`, `/admin/competitions`, `/admin/accounts` giữ nguyên hero/card và không có phần tử `.support-*` rò sang | passing | `frontend/src/pages/{AdminCompetitionsPage,AdminAccountsPage,DashboardPage}.test.tsx`, Chromium headless `/tmp/uiverify/support-verify.mjs` + `/tmp/uiverify/support-admin-regression.mjs` |

## 9e. Trang Giới thiệu (ADR-023, bố cục ba hàng theo ADR-024)

Contract trình bày ở `ABOUT_PAGE_DESIGN.md` (§A.2 đã thay thế, bố cục hiện hành ở §A.2.1); quyết định ở
ADR-023 và ADR-024 (`docs/DECISIONS.md`). Nguồn sự thật cho wording và dữ kiện vẫn là
`frontend/src/lib/vkuInfo.ts` (page không hardcode dữ kiện).

| Check | Status | Nguồn |
|---|---|---|
| Outline: đúng một `h1` `Giới thiệu` và ba `h2` theo thứ tự `Về nền tảng AI Challenge` → `VKU - đơn vị chủ trì` → `Đơn vị và đầu mối hỗ trợ` | passing | `frontend/src/pages/AboutPage.test.tsx`, Chromium headless `/tmp/uv2/verify.mjs` |
| Ba khối là ba hàng full-width - đo @1440 cả ba section rộng đúng 1376px bằng bề ngang `.about-grid`, không còn wrapper cột nửa `.about-col` để cân | passing | `frontend/src/pages/AboutPage.test.tsx`, Chromium headless `/tmp/uv2/verify.mjs` |
| Mỗi khối tự chia lưới con và hàng cuối luôn kín: feature 4 ô 4/2/1 cột, fact 5 ô 3/2/1 cột, unit 3 ô 3/2/1 cột; đo gap cuối hàng = 0px ở 375/640/768/1024/1199/1200/1440 | passing | `frontend/src/pages/AboutPage.test.tsx`, Chromium headless `/tmp/uv2/verify.mjs` |
| Platform card tách thành bốn feature item (`h3` + mô tả nguyên văn), giữ đủ bốn mô tả cũ | passing | `frontend/src/pages/AboutPage.test.tsx` |
| VKU card giữ nguyên list có accessible name `Thông tin VKU` với đúng năm dữ kiện theo thứ tự; câu Quyết định 15/QĐ-TTg ngày 03/01/2020 còn nguyên một text node; `Sứ mệnh` là dữ kiện duy nhất mang ô rộng (`span 2` cột: 880px = 2×434 + 12px gap @1440) | passing | `frontend/src/pages/AboutPage.test.tsx`, Chromium headless `/tmp/uv2/verify.mjs` |
| Ba đầu mối hỗ trợ đúng thứ tự VKU → Phòng KHCN-HTQT → Nguyễn Kết Đoàn; không lặp `mailto:`/`tel:` của `/ho-tro` | passing | `frontend/src/pages/AboutPage.test.tsx`, Chromium headless `/tmp/uiverify/about-verify.mjs` |
| Không thêm slogan/CTA phụ/khối bịa: còn **đúng một** link trên toàn trang (nội bộ `/ho-tro`), không `form`/`input`/`textarea`/`aside`/`nav`, trang tĩnh không gọi API | passing | `frontend/src/pages/AboutPage.test.tsx`, Chromium headless `/tmp/uv2/verify.mjs` |
| Đã bỏ hẳn khối `Bắt đầu` và khối `Nguồn thông tin`: không còn `.about-cta*`/`.about-sources*` trong DOM, không còn chuỗi `Nguồn thông tin` hay `Xem danh sách cuộc thi` | passing | `frontend/src/pages/AboutPage.test.tsx`, Chromium headless `/tmp/uv2/verify.mjs` |
| Hệ quả dữ liệu của ADR-024: `VKU_SOURCES` thu về một hằng `VKU_DEPARTMENT_URL` (dùng cho chip `Trang đơn vị` ở `/ho-tro`); kiểu `VkuSource` và ba URL còn lại đã xoá | passing | `frontend/src/lib/vkuInfo.ts` |
| Không còn markup giao diện cũ (`.page`/`.card`/`.ov-*`) lẫn phần tử `.support-*` của trang Hỗ trợ | passing | `frontend/src/pages/AboutPage.test.tsx`, Chromium headless `/tmp/uiverify/about-verify.mjs` |
| Nhịp màu viền trên ba khối `blue｜red｜yellow` (`rgb(9,105,232)｜rgb(236,22,49)｜rgb(245,184,0)`); thân card nền trắng; icon feature `blue,blue,red,yellow`; icon đầu mối hỗ trợ blue | passing | `frontend/src/index.css`, Chromium headless `/tmp/uiverify/about-verify.mjs` |
| Toàn bộ 16 SVG đều `aria-hidden="true"` + `focusable="false"`; tab order khớp thứ tự DOM; focus ring 2px `solid` | passing | `frontend/src/index.css`, Chromium headless `/tmp/uiverify/about-verify.mjs` |
| Thứ tự responsive: một cột theo đúng thứ tự đọc `Nền tảng → VKU → Đầu mối hỗ trợ` ở mọi breakpoint (ba hàng full-width ở cả 375 và 1440); không tràn ngang ở 375/640/768/1024/1199/1200/1440 | passing | Chromium headless `/tmp/uv2/verify.mjs` |
| Chiều cao ô trong cùng một lưới con đồng đều nên hàng không bị so le: feature 173px ×4, fact 102px ×5, unit 102px ×3 @1440 | passing | Chromium headless `/tmp/uv2/verify.mjs` |
| Hero không bị fixed header che ở mọi breakpoint (đỉnh hero 84px > đáy header 64px) | passing | Chromium headless `/tmp/uiverify/about-verify.mjs` |
| Shell 1440px `.app-main-about` chỉ gắn cho đúng route `/gioi-thieu`; `/ho-tro` và `/` không thừa hưởng, và không rò `about-*` sang route khác | passing | `frontend/src/App.test.tsx`, Chromium headless `/tmp/uiverify/about-verify.mjs` |
| `/gioi-thieu/khong-co` vẫn rơi vào 404 (không có route con) | passing | Chromium headless `/tmp/uiverify/about-verify.mjs` |
| Regression: `/ho-tro` giữ nguyên cấu trúc/FAQ/chip, `/` và hai màn quản trị giữ hero/card, không tràn ngang | passing | Chromium headless `/tmp/uiverify/support-verify.mjs` + `/tmp/uiverify/support-admin-regression.mjs` |

## 9f. Migrate VKU toàn frontend (một hệ thiết kế duy nhất)

Master spec ở `VKU_GLOBAL_DESIGN.md` (root), đứng trên `DESIGN.md`, `ADMIN_COMPETITIONS_DESIGN.md`,
`COMPETITION_DETAIL_DESIGN.md`, `ACCOUNT_MANAGEMENT_DESIGN.md` và source code khi mâu thuẫn visual;
source/API hiện tại vẫn thắng khi mâu thuẫn dữ liệu/nghiệp vụ. Bảng dưới map 14 route pattern
(13 pattern có tên + wildcard) × 6 breakpoint, kèm các bất biến chống tái xuất hiện UI cũ.

| Check | Status | Nguồn |
|---|---|---|
| Guard cấp nguồn: không còn utility token Tailwind chết (`flex`, `inline-flex`, `items-*`, `justify-*`, `gap-*`) trong `className` của mọi TSX, ở cả chuỗi tĩnh, template literal và nhánh điều kiện | passing | `frontend/src/test/designSystemGuard.test.ts` |
| Guard tự kiểm: glob quét được >20 file TSX (không pass rỗng nếu cú pháp glob đổi) và không gắn cờ nhầm class thật của ứng dụng (`text-muted`, `sr-only`, `btn-sm`) hay class no-op có chủ đích | passing | `frontend/src/test/designSystemGuard.test.ts` |
| Route gate: khi `/auth/me` chưa kết luận, `RequireAuth` và `RequireAdmin` cùng render boot state VKU (`role="status"` `Đang kiểm tra phiên đăng nhập...` + logo `/vku-logo.png`) và **không** điều hướng đi đâu cả | passing | `frontend/src/auth/RequireAuth.test.tsx` |
| 404: hai lối thoát đúng route (link `Về trang chính` → `href="/"`, nút `Quay lại`); icon là SVG trang trí `aria-hidden="true"`, không có emoji production | passing | `frontend/src/App.test.tsx` |
| 14 route × 6 width (375/640/768/1024/1200/1440) không route nào gây tràn ngang body | passing | Chromium headless `/tmp/uiverify/vku-global-verify.mjs` (335 check đạt, 0 fail; 3 lần chạy liên tiếp cho cùng kết quả) |
| Light-only trên toàn bộ 84 tổ hợp route × width: `color-scheme` không chứa `dark` | passing | Chromium headless `/tmp/uiverify/vku-global-verify.mjs` |
| Một màu CTA chủ đạo duy nhất `rgb(6, 79, 196)` (`--accent`) trên 60 tổ hợp có `.btn` primary; **0** `.btn` mang nền mực `rgb(11, 31, 68)`; 24 tổ hợp còn lại (trang quản trị dùng class riêng) cũng không có `.btn` nền mực | passing | Chromium headless `/tmp/uiverify/vku-global-verify.mjs` |
| Không phần tử tương tác nào (`button`, `a`, `[role=button]`, `input[type=submit]`, `.btn`) mang nền mực trên cả 14 route; nền tối chỉ còn ở `pre`/`code` Markdown (`rgb(16, 36, 70)`) đúng chủ ý của spec | passing | Chromium headless `/tmp/uiverify/probe-ink.mjs` |
| Token `--ac-*` của khu quản trị khai báo ở `:root`, không phải `.ac-page`: modal và menu ba chấm đều portal ra `document.body`, nằm ngoài cây `.ac-page`, nên token scope hẹp không giải được ở đó | passing | Chromium headless `/tmp/uiverify/probe-modals2.mjs`, `/tmp/uiverify/probe-menu-disabled.mjs` |
| Modal tạo/sửa cuộc thi (`.modal-competition-form`, portal → `body`): nút chính `Tạo`/`Lưu` nền `--accent` `rgb(6, 79, 196)` + chữ trắng, hover `--accent-strong`; không còn nền trong suốt do `var(--ac-ink)` không giải được | passing | Chromium headless `/tmp/uiverify/probe-modals2.mjs` |
| Menu ba chấm (`.ac-menu`, portal → `body`): mục bị vô hiệu hoá dùng `--ac-outline` `rgb(148, 163, 184)`, phân biệt được với mục đang bật `rgb(11, 31, 68)`; mục nguy hiểm vẫn `--danger` | passing | Chromium headless `/tmp/uiverify/probe-menu-disabled.mjs` |
| Leaderboard bị khoá: **không phát request `/leaderboard` nào**; card trắng viền trên `--vku-blue-600`, 3 sọc `vku-accent`, emblem `--vku-yellow-100`, 3 tile viền trên xanh/đỏ/vàng | passing | Chromium headless `/tmp/uiverify/vku-global-verify.mjs` |
| Leaderboard mở: đủ 7 cột, region cuộn được và focus được có `aria-label="Bảng xếp hạng"`; huy hiệu hạng `--vku-yellow-100`/`--vku-blue-100`/`--vku-red-100` kèm nhãn; hàng của người đang xem nền `--vku-blue-100` + badge `Bạn` | passing | Chromium headless `/tmp/uiverify/vku-global-verify.mjs` |
| Bài đã nộp: đủ 7 cột, `.subm-badge-best` và hàng bài tốt nhất `--vku-yellow-100`/`--vku-yellow-50`, telemetry thành công dùng `--success`, region focus được | passing | Chromium headless `/tmp/uiverify/vku-global-verify.mjs` |
| Nộp bài: icon hướng dẫn `--accent`, icon cảnh báo `--danger`; không còn `#15803d`/`#22c55e` trong DOM; dropzone và thanh hành động hiện đúng | passing | Chromium headless `/tmp/uiverify/vku-global-verify.mjs` |
| `/login`: CTA không phải mực đậm, card trắng, 3 sọc accent, logo `/vku-logo.png`; slug kỹ thuật dùng `"JetBrains Mono"` + `--info` | passing | Chromium headless `/tmp/uiverify/vku-global-verify.mjs` |
| 375px: bảng leaderboard và bài đã nộp cuộn **trong region** (`overflow-x: auto`, `overscroll-behavior-x: contain`), body không tràn | passing | Chromium headless `/tmp/uiverify/vku-global-verify.mjs` |
| Focus ring `:focus-visible` 2px `solid`; CTA chính cao 46px ≥44px | passing | Chromium headless `/tmp/uiverify/vku-global-verify.mjs` |
| Không còn hex màu hardcode trong TSX, không còn `var(--palette*)` trong TSX, không còn emoji trong `src`; chỉ còn **một** inline `style` - vị trí menu portal ở `AdminCompetitionsPage.tsx:750`, đúng ngoại lệ spec cho phép | passing | `rg` toàn `frontend/src` |
| Dọn CSS chết: 10 rule không còn consumer nào (`.page-head` + bản trong media query, `.page-subtitle`, `.form-field-wide`, `.spinner-light`, `.placeholder-note`, `.comp-header-join`, `.sub-blocked-warning-badge` + rule `svg`) và 16 custom property không ai đọc - đã xoá khỏi `index.css`; ngoặc `{}` cân bằng, không còn `var()` trỏ tới tên đã xoá, không file TSX/test nào nhắc tên đó | passing | `rg` toàn `frontend/src` (chỉ còn `.ac-page-head*` trùng chuỗi, là class sống) |
| Sau khi dọn CSS: 14 route × 6 width vẫn 335 check đạt / 0 fail; nút chính modal cuộc thi vẫn `rgb(6, 79, 196)` nền + chữ trắng; mục menu disabled vẫn `rgb(148, 163, 184)`; 0 phần tử tương tác nền mực trên 14 route | passing | Chromium headless `/tmp/uiverify/vku-global-verify.mjs`, `/tmp/uiverify/probe-modals2.mjs`, `/tmp/uiverify/probe-menu-disabled.mjs`, `/tmp/uiverify/probe-ink.mjs` |
| Kích thước CSS sau dọn (bundle production) | passing | `npm run build` → `dist/assets/index-*.css` 157.59 kB (trước dọn 159.24 kB) |
| Toàn bộ test frontend, lint và production build | passing | `npx vitest run --maxWorkers 1` → 277 passed (22 file, tất định); `npm run lint` → 0 error; `npm run build` → `tsc -b` + Vite build OK |
| Flake liên file đã biết: `CompetitionDetailPage.test.tsx > deep-link content/:contentSlug render markdown panel` - chạy song song nhiều worker thì lúc đạt lúc không (cùng một mã nguồn: đạt → fail → đạt), chạy một mình 14/14 đạt và `--maxWorkers 1` 277/277 đạt. Không liên quan tới thay đổi CSS/TSX (test này đi nhánh render markdown, không tới nhánh lỗi) | flaky, chưa sửa | `npx vitest run src/pages/CompetitionDetailPage.test.tsx`; 3 lần `npm test` liên tiếp |

Ghi chú quyết định (không suy ra được từ master spec): dự án **không cài Tailwind**, nên utility kiểu
Tailwind viết trong TSX không khớp selector nào trong `index.css` và là class chết. Guard vì vậy chặn ở
tầng nguồn TSX với allowlist hẹp 15 token đã biết, chứ không cài Tailwind, không thêm CSS linter và
không gắn cờ các class no-op có chủ đích hay class thật của ứng dụng.

## 9g. Participant Competition Module (redesign VKU)

Contract trình bày ở `PARTICIPANT_COMPETITION_DESIGN.md` (root), kế thừa `VKU_GLOBAL_DESIGN.md`; module
gồm bốn route con dùng chung một shell `CompetitionDetailPage`. Bảng dưới là bằng chứng thu được từ
Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` (5 route × 7 width + leaderboard ẩn +
guest = 37 lượt đo, `FAILED: none`) và từ test tự động.

| Check | Status | Nguồn |
|---|---|---|
| Một `h1` duy nhất ở masthead trên cả 37 lượt đo; workspace title là `h2` | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Tab navigation là `<nav>` (`tabNavTag=NAV` ở mọi lượt), không có `role="tablist"`/`role="tab"` nào (`tablistCount=0`) | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| `aria-current="page"` có mặt đúng chỗ: 1 ở ba workspace (tab đang mở), 2 ở route nội dung (tab **và** mục lục `Mục lục nội dung`) | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Một khung duy nhất `68rem` (1088px) cho cả bốn tab: `.comp-page` rộng 339/354/604/704/960/**1088/1088** tương ứng 375/390/640/768/1024/1200/1440; breadcrumb, masthead và tab bar (`chrome`) luôn **bằng đúng** chiều rộng khung ở cả 7 width | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Không phần tử nào thoát khỏi khung: `outsideFrame` rỗng ở cả 35 lượt đo có `.comp-page` (chỉ bỏ qua vùng cuộn ngang có chủ đích) - đây là phép đo trực tiếp lỗi "chữ tràn ra ngoài lề" | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Trần rộng không rò sang route khác: `.app-main` đo được **1280px** ở 1440 trên cả bốn tab, và `App.tsx` không còn class shell rộng nào cho `/competitions/*` (`rg app-main-participant` → 0 kết quả) | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` (`mainWidth`), `rg` toàn `frontend/src` |
| Không tràn ngang body ở cả 37 lượt: `documentElement.scrollWidth == viewport`, danh sách phần tử tràn rỗng, không page error | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Chiều rộng bảng dữ liệu trong khung 1088px: `Bảng bài đã nộp` cuộn trong ở 375/390/640/768/1024 (`scrollsX=true`), vừa khung từ 1200; `Bảng xếp hạng` cuộn trong ở 375/390/640/768; `Bảng dữ liệu` (Markdown) vừa khung ở mọi width - body vẫn không tràn | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Masthead dùng đúng công thức mặt `.ac-page-head` của trang quản trị cuộc thi: gradient `135deg` trắng → `--vku-blue-50`, ribbon `::before` chéo lam/đỏ/vàng góc phải, kèm `.comp-brand-accent` ba sọc lam–đỏ–vàng dưới mô tả | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` + ảnh `/tmp/uiverify/shots-participant/` |
| Dải quy định Nộp bài: **4** thẻ `.sub-spec-item` với icon trang trí `aria-hidden`, màu icon xoay lam/đỏ/vàng theo vị trí (`rgb(9,105,232)` / `rgb(236,22,49)` / `rgb(180,83,9)` / `rgb(9,105,232)`) - đo giống nhau ở cả 7 width | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Thanh hạn mức full-width dưới 4 thẻ: với `quota = 4/5` đo được `width: 80%`, `data-level="ok"`, nền `rgb(16, 185, 129)` (`--success-bright`), nhãn `Còn 4/5 lượt hôm nay`; track thật sự trải hết hàng (536/596/461/247 px ở 1440/768/1024/375 = bề ngang ribbon trừ padding) và fill bằng đúng 80% track - giống nhau ở cả 7 width | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Bốn thẻ quy định chia đúng 4 cột bằng nhau (`grid-template-columns` tính ra `131.875px × 4` ở 1440, `127.5px × 2` ở 375), đủ chỗ để `Binary` và `positive label: 1` xuống hai tầng theo thiết kế thay vì ngắt dòng giữa câu | passing | Chromium headless `/tmp/uiverify/measure-strip.mjs` |
| Ngưỡng màu thanh hạn mức: `4/5` → `ok`; `1/5` → `low`; `0/5` → `empty` + rộng `0%`; khi backend không trả `quota` thì **không vẽ thanh** (`.sub-quota-track` là `null`) và chỉ còn câu `5 lượt/ngày` | passing | `frontend/src/pages/SubmissionPage.test.tsx` (10 test) |
| `color-scheme: light` trên cả 37 lượt (kể cả guest và leaderboard ẩn); không có dark mode | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Guest (401 ở `/auth/me`) vẫn vào được `/competitions/:slug`, render đúng 1 `h1`, không tràn ngang | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Ba region bảng có tên và focus được: `Bảng dữ liệu`, `Bảng bài đã nộp`, `Bảng xếp hạng` - đều `tabindex=0` | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Keyboard đi được tới region bảng Markdown kèm focus ring thật `2px solid rgb(6, 79, 196)`; `subm-id-copy-btn` (Sao chép ID), `Chọn file CSV`, tab links và nút pager đều nhận focus và có outline hiển thị | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` (`probeKeyboard`, 45 lần Tab ở 1440) |
| Thứ tự tab khớp DOM: skip link → brand → nav → đăng xuất → breadcrumb → vào/rời cuộc thi → bốn tab → nội dung workspace | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Chiều cao control đo được ở 1440: `.btn` chính/phụ 40–41px (spec toàn cục "control thường 40–42px"), nút toolbar/pager 32px, nút copy icon 24px - đúng như baseline các trang khác, không phát sinh control cao bất thường | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` (`btnHeights`) |
| Leaderboard ẩn: **không request `/leaderboard` nào** phát ra (log chỉ có competition, `/auth/me`, `/contents`); card khoá render thay bảng | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Leaderboard mở: có request `/leaderboard`, bảng 7 cột nằm trong region `Bảng xếp hạng`; `Trang trước`/`Trang sau` nằm **ngoài** region cuộn | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Markdown runtime: `h2` có vạch trái `4px rgb(9, 105, 232)`; blockquote gradient `rgb(245,249,255) → rgb(255,251,235)`; inline code `rgb(211, 11, 35)`; `hr` là gradient; `script`/`iframe` trong nội dung = 0; link ngoài `rel="noopener noreferrer"` | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs` |
| Ảnh Markdown chỉ nhận asset same-origin: `src` render thành `/api/competitions/ai-challenge-2026/assets/diagram.png` | passing | Chromium headless `/tmp/uiverify/participant-redesign-verify.mjs`, `frontend/src/markdown/MarkdownView.test.tsx` |
| Heading tác giả hạ một bậc: `#` → `h2`, không sinh `h1` thứ hai trong Markdown | passing | `frontend/src/markdown/MarkdownView.test.tsx` |
| Blockquote, inline code ngoài `pre`, và `hr` render đúng phần tử để CSS VKU bám vào | passing | `frontend/src/markdown/MarkdownView.test.tsx` |
| Bảng GFM vẫn nằm trong region có tên, `tabindex=0`, giữ ngữ nghĩa `table` | passing | `frontend/src/markdown/MarkdownView.test.tsx` |
| XSS: `script`, `iframe`, handler `onerror`, `javascript:` đều không sống sót | passing | `frontend/src/markdown/MarkdownView.test.tsx` |
| Ảnh external/`data:`/traversal bị loại, chỉ `assets/...` same-competition được transform | passing | `frontend/src/markdown/MarkdownView.test.tsx` |
| Full frontend gate sau thay đổi khung, masthead và dải quy định | passing | `npx vitest run --maxWorkers 1` → **291 passed (23 file)**; `npm test` (song song) dao động 289–291 do flake ở ghi chú dưới; `npx tsc -b --force` → exit 0; `npm run lint` → 0 error (22 warning có sẵn, không phát sinh mới); `npm run build` → OK, chunk `MarkdownView-CE0sU9dR.js` 159.71 kB vẫn tách riêng khỏi entry `index-CSYoikAK.js` |
| Dọn CSS chết: `.submission-rules` + `.submission-rules > span` (rule cũ ép dải quy định thành flex-wrap và ghi đè `display: grid` của `.sub-specs-strip`, khiến bốn thẻ co theo nội dung) đã xoá khỏi `index.css`; `rg` xác nhận không còn file nào nhắc tên | passing | `rg submission-rules frontend/src` (0 kết quả) |
| Dọn dead code: `.comp-body.comp-body-workspace { width: 100% }` là rule no-op sau khi khôi phục card - đã xoá cùng class `comp-body-workspace` khỏi `CompetitionDetailPage.tsx` (`.content-layout.is-workspace` vẫn giữ vì nó thật sự bỏ cột sidebar) | passing | `rg comp-body-workspace frontend/src` (0 kết quả); `npx tsc -b --force` exit 0 |
| Backend regression (UI migration không kéo theo contract break) | passing | `uv run pytest -q` → 190 passed |
| Repo hygiene | passing | `git diff --check` → exit 0 |

Ghi chú: `npm test` chạy mặc định song song vẫn còn flake liên file đã ghi ở mục 9f
(`CompetitionDetailPage.test.tsx > deep-link content/:contentSlug render markdown panel`, dòng 219),
thỉnh thoảng lan sang `AdminCompetitionDetailPage.test.tsx > findByText("Đề bài")` - cùng một họ test
(panel Markdown lazy render: `findBy*` hết thời gian chờ khi 23 worker tranh nhau). Cùng một mã nguồn
cho ra 291/291 rồi 290/291 rồi 289/291 ở ba lần chạy liên tiếp, trong khi `--maxWorkers 1` luôn
291/291 và chạy riêng file đó luôn 14/14. Không phải lỗi do thay đổi CSS/TSX trong mục này.

Nút copy ID cao 24px và nút toolbar/pager 32px là kích thước có sẵn của design system, không thay
đổi trong lần redesign này - ghi đúng số đo, không suy diễn thành ≥44px.

## 9h. Dialog Tạo/Sửa cuộc thi (redesign VKU)

Hợp đồng: `CREATE_COMPETITION_DIALOG_DESIGN.md`. Phạm vi chỉ presentation:
`CompetitionFormModal` trong `AdminCompetitionManagement.tsx` + block CSS `.modal-competition-form`/`.ac-form*`.
Không đổi API, payload, validation, enum, default, route hay quyền.

### Bằng chứng tự động (Vitest / lint / build)

| Check | Kết quả |
|---|---|
| `vitest run AdminCompetitionManagement + AdminCompetitionsPage + AdminCompetitionDetailPage` | 3 file, 81/81 pass |
| `npm test` | 291/291 pass (4 lần chạy liên tiếp) |
| `npm run lint` | exit 0, 0 finding trong `AdminCompetitionManagement.tsx` |
| `npm run build` (`tsc -b && vite build`) | exit 0, 308 module, CSS 165.93 kB, 646ms |
| `git diff --check` | sạch |
| Diff TSX (bỏ whitespace) | chỉ xoá 8 dòng trình bày: eyebrow cũ, 2 `<legend>` chuyển `sr-only`, class nút phụ |
| Diff theo bất biến | 8 `id="comp-*"`, `name="comp-join"`, 12 `required`, `autoFocus`, `isoToLocalInput`/`localInputToIso`, `MAX_COMPETITION_RESOURCES` đều còn |
| Diff payload/mutation | **0 dòng** đụng `fetch`/payload/`slug:`/`join_mode:`/`primary_metric:` |
| File ngoài phạm vi | không backend/api/auth/route/`package.json`/`Modal.tsx` |

### Bằng chứng browser (Chromium headless, mock `/api`, 375/390/640/768/1024/1200/1440px)

| Oracle | Kết quả đo được |
|---|---|
| `documentElement.scrollWidth <= clientWidth` | 0 ở cả 7 bề rộng; không phần tử nào của dialog tràn ngang |
| Header/footer cố định, chỉ body cuộn | `headTop` 0 (mobile)/16 (≥640) và `footerBottom` 900/884 **không đổi** khi `bodyScrollTop` đi 0 → 400 → cuối; `overflow-y: auto` chỉ ở body, dialog `overflow: hidden` |
| Focus control cuối không bị footer che | radio/ô tài nguyên/nút thêm/nút xoá đều `obscured: false`, `visible: true` ở 375 và 1440 → không cần `scroll-padding` |
| Footer trọn viewport, mobile full-screen | dialog 375×900 và 390×900, `border-radius: 0`; ≥640 rộng 592/720/960 (chặn ở 960), radius 18px, không sát mép |
| Số cột participation | 1 cột ở 375/390 (card 62px), 2 cột ở 640 (2+1), 3 cột từ 768 (card 82px) |
| 5 section + nhịp màu | tone `blue/red/yellow/blue/yellow`, số `01–05`, icon nền `#eaf3ff`/`#ffecef`/`#fff5cc` |
| Tiêu đề dài không chồng nút đóng | đo `Range` từng dòng chữ: 0 dòng giao nút đóng ở 375/390/640/1440; khe hở nhỏ nhất 16px (390), 25px (375), 5px (1440) |
| Esc + trả focus | dialog đóng và focus về `.ac-create-button` ở cả 7 bề rộng |
| Focus trap | 40 lần Tab liên tiếp đều nằm trong dialog; Shift+Tab cũng vậy |
| Cả 3 chế độ tham gia | chọn được `open`/`code`/`invite_only`, card selected đổi đúng tone; radio dùng chung ring xanh `--vku-blue-700` với checkbox leaderboard |
| Lỗi ngày | `end <= start` → `.ac-date-error[role="alert"]` "Thời gian kết thúc phải sau thời gian bắt đầu.", dialog giữ nguyên và **không gửi POST** |
| Lỗi API | 409 → dialog vẫn mở, đúng 1 `role="alert"`, footer vẫn thấy |
| Trần tài nguyên | 10 dòng thì nút "Thêm tài nguyên" `disabled`; không tràn ngang; viền `dashed --vku-blue-500` |
| Reduced motion | `prefers-reduced-motion: reduce` → `transition-duration` về ~0, không animation |
| Lỗi runtime | 0 `pageerror` ở mọi kịch bản |

### Phát hiện ngoài phạm vi (không sửa)

1. **Focus khi mở dialog rơi vào nút đóng, không phải `Tên cuộc thi`.** Chuỗi `focusin` thật:
   `.ac-create-button` → `#comp-name` (React `autoFocus`) → `.ac-create-button` → `.modal-close`.
   `Modal.tsx:41-42` chỉ can thiệp khi focus đang ở ngoài dialog, rồi lấy
   `querySelector(FOCUSABLE)` - mà phần tử khớp đầu tiên theo thứ tự DOM là `button.modal-close`
   trong `.modal-head`. **Có từ trước, không phải hồi quy**: modal tài khoản (không thuộc task này)
   cho kết quả y hệt. Sửa được chỉ bằng cách đụng `Modal.tsx`, mà kế hoạch cấm - nên giữ nguyên và
   ghi lại. Test jsdom khẳng định focus ở `#comp-name` vì jsdom không mô phỏng `autofocus` như trình duyệt.
2. **`datetime-local` tốn 7 lần Tab mỗi ô** (từng phân đoạn ngày/giờ là một điểm dừng). Hành vi gốc
   của trình duyệt với input native, không phải do redesign.
3. **Menu thao tác hàng trong danh sách tự đóng khi trang cuộn** (neo theo toạ độ viewport). Ở 375px
   Playwright tự cuộn trigger vào tầm nhìn nên menu đóng ngay; cuộn trước rồi mới click thì mở bình
   thường - đúng thiết kế hiện có của `AdminCompetitionsPage.tsx`, không liên quan dialog.

### Sai lệch có chủ ý so với đặc tả

| Đặc tả | Thực tế | Lý do |
|---|---|---|
| `border: 1.5px solid` cho card chọn | `1px` + ring `3px` | tránh reflow dưới nửa pixel khi chọn |
| Viền `#9CBDE5` cho nút thêm tài nguyên | `--vku-blue-500` | `#9CBDE5` không có trong token |
| Nền body `white → #FBFCFE` | `--surface` phẳng | §5 quy định token `--vku-*` là chuẩn |
| `font-weight: 750` | `700` | stylesheet chỉ có 400/500/600/700 (§6) |
| Helper footer ẩn dưới 640px | ẩn dưới 768px | cùng ý định, gộp vào nhánh tablet |
| `position: sticky` header/footer | bỏ | ở shell này chúng là flex item `flex: none` ngoài vùng cuộn, sticky là no-op |

## 9i. Markdown Document Renderer (VKU)

Hợp đồng: `MARKDOWN_RENDERER_DESIGN.md` (root). Một renderer dùng chung cho mọi nội dung cuộc thi, giữ
`react-markdown` + `remark-gfm` + `rehype-sanitize` (không `rehype-raw`, không highlighter, không
dependency mới). Không đổi API, asset endpoint, auth hay business logic; không hardcode tên file,
dataset hay heading của bất kỳ cuộc thi nào.

### Bằng chứng tự động

| Check | Kết quả | Nguồn |
|---|---|---|
| Resolver asset: 3 alias (`assets/`, `./assets/`, `../assets/`) normalize về cùng endpoint phẳng; ma trận reject đầy đủ (traversal, subpath, absolute, scheme, query/fragment, percent-encoding, backslash, control char, hidden name, extension ngoài allowlist) | passing (11 test) | `frontend/src/markdown/resolveMarkdownAssetUrl.test.ts` |
| GFM/CommonMark: 6 cấp heading tác giả sau demotion (`#`..`######` → `H2,H3,H4,H5,H6,H6`, mức chặn dưới ở `h6`, không tự đánh số, giữ nguyên chữ), `strong`/`em`/`del`, list lồng `ul > li > ul` và `ol > li > ol`, task list (`disabled`, đúng checked, 2 `li.task-list-item`), autolink trần, table region, code, link, image | passing | `frontend/src/markdown/MarkdownView.test.tsx` |
| Ảnh: 3 alias render đúng `src` + `loading="lazy"`; external/`data:`/traversal/SVG tạo 0 `<img>` và 4 placeholder giữ alt; `fireEvent.error` chuyển ảnh lỗi sang placeholder | passing | `frontend/src/markdown/MarkdownView.test.tsx` |
| Code block: nhãn theo info string (`text`, `python`) và nhãn chung `Code`; `pre > code` giữ nguyên từng ký tự (`├── train.csv\n└── sample_submission.csv\n`); toolbar nằm ngoài `pre`; copy đúng text đã parse sau khi bỏ newline cuối; `role="status"` khi thành công, `role="alert"` + hướng dẫn sao chép thủ công khi clipboard reject/không tồn tại; state hai block độc lập; inline code không có toolbar | passing (6 test) | `frontend/src/markdown/MarkdownCodeBlock.test.tsx` |
| Security: `script`/`iframe`/`onerror`/`javascript:` không sống sót; link ngoài `target="_blank" rel="noopener noreferrer"`, link nội bộ không bị ép mở tab; prop nội bộ `node` của react-markdown không rơi xuống DOM (`[node]` = null, không có `[object Object]`) | passing | `frontend/src/markdown/MarkdownView.test.tsx` |
| Heading theo ngữ cảnh: đúng một root `#` → `h2.md-doc-title`; `##` → `h3.md-section`; cấp sâu nâng lần lượt; nhiều `#` giữ section mode; không có `#` không tự suy diễn; marker con nhận accent của section cha; inline code/`strong` và accessible name giữ nguyên | passing (5 test chuyên biệt) | `frontend/src/markdown/MarkdownView.test.tsx`, `frontend/src/markdown/headingHierarchy.ts` |
| Full frontend gate (phần renderer) | passing | `npx vitest run src/markdown` → **38 passed (3 file)**; `npx tsc -b --force` → exit 0; `npm run lint` → 0 error, 22 warning có sẵn và **0** ở `src/markdown/`; `npm run build` → OK, chunk `MarkdownView-D36-iQcr.js` 164.24 kB vẫn tách riêng khỏi entry `index-D1Ct03Qn.js` 481.94 kB, CSS 167.77 kB |
| Full suite `npx vitest run --maxWorkers 1` sau hierarchy mới | 329 passed, 5 failed | 5 lỗi nằm trọn trong `src/pages/CompetitionDetailPage.test.tsx` và **có sẵn từ commit `d224fa4`**, không phải hồi quy của renderer - xem ghi chú dưới |
| Backend contract không đổi (asset allowlist/traversal/nosniff vẫn nguyên) | passing | `uv run pytest -q tests/test_content_storage.py tests/test_contents_public.py` → 13 passed |
| Repo hygiene | passing | `git diff --check` → sạch |

Ghi chú về 5 lỗi `CompetitionDetailPage.test.tsx`: commit `d224fa4` (phiên song song) đổi
`{contents.length} mục` → `{contents.length}` trong `CompetitionDetailPage.tsx:394` và chuẩn hoá
dấu gạch dài thành `-` trong chuỗi tiêu đề, nhưng không cập nhật assertion tương ứng ở
`CompetitionDetailPage.test.tsx:98` (`/2\s*mục/`) và `:365` (`— AI Challenge`). Đã chạy đối chứng
trên worktree sạch tại đúng `HEAD` (`/tmp/vku-head`, không có thay đổi nào của renderer): cùng
5 tên test đổ, cùng `5 failed | 9 passed (14)`, nên đây không phải hồi quy của renderer. Việc sửa
thuộc phạm vi commit đó, không nằm trong task này.

### Bằng chứng browser (Chromium headless, mock `/api`, 7 bề rộng)

Script: `/tmp/uiverify/markdown-verify.mjs` → **152 check, 0 fail**; số đo ghi ở
`/tmp/uiverify/markdown-verify.json`; ảnh `/tmp/uiverify/shots-markdown/article-{375,768,1440}.png`
và `prose-{...}.png`; ảnh riêng từng thanh mục `section-{1,2,3}.png` + `ladder.png` do
`/tmp/uiverify/shot-sections.mjs` chụp ở 1440 (deviceScaleFactor 2).
Fixture Markdown generic: đúng 1 source `#` làm title, 3 source `##` làm section lam/đỏ/vàng,
đủ `###`..`######`, nested/task list, `del`, autolink, 5 ảnh (3 hợp lệ, 1 trả 404, 1 external),
2 fenced block (`text`, `python`), bảng 3 cột, blockquote, `---`.

| Oracle | Số đo tại 375 / 390 / 640 / 768 / 1024 / 1200 / 1440 |
|---|---|
| `documentElement.scrollWidth === clientWidth` | đúng ở cả 7 bề rộng; danh sách phần tử tràn ngoài vùng cuộn rỗng |
| Đúng một `h1` của trang | `h1=1 "AI Challenge 2026"`; heading tài liệu bắt đầu từ `H2` |
| Title mode và cỡ tuyệt đối | đúng một `#` → title `H2`, đỏ `rgb(211,11,35)`, không badge; mobile `28/22/18/16/14/12px`, desktop `32/24/20/16/14/12px` lần lượt cho title/section/square/dash/sub/label |
| Sub và label không render giống nhau | sub 14px, chữ thường; label 12px, uppercase và giãn chữ. Cả hai vẫn giữ semantic `h6` khi source là `#####`/`######` vì không còn bậc dưới |
| Thanh mục source `##` | cả 3 section ở mọi bề rộng: badge **12×12px mobile / 14×14px desktop**, chỉ lớn hơn ô viền con 9px một ít; đường kẻ tới lề, `centered=true`, không chữ số, badge rỗng |
| Màu section xoay lam → đỏ → vàng | `rgb(9,105,232)` / `rgb(236,22,49)` / `rgb(233,169,0)`; marker `###` nhận đúng ba màu tương ứng từ section cha, không fix cứng xanh |
| Sáu vai trò heading có dấu hiệu khác nhau | title đỏ; section badge + leader; square 9×9px, viền computed 1px (CSS 1.5px rasterize); dash 10×2px; sub chữ thường 14px; label uppercase 12px |
| Ba ảnh asset hợp lệ | `src` = `/api/competitions/ai-challenge-2026/assets/{ok,ok-2,ok-3}.png`, `loading="lazy"`, `naturalWidth=484` |
| Ảnh 404 và ảnh external | 2 `.md-image-fallback`, text `Không tải được hình ảnh: Ảnh thiếu` / `Ảnh ngoài`; **không** request nào ra host lạ |
| Hai code block | nội dung y nguyên `├── du-lieu.csv\n└── mau-nop-bai.csv\n` và `cot = mau_nop_bai["id"]\n` |
| Inline code ngoài code block | `id,prediction`, `rgb(211, 11, 35)`, `inBlock=false` |
| Task list | 2 checkbox thật, `{checked:true,disabled:true}` và `{checked:false,disabled:true}`; `ul=disc`, `ol=decimal`, `.task-list-item` = `none` |
| Table | region `Bảng dữ liệu`, `tabindex=0`; wrap `border-top: 2px rgb(9,105,232)`, `th` nền `rgb(245,249,255)` |
| Code panel | nền `rgb(16,36,70)`, `border-top: 3px rgb(255,197,27)`, radius 8px; `code-lang` 12px/600 |
| Blockquote / `hr` / marker dash | blockquote chỉ có gradient `rgb(245,249,255) → rgb(255,251,235)`, **không viền trái**; `hr` radius 999px; `.md-h-dash::before` 10×2px theo màu section cha |
| Placeholder ảnh | nền `rgb(248,250,252)`, viền `1px rgb(203,213,225)` |
| Tương tác copy (1440) | click block 2 → nhãn `Đã sao chép`, `role="status"` có nội dung, clipboard đọc lại đúng `cot = mau_nop_bai["id"]`; block 1 vẫn `Sao chép`; nhãn tự về sau ~2s |
| Keyboard | 20 lần Tab tới được nút copy; outline `solid 2px`, `overflow: visible` và nằm trọn trong khối code (`inside=true`) |
| Touch target | 375px: nút copy cao **44px**, toolbar không tràn khối (`btn=103 < block=289`); 1440: giữ control compact **28px** |
| Clipboard thất bại | `role="alert"` "Không sao chép được nội dung - hãy chọn và sao chép thủ công.", code còn nguyên, nhãn không đổi, vẫn đủ 2 block |
| Console | sạch; chỉ loại trừ 401 `/api/auth/me` (khách) và 404 `/api/competitions/.../assets/missing.png` là hai case có chủ đích của fixture |

Ghi chú: browser evidence chạy trên `vite preview` với `/api/**` được mock, nên **không** phải live-asset
E2E; contract asset phía server được chứng minh riêng bằng test backend ở bảng trên.

Oracle so cỡ tuyệt đối vẫn giữ để chặn hồi quy specificity ở media query: mọi role được kiểm tra bằng
class (`.md-doc-title`, `.md-section`, `.md-h-square`...) thay vì semantic tag. Điều này cần thiết vì
title mode cố ý tách **vai trò thị giác** khỏi tag: ví dụ source `##` vẫn là semantic `h3` nhưng mang
style section 22/24px.

### Sai lệch có chủ ý so với kế hoạch

| Kế hoạch | Thực tế | Lý do |
|---|---|---|
| Kế hoạch ban đầu coi mọi `#` là section 22/24px | Khi đúng một `#`, nó là title đỏ 28/32px; `##` được nâng thành section 22/24px. Nhiều `#` vẫn giữ section mode | hierarchy phụ thuộc cấu trúc tài liệu như người dùng chốt; semantic tag vẫn hạ một bậc nên contract một H1 không đổi |
| Badge section ban đầu 28/32px | 12/14px; marker con 9px, viền CSS 1.5px | giảm độ lấn át; badge section chỉ lớn hơn marker con một ít nhưng vẫn là ô đặc và có leader để thể hiện cấp cao hơn |
| Đánh số mục `1. 2. 3.` (chỉ có trong mockup, kế hoạch §7 đã xếp vào non-goals) | **Không** đánh số; ô màu là hình trang trí, không phải ô số | Chốt với người dùng: số trong mockup tượng trưng cho *kiểu định dạng* của `##`, không phải nội dung renderer phải sinh. Nếu tác giả muốn số thì tự viết số trong tiêu đề |
| paragraph `line-height: 1.7` | `var(--leading-body)` = 1.65 | token có sẵn của hệ, không tạo giá trị thứ hai |

### Flake: panel markdown nạp lazy dưới tải

| Check | Status | Cách verify |
|---|---|---|
| `findBy*` chờ `MarkdownView` (nạp bằng `React.lazy` + dynamic `import()`) không hết giờ chờ khi máy bận | passing | `asyncUtilTimeout: 5000` trong `frontend/src/test/setup.ts`. Flake có thật, bắt được ngày 2026-09-19: `CompetitionDetailPage.test.tsx` fail ở 1047ms với `Unable to find role heading`, đúng mốc hết giờ 1000ms mặc định |

Nguyên nhân không phải race của sản phẩm: `React.lazy` chỉ trễ, không tranh chấp, và trong browser thật
chunk được tải một lần rồi cache. Cái sai là ngân sách 1000ms của môi trường test không tính tới việc
Vite phải transform cả nhánh module markdown ở lần render đầu.

Số đo để chọn mốc mới, trên máy 4 core chạy 4 vòng lặp CPU bận song song (nặng hơn CI thật): test mất
**932 / 1039 / 1142 / 1195 ms**. Mốc cũ 1000ms nằm giữa phân bố đó, nên flake xảy ra thưa chứ không
phải luôn luôn. Mốc 5000ms cho khoảng đệm ~4x so với đỉnh quan sát được, và vẫn là một cận có ý nghĩa:
phần tử không bao giờ xuất hiện thì vẫn fail, chỉ chậm hơn.

### `new Response(new Blob([...]))` không dựng được trong jsdom

| Check | Status | Cách verify |
|---|---|---|
| Test download/xuất Excel dựng `Response` từ chuỗi, không từ `Blob` | passing | `frontend/src/api/client.test.ts`, `frontend/src/pages/AdminCompetitionDetailPage.test.tsx`. Trên Node 22.23.2 (bản CI dùng) 5 test fail với `TypeError: object.stream is not a function` |

Trong môi trường jsdom của vitest, `Blob` toàn cục là Blob của jsdom và `Blob.prototype.stream` không
tồn tại. undici đi kèm Node 22.23.2 nhận nó là blob-like rồi gọi `.stream()` và ném `TypeError`.
`new Response("xlsx-bytes")` vẫn cho `api.download` một blob thật để đọc.

Đây là lỗi thật của test, không phải flake, và nó **chỉ lộ trên CI**: máy dev chạy Node 24 không tái
hiện, Node 22.22.1 cũng pass - chỉ từ 22.23.2 mới đổ. Vì vậy đối chiếu Node phải dùng đúng bản CI chạy
(`node-version: 22` resolve thành 22.23.2), không phải bản có sẵn trên máy.

## 10. Production deploy (Sprint 08)

| Check | Status |
|---|---|
| Docker Compose prod chạy trên GCE | passing |
| Cloudflare Tunnel serve HTTPS | passing |
| Smoke test production | passing |

Kiểm 2026-09-19 trên VM production: `api`/`web`/`mongo`/`minio`/`cloudflared` đều `healthy` ở
`0864b80c913b`, `/api/health` trả `200 {"status":"ok","mongo":"reachable"}` qua
`https://vku-ai-challenge-platform.ketdoannguyen.workers.dev` (HTTPS của Cloudflare), và smoke
artifact/legacy/case âm đã chạy trọn qua đúng đường đó (chi tiết ở §13).

## 11. Backup/restore & pilot (Sprint 09) - planned

| Check | Status |
|---|---|
| Backup + restore Mongo + /data | passing |
| Runbook pilot | planned |

Backup + restore đã chạy thật trên VM ngày 2026-09-19, gồm cả mirror bucket MinIO và restore drill
(chi tiết ở §13). Backup định kỳ cũng đã bật sẵn: `vku-backup.timer` ở trạng thái `enabled`/`active`,
chạy hằng ngày ~03:20 UTC. Riêng "Runbook pilot" (chạy với người dùng thật) vẫn chưa diễn ra.

## 12. Auto-deploy (Sprint 08, ADR-026)

`passing` = có test/kiểm tra chạy được ở local hoặc trong `release-gate`; `planned` = phải chạy trên
hạ tầng thật, chưa thực hiện lần nào.

| Check | Status | Cách verify |
|---|---|---|
| Deployer không chạy khi chưa bootstrap | passing | `deploy/vps/tests/auto-deploy.test.sh` case "chưa bootstrap: từ chối deploy tip" |
| Đúng SHA đang chạy thì không fetch/build | passing | harness case "up-to-date" |
| Commit chỉ đổi docs/CI không chạm container | passing | harness case "docs-only" |
| `backend/**` deploy **cả** `api` và `web` (nginx giữ IP của `api`) | passing | harness case "backend-only": assert `build api web` + `up ... api web` |
| `frontend/**` chỉ deploy `web` | passing | harness case "frontend-only": assert không có `build api` |
| Đường dẫn chưa phân loại thì fail closed | passing | harness case "đường dẫn lạ" |
| Working tree bẩn thì từ chối deploy | passing | harness case "working tree bẩn" |
| Hai lượt deploy không chồng lấn (flock) | passing | harness case "flock" |
| `--dry-run` không đổi state/HEAD/worktree | passing | harness case "dry-run" |
| Build lỗi thì production giữ nguyên bản cũ | passing | harness case "build lỗi" (`FAKE_FAIL_BUILD`) |
| SHA lỗi chỉ thử một lần | passing | harness case "SHA lỗi" + "SHA mới sau SHA lỗi" |
| Revision label sai sau `up` → rollback bằng image cũ, **không** build lại | passing | harness case "revision sai sau up" (`FAKE_BAD_LABEL`) + assert chỉ có một lệnh `build` |
| `up` lỗi giữa chừng → rollback ngay trong cùng lượt | passing | harness case "up lỗi" (`FAKE_FAIL_UP`) |
| Không có image cũ → **từ chối** rollback, không build bù source mới dưới nhãn cũ | passing | harness case "không có image cũ" (`FAKE_NO_OLD_IMAGE`) + assert không có lệnh `up` của rollback |
| Mọi lệnh `up` đều có `--no-build` | passing | harness case "audit lệnh Compose" |
| Health hỏng sau `up` → rollback | passing | harness case "health hỏng" (`FAKE_HEALTH_FAIL`) |
| Rollback cũng hỏng → chỉ chỗ can thiệp tay, không chết vì biến chưa gán | passing | harness case "health hỏng": assert nhắc `history.log` |
| Mọi lệnh Compose có `--env-file` + base `-f` + override `-f` | passing | harness case "audit lệnh Compose" |
| Không có lệnh Compose nào chạm `mongo`/`down`/`volume`/`prune`, và không lệnh nào đổi trạng thái `cloudflared` | passing | harness case "audit lệnh Compose" (chỉ cấm mutate; watchdog đọc `cloudflared` là hợp lệ) |
| Giữ image của SHA đang chạy và SHA trước, xoá tag cũ hơn, giữ `:prod` | passing | harness case "audit lệnh Compose" |
| Deployer từ chối chạy khi không phải root | passing | harness case "an toàn: không phải root" |
| Watchdog phát hiện hostname Quick Tunnel đổi và in URL cũ/mới + chỗ sửa | passing | harness case "watchdog Quick Tunnel: phát hiện URL đổi" |
| URL tunnel không đổi thì watchdog im lặng (không spam mỗi phút) | passing | harness case "watchdog Quick Tunnel": lượt thứ hai assert không có `CẢNH BÁO` |
| Log `cloudflared` mất dòng URL thì giữ giá trị cũ, không báo động giả | passing | harness case "watchdog: log mất URL" |
| Không có container `cloudflared` (named tunnel) thì watchdog không ghi state | passing | harness case "watchdog: không có container cloudflared" |
| `--dry-run` không để watchdog ghi state | passing | harness case "watchdog: dry-run và bootstrap không ghi state" |
| Cú pháp shell của deployer + installer + harness | passing | `bash -n` trong `release-gate / deploy-script` |
| Unit systemd hợp lệ và `ExecStart` trỏ đúng bản copy đóng băng | passing | `systemd-analyze verify` trên bản copy thay `ExecStart` + `grep -qx` đường dẫn thật |
| Compose prod còn hợp lệ (base và base + override named tunnel) | passing | `docker compose config --quiet` với env giả trong `release-gate` |
| Gate chạy trên push vào `main` | passing | Run `35440863656`: cả ba job `frontend`/`backend`/`deploy-script` xanh |
| Gate frontend/backend chạy trên PR vào `release` | planned | Mở PR đầu tiên vào `release` và xem `release-gate / frontend`, `/ backend`, `/ deploy-script` xanh |
| Actions deploy Worker | passing | Run `35441083752` (dispatch trên `release`): upload 4 file, version `03c71a3f`, smoke tĩnh `/` và deep link `200 text/html`, `/api/health` `200` |
| `keep_vars` giữ `API_ORIGIN` qua deploy | passing | Sau run `35441083752`, `/api/health` vẫn `{"status":"ok","mongo":"reachable"}` - nếu `--var` ghi đè thì API đã 502 |
| Secret của environment `production` chỉ dùng được từ `release` | passing | `deployment_branch_policies` trả đúng một policy `release`; `gh workflow run --ref main` sẽ bị chặn |
| Push tạo nhánh `release` ở cùng commit với `main` không kích hoạt deploy | passing | Quan sát thật: `release` tạo ở `6b86509` (trùng `main`) nên `paths: frontend/**` không khớp diff rỗng; dùng `workflow_dispatch` theo thiết kế break-glass. Push có diff thật sẽ chạy bình thường |
| Smoke tĩnh fail thì workflow tự rollback Worker | planned | Chưa diễn tập - xem "Failure drills" trong plan |
| Timer kéo commit mới về VM trong ~1 phút | passing | Timer đã bật trên VM; kiểm chứng bằng một lượt deploy thật qua timer: probe `POST .../reopen` qua hostname Worker trả `401` còn đường dẫn bịa trả `404` ⇒ image `api` đã build lại. Xem ADR-026 "Rollout" |
| Deploy lỗi trên VM tự rollback về image cũ | planned | Diễn tập bằng một commit cố tình hỏng |
| Trần thời gian `TimeoutStartSec=1800` đủ cho một lượt deploy thật | planned | Đo bằng `systemd-analyze`/`journalctl` ở lượt deploy thật đầu tiên |

## 13. Artifact submission trên MinIO (ADR-028)

Cùng quy ước với §12: `passing` = có test/kiểm tra chạy được ở local, `planned` = phải chạy trên hạ
tầng thật.

Unit test của backend **không** cần MinIO: `backend/tests/fake_minio.py` thay SDK bằng store
in-memory nhưng giữ đúng hình dạng lỗi/response; MinIO thật chỉ được kiểm ở smoke và khi diễn tập
trên VM.

### Backend - nộp bài (hai artifact bắt buộc)

| Check | Status | Cách verify |
|---|---|---|
| Một lượt nộp hợp lệ lưu **cả** CSV lẫn notebook: hai object dưới cùng prefix + một document, `submission_no` thật trong response | passing | `backend/tests/test_submissions.py::test_valid_submission_scores_and_stores_both_artifacts` |
| Thiếu part `notebook` → 400, **không** record, **không** object nào, **không** tiêu quota | passing | `test_submissions.py::test_missing_notebook_part_is_rejected_without_side_effects` |
| Notebook sai đuôi / JSON hỏng / không phải object / `nbformat` ngoài `4.x` → mã lỗi riêng, không record | passing | `test_submissions.py::test_notebook_validation_rejects_bad_notebooks` + `test_submission_artifacts.py::test_validate_notebook_rejects_malformed_payloads` |
| Notebook UTF-8 BOM + CRLF vẫn nhận; `nbformat 4.5` hợp lệ | passing | `test_submissions.py::test_notebook_accepts_utf8_bom_and_crlf_sources`, `test_submission_artifacts.py::test_validate_notebook_accepts_v4_notebook_with_nul_free_source` |
| Validate notebook bằng `json` stdlib, không import/execute/render nội dung | passing | `backend/app/submission_artifacts/validation.py` chỉ `json.loads` + duyệt dict; test ở trên không dựng kernel nào |
| Trần riêng cho từng slot: CSV `MAX_UPLOAD_MB`, notebook `MAX_NOTEBOOK_MB` | passing | `test_submissions.py::test_submission_rejects_extension_and_size_limits` |
| Upload lỗi giữa đường → xoá object đã put; insert lỗi → xoá cả hai object | passing | `test_submissions.py::test_storage_failure_rolls_back_uploaded_artifacts`, `::test_insert_failure_removes_both_objects` |
| `submission_no` tăng dần theo `(competition_id, account_id)`, bỏ qua khoảng trống của record legacy, chịu được nộp đua | passing | `test_submissions.py::test_submission_sequence_increments_and_ignores_legacy_gaps`, `::test_submission_sequence_is_per_account_and_competition`, `::test_concurrent_submissions_get_distinct_numbers` |
| Log lượt nộp bị từ chối chỉ chứa mã lỗi, không chứa giá trị người dùng nộp | passing | `test_submissions.py::test_rejected_submission_log_contains_code_but_not_uploaded_values` |

### Backend - tải artifact

| Check | Status | Cách verify |
|---|---|---|
| Chủ bài tải được cả hai artifact; header `Content-Disposition` an toàn | passing | `backend/tests/test_submission_downloads.py::test_owner_downloads_both_artifacts_with_safe_headers` |
| Chưa đăng nhập / không phải chủ bài → từ chối | passing | `test_submission_downloads.py::test_download_requires_auth_and_ownership` |
| Admin tải được bài của mọi đội; participant thì không | passing | `test_submission_downloads.py::test_admin_downloads_any_team_artifact_but_participant_cannot` |
| Bài của cuộc thi khác không tải chéo được | passing | `test_submission_downloads.py::test_download_rejects_submission_of_another_competition` |
| Tên file `{slug}_{account}_submission-NNNN_{prediction.csv,notebook.ipynb}` (một `_` mỗi phân cách, ADR-031), fallback ObjectId ngắn cho record legacy | passing | `test_submission_artifacts.py::test_download_filename_uses_sequence_number_and_sanitized_segments`, `::test_download_filename_falls_back_to_short_id_for_legacy_submissions` |
| Slug/account chứa space, `_`, `__`, ký tự nguy hiểm → tên kết quả **không bao giờ** có `__`, luôn đúng ba dấu `_` | passing | `test_submission_artifacts.py::test_download_filename_never_emits_double_underscore` (regression ADR-031, 4 cặp input) |
| Tên file chống traversal, có cận độ dài, tên account rỗng thì lấy `account_id` | passing | `test_submission_artifacts.py::test_download_filename_strips_path_traversal_from_user_controlled_parts`, `::test_download_filename_is_bounded_for_long_names`, `::test_download_filename_empty_account_name_falls_back_to_account_id` |
| `filename*=UTF-8''…` giữ tên Unicode, `filename=` fallback ASCII, không bao giờ rỗng | passing | `test_submission_artifacts.py::test_content_disposition_keeps_unicode_name_and_ascii_fallback`, `::test_content_disposition_falls_back_when_ascii_is_empty` |
| Bài legacy (chỉ CSV trên disk) vẫn tải được, không cần migration | passing | `test_submission_downloads.py::test_legacy_submission_is_still_downloadable` |
| `file_path` legacy mất hoặc trỏ ra ngoài `DATA_DIR` → 404, không đọc file ngoài | passing | `test_submission_downloads.py::test_legacy_submission_with_missing_or_escaping_path_is_not_found` |
| Object mất → 404 `ARTIFACT_NOT_FOUND`; MinIO không tới được → 503 `ARTIFACT_STORAGE_UNAVAILABLE` cho cả upload lẫn download | passing | `test_submission_downloads.py::test_missing_object_maps_to_artifact_not_found`, `::test_storage_outage_returns_503_for_upload_and_download` |
| **MinIO hỏng không làm `/api/health` đổi trạng thái** (health là oracle rollback của auto-deploy) | passing | `test_submission_downloads.py::test_storage_outage_does_not_break_health` |
| Trần bytes khi đọc lại vẫn áp theo settings, không tin `size_bytes` trong DB | passing | `test_submission_downloads.py::test_download_uses_stored_oversized_limit_from_settings`, `test_submission_artifacts.py::test_get_rejects_object_larger_than_limit_without_reading_all` |
| Response tải artifact không lộ `account_id` hay `object_key` | passing | `test_submission_downloads.py::test_download_route_does_not_leak_account_ids` |
| Put/get/remove đi qua storage module, lỗi SDK map thành lỗi nghiệp vụ; bucket sai/thiếu credential = không khả dụng | passing | `test_submission_artifacts.py::test_object_keys_are_built_from_immutable_ids`, `::test_put_then_get_roundtrip_closes_response`, `::test_get_missing_object_raises_not_found`, `::test_storage_errors_map_to_unavailable`, `::test_unknown_bucket_is_treated_as_upload_failure`, `::test_missing_credentials_are_unavailable` |

### Backend - quản trị và dọn dẹp

| Check | Status | Cách verify |
|---|---|---|
| `/api/admin/submissions` chỉ admin gọi được | passing | `backend/tests/test_admin_submissions.py::test_global_list_requires_admin` |
| Bảng trải nhiều cuộc thi, lọc theo cuộc thi / account / status | passing | `test_admin_submissions.py::test_global_list_spans_competitions_with_filters` |
| Sắp xếp `created_at` / `primary_score` / `team` + phân trang server-side, `total` khớp số bản ghi | passing | `test_admin_submissions.py::test_global_list_sorts_and_paginates` |
| Tham số `sort`/`order`/`limit`/`offset` sai → 422 chứ không im lặng dùng default | passing | `test_admin_submissions.py::test_global_list_rejects_invalid_params` |
| Cuộc thi hoặc account đã xoá thì bảng vẫn trả về (không 500) | passing | `test_admin_submissions.py::test_global_list_survives_deleted_competition_and_account` |
| Row của bài mới trả metadata artifact (tên file + cờ `available`), không trả `object_key` | passing | `test_admin_submissions.py::test_global_list_reports_artifact_metadata_for_new_submissions` |
| Xoá cuộc thi dọn prefix `competitions/<id>/` trên MinIO | passing | `backend/tests/test_competitions_delete.py::test_delete_removes_artifact_objects_under_competition_prefix` |
| MinIO không tới được lúc xoá cuộc thi → DB đã xoá xong nhưng `files_removed:false`, không kéo theo lỗi 500 | passing | `test_competitions_delete.py::test_delete_reports_partial_cleanup_when_storage_is_unavailable` |
| Xoá cứng member dọn object của bài chưa `completed`, bài `completed` thì 409 và không xoá gì | passing | `backend/tests/test_memberships.py::test_admin_hard_delete_member_only_without_completed_submission`, `::test_admin_hard_delete_member_removes_pending_submission_artifacts` |

### Frontend

| Check | Status | Cách verify |
|---|---|---|
| Form nộp chỉ mở nút khi đã đủ **hai** tệp; từ chối sai định dạng và vượt trần theo từng slot | passing | `frontend/src/pages/SubmissionPage.test.tsx` ("hiển thị rule summary và chỉ mở nút nộp khi đã đủ hai tệp", "từ chối tệp sai định dạng và tệp vượt trần của từng slot") |
| Submit gửi multipart hai phần và hiển thị metrics + quota còn lại | passing | `frontend/src/pages/SubmissionPage.test.tsx` ("submit hiển thị loading rồi metrics và quota còn lại") |
| Nút tải trong lịch sử chỉ hiện cho artifact backend thực sự có | passing | `frontend/src/components/ArtifactLinks.test.tsx` ("chỉ hiện nút cho tệp backend thực sự có") |
| Tải dùng đúng route của nơi gọi và đặt tên file theo `Content-Disposition` | passing | `ArtifactLinks.test.tsx` ("tải đúng route của nơi gọi và dùng tên file từ Content-Disposition") |
| 503 của MinIO hiện ngay trong dòng artifact, không làm hỏng cả bảng | passing | `ArtifactLinks.test.tsx` ("lỗi 503 hiện ngay trong dòng thay vì làm hỏng cả bảng") |
| Trang `/admin/submissions`: bảng toàn cục có cuộc thi/đội/trạng thái/điểm + nút tải gọi route admin | passing | `frontend/src/pages/AdminSubmissionsPage.test.tsx` ("hiển thị bảng toàn cục…", "nút tải artifact gọi route admin toàn cục của đúng bài nộp") |
| Bộ lọc gửi lên server và đưa bảng về trang đầu | passing | `AdminSubmissionsPage.test.tsx` ("gửi bộ lọc lên server và đưa bảng về trang đầu") |
| Bấm tiêu đề cột đổi `sort`/`order` gửi lên server (mặc định riêng của từng cột rồi đảo chiều) | passing | `AdminSubmissionsPage.test.tsx` ("sắp xếp theo tiêu đề cột…") |
| Đổi trang giữ bảng cũ và báo đang bận thay vì để bảng trống | passing | `AdminSubmissionsPage.test.tsx` ("đổi trang giữ bảng cũ, báo đang bận rồi render trang mới") |
| Cuộc thi đã xoá hiện tên nhưng không có link; lỗi tải danh sách có nút thử lại; bộ lọc không khớp có empty state xoá được | passing | `AdminSubmissionsPage.test.tsx` (3 test còn lại) |

### Browser smoke thật (stack dev: api + web + MinIO, không mock)

Script `/tmp/uiverify/artifact-smoke.mjs` chạy Chromium headless trên stack dev thật
(`docker compose` với `minio` + `minio-init`, `VITE_API_PROXY_TARGET` → api), đăng nhập thật bằng
`team1@vku.vn` và `admin@vku.vn`; chạy lại toàn bộ 2026-09-19: **26/26 PASS**.

Chạy lại: `docker compose up -d minio minio-init api web` rồi
`LD_LIBRARY_PATH=/tmp/uiverify/libs/usr/lib/x86_64-linux-gnu node /tmp/uiverify/artifact-smoke.mjs`
(đổi `BASE` nếu dev server không ở `http://localhost:5173`). Smoke tiêu một lượt quota nộp bài của
`team1@vku.vn`.

| Check | Status | Kết quả đo được |
|---|---|---|
| Form nộp: nút nộp khoá khi chưa có tệp, vẫn khoá khi mới có CSV, mở khi đủ hai tệp | passing | `disabled` đúng ở cả ba trạng thái; form có đúng 2 slot `input[type=file]` |
| Chọn tệp xong slot đổi thành thẻ tệp (tên + dung lượng) và hiện trần riêng từng slot | passing | Hint hiển thị `10 MiB` cho CSV và `20 MiB` cho notebook |
| Nộp thật qua API → MinIO → chấm điểm, màn kết quả hiện điểm | passing | Nhận `201`, màn kết quả hiện F1 `0.571429` |
| Lịch sử participant: hàng mới nhất có nút `CSV` và `Notebook`, tải về đúng bytes đã nộp | passing | Lượt chạy lại 2026-09-19 trên code ADR-031: `ai-challenge_Đội-01_submission-0010_notebook.ipynb` / `…_prediction.csv` (một `_` mỗi phân cách); bytes khớp tệp nguồn |
| Admin toàn cục: đủ cột cuộc thi/đội/tệp/trạng thái/điểm, có dữ liệu thật nhiều cuộc thi | passing | 17 dòng ở trang đầu |
| Admin toàn cục: sắp xếp và lọc chạy phía server | passing | Bấm "Điểm chính" → request `?…&sort=primary_score`; cột điểm giảm dần `1.000000 → 0.000000`; lọc đội → `?…&q=team1` và bảng chỉ còn team1 |
| Admin toàn cục: tải được artifact của đội khác bằng route admin | passing | `ai-challenge_Đội-01_submission-0010_prediction.csv` (lượt chạy lại 2026-09-19 trên code ADR-031) |
| Admin toàn cục: bộ lọc không khớp thì bảng unmount và hiện empty state | passing | `Không có bài nộp phù hợp.` + nút "Xóa bộ lọc"; không còn `tbody tr` nào |
| Không tràn ngang ở desktop 1280 cho form/lịch sử/admin | passing | `scrollWidth == innerWidth == 1280` cả ba màn |
| Không tràn ngang ở mobile 375 cho form/lịch sử/admin | passing | `scrollWidth == innerWidth == 375` cả ba màn |
| Ảnh chụp để soi bằng mắt | passing | `/tmp/vku-shots/artifact-smoke/{1-form-ready,2-form-result,3-history,4-admin-global,5-admin-filtered,6-mobile-*}.png` |

Ghi chú khi chạy lại: bài nộp cũ (CSV trên `DATA_DIR`) vẫn hiện nút tải dù tệp đã bị dọn khỏi đĩa —
API trả 404 và UI báo lỗi ngay trong dòng, không làm hỏng bảng (đúng thiết kế của
`ArtifactLinks`), nên smoke chọn hàng có notebook (bài nộp mới, tệp nằm trong MinIO) làm mốc kiểm tra.

### Hạ tầng và vận hành

| Check | Status | Cách verify |
|---|---|---|
| `minio-init` idempotent: chạy lại không lỗi, bucket `submission-artifacts` private | passing | `scripts/minio_smoke.sh` (Compose project cô lập `vku-minio-smoke`), chạy thật 2026-09-19: `MinIO smoke PASS` |
| Anonymous **list** và **GET object** đều bị `Access Denied` sau khi object đã nằm trong bucket | passing | Cùng smoke: `anonymous bị từ chối: … Access Denied.`, `anonymous GET object bị từ chối` |
| Credential app put/get lại đúng bytes và delete được đúng object của mình (không dư object) | passing | Cùng smoke: `cmp` cả hai artifact khớp bytes gốc |
| MinIO không publish port ra host | passing | Cùng smoke: `docker port` trên container `minio` rỗng |
| MinIO không có route qua Nginx | passing | `frontend/nginx.conf` không có `location` nào trỏ `minio:9000`; service chỉ nằm trong network nội bộ của compose |
| Nginx cho phép body 32 MiB (đủ 20 MiB notebook + 10 MiB CSV + overhead multipart) | passing | `grep client_max_body_size frontend/nginx.conf` → `32m`; review §11 `docs/DEPLOYMENT.md` khi đổi trần |
| Auto-deploy **dừng trước khi** thay `api`/`web` khi `minio`/`minio-init` chưa bootstrap, in lệnh bootstrap, và **không** khoá SHA mục tiêu lại | passing | `deploy/vps/tests/auto-deploy.test.sh` case "MinIO chưa bootstrap: dừng trước khi thay api/web" (3 nhánh: không có container/không healthy/`minio-init` exit ≠ 0) |
| MinIO đã bootstrap → deploy chạy bình thường, không build/up container MinIO | passing | harness case "MinIO healthy: deploy bình thường" |
| Compose file không khai báo MinIO thì preflight không chặn deploy | passing | harness case "compose không có MinIO: không chặn deploy" |
| Cú pháp shell của deployer/backup/init/smoke + unit systemd + `docker compose config` (có biến MinIO) | passing | `release-gate / deploy-script` (`bash -n`, harness, `systemd-analyze verify`, `docker compose config --quiet` với env giả) |
| Backup đủ ba phần và restore drill đọc lại được **cả** CSV legacy **lẫn** CSV/notebook mới | passing | Diễn tập trên stack dev 2026-09-19 (đúng quy trình §10 `docs/DEPLOYMENT.md`): `mongodump` → `gzip -t` + `mongorestore --dryRun`; `app-data.tar.gz` giải nén ra đọc được CSV legacy tại `file_path` trong DB (183 B, 15 dòng); `mc mirror` bucket bằng tag `mc` mà compose pin → `minio-artifacts.tar.gz` (6 object); Mongo restore vào DB tạm `ai_challenge_drill` (65 document, index `submission_no_unique` còn nguyên) → lấy `object_key` thật của submission `0009` → dựng bucket test private (`anonymous set none` → `private`) → mirror ngược → đọc lại hai artifact theo đúng key đó: **trùng sha256** với tệp đã nộp (`d7b9c730…` prediction, `b74a1f2b…` notebook). Bucket test và DB tạm đã xoá sau khi kiểm; bucket thật còn nguyên 6 object |
| `scripts/backup_prod.sh` chạy trọn trên VM, `MANIFEST.txt` có sha256, và lượt dở dang bị xoá thay vì để lại bản thiếu dữ liệu | passing | Chạy thật trên VM 2026-09-19: `20260919T224501Z` đủ ba archive + `MANIFEST.txt` ba dòng sha256 (`sha256sum -c` khớp); lượt bị `SIGTERM` giữa đường (`20260919T224533Z`) trả exit 143, in "Backup dở dang - đã xoá …" ra stderr và **không** để lại thư mục nào. Cộng thêm harness `deploy/vps/tests/backup-prod.test.sh` (27 case) chạy trong `release-gate` |
| Backup chạy qua **đúng unit systemd** (đường `vku-backup.timer`), không phải gọi tay script | passing | `sudo systemctl start vku-backup.service` trên VM 2026-09-19: `Result=success`/`ExecMainStatus=0`, `20260919T225043Z` đủ `mongo.archive.gz`/`app-data.tar.gz`/`minio-artifacts.tar.gz`/`MANIFEST.txt`, `mongorestore --dryRun` đọc lại archive. Đây chính là đường timer chạy nên nó kiểm luôn `ExecStart=/usr/local/sbin/vku-backup-prod` (bản đóng băng) và env của unit. Timer đang `enabled`/`active`, lượt kế tiếp 2026-09-20T03:20:05Z; lượt `03:21` ngày 2026-09-19 còn là bản **trước** ADR-028 nên chỉ có 3 archive - lượt rạng sáng 2026-09-20 là lượt timer đầu tiên phải có `minio-artifacts.tar.gz` |
| Bucket `submission-artifacts` **rỗng**: backup vẫn thành công với archive MinIO rỗng hợp lệ | passing | Harness case "bucket rỗng"; và chạy thật trên VM khi production chưa có submission nào: `20260919T224501Z/minio-artifacts.tar.gz` (120 B, chỉ có entry `minio-artifacts/`), exit 0 |
| Chạy chồng lấn bị bỏ qua, và retention chỉ chạy SAU khi backup mới thành công | passing | Harness hai case tương ứng: lượt thứ hai in "Đã có tiến trình backup khác đang chạy" và không tạo thư mục nào; bản quá hạn chỉ bị xoá ở lượt thành công, còn nguyên ở lượt mirror lỗi |
| Restore drill trên **đường production** (backup thật trên VM → bucket test) | passing | Diễn tập 2026-09-19 từ `20260919T221818Z`: `mongorestore --nsFrom/--nsTo` vào DB tạm `ai_challenge_drill` (accounts=5, competitions=2, memberships=2, submissions=1); đọc `object_key` từ DB đã restore; dựng bucket drill private (`anonymous get` → `private`); mirror ngược rồi đọc lại **cả hai** artifact: `prediction.csv` 183 B sha256 `f86105bb…` và `notebook.ipynb` 550 B sha256 `559eb4ec…`, **trùng** bản trong backup và trùng tệp gốc đã nộp. `ground_truth.csv` trong `app-data.tar.gz` khớp byte với `/srv/vku-ai-challenge/data/app/...` đang chạy. Bucket drill + DB tạm đã xoá, bucket thật còn nguyên |
| Nộp + tải artifact thật trên production (API → MinIO trong compose prod) | passing | Smoke qua đúng đường người dùng (Worker → Tunnel → nginx → FastAPI) ngày 2026-09-19: 17/17 case artifact (nộp multipart hai part, participant tải lại đúng byte, đội khác 404 `NOT_FOUND`, admin tải được artifact đội khác), 7/7 case đường legacy (tên tải 8 ký tự cuối ObjectId, notebook 404, shape `size_bytes: null`), 4/4 case âm (422 `VALIDATION_ERROR`/`INVALID_NOTEBOOK_TYPE`/`NOTEBOOK_INVALID`, không tạo submission nào). Health vẫn `200 {"status":"ok","mongo":"reachable"}` khi **dừng hẳn** container `minio` (nhánh artifact 503 đã có ở test backend, production lúc đó không còn submission nào để gọi) |

## 14. Bảng bài nộp toàn cục, hướng dẫn nộp bài và notebook khung (ADR-029 → ADR-031)

Cùng quy ước §12/§13: `passing` = đã chạy ở local, `planned` = phải chạy trên hạ tầng thật. Ba ADR
này còn là thay đổi **chưa lên production** (xem §1 `docs/PROJECT_STATE.md`).

### Backend - sort và thống kê

| Check | Status | Cách verify |
|---|---|---|
| `sort=competition` sắp theo **tên** cuộc thi rồi slug (qua `$lookup`), cuộc thi đã xoá không làm endpoint lỗi | passing | `backend/tests/test_admin_submissions.py::test_global_list_sorts_by_competition_name` |
| `sort=f1\|precision\|recall` chạy cả `asc` lẫn `desc`, chịu được record thiếu `metrics`, phân trang không trùng/mất dòng (tie-break `created_at` → `_id`) | passing | `test_admin_submissions.py::test_global_list_sorts_by_metrics_with_stable_pagination` |
| Giá trị `sort` ngoài allowlist → 422 | passing | `test_admin_submissions.py::test_global_list_rejects_invalid_params` |
| Route theo một cuộc thi **không** nhận `sort=competition` và **không** trả `stats` (shape cũ giữ nguyên) | passing | `test_admin_submissions.py::test_competition_scoped_list_has_no_stats_and_rejects_competition_sort` |
| `stats` tính bằng **một** `$facet` trên đúng bộ lọc đang xem; `stats.total === total`; `competitions`/`teams`/`completed` đếm theo `competition_id`/`account_id`/`status=completed` | passing | `test_admin_submissions.py::test_global_list_returns_stats_for_current_filter` (không lọc, và kết hợp `competition_id`/`q`/`status`) |
| Cuộc thi/account đã xoá vẫn trả hàng với tên cũ thay vì 500 | passing | `test_admin_submissions.py::test_global_list_survives_deleted_competition_and_account` |
| Hành vi cũ không đổi: phân trang, lọc chéo cuộc thi, metadata artifact, chặn non-admin | passing | `test_admin_submissions.py::test_global_list_sorts_and_paginates`, `::test_global_list_spans_competitions_with_filters`, `::test_global_list_reports_artifact_metadata_for_new_submissions`, `::test_global_list_requires_admin` |
| **Không** thêm index Mongo nào cho batch này | passing | `docs/DATA_MODEL.md` §6 ghi rõ metric sort là đường quản trị phụ; review code `backend/app/submissions/service.py` không có `create_index` mới |

### Frontend - bảng bài nộp

| Check | Status | Cách verify |
|---|---|---|
| Bảy cột sắp xếp được, mỗi cột có thứ tự mặc định riêng (`competition`/`team` asc, các điểm và `created_at` desc), `aria-sort` khớp chiều đang xem, `offset` về 0 | passing | `frontend/src/pages/AdminSubmissionsPage.test.tsx::bảy cột sắp xếp được với thứ tự mặc định riêng của từng cột` |
| Bấm lại cột đang chọn thì đảo chiều; rời cột rồi quay lại thì về mặc định của cột; cột không sắp xếp được (Trạng thái, Tệp đã nộp) **không** mang `aria-sort` | passing | Cùng test trên |
| Đổi bộ lọc cuộc thi/trạng thái gọi lại API **ngay**, không còn nút `Lọc` | passing | `AdminSubmissionsPage.test.tsx::đổi bộ lọc cuộc thi và trạng thái áp dụng ngay, không còn nút Lọc` |
| Gõ tìm kiếm chỉ gọi server sau debounce, Enter áp dụng ngay | passing | `AdminSubmissionsPage.test.tsx::gõ tìm kiếm chỉ gọi server sau khi ngừng gõ, Enter áp dụng ngay` |
| Xoá bộ lọc không phát request trùng và hiện empty state đúng | passing | `AdminSubmissionsPage.test.tsx::bộ lọc không khớp thì hiện empty state và xóa bộ lọc không gọi trùng request` |
| Bốn thẻ thống kê đọc theo bộ lọc hiện tại và **không** đổi sort/phân trang đang xem | passing | `AdminSubmissionsPage.test.tsx::hiện bốn thẻ thống kê theo bộ lọc hiện tại` |
| Lần tải đầu để chỗ trống + "Đang tải thống kê", không hiện số 0 giả | passing | `AdminSubmissionsPage.test.tsx::chưa có dữ liệu thì thẻ thống kê để chỗ trống thay vì số 0 giả` |
| Chỉ cột `Điểm chính` mang class nổi bật (`primary-col` ở header, `primary-score` ở cell), các cột điểm khác không | passing | `AdminSubmissionsPage.test.tsx::chỉ cột Điểm chính được đánh dấu nổi bật` |
| Panel `Kết quả` trong cuộc thi: không ô lọc/cột Cuộc thi, không gọi endpoint toàn cục, không thẻ thống kê, không nút `Lọc`; metric sort vẫn chạy qua endpoint của cuộc thi; lọc trạng thái áp dụng ngay; cột Điểm chính vẫn nổi bật | passing | `frontend/src/pages/AdminCompetitionDetailPage.test.tsx::tab Kết quả khóa bảng bài nộp vào cuộc thi đang mở` |
| Đổi trang giữ hàng cũ rồi thay bằng trang mới; lỗi tải có thông báo + nút thử lại; cuộc thi xoá hiện tên không có link | passing | `AdminSubmissionsPage.test.tsx::đổi trang giữ bảng cũ, báo đang bận rồi render trang mới`, `::lỗi tải danh sách hiện thông báo và nút thử lại gọi lại đúng trang`, `::cuộc thi đã xóa hiện tên nhưng không có link để mở` |
| CSS nằm trong `frontend/src/index.css`, không thêm utility/Tailwind | passing | `frontend/src/test/designSystemGuard.test.ts` (suite frontend) |

### Notebook khung và trang Hướng dẫn

| Check | Status | Cách verify |
|---|---|---|
| Khách **chưa đăng nhập** tải được `/api/starter-notebook`: `application/x-ipynb+json`, `nosniff`, `cache-control: public, max-age=3600`, `Content-Disposition` an toàn và **không** chứa `__` | passing | `backend/tests/test_starter_notebook.py::test_anonymous_visitor_can_download` |
| Body là notebook **v4 hợp lệ** qua đúng `validate_notebook()` dùng cho bài sinh viên nộp; có bước khai báo thư viện (`numpy`, `pandas`), `SEED = 42` + `random.seed(SEED)`/`np.random.seed(SEED)`, hai bước `TODO` của thí sinh (`# 5. TIỀN XỬ LÝ DỮ LIỆU`, `# 6. HUẤN LUYỆN MÔ HÌNH`), scaffold `to_csv(OUTPUT_FILE, index=False)` và cả cell markdown lẫn cell code (không phải stub rỗng) | passing | `test_starter_notebook.py::test_body_is_a_valid_v4_scaffold_with_imports_seed_and_student_todo_steps` |
| Khung **không** còn "Checklist tái lập kết quả" lẫn bảng "Lỗi thường gặp" (kể cả `PYTHONHASHSEED`, `pip freeze`) | passing | `test_starter_notebook.py::test_scaffold_drops_reproducibility_checklist_and_error_table` |
| Asset nằm trong `app/competitions/` (để `COPY app ./app` mang theo); thiếu asset lúc deploy → 500 `STARTER_NOTEBOOK_MISSING` chứ không phải 404 HTML | passing | `test_starter_notebook.py::test_asset_lives_inside_the_package` |
| Endpoint không truy vấn Mongo/MinIO, không cần auth, không tạo bản sao theo cuộc thi | passing | `backend/app/competitions/starter_notebook.py` chỉ đọc file module + `lru_cache`; test trên chạy được khi không có Mongo/MinIO |
| Trang Hướng dẫn dựng **đúng bốn khối** bằng cấu hình thật của cuộc thi (`id_column`, `prediction_column`, `average`, `pos_label`, hai trần dung lượng) | passing | `frontend/src/pages/CompetitionGuidePage.test.tsx::bốn khối hướng dẫn dùng đúng cấu hình của cuộc thi` (đếm toàn bộ heading cấp 3, nên khối thừa cũng làm đỏ) |
| Ví dụ CSV đúng tên cột của cuộc thi; cuộc thi chưa cấu hình rơi về `id,prediction` và **không** lộ `null`/`undefined` | passing | `CompetitionGuidePage.test.tsx::cuộc thi chưa cấu hình chấm điểm vẫn đọc được hướng dẫn, không lộ null/undefined` |
| Trang Hướng dẫn **không** còn khối seed/tái lập và khối lỗi thường gặp (chúng chỉ còn ở tab `Nộp bài`) | passing | Cùng test trên - danh sách heading cấp 3 phải bằng đúng bốn tên khối |
| CTA tải notebook khung gọi endpoint công khai và báo lỗi bằng `role="alert"` tại chỗ, nút bật lại sau lỗi | passing | `CompetitionGuidePage.test.tsx::CTA tải notebook khung gọi endpoint công khai và báo lỗi bằng alert` |
| Nội dung hướng dẫn và trang `Nộp bài` dùng **cùng** một nguồn (`frontend/src/lib/submissionRequirements.ts`), không có hai bản mô tả lệch nhau | passing | `frontend/src/lib/submissionRequirements.test.ts` (3 test: config đầy đủ, fallback rỗng, mọi pitfall có mã + mô tả; chỉ `VALUE_OUT_OF_RANGE` mang tone cảnh báo) |
| Mục `Hướng dẫn` đứng **ngay sau** `Tổng quan`, mở được và không cần đăng nhập; nav vẫn là link route + `aria-current`, không giả `role=tab` | passing | `frontend/src/pages/CompetitionDetailPage.test.tsx::mục Hướng dẫn đứng ngay sau Tổng quan, mở được và không cần đăng nhập` |
| Trang Hướng dẫn là route riêng, không hiện sidebar mục lục nội dung, đặt đúng tiêu đề tab | passing | `CompetitionDetailPage.test.tsx::trang Hướng dẫn mở công khai ở route riêng, không hiện sidebar mục lục nội dung` |
| Khách mở `/competitions/<slug>/huong-dan` **không** bị đẩy về `/login` | passing | `frontend/src/App.test.tsx::khách mở trang Hướng dẫn của cuộc thi, không bị đẩy về /login` |
| Block `Tài nguyên` luôn có notebook khung built-in, count = `1 + số link ngoài hợp lệ`; cuộc thi **không** có link ngoài vẫn thấy block | passing | `CompetitionDetailPage.test.tsx::cuộc thi không có link ngoài vẫn thấy block tài nguyên với notebook khung` + test tài nguyên hiện có (count `3`, 3 `.resource-link`) |
| Tải notebook khung gọi đúng endpoint; lỗi tại chỗ không làm mất các link Drive đã lọc an toàn | passing | `CompetitionDetailPage.test.tsx::tải notebook khung gọi đúng endpoint và báo lỗi tại chỗ khi máy chủ từ chối` |
| `competitions.resources` **không** chứa URL nội bộ; allowlist Drive/Docs và form tạo/sửa tài nguyên không đổi | passing | `frontend/src/components/CompetitionResources.tsx` chỉ thêm item built-in ngoài danh sách đã lọc `isSafeResourceUrl`; test tài nguyên cũ vẫn xanh |
| Trang Hướng dẫn dùng lại nhịp khối `.ov-*` của Tổng quan, chỉ thêm `.guide-code` | passing | `frontend/src/index.css` (comment tại chỗ nêu rõ lý do tái dùng); `.guide-steps` đã xoá cùng khối seed/tái lập |

### Smoke browser trên stack dev (chạy thật 2026-09-20, image build từ chính working tree này)

Hai script, đều chạy trên `docker compose up -d --build api web` (không mock `/api`, có Mongo + MinIO
thật): `node /tmp/uiverify/adr029-smoke.mjs` cho batch này và `node /tmp/uiverify/artifact-smoke.mjs`
(§13, đã cập nhật sang hợp đồng mới) để chắc luồng nộp/tải cũ không vỡ. Kết quả: **46/46 PASS**
(43/43 ở lượt 2026-09-19, thêm ba case cho nội dung Hướng dẫn/notebook mới) và **26/26 PASS**. Ảnh
ở `/tmp/vku-shots/adr029-smoke` và `/tmp/vku-shots/artifact-smoke`. Sau lượt 2026-09-20, case thống
kê đối chiếu với chính `stats` của response thay vì con số cứng 18/2/2/18 - DB dev tăng một bài nộp
sau mỗi lượt `artifact-smoke.mjs` nộp thật, nên con số cứng cũ đã lỗi thời chứ không phải hồi quy.

| Check | Status | Kết quả đo được |
|---|---|---|
| Khách chưa đăng nhập mở `/competitions/ai-challenge/huong-dan`: không bị đẩy về `/login`, không có ô mật khẩu | passing | URL giữ nguyên `/huong-dan`; `input[type=password]` = 0 |
| Hướng dẫn đúng **bốn khối**, đã bỏ khối seed/tái lập và khối lỗi thường gặp; ví dụ CSV dùng đúng cột của cuộc thi | passing | `Hai tệp bắt buộc trong mỗi lượt nộp / Định dạng tệp prediction.csv / Notebook tái lập (.ipynb) / Notebook khởi đầu`; toàn văn `section.guide` không còn chữ `seed` lẫn `lỗi thường gặp`; code block mở đầu bằng `id,prediction` |
| Đã bỏ câu "Hệ thống chỉ kiểm tra cấu trúc… **không được thực thi** trên máy chủ" | passing | Toàn văn `section.guide` không chứa chuỗi `không được thực thi` |
| Menu cuộc thi đúng thứ tự và mục đang mở có `aria-current` | passing | `Tổng quan \| Hướng dẫn \| Nộp bài \| Bài đã nộp \| Bảng xếp hạng`, `aria-current="page"` ở `Hướng dẫn` |
| CTA tải notebook khung chạy thật cho khách | passing | Tên tệp `starter-notebook.ipynb`, body parse JSON, `nbformat == 4`, có `SEED = 42`, `import numpy as np`, `import pandas as pd`, hai bước `# 5. TIỀN XỬ LÝ DỮ LIỆU`/`# 6. HUẤN LUYỆN MÔ HÌNH`; không còn `Checklist tái lập kết quả` lẫn `Lỗi thường gặp` |
| Hướng dẫn không tràn ngang ở 1280 và 375 | passing | `scrollWidth == innerWidth` ở cả hai bề rộng |
| Cuộc thi **không** có link ngoài (`ai-challenge-6`) vẫn thấy block `Tài nguyên` | passing | Count `1`, đúng một `button.resource-link` là `Notebook khởi đầu (.ipynb)`, tải được |
| Admin toàn cục: không còn nút `Lọc`; đúng bảy cột mang `aria-sort` | passing | 0 nút `Lọc`; 7 `th[aria-sort]` (`Trạng thái`/`Tệp đã nộp` không có) |
| Bảy cột gửi đúng `sort`/`order`/`offset` lên server và đổi `aria-sort` tại chỗ | passing | `competition`/`team` → `order=asc`; `f1`/`precision`/`recall`/`primary_score`/`created_at` → `order=desc`; mọi lượt `offset=0`, `aria-sort` khớp chiều |
| Chỉ cột `Điểm chính` được nhấn nổi bật | passing | `th.primary-col` = 1, nhãn `ĐIỂM CHÍNH`; các cột F1/Precision/Recall không có |
| Bốn thẻ thống kê khớp `stats` của response và tính lại theo bộ lọc | passing | Lượt 2026-09-20: không lọc `19/2/2/19` (khớp `stats` của response); sau khi lọc một cuộc thi `17/1/2/17` |
| Đổi ô lọc cuộc thi gọi server **ngay** và quay về trang đầu | passing | Request phát ngay với `competition_id=…&offset=0`, không cần bấm nút |
| Tên artifact tải thật chỉ còn **một** `_` mỗi phân cách | passing | `ai-challenge_Admin_submission-0007_prediction.csv`, `ai-challenge_Đội-01_submission-0010_{prediction.csv,notebook.ipynb}` - không tên nào chứa `__` |
| Panel `Kết quả` của cuộc thi: không thẻ thống kê, không cột Cuộc thi, không nút `Lọc`, không gọi endpoint toàn cục | passing | Header chỉ còn `thời gian đội tệp đã nộp trạng thái f1 precision recall điểm chính`; request duy nhất đi vào `/api/admin/competitions/<id>/submissions` |
| Panel `Kết quả`: sort metric qua endpoint của cuộc thi, lọc trạng thái áp dụng ngay | passing | `?limit=50&offset=0&sort=f1&order=desc` rồi `…&status=completed`, cùng path scoped |
| Không tràn ngang ở 1280 và 375 cho `/admin/submissions` | passing | `scrollWidth == innerWidth` ở cả hai bề rộng |
| Luồng cũ không vỡ sau batch này (§13): nộp hai tệp, tải lại đúng bytes, admin tải chéo được, lọc đội tức thời, empty state | passing | `artifact-smoke.mjs` 26/26 PASS, gồm 3 case mobile 375 |
| Notebook khung tải bằng HTTP trên hạ tầng thật | passing (local) | Qua nginx của compose dev: `200`, `content-type: application/x-ipynb+json`, `content-length: 7056`, `nosniff`, `cache-control: public, max-age=3600`, `attachment; filename="starter-notebook.ipynb"` |
| Notebook khung tải từ **production** mở được bằng nbformat | planned | `curl -sI https://<host>/api/starter-notebook` → 200 + `application/x-ipynb+json`, rồi parse JSON kiểm `nbformat == 4` |
