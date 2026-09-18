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
| Publish/close transition đúng; sai trạng thái 422 INVALID_TRANSITION | passing | `backend/tests/test_competitions_admin.py` |
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
| Submit disabled + lý do rõ trước giờ mở/sau deadline (frontend derive, backend vẫn enforce) | passing | `frontend/src/pages/SubmissionPage.test.tsx` |
| Admin confirm destructive actions: xóa content/asset, đổi mã tham gia, member/account active toggle, thay ground truth | passing | `frontend/src/pages/AdminCompetitionDetailPage.test.tsx`, `frontend/src/pages/AdminAccountsPage.test.tsx` |
| Admin members tải đến 200 dòng (limit=200) + thông tin chung cuộc thi ở detail | passing | `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |
| Password admin UI: type=password, minLength 10, autoComplete new-password (create + reset) | passing | `frontend/src/pages/AdminAccountsPage.test.tsx` |
| Admin accounts phân trang thật: mock >200 dòng, Trang sau/trước đổi `offset` và chặn ở biên, tài khoản thứ 201+ tới được bằng UI, đổi từ khóa reset `offset=0`, response trang cũ không ghi đè kết quả mới, trang cuối rỗng thì lùi về trang còn dữ liệu | passing | `frontend/src/pages/AdminAccountsPage.test.tsx` |
| Trần upload động: admin detail + mọi response mutate trả `upload_limits`, list/public không có; env override phản ánh trong response; UI thiếu field thì rơi về `DEFAULT_UPLOAD_LIMITS`; file quá trần bị chặn ở client và không phát request | passing | `backend/tests/test_competitions_admin.py`, `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |

## 8. Hardening (Sprint 07) — passing

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
| Block "Tài nguyên tải về" nằm SAU "Mục lục nội dung" theo DOM; ẩn khi rỗng; link ngoài có `rel="noopener noreferrer nofollow"`; URL không hợp lệ bị FE lọc bỏ | passing | `frontend/src/pages/CompetitionDetailPage.test.tsx` |
| Payload public không có `created_by`; `pos_label` chỉ với thành viên active (guest/non-member/inactive không có key); admin vẫn nhận `created_by` | passing | `backend/tests/test_competitions_public.py` |
| Datetime naive/aware cùng instant normalize giống nhau; PATCH chỉ `start_at` hoặc chỉ `end_at` lệch thứ tự → 422 chứ không 500 | passing | `backend/tests/test_datetimes.py`, `backend/tests/test_competitions_admin.py` |
| Publish readiness: thiếu config / config invalid / thiếu ground truth / file hỏng / config+GT hợp lệ | passing | `backend/tests/test_scoring_admin.py`, `backend/tests/test_competitions_admin.py` |
| Publish thất bại giữ nguyên `draft`; join-code thiếu thắng readiness khi cả hai cùng thiếu; publish xong thì submission fixture chấm được | passing | `backend/tests/test_competitions_admin.py`, `backend/tests/test_submissions.py` |
| Admin detail trả `publish_ready`/`publish_blocked_reason`; banner + disable Publish; 422 vẫn hiện trong modal | passing | `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |
| Join: trước `start_at` thành công; non-member sau `end_at` → `JOIN_DEADLINE_PASSED` và không tạo membership; active member sau deadline/closed vẫn idempotent; inactive vẫn 403; closed thắng deadline | passing | `backend/tests/test_memberships.py`, `frontend/src/components/JoinControl.test.tsx` |
| Quota: đúng trước/sau khi nộp, `resets_at` ISO `Z`, loại bài của ngày hôm trước, quota 0; không có key quota trên guest/non-member/inactive/list | passing | `backend/tests/test_competitions_public.py`, `backend/tests/test_submissions.py` |
| UI quota: hiện "Còn X/Y lượt", khoá form khi remaining=0, nộp xong refetch detail | passing | `frontend/src/pages/{CompetitionDetailPage,SubmissionPage}.test.tsx` |
| Leaderboard: phân trang giữ rank toàn cục, `has_more`, tham số sai → 422; `me` đúng khi ngoài page, `null` khi chưa có bài completed, không chứa account id; admin/export vẫn full list | passing | `backend/tests/test_results.py` |
| UI leaderboard: paging gửi đúng params, disable nút ở biên, card hạng `#x/y`, highlight row của mình khi nằm trong page | passing | `frontend/src/pages/LeaderboardPage.test.tsx` |
| Leave: active/inactive/chưa join/draft; bài nộp + rank còn nguyên; `joined_at` giữ khi admin reactivate | passing | `backend/tests/test_memberships.py` |
| Hard-delete member: chưa nộp → xoá và dọn file; đã có bài completed → 409 và Mongo/file/membership đều còn | passing | `backend/tests/test_memberships.py` |
| Đếm thành viên: `active_total` tách khỏi `total` (kể cả document legacy thiếu `active`) | passing | `backend/tests/test_memberships.py`, `frontend/src/pages/AdminCompetitionDetailPage.test.tsx` |
| Delete competition: thiếu/sai `confirm_slug` không xoá gì; published/closed → 409; draft cascade sạch 4 collection + 2 thư mục, không đụng competition khác/accounts/sessions; lỗi dở đường giữ competition để retry | passing | `backend/tests/test_competitions_delete.py` |
| UI xoá competition: chỉ draft có action, modal bắt gõ đúng slug, 409 hiện trong modal, xoá từ detail thì về danh sách | passing | `frontend/src/pages/{AdminCompetitionsPage,AdminCompetitionDetailPage}.test.tsx` |
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
| Danh sách không có nút "Rời cuộc thi": thẻ đã tham gia chỉ còn "Đã tham gia" + link "Vào cuộc thi" (`showLeave={false}`); trang chi tiết vẫn giữ nút rời | passing | `frontend/src/pages/{DashboardPage,CompetitionDetailPage}.test.tsx`, `frontend/src/components/JoinControl.test.tsx` |
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

## 10. Production deploy (Sprint 08) — planned

| Check | Status |
|---|---|
| Docker Compose prod chạy trên GCE | planned |
| Cloudflare Tunnel serve HTTPS | planned |
| Smoke test production | planned |

## 11. Backup/restore & pilot (Sprint 09) — planned

| Check | Status |
|---|---|
| Backup + restore Mongo + /data | planned |
| Runbook pilot | planned |
