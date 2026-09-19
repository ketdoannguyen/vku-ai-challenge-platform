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

## 10. Production deploy (Sprint 08) - planned

| Check | Status |
|---|---|
| Docker Compose prod chạy trên GCE | planned |
| Cloudflare Tunnel serve HTTPS | planned |
| Smoke test production | planned |

## 11. Backup/restore & pilot (Sprint 09) - planned

| Check | Status |
|---|---|
| Backup + restore Mongo + /data | planned |
| Runbook pilot | planned |

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
| Gate frontend/backend chạy trên PR vào `release` | planned | Mở PR đầu tiên vào `release` và xem `release-gate / frontend`, `/ backend`, `/ deploy-script` xanh |
| Actions deploy Worker khi push vào `release` | planned | Cần secret ở environment `production`; xem `docs/DEPLOYMENT.md` §5.1 |
| Smoke tĩnh fail thì workflow tự rollback Worker | planned | Chưa diễn tập - xem "Failure drills" trong plan |
| Timer kéo commit mới về VM trong ~1 phút | planned | Cần bootstrap trên VM; xem `docs/DEPLOYMENT.md` §7.1 |
| Deploy lỗi trên VM tự rollback về image cũ | planned | Diễn tập bằng một commit cố tình hỏng |
| Trần thời gian `TimeoutStartSec=1800` đủ cho một lượt deploy thật | planned | Đo bằng `systemd-analyze`/`journalctl` ở lượt deploy thật đầu tiên |
