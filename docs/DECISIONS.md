# AI Challenge Platform - Decision Log

Format theo ADR. Chỉ ghi quyết định có ảnh hưởng về sau; thay decision cũ thì đánh dấu superseded và link decision mới, không xóa lịch sử.

## ADR-001 - Single GCE VM + Docker Compose
- Date: 2026-09-15
- Status: accepted
- Context: MVP phục vụ 40-80 đội; cần chi phí và vận hành tối thiểu.
- Decision: Toàn bộ runtime trên 01 Google Compute Engine VM (Ubuntu Server LTS), điều phối bằng Docker Compose. Không Kubernetes, không multi-VM, không Cloud Run.
- Consequences: Đơn giản, rẻ, dễ backup cả VM/disk. Không HA - chấp nhận được cho MVP.
- Affected files/contracts: `plans/01_MASTER_CONTEXT.md` §3, `docs/DEPLOYMENT.md`

## ADR-002 - Same-origin frontend/API through Nginx
- Date: 2026-09-15
- Status: accepted
- Context: Tránh phức tạp CORS và expose backend trực tiếp ra public.
- Decision: Nginx là reverse proxy duy nhất: `/` → React SPA (static + fallback), `/api/` → FastAPI container. Không map `/data` ra web.
- Consequences: Không cần CORS production; một public origin qua Cloudflare Tunnel.
- Cập nhật 2026-09-19: ADR-025 thêm một public entry mới (Cloudflare Workers Static Assets) phía trước, nhưng **giữ nguyên nguyên tắc của ADR-002**: browser vẫn chỉ thấy một origin duy nhất và `/api/*` vẫn đi qua Nginx same-origin. Nginx chỉ đổi vai trò từ public entry thành origin sau tunnel.
- Affected files/contracts: `plans/02_ARCHITECTURE_CONTRACTS.md` §2, `docs/API_CONTRACT.md` §1

## ADR-003 - MongoDB cho nghiệp vụ, persistent disk cho files
- Date: 2026-09-15
- Status: accepted
- Context: Cần lưu dữ liệu có cấu trúc (accounts, competitions, submissions) và files (Markdown, assets, ground truth, submissions CSV, backups).
- Decision: MongoDB lưu toàn bộ dữ liệu nghiệp vụ; files nằm trên persistent disk theo layout `/data/competitions/<id>/...` và `/data/submissions/<id>/...`. Không external object storage ở MVP.
- Consequences: Backup phải cover cả Mongo dump lẫn `/data`. Private files (ground truth, scoring config) tuyệt đối không được Nginx serve.
- Cập nhật 2026-09-19: ADR-028 **thay thế một phần** decision này - artifact của submission (CSV dự đoán + notebook) chuyển sang MinIO private. Phần còn nguyên: Mongo vẫn là nguồn sự thật của dữ liệu nghiệp vụ, và mọi file khác (content Markdown, asset, ground truth) vẫn nằm trên persistent disk theo layout cũ.
- Affected files/contracts: `plans/01_MASTER_CONTEXT.md` §11-12, `docs/DATA_MODEL.md`

## ADR-004 - Server-side sessions, no Firebase Auth
- Date: 2026-09-15
- Status: accepted
- Context: Tài khoản do BTC cấp, no self-registration; cần kiểm soát đầy đủ và đơn giản.
- Decision: Auth = account trong MongoDB + Argon2id password hash + server-side session. Transport bằng cookie HttpOnly + Secure (production) + SameSite. Session token là opaque random, entropy cao; DB lưu hash của token. Không Firebase/Firestore/OAuth ở MVP.
- Consequences: Restart backend không mất session (lưu DB). Cần TTL index dọn session hết hạn.
- Affected files/contracts: `plans/01_MASTER_CONTEXT.md` §3, §13; `plans/02_ARCHITECTURE_CONTRACTS.md` §6

## ADR-005 - Competition-centric multi-competition model
- Date: 2026-09-15
- Status: accepted
- Context: Một website chạy nhiều cuộc thi; không hard-code từng mùa thi.
- Decision: `competition` là entity trung tâm; mọi dữ liệu nghiệp vụ (memberships, content, submissions, scoring config, ground truth path, leaderboard, export) đều gắn `competition_id`. Không hard-code tên competition vào logic.
- Consequences: Mọi query/API phải scope theo competition; adding competition mới không cần deploy.
- Affected files/contracts: `plans/01_MASTER_CONTEXT.md` §5, `docs/DATA_MODEL.md`

## ADR-006 - Markdown content tách khỏi source code
- Date: 2026-09-15
- Status: accepted
- Context: Đề bài/rules thay đổi theo từng competition, do BTC quản lý, không nên đổi code mỗi kỳ thi.
- Decision: Markdown lưu trên disk (`/data/competitions/<id>/content/`), metadata (title, slug, order, visibility, markdown_path) lưu trong `competition_contents`. Frontend render GFM có sanitize; asset chỉ lấy từ thư mục assets của competition, cấm path traversal.
- Consequences: Cần validate path khi đọc file; HTML nguy hiểm phải sanitize/disable.
- Affected files/contracts: `plans/01_MASTER_CONTEXT.md` §9, §11; `plans/02_ARCHITECTURE_CONTRACTS.md` §8

## ADR-007 - MVP scoring: classification CSV only
- Date: 2026-09-15
- Status: accepted
- Context: MVP chỉ cần chấm bài phân loại bằng F1/Precision/Recall; schema khác sẽ xuất hiện ở các kỳ thi sau.
- Decision: Submission chỉ nhận `.csv`. Scoring engine hỗ trợ classification với config: `id_column`, `prediction_column`, `label_column`, `average` (binary/macro/weighted), `pos_label`, `primary_metric`, `higher_is_better=true`. Align theo ID, `zero_division=0`. Leaderboard lấy best valid submission mỗi account.
- Consequences: Nếu kỳ thi thực tế cần schema/scoring khác, phải dừng và hỏi người dùng trước khi mở rộng engine.
- Affected files/contracts: `plans/01_MASTER_CONTEXT.md` §10, `plans/02_ARCHITECTURE_CONTRACTS.md` §9-10

## ADR-008 - Session representation & per-request resolution
- Date: 2026-09-15
- Status: accepted
- Context: ADR-004 chốt server-side session, DB lưu hash token, nhưng chưa chốt chi tiết representation và luồng resolve.
- Decision: Session `_id` = sha256 hex của raw token `secrets.token_urlsafe(32)`; `account_id` là ObjectId khớp `accounts._id`. Mọi request đi qua middleware resolve session → account (check `expires_at` + `active`) và gắn vào `request.state.account`; dependency `get_current_account`/`get_current_admin` chỉ đọc state đó. TTL index trên `expires_at` là cơ chế dọn dẹp, không phải cơ chế enforcement.
- Consequences: Disable account có hiệu lực tức thì với mọi session hiện có. Login sai email và sai password trả cùng response 401 generic. Không log raw token/password. `SESSION_SECRET` hiện không dùng (token opaque, không cần ký).
- Affected files/contracts: `docs/DATA_MODEL.md` §2, `docs/API_CONTRACT.md` §2, `backend/app/auth/`

## ADR-009 - Competition lifecycle, edit rules, clone & visibility
- Date: 2026-09-15
- Status: accepted, riêng mệnh đề "`closed` là terminal - không reopen" đã bị ADR-027 thay thế
- Context: Sprint 03 cần chốt status transition, quy tắc edit theo trạng thái, hành vi clone và participant visibility; sprint file yêu cầu "clear rules" nhưng không chỉ định chi tiết.
- Decision:
  - Lifecycle: create → `draft`; `draft` → `published` (publish); `published` → `closed` (close). `closed` là terminal - không reopen/archive ở MVP (sprint file: dừng và hỏi nếu cần).
  - Edit theo status: `draft` sửa mọi config field; `published` mọi field trừ `primary_metric` (ảnh hưởng leaderboard đã có); `closed` read-only. `slug`, `status`, `created_by` luôn immutable - status chỉ đổi qua endpoint publish/close.
  - Clone: copy config (name/mô tả/join_mode/metric/quota/leaderboard_visible) thành draft mới với slug tự sinh `<slug>-copy`; KHÔNG copy status, dates (now → +1 năm), submissions, memberships. Content/ground-truth clone defer Sprint 04.
  - Visibility participant: API public chỉ trả `published` + `closed`; `draft` trả 404 như không tồn tại (không tiết lộ sự tồn tại).
- Consequences: Quota 0-1000, slug ≤64 ký tự enforced ở API layer. Publish/close sai trạng thái → 422 `INVALID_TRANSITION`. Không reopen - nếu BTC cần, phải hỏi user trước khi thêm transition mới.
- Affected files/contracts: `backend/app/competitions/`, `docs/API_CONTRACT.md` §3+§5.2, `docs/DATA_MODEL.md` §3

## ADR-010 - Sprint 04: membership policies, content storage & safe Markdown
- Date: 2026-09-15
- Status: accepted
- Context: Sprint 04 cần chốt participant route convention, join policies, join code provisioning, content storage/visibility, asset allowlist và Markdown render stack. Các lựa chọn đã được user xác nhận.
- Decision:
  - Participant route dùng `{slug}` nhất quán (join/contents/assets); admin giữ `{id}`. Cập nhật `plans/02_ARCHITECTURE_CONTRACTS.md` §4 thay baseline `{id}`.
  - Join policies: draft → 404; closed → 422 `JOIN_CLOSED` (không join mới); membership inactive → 403 `MEMBERSHIP_INACTIVE`, chỉ admin kích hoạt lại (reactivate giữ `joined_at`); join idempotent qua unique compound index + bắt DuplicateKeyError; thiếu và sai code trả cùng 403 `JOIN_CODE_INVALID` (không tạo oracle).
  - Join code: admin tự đặt/đổi qua `PUT .../join-code` (8-128 ký tự); lưu Argon2id hash (tái dùng `auth/passwords.py`), raw không lưu/trả/log; publish competition mode `code` chưa có code → 422 `JOIN_CODE_REQUIRED`.
  - Content visibility: `public` = mọi account đã đăng nhập (không anonymous API); `members` = membership active. Trang không được xem → 404 (không tiết lộ tồn tại). Closed vẫn đọc được.
  - Storage: `<DATA_DIR>/competitions/<cid>/content/<content_id>.md` (ObjectId sinh trước insert); atomic write (temp + fsync + os.replace); read qua resolve + containment check + `O_NOFOLLOW`; mọi path do backend sinh.
  - Assets: PNG/JPEG/GIF/WebP ≤2 MiB, sniff magic bytes (không tin MIME header), không SVG (vector XSS); tên `uuid4.<ext>`; serve qua API có authz + `nosniff` + `private, max-age=300`; không có DB collection.
  - Markdown frontend: `react-markdown` + `remark-gfm` + `rehype-sanitize` (default schema), KHÔNG `rehype-raw`/`dangerouslySetInnerHTML`; ảnh chỉ chấp nhận relative `assets/...` transform sang `/api/competitions/{slug}/assets/...`; link ngoài `target="_blank" rel="noopener noreferrer"`.
  - Clone vẫn KHÔNG copy content/assets/memberships (tiếp tục defer).
- Consequences: Thêm deps `python-multipart` (backend) và `react-markdown`/`remark-gfm`/`rehype-sanitize` (frontend). Env mới `MAX_CONTENT_MB=2`, `MAX_ASSET_MB=2` (dùng chung `MAX_UPLOAD_MB` cho submission Sprint 05). Nginx `client_max_body_size 12m` đã lớn hơn các limit. **[Sửa bởi ADR-028: Nginx nay là `32m` vì mỗi lượt nộp mang theo cả CSV lẫn notebook tới 20 MiB.]**
- Affected files/contracts: `backend/app/memberships/`, `backend/app/content/`, `frontend/src/markdown/`, `docs/API_CONTRACT.md` §3+§5.3+§5.4, `docs/DATA_MODEL.md` §4-5b, `plans/02_ARCHITECTURE_CONTRACTS.md` §4

## ADR-011 - Sprint 05: scoring ownership, locking and rejected uploads
- Date: 2026-09-15
- Status: accepted
- Context: Sprint 05 cần tránh drift giữa competition fields, environment và `scoring_config.json`; đồng thời phải chốt khả năng thay ground truth sau khi đã có điểm và policy lưu bài validation-rejected. User đã xác nhận trực tiếp các lựa chọn này.
- Decision:
  - Không dùng `scoring_config.json`. Mongo competition là nguồn duy nhất cho config theo cuộc thi: `primary_metric` và `quota_per_day` tiếp tục ở top-level; `scoring_config` chỉ chứa `id_column`, `prediction_column`, `label_column`, `average`, `pos_label`, `higher_is_better=true`.
  - `MAX_UPLOAD_MB=10` là giới hạn chung toàn platform từ environment; không có upload limit riêng từng competition và không copy giá trị này vào Mongo.
  - Ground truth nằm ở `<DATA_DIR>/competitions/<id>/private/ground_truth.csv`; Mongo chỉ giữ path tương đối và metadata an toàn (row count, columns, uploaded time). Không có participant/public download endpoint.
  - Admin được cấu hình hoặc thay ground truth khi competition draft/published và chưa có submission `completed`. Closed hoặc đã có điểm đầu tiên thì cả config và ground truth bị khóa; không rescore lịch sử trong MVP.
  - Validation-rejected upload chỉ trả lỗi cho participant; không lưu record và không giữ file. Quota ngày chỉ đếm submission `completed`, reset theo ngày UTC.
  - Scoring synchronous bằng scikit-learn, align theo ID, tính F1/Precision/Recall với cùng average/pos_label và `zero_division=0`. CSV UTF-8/UTF-8 BOM, tối đa 1.000.000 dòng bên cạnh byte limit.
- Consequences: Config không có dữ liệu trùng để drift. Bài đã có điểm luôn so sánh trên cùng ground truth/config. Invalid upload không tạo audit trail và không tiêu quota; Sprint 06 chỉ cần query các record completed.
- Affected files/contracts: `backend/app/scoring/`, `backend/app/submissions/`, `docs/API_CONTRACT.md` §3-5, `docs/DATA_MODEL.md` §3+§6-8

## ADR-012 - Sprint 06: derived ranking, visibility and safe XLSX export
- Date: 2026-09-15
- Status: accepted
- Context: Sprint 06 cần biến completed submissions thành lịch sử, ranking và báo cáo Excel mà không thay đổi policy persistence/scoring của Sprint 05.
- Decision:
  - Mọi result đều query theo `competition_id`; leaderboard chỉ dùng `status=completed`, lấy submission tốt nhất mỗi account.
  - Ranking ordinal `1..N`: `primary_score DESC`, sau đó `created_at ASC`; nếu cả hai bằng tuyệt đối thì `account_id` và submission `_id` làm tertiary key để kết quả deterministic. Không dense rank/freeze snapshot trong MVP.
  - Participant leaderboard bị chặn ở backend bằng 403 `LEADERBOARD_HIDDEN` khi config ẩn; admin luôn xem được. Participant response không có email/account id; history không có account id/server path.
  - Validation-rejected tiếp tục không persist theo ADR-011. History/admin serializers chỉ đọc optional safe error fields để tương thích nếu có record `failed|rejected` từ luồng tương lai.
  - Export là một sheet `Results` chứa best result và completed submission count; không có full-history sheet/download participant CSV. Formula-like text được prefix apostrophe, ký tự control không hợp lệ bị loại.
- Consequences: Không cần migration dữ liệu, chỉ thêm query indexes. Ranking được tính lúc đọc, phù hợp quy mô 40-80 đội; nếu cần snapshot/public-private split/dense rank phải có quyết định mới.
- Affected files/contracts: `backend/app/leaderboard/`, `backend/app/submissions/`, `docs/API_CONTRACT.md` §4+§5.5, `docs/DATA_MODEL.md` §6

## ADR-013 - Sprint 07: login abuse control, API failure envelope and CSP rollout
- Date: 2026-09-16
- Status: accepted
- Context: Release candidate cần chặn brute-force đăng nhập ở quy mô 40-80 users, giữ error response ổn định và thêm CSP mà chưa biết cấu hình Cloudflare/domain thật của Sprint 08. User xác nhận chỉ rate-limit login, không rate-limit join code trong sprint này.
- Decision:
  - Login dùng limiter in-process, không Redis/dependency mới: key là identifier email đã `strip().lower()`, tối đa 10 lần sai trong cửa sổ 15 phút; lần tiếp theo trả 429 `RATE_LIMITED` + `Retry-After`. Login đúng reset counter. State process-local, bounded 10.000 identifier và mất khi API restart.
  - Không dựa vào client IP trước khi Sprint 08 chốt trusted proxy/Cloudflare headers; không áp limiter cho join code ở Sprint 07.
  - Unhandled exception trả JSON 500 `INTERNAL_ERROR` với message generic; 405 có code `METHOD_NOT_ALLOWED`. Traceback chỉ ghi server log, không trả client.
  - Nginx thêm `Permissions-Policy` và `Content-Security-Policy-Report-Only` theo same-origin; chưa enforce CSP và chưa thêm HSTS trước HTTPS/Cloudflare production.
- Consequences: Một actor biết email có thể gây lockout tối đa 15 phút cho email đó; state không chia sẻ nếu sau này chạy nhiều API worker. Đây là trade-off MVP được chấp nhận và phải review lại khi thay topology ở Sprint 08. CSP violations chỉ quan sát, chưa block; enforce sau browser smoke trên domain thật.
- Affected files/contracts: `backend/app/auth/rate_limit.py`, `backend/app/auth/router.py`, `backend/app/main.py`, `frontend/nginx.conf`, `docs/API_CONTRACT.md` §2+§6

## ADR-014 - Sprint 08: đọc công khai cho khách (danh sách, chi tiết, nội dung public)
- Date: 2026-09-17
- Status: accepted
- Context: Nút "quay lại" ở `/login` bấm được và `navigate("/")` chạy, nhưng `RequireAuth` đẩy ngược về `/login` vì `/` đòi phiên, và backend cũng trả 401 cho `GET /api/competitions` khi ẩn danh - người dùng không có lối về dashboard. User chọn hướng mở dashboard cho khách thay vì sửa nút quay lại.
- Decision:
  - Thêm `get_optional_account`/`OptionalAccount` (`backend/app/auth/dependencies.py`): trả `request.state.account` hoặc `None` thay vì 401. Middleware sẵn có chỉ set `request.state.account` khi có cookie phiên nên không cần đổi gì thêm.
  - Chuyển sang auth tuỳ chọn: `GET /api/competitions`, `GET /api/competitions/{slug}`, `GET /api/competitions/{slug}/contents`, `.../contents/{content_slug}`, `.../assets/{name}`.
  - Khách không có membership nào nên `membership = {active:false, joined_at:null}` và chỉ thấy content `visibility=public`; content `members` vẫn 404 (không tiết lộ tồn tại). Draft vẫn 404 với mọi đối tượng, ở cả list lẫn detail.
  - **Thay đổi so với ADR-010**, vốn ghi "public = mọi account đã đăng nhập (không anonymous API)". Từ ADR-014, `public` nghĩa là "mọi người, kể cả khách"; `members` không đổi.
  - Vẫn yêu cầu đăng nhập (401, dùng `CurrentAccount`): join, submissions, submissions/me, leaderboard. Frontend giữ ranh giới tương ứng: bỏ `RequireAuth` ở `/` và route cha `/competitions/:slug`, bọc lại cho 3 route con `submit`/`submissions`/`leaderboard`.
  - Điều hướng khách: navbar hiện mục "Cuộc thi"; drawer mobile (dưới 40rem nút "Đăng nhập" trên header bị ẩn) có thêm lối "Đăng nhập"; thẻ cuộc thi hiện CTA "Đăng nhập để tham gia" kèm `state.from` để quay lại đúng trang, thay vì bắn POST join rồi ăn 401. Ô thống kê "Đã tham gia" bị ẩn với khách vì luôn bằng 0.
- Consequences: `assets/{name}` trước đây chỉ đòi đăng nhập chứ không kiểm tra visibility của content; mở cho khách giữ nguyên mức phơi nhiễm với participant và mở rộng thêm cho khách - chấp nhận để ảnh trong nội dung public hiển thị. `Cache-Control: private, max-age=300` giữ nguyên. Leaderboard vẫn chặn đăng nhập vì nằm ngoài phạm vi user xác nhận.
- Affected files/contracts: `backend/app/auth/dependencies.py`, `backend/app/competitions/router.py`, `backend/app/content/router.py`, `frontend/src/App.tsx`, `frontend/src/components/JoinControl.tsx`, `frontend/src/pages/DashboardPage.tsx`, `docs/API_CONTRACT.md` §3, `docs/TEST_MATRIX.md` §4-5

## ADR-015 - Tài nguyên cuộc thi là link Google Drive, không host binary
- Date: 2026-09-17
- Status: accepted
- Context: BTC cần chỗ khai báo dataset/sample submission cho thí sinh, nhưng nền tảng không có object storage và không muốn biến máy chủ thi thành nơi phân phối file nặng. User chốt: "về dataset chỉ cho phép update link drive thôi, ko cho ảnh lên hệ thống".
- Decision:
  - Thêm `competitions.resources`: list `{label, url}`, tối đa 10 mục, label ≤120 ký tự, url ≤2048 ký tự, bắt buộc `https`, không credentials, host thuộc `drive.google.com`/`docs.google.com` (kể cả subdomain).
  - Không upload dataset/zip/binary lên hệ thống; không proxy download, không gọi Drive API, không lưu kích thước/version/checksum. Platform chỉ validate shape của URL và **không** kiểm tra link còn truy cập được.
  - FE re-filter URL lần nữa trước khi render anchor (`target="_blank"`, `rel="noopener noreferrer nofollow"`) để document legacy/DB sửa tay không tạo được link nguy hiểm; không dùng attribute `download` vì cross-origin.
  - Block "Tài nguyên tải về" nằm dưới "Mục lục nội dung" trong tab Tổng quan, ẩn khi rỗng. Feature upload ảnh dùng trong Markdown giữ nguyên, không liên quan.
- Consequences: Rủi ro chuyển sang phía BTC - link có thể private/hết hạn mà platform không biết; helper text yêu cầu bật "Bất kỳ ai có liên kết". Đổi lại không có file người dùng nào đi vào `/data`, không tốn dung lượng, không cần thêm hạ tầng.
- Affected files/contracts: `backend/app/competitions/service.py` (`normalize_resources`, `_validate_resource_url`), `frontend/src/components/CompetitionResources.tsx`, `docs/API_CONTRACT.md` §3+§5.6, `docs/DATA_MODEL.md` §9

## ADR-016 - Tách representation public/admin, không lộ `created_by`/`pos_label`, chuẩn hoá datetime
- Date: 2026-09-17
- Status: accepted
- Context: Payload public trả `created_by` (email admin) cho cả khách ẩn danh, và `submission_config.pos_label` cho cả người chưa join. `pos_label` là nhãn dương thật của ground truth nên tiết lộ nó cho non-member là rò thông tin đề bài.
- Decision:
  - Một serializer public (`public_competition`) cho guest/participant: **không bao giờ** có `created_by`; `submission_config.pos_label` chỉ xuất hiện khi membership đang active. Guest, non-member và inactive member không nhận key này.
  - Một serializer admin (`admin_competition`) cho route `/api/admin/...`: có `created_by` và luôn có `pos_label` (admin đã thấy ground truth).
  - Không thêm field admin-only nào trở lại serializer public; mọi field mới phải xác định rõ nó thuộc bên nào.
  - Chuẩn hoá luôn việc xử lý datetime: helper dùng chung ở `backend/app/core/datetimes.py` (`as_utc`, `utc_day_bounds`, `iso_z`), naive datetime từ motor được hiểu là UTC. Trước đó PATCH chỉ một trong `start_at`/`end_at` có thể so aware với naive và trả 500 thay vì 422.
- Consequences: FE TypeScript bỏ `created_by` khỏi `Competition` (chỉ `AdminCompetition` có). `pos_label` là optional ở type dùng chung, nên chỗ render phải chịu được thiếu key. Không có migration.
- Affected files/contracts: `backend/app/competitions/service.py`, `backend/app/core/datetimes.py`, `frontend/src/api/competitions.ts`, `docs/API_CONTRACT.md` §3

## ADR-017 - Publish phải chấm được, join mở đến hết `end_at`
- Date: 2026-09-17
- Status: accepted
- Context: Publish chỉ kiểm tra trạng thái nên BTC publish được một cuộc thi thiếu scoring config hoặc ground truth hỏng - mọi bài nộp sau đó đều 422 `SCORING_NOT_READY`. Ở chiều ngược lại, join chỉ chặn draft/closed nên thí sinh vẫn join được sau `end_at` cho tới khi admin bấm close thủ công.
- Decision:
  - `backend/app/scoring/readiness.py` là **một** nguồn sự thật cho readiness *chấm điểm*: đọc và parse lại ground truth thật bằng chính code chấm điểm (không chỉ `is_file()`), trả `{ready, code, message}`. Endpoint scoring và `_publish_blocked_reason` đều đi qua đây.
  - Cổng publish là **phép gộp** của hai điều kiện (mã tham gia + readiness chấm điểm), nằm ở `_publish_blocked_reason` trong `backend/app/competitions/admin_router.py` và dùng chung cho cả endpoint publish lẫn `publish_blocked_reason` của admin detail. Không tách làm hai chỗ: bản đầu chỉ kiểm tra join code ở endpoint nên banner báo sẵn sàng trong khi bấm Publish vẫn 422 `JOIN_CODE_REQUIRED`.
  - Thứ tự kiểm tra khi publish: join code (`JOIN_CODE_REQUIRED`) trước, readiness sau (`SCORING_CONFIG_REQUIRED`/`SCORING_CONFIG_INVALID`/`GROUND_TRUTH_REQUIRED`/`GROUND_TRUTH_INVALID`). Publish thất bại giữ nguyên `draft`; submission runtime vẫn map về code chung `SCORING_NOT_READY` để không phá contract cũ.
  - Admin detail trả `publish_ready`/`publish_blocked_reason` = kết quả `_publish_blocked_reason`, nên banner và nút Publish luôn khớp cổng thật ở endpoint; list cố ý không, vì readiness phải đọc file (N+1). Nút Publish ở list vẫn gọi backend và hiển thị lỗi API.
  - Join mở từ lúc publish đến hết `end_at`. Không có khái niệm "hạn đăng ký". Không kiểm tra `start_at` - join sớm để chuẩn bị là hợp lệ, chỉ nộp bài mới phụ thuộc `start_at`.
  - Thứ tự policy join: draft/unknown → 404; inactive membership → 403; đã join → 200 idempotent (kể cả sau deadline/closed); closed → `JOIN_CLOSED`; `now > end_at` → `JOIN_DEADLINE_PASSED`; rồi mới tới invite/code. Membership hiện có được xử lý trước cửa sổ thời gian để UI luôn đọc được trạng thái của mình.
- Consequences: BTC phải có config + ground truth hợp lệ trước khi mở cuộc thi; đổi lại không còn tình huống publish xong mà không ai nộp được. `JOIN_CLOSED` và `JOIN_DEADLINE_PASSED` cùng 422 nhưng khác code để UI phân biệt "BTC đã đóng" với "đã quá hạn". Banner publish của admin detail giờ có thể mang `JOIN_CODE_REQUIRED`, nên nút CTA chọn tab theo `code` (mã tham gia nằm ở tab Thành viên, không phải tab Chấm điểm).
- Affected files/contracts: `backend/app/scoring/readiness.py`, `backend/app/competitions/admin_router.py`, `backend/app/memberships/router.py`, `frontend/src/components/JoinControl.tsx`, `docs/API_CONTRACT.md` §3+§5.2+§6

## ADR-018 - Xoá theo hướng giữ lịch sử thi
- Date: 2026-09-17
- Status: accepted, riêng mệnh đề "xoá competition chỉ cho `draft`" đã bị ADR-027 nới thành `draft` + `closed`
- Context: Thiếu cả ba đường thoát: participant không rời được cuộc thi, admin không xoá cứng được member, và không có `DELETE` cho competition. Đồng thời phải tránh việc dọn dữ liệu làm mất kết quả đã chấm.
- Decision:
  - Participant **rời** cuộc thi = soft deactivate (`active=false`) qua `POST /leave`, áp dụng cả published/closed, idempotent, giữ nguyên bài nộp/điểm/thứ hạng. Tự join lại vẫn bị 403 `MEMBERSHIP_INACTIVE`; muốn quay lại phải nhờ BTC kích hoạt.
  - Admin **xoá cứng member** chỉ khi account chưa có bài `completed` trong cuộc thi (`has_completed_submission`). Có bài đã chấm → 409 `MEMBER_HAS_SUBMISSIONS` và không xoá gì. Khi được phép: xoá record submission chưa hoàn thành + file (best-effort, containment-check) rồi xoá membership sau cùng. Không có "force" flag.
  - **Xoá competition chỉ cho `draft`** (`confirm_slug` phải khớp, sai → 422 `CONFIRM_SLUG_MISMATCH`, không phải draft → 409 `COMPETITION_NOT_DELETABLE`). Published/closed phải giữ lịch sử; muốn kết thúc thì Đóng cuộc thi.
  - Cascade không dùng transaction (Mongo standalone): xoá con trước, cha sau, để lỗi giữa đường vẫn retry được. File dọn **sau** khi DB xong, best-effort; không phục hồi DB nếu xoá file lỗi mà báo `files_removed:false`.
  - `member_count` của admin đổi nghĩa thành số membership đang hoạt động, thêm `active_total` bên cạnh `total` để UI không trộn hai con số.
- Consequences: Không có đường nào xoá mất điểm đã chấm. Đổi lại, dữ liệu membership inactive tồn tại vĩnh viễn (đúng chủ đích) và race nhỏ giữa check-vs-delete member với một submission đồng thời vẫn tồn tại - chấp nhận, backend vẫn enforce membership khi nộp (ghi ở technical debt).
- Affected files/contracts: `backend/app/competitions/service.py` (`delete_competition_cascade`, `remove_competition_files`), `backend/app/memberships/{router,admin_router}.py`, `backend/app/submissions/service.py`, `docs/API_CONTRACT.md` §3+§5.2+§5.3, `docs/DATA_MODEL.md` §10

## ADR-019 - Quota hiển thị trước khi nộp; leaderboard phân trang nhưng hạng vẫn toàn cục
- Date: 2026-09-17
- Status: accepted
- Context: Người dùng chỉ biết còn bao nhiêu lượt **sau** khi POST thành công, nên rất dễ đâm vào 429 khi đã hết quota. Leaderboard trả `total` và `account_id` nhưng UI không render gì: không có "hạng của bạn #47/120", cũng không phân trang.
- Decision:
  - `quota_status(...)` trả `{per_day, used_today, remaining, resets_at}` (ngày UTC, `resets_at` = 00:00 UTC kế tiếp để UI đổi sang giờ local). Chỉ tính trong `GET /api/competitions/{slug}` khi người gọi là thành viên active của cuộc thi `published`; list không tính (N+1). Sau khi nộp, FE gọi lại detail để cập nhật; response POST vẫn trả `quota_remaining` làm nguồn tức thời.
  - `remaining=0` thì FE khoá form nộp kèm message; backend 429 vẫn là authority khi race/stale tab.
  - Leaderboard participant nhận `limit` (1-200, default 50)/`offset` và trả `{entries,total,limit,offset,has_more,me}`. Ranking vẫn tính full trong bộ nhớ (quy mô 40-80), `rank` giữ nguyên thứ hạng toàn cục, `me` tìm trên full list trước rồi mới cắt trang nên vẫn đúng khi người dùng ngoài page.
  - `me` dùng chung serializer participant: không có `account_id`/email. Admin leaderboard và XLSX export vẫn lấy toàn bộ danh sách, contract không đổi.
  - Countdown ở dashboard/chi tiết đổi thành clock sống: một page-level clock cho dashboard (không mở timer cho từng thẻ), nhịp thưa 30 giây khi còn trên 1 ngày và mỗi giây khi dưới 1 ngày, dọn timer khi unmount, đồng bộ lại khi tab visible trở lại.
- Consequences: Thêm một `count_documents` cho mỗi lần mở detail của thành viên - chấp nhận. Phân trang chỉ giảm payload/UI, không đổi độ phức tạp query; còn in-memory nên phải xem lại nếu vượt quy mô hiện tại. Countdown không còn đứng yên nhưng tốn timer chạy nền; nhịp thưa giữ chi phí thấp.
- Affected files/contracts: `backend/app/submissions/service.py` (`quota_status`), `backend/app/competitions/router.py`, `backend/app/leaderboard/{router,service}.py`, `frontend/src/hooks/useCountdown.ts`, `frontend/src/lib/countdown.ts`, `docs/API_CONTRACT.md` §3+§4

## ADR-020 - Tạm hoãn public/private leaderboard split (deferred)
- Date: 2026-09-17
- Status: deferred - không implement trong scope này
- Context: Cần bảng xếp hạng public và private (theo mùa thi). Đề xuất ban đầu là tạo hai competition, một public một private.
- Decision: Không làm theo hướng hai competition, và cũng chưa implement split trong scope hiện tại.
  - Hai competition không tương đương: join/quota/content/submission/export bị nhân đôi, một lần nộp không sinh được hai điểm đúng nghĩa, và thí sinh phải join hai lần.
  - Hướng đúng khi làm thật: **một** ground truth có partition public/private, một submission sinh hai score, private chỉ reveal/finalize sau khi close (hoặc theo cờ "final submission" do BTC chọn). Việc này chạm vào scoring nên phải là thay đổi riêng, có ADR mới.
- Consequences: Trong khi chờ, chỉ có một bảng xếp hạng duy nhất và nó bị `leaderboard_visible` bật/tắt. Ghi lại để lần sau không ai "giải quyết" bằng cách nhân đôi competition.
- Affected files/contracts: `docs/DECISIONS.md`, `docs/PROJECT_STATE.md` §3

## ADR-021 - Hai trang tĩnh công khai `/gioi-thieu` và `/ho-tro`
- Date: 2026-09-18
- Status: accepted
- Context: Cổng thí sinh chỉ có danh sách và chi tiết cuộc thi, nên các câu "liên hệ Ban Tổ chức" trong UI không có đích đến thật và nền tảng thiếu thông tin chính danh về đơn vị chủ trì. `DESIGN.md` §19 cấm tự thêm block About/marketing lên dashboard, nên nội dung này phải nằm ở route riêng. User chấp thuận bổ sung hai trang tĩnh với điều kiện các trang hiện tại không đổi.
- Decision:
  - Thêm hai route tĩnh đọc công khai, không gọi API và không đụng backend: `/gioi-thieu`, `/ho-tro`.
  - Nội dung là văn bản tĩnh + liên kết/hộp thư chính thức. Mọi khẳng định về VKU gắn với mục "Nguồn thông tin" và ngày truy cập; không thêm khẩu hiệu, xếp hạng, số liệu hay nội dung không có nguồn. **[Sửa bởi ADR-022: chỉ `/gioi-thieu` còn khối "Nguồn thông tin".]**
  - Thay đổi duy nhất trên shell hiện có: hai mục thêm vào `useNavItems()` (dùng chung navbar desktop và drawer). Nhãn điều hướng dùng bản ngắn `Giới thiệu`/`Hỗ trợ` để navbar không chật ở 768–1023px; H1 giữ tên đầy đủ "Hỗ trợ & Liên hệ". Không sửa CSS, không sửa route/nội dung/bố cục của bất kỳ trang hiện có nào. **[Sửa bởi ADR-022: `/ho-tro` được redesign và có CSS riêng.]**
  - Liên hệ ba tầng: VKU (chung), Phòng Khoa học Công nghệ - Hợp tác Quốc tế, và hỗ trợ kỹ thuật nền tảng. Không có biểu mẫu liên hệ; chỉ website, `mailto:` và `tel:`.
  - Thông tin cá nhân của đầu mối hỗ trợ kỹ thuật (Nguyễn Kết Đoàn - `nkdoan@vku.udn.vn` - `0396090576`) do user uỷ quyền công bố, chỉ gồm tên/email/điện thoại, không thêm chức danh hay dữ liệu khác.
- Consequences: Dashboard, trang chi tiết cuộc thi và luồng nghiệp vụ giữ nguyên; chỉ navbar có thêm hai mục. Nội dung tĩnh có thể lệch khi VKU đổi thông tin - vì vậy dữ kiện, nguồn và ngày truy cập nằm một chỗ ở `frontend/src/lib/vkuInfo.ts`. Không thêm footer, contact form, asset, dependency hay schema.
  - Hạn chế đã biết (đo trên browser; chưa xử lý vì nằm ngoài phạm vi additive-only của ADR này): hai mục nav mới làm `.app-nav` rộng thêm ~95px. Ở khung nhìn 1024–1152px với tài khoản **admin** (5 mục), capsule tên vượt khỏi cột phải của `.app-header-inner` và chồng lên mục cuối khi tên hiển thị rộng hơn ~130px - đo được "Trần Thị Ngọc Huyền" (139px) chồng 6px ở 1024px, tên dài 252px chồng tới 119px. Đây là điểm yếu sẵn có của shell: trước ADR-021, tên 252px đã chồng 24px ở 1024px, ADR-021 mở rộng vùng lỗi. Từ 1280px trở lên không chồng; khách và thí sinh với tên thực tế không bị. Muốn xử lý dứt điểm cần một thay đổi CSS riêng cho `.app-header-inner`/`.app-header-right`.
- Affected files/contracts: `frontend/src/App.tsx`, `frontend/src/lib/vkuInfo.ts`, `frontend/src/pages/AboutPage.tsx`, `frontend/src/pages/SupportPage.tsx`, `docs/DECISIONS.md`

## ADR-022 - Redesign `/ho-tro` thành Help Center: bỏ khối "Nguồn thông tin", FAQ accordion
- Date: 2026-09-18
- Status: accepted
- Context: Sau khi dashboard và hai màn quản trị được redesign theo design system VKU, `/ho-tro` vẫn là một card nội dung dài dùng class chung `.page`/`.card`/`.ov-*`: 6 bước, 9 FAQ và 3 tầng liên hệ hiển thị liên tục, cộng thêm khối "Nguồn thông tin". Trang không đồng bộ với phần còn lại của hệ thống và khó quét. User yêu cầu redesign theo `SUPPORT_PAGE_DESIGN.md`, giữ nguyên toàn bộ nội dung nghiệp vụ và dữ liệu liên hệ.
- Decision:
  - Trình bày lại `/ho-tro`: hero VKU, 6 bước thành timeline dọc có nhịp màu blue→red→yellow theo chỉ số bước (thuần trang trí, không mang nghĩa nghiệp vụ), FAQ thành accordion, panel Liên hệ 3 tầng. Desktop khoảng 70/30; dưới 1200px một cột theo thứ tự Hướng dẫn → Liên hệ → FAQ.
  - **Bỏ hẳn khối "Nguồn thông tin" trên `/ho-tro`** (đảo một phần ADR-021). Vẫn không thêm nguồn mới, không đổi email/điện thoại/địa chỉ/đơn vị; mọi dữ kiện vẫn lấy từ `frontend/src/lib/vkuInfo.ts`. Khối "Nguồn thông tin" của `/gioi-thieu` giữ nguyên, kèm `SOURCE_ACCESSED`.
  - Không render "Danh mục hỗ trợ", sidebar phụ, CTA "Cần hỗ trợ thêm?" hay biểu mẫu liên hệ; không chatbot/ticket/SLA. Không thêm API, dependency, asset hay route - SVG inline theo convention sẵn có, light mode only.
  - FAQ là accordion native (`button` trong `h3`, `aria-expanded`/`aria-controls`; panel `role="region"` + `aria-labelledby`) đóng hết mặc định và chỉ mở một mục. Panel **luôn được mount**, đóng bằng thuộc tính `hidden` để `aria-controls` không trỏ vào phần tử không tồn tại - vì vậy CSS không được khai báo `display` trên `.support-faq-panel`.
  - `/ho-tro` dùng trần 1440px qua `.app-main-support` - ngoại lệ page-specific mà `VKU_GLOBAL_DESIGN.md` §9 cho phép. Breakpoint 70/30 đặt tại `75rem` (1200px) chứ không phải 1024px, vì cột phải 30% ở 1024px chỉ còn ~215px, không đủ cho chip email.
  - Liên hệ **không** dùng `position: sticky`: panel có thể cao hơn viewport và sẽ chui dưới header cố định, che control đang focus.
- Consequences: `/ho-tro` không còn chỗ trích dẫn nguồn, nên khi VKU đổi thông tin chỉ còn `/gioi-thieu` hiển thị ngày truy cập; bù lại trang gọn hơn và không lặp lại cùng một danh sách link ở hai nơi. Nội dung, thứ tự 3 tầng liên hệ và mọi `mailto:`/`tel:`/URL giữ nguyên. Rủi ro còn lại: nếu sau này thêm nguồn mới cho dữ kiện trên `/ho-tro` thì phải mở lại quyết định này.
- Affected files/contracts: `frontend/src/pages/SupportPage.tsx`, `frontend/src/pages/SupportPage.test.tsx`, `frontend/src/App.tsx`, `frontend/src/index.css`, `frontend/src/lib/vkuInfo.ts`, `SUPPORT_PAGE_DESIGN.md`, `docs/TEST_MATRIX.md`

## ADR-023 - Redesign `/gioi-thieu`: hero VKU, hai cột theo nhịp màu xanh–đỏ–vàng
- Date: 2026-09-18
- Status: accepted
- Context: Sau khi dashboard, hai màn quản trị và `/ho-tro` chuyển sang design system VKU, `/gioi-thieu` là trang cuối cùng còn dùng class chung `.page`/`.card`/`.ov-*`: nội dung đúng nhưng đổ thành khối văn bản dài, hierarchy yếu, không có neo thị giác nào và lệch hẳn so với phần còn lại của hệ thống. User yêu cầu redesign theo `ABOUT_PAGE_DESIGN.md`, đồng bộ với dashboard/admin, **chỉ đổi trình bày**: mọi text, dữ kiện, nguồn, liên kết và route giữ nguyên.
- Decision:
  - Trình bày lại `/gioi-thieu`: hero VKU (icon + tiêu đề + subtitle hiện có + ba vạch `vku-accent`), rồi bốn card có semantic hierarchy - `Về nền tảng AI Challenge` (4 đặc điểm, mỗi đặc điểm một `h3` + mô tả nguyên văn), `VKU - đơn vị chủ trì` (5 dữ kiện, list vẫn giữ accessible name `Thông tin VKU`), `Đơn vị và đầu mối hỗ trợ` (3 đầu mối + câu dẫn sang `/ho-tro`), `Bắt đầu` (đúng một CTA xanh VKU tới `/`).
  - **Giữ khối "Nguồn thông tin" thành card thứ năm, neutral, full-width ở cuối lưới** - đúng cam kết của ADR-022 về việc `/gioi-thieu` tiếp tục có khối này (không bỏ mất nguồn). Card dùng viền trên `--vku-border` để không tranh nhịp màu với bốn khối chính; ở desktop danh sách trải hai cột để nhãn ngắn không bị kéo căng hết chiều rộng card.
  - **Điều chỉnh theo yêu cầu trực tiếp của user (2026-09-18):** bỏ câu dẫn "Thông tin về VKU được tổng hợp từ các nguồn chính thức dưới đây, truy cập ngày…" - hằng `SOURCE_ACCESSED` vì thế không còn nơi dùng nên đã xoá khỏi `frontend/src/lib/vkuInfo.ts`; bổ sung nguồn thứ tư là trang Phòng KHCN - HTQT (nguồn này đã có sẵn trong `VKU_SOURCES` và đang dùng ở `/ho-tro`, không phải nguồn bịa thêm), URL đổi sang biến thể `/vi/` do user cung cấp; cả bốn nhãn rút về tên ngắn 2–6 chữ thay vì dán tiền tố domain.
  - Nhịp màu thuần trang trí: viền trên 3px blue/red/yellow/blue cho bốn khối chính, thân card luôn nền trắng; icon feature xoay vòng blue/blue/red/yellow; icon đầu mối hỗ trợ blue; CTA chính vẫn là `.btn` xanh VKU, không dùng nút đen. Ý nghĩa luôn nằm ở heading chữ, màu không mang thông tin.
  - Desktop từ `75rem` (1200px): hai cột trái/phải (`platform`+`vku` | `support`+`cta`) bằng `grid-template-areas`, `sources` span cả hai. Dưới 1200px một cột theo đúng thứ tự DOM - nên tab order luôn khớp thứ tự thị giác, không cần `tabindex` hay đảo DOM.
  - **Hai cột xếp dọc độc lập** qua wrapper `.about-col` (`display: contents` dưới 1200px, `flex-direction: column` từ 1200px). Lưới theo hàng ban đầu để lại ~350px trống ở rail phải tại 1440px - đúng lỗi "khoảng trắng chưa dùng hiệu quả" mà đặc tả §2 yêu cầu loại bỏ. Wrapper `display: contents` không đổi cây DOM nên thứ tự tab giữ nguyên.
  - `/gioi-thieu` dùng trần 1440px qua `.app-main-about`, thêm cạnh `.app-main-support`: ngoại lệ page-specific mà `VKU_GLOBAL_DESIGN.md` §9 cho phép. Không đổi `--container` toàn cục.
  - Chỉ SVG inline theo convention sẵn có (`aria-hidden`, `focusable="false"`, `stroke="currentColor"`); không thêm icon package, dependency, API, asset hay route. Không có ảnh campus chính thức trong repo nên hero dùng hình học CSS chữ nhật chéo - không đưa ảnh AI-generated vào production. Light mode only, không animation.
- Consequences: `/gioi-thieu` đồng bộ với dashboard/admin/`/ho-tro` và dễ quét hơn nhiều, nhưng từ nay có thêm một trang phải cập nhật khi design token đổi. Nội dung tĩnh vẫn có thể lệch khi VKU đổi thông tin - vì vậy dữ kiện và nguồn vẫn nằm một chỗ ở `frontend/src/lib/vkuInfo.ts`, không hardcode trong page. Việc bỏ câu dẫn và đổi nhãn nguồn khiến trang không còn nói rõ các link này là nguồn tham chiếu - bù lại bằng heading `Nguồn thông tin` và `target="_blank"`; nếu cần nêu ngày truy cập lại thì phải thêm hằng mới chứ không khôi phục `SOURCE_ACCESSED`.
- Affected files/contracts: `frontend/src/pages/AboutPage.tsx`, `frontend/src/pages/AboutPage.test.tsx`, `frontend/src/App.tsx`, `frontend/src/App.test.tsx`, `frontend/src/index.css`, `ABOUT_PAGE_DESIGN.md`, `docs/TEST_MATRIX.md`

## ADR-024 - Bố cục hàng cho `/gioi-thieu` và `/ho-tro`: lưới ô thay cột nửa, bỏ "Bắt đầu" và "Nguồn thông tin"
- Date: 2026-09-19
- Status: accepted
- Context: ADR-023 trải `/gioi-thieu` thành hai cột trái/phải để vá lỗ hổng ~350px ở rail phải, và ADR-022 đặt `/ho-tro` theo tỉ lệ 70/30. Ở 1440px hai bố cục đó vẫn hở: cột hẹp chứa nội dung ngắn nên nửa dưới của cột cao bị bỏ trống, và nội dung bên trong mỗi card dồn thành một hàng dài hoặc những khối chỉ chiếm nửa chiều ngang. User yêu cầu trực tiếp (2026-09-19): hai trang phải **chỉ còn hàng full-width** - `/gioi-thieu` ba hàng `Về nền tảng` → `VKU` → `Đầu mối hỗ trợ`, `/ho-tro` hàng 1 là `Các bước tham gia` và hàng 2 là `Liên hệ` ｜ `Câu hỏi thường gặp`; nội dung con trong mỗi hàng trải thành grid thay vì để trống. Kèm yêu cầu bỏ hẳn khối `Bắt đầu` và `Nguồn thông tin`.
- Decision:
  - **`/gioi-thieu`: ba hàng full-width.** `.about-grid` từ hai cột (`grid-template-areas`) về một cột; DOM còn đúng ba `section.about-card` theo thứ tự đọc Nền tảng → VKU → Đầu mối hỗ trợ. Bỏ hẳn `.about-col` và cơ chế `display: contents` của ADR-023 - không còn cột nửa nào để cân.
  - **Bỏ khối `Bắt đầu` và khối `Nguồn thông tin`** (đảo phần còn lại của ADR-022 và phần "card thứ năm" của ADR-023). Đây là quyết định của user sau khi được nêu rõ hệ quả: `/gioi-thieu` là nơi duy nhất còn hiển thị nguồn, nên **từ nay không trang nào trích dẫn nguồn thông tin VKU**. `VKU_SOURCES` vì thế thu về một hằng duy nhất `VKU_DEPARTMENT_URL` (trang Phòng KHCN - HTQT vẫn dùng làm chip "Trang đơn vị" ở `/ho-tro`); kiểu `VkuSource` và ba URL còn lại bị xoá.
  - **Mỗi card tự chia lưới con, số cột theo số mục** để hàng cuối luôn kín: đặc điểm nền tảng 4 mục 4/2/1 cột; dữ kiện VKU 5 mục 3 cột ở desktop với `Sứ mệnh` mang `grid-column: span 2`, 2 cột dưới 1200px với mục lẻ cuối kéo hết hàng; đầu mối hỗ trợ 3 mục 3/2/1 cột. `.about-feature`, `.about-fact`, `.about-unit` dùng chung một rule ô (viền mảnh `--vku-border-soft`, nền `--surface`, bo `--radius-xl`) để ba lưới đọc như cùng một hệ.
  - **`/ho-tro`: hai hàng.** `.support-timeline` đổi từ timeline dọc sang lưới ô 1/2/3 cột, nên `.support-step` trở thành ô có viền/nền và **đường nối dọc giữa các marker bị xoá** (không còn nghĩa trong lưới). Hàng 2 giữ `Liên hệ` ｜ `Câu hỏi thường gặp` bằng `grid-template-areas` `"contact faq"`. Dưới 1200px hai khối xếp dọc theo thứ tự DOM Hướng dẫn → Liên hệ → FAQ, tab order vẫn khớp thị giác.
  - **Điều chỉnh theo yêu cầu trực tiếp của user (2026-09-19):** hàng 2 đổi từ `0.85fr ｜ 1.6fr` sang **hai cột chia đôi đều nhau** (`repeat(2, minmax(0, 1fr))`). Tỉ lệ cũ khiến Liên hệ và FAQ lệch bề ngang tới gần gấp đôi và lệch cả chiều cao (818px ｜ 611px @1440), đọc như hai khối thuộc hai cỡ khác nhau. Bỏ luôn sàn `340px` của cột trái: ở 1200px mỗi cột đã rộng 556px, chip email không còn là ràng buộc. Đo lại: 556px ｜ 556px @1200 và 676px ｜ 676px @1440, chiều cao 634px ｜ 611px @1440.
  - Marker số bước giữ nguyên nhịp màu blue→red→yellow thuần trang trí; đổi tên gọi trong code/tài liệu từ "timeline" sang "lưới bước" cho khớp thực tế. Không đổi nội dung, thứ tự bước, dữ liệu liên hệ, `mailto:`/`tel:`/URL, route, API, dependency hay asset. Light mode only.
- Consequences: Hai trang hết khoảng trống giữa hàng ở mọi breakpoint (đo 375/640/768/1024/1199/1200/1440: ba hàng full-width, hàng cuối của cả ba lưới con kín, không tràn ngang). Đổi lại, `/gioi-thieu` mất liên kết ra bốn trang nguồn chính thức và từ nay **cả hai trang tĩnh đều không nêu nguồn** - nếu sau này cần trích dẫn lại thì phải mở ADR mới và khôi phục dữ liệu nguồn, không chỉ thêm JSX. `ABOUT_PAGE_DESIGN.md` §A.2 cũ giữ nguyên văn bản gốc nhưng đánh dấu "đã thay thế", bố cục hiện hành nằm ở §A.2.1.
- Affected files/contracts: `frontend/src/pages/AboutPage.tsx`, `frontend/src/pages/SupportPage.tsx`, `frontend/src/pages/AboutPage.test.tsx`, `frontend/src/pages/SupportPage.test.tsx`, `frontend/src/index.css`, `frontend/src/lib/vkuInfo.ts`, `ABOUT_PAGE_DESIGN.md`, `SUPPORT_PAGE_DESIGN.md`, `docs/TEST_MATRIX.md`

## ADR-025 - Public entry cho frontend: Cloudflare Workers Static Assets + proxy `/api/*` same-origin
- Date: 2026-09-19
- Status: accepted (chưa rollout - xem "Rollout")
- Context: Frontend hiện do Nginx trong stack GCE phục vụ và public chỉ qua Cloudflare **Quick Tunnel** (`*.trycloudflare.com`): URL đổi mỗi lần `cloudflared` restart, giới hạn 200 kết nối, không SLA. User yêu cầu một public entry ổn định cho frontend trên Cloudflare Workers, nhưng **giữ nguyên** backend FastAPI + MongoDB + Nginx + Quick Tunnel base trên GCE hiện tại (không migrate sang VPS khác, không tách repo, không Cloudflare Pages) và **giữ nguyên hợp đồng browser same-origin** `/api`: cookie phiên host-only `HttpOnly`/`Secure`/`SameSite=Lax`, frontend `credentials: "same-origin"`, không CORS rộng, không JWT, không token trong `localStorage`.
- Decision:
  - Worker tên `vku-ai-challenge-platform` (tài khoản `ketdoannguyen`) chạy Workers Static Assets: `assets.directory: ./dist`, `not_found_handling: single-page-application`, `run_worker_first: ["/api/*"]`. Chỉ `/api/*` vào Worker; phần còn lại do static assets + SPA fallback phục vụ. Trước lần deploy đầu tiên tài khoản **chưa có Worker nào** - tên này do `wrangler deploy` tạo, không phải Worker dựng sẵn trên Dashboard.
  - **`API_ORIGIN` là runtime variable, không khai trong `wrangler.jsonc`** (`vars` trong file sẽ ghi đè giá trị đặt ngoài file ở mỗi lần deploy, nên chỉ bật `keep_vars: true`) và **không phải biến `VITE_*`**: browser không bao giờ biết địa chỉ backend. Đặt được bằng cả hai đường: Dashboard (Workers & Pages → Worker → Settings → Variables) hoặc `wrangler deploy --var API_ORIGIN:<origin>`; nhờ `keep_vars: true` giá trị sống sót qua các lần deploy sau **không** kèm `--var` - điều này đã kiểm chứng trên bản deploy thật (deploy lại không `--var`, `/api/health` vẫn `200`). Giá trị trỏ về hostname Cloudflare Tunnel kết thúc tại Nginx (`http://web:80`) - **không** trỏ về public hostname của chính app (proxy loop).
  - Worker fail closed: chỉ nhận origin http(s) thuần (không credentials, path, query, fragment), từ chối host trùng host của request public; thiếu/sai cấu hình → `500`, không gọi được upstream → `502`, body generic theo đúng envelope `{error:{code,message}}` của backend và không lộ giá trị cấu hình.
  - Proxy **không đọc body**: `new Request(url, request)` giữ method, headers (`Cookie`, `Authorization`, `Content-Type`), body stream và redirect mode; trả nguyên `Response` của upstream nên `Set-Cookie`, `Content-Disposition`, upload multipart và download stream đi nguyên trạng. Không thêm header CORS, không log cookie/token.
  - Static assets giữ 5 security header tương đương `frontend/nginx.conf` qua `frontend/public/_headers` (Vite copy vào `dist/_headers`), kèm cache `immutable` cho `/assets/*` (Vite sinh filename có content hash).
  - Tunnel production dùng **remotely-managed Named Tunnel**: ingress cấu hình trên Dashboard `origin-api.<DOMAIN>` → `http://web:80`, bật bằng override additive `deploy/docker-compose.tunnel.named.yml` (token từ `CLOUDFLARE_TUNNEL_TOKEN`, giữ `--metrics 127.0.0.1:20241` để healthcheck kế thừa từ base còn dùng được). Stack Quick Tunnel base **không đổi** và tiếp tục là đường lùi.
  - Không đổi: `docker-compose.prod.yml`, `frontend/nginx.conf`, `frontend/src/api/client.ts`, Vite dev proxy, backend, API contract, schema Mongo.
- Consequences:
  - Frontend có URL do Cloudflare quản lý, asset được CDN cache, VPS không phải phục vụ static; đổi lại mọi request `/api/*` phải qua Worker rồi tunnel - đó chính là điều kiện để giữ same-origin.
  - 5 security header cho static giờ nằm ở **hai nơi** theo hai đường khác nhau: `nginx.conf` cho response của `/api/*`, `_headers` cho static. `_headers` **không** áp dụng cho response do Worker sinh, nên sửa header phải sửa cả hai file.
  - `/data/` chỉ bị chặn 404 ở Nginx; trên hostname Workers, `/data/<x>` rơi vào SPA fallback và trả `index.html` (đã kiểm chứng trên bản deploy thật: `200` + HTML của SPA). Không lộ dữ liệu (Workers không có file hệ thống đó), nhưng smoke test `/data/` phải chạy trên origin (tunnel/nginx), không phải hostname Workers.
  - Cookie phiên là host-only (không `Domain`), nên session **không** dùng chung giữa hostname Workers và hostname tunnel: tại một thời điểm chỉ dùng một public origin cho người dùng thật.
  - `client_max_body_size 12m` của Nginx vẫn là giới hạn body hiệu lực; Workers không cấu hình body limit trong file này, nên hành vi biên khi vượt ngưỡng là `413` từ Nginx. **[Sửa bởi ADR-028: Nginx nay là `client_max_body_size 32m` vì mỗi lượt nộp mang theo cả CSV lẫn notebook tới 20 MiB.]**
  - Thêm `wrangler` (kèm `workerd`) vào devDependencies của frontend làm image build của service `web` cài nhiều hơn; build chậm hơn là có, không ảnh hưởng runtime vì `dist/` là output duy nhất được copy sang stage Nginx.
- Rollout: code + test + tài liệu đã xong và qua local gate (`npm run lint`, `npm test`, `npm run build`, `npm run cf:dry-run`, compose `config --quiet`, backend `pytest`). Đã **deploy thật** lên Workers Static Assets tại `https://vku-ai-challenge-platform.ketdoannguyen.workers.dev` (14 asset, `_headers` được đọc làm cấu hình nên không nằm trong danh sách upload) và smoke test trực tiếp: static + 5 security header, SPA deep link, cache `immutable` cho `/assets/*`, `/api/health` `200`, `/api/auth/me` `401` đúng envelope, API 404 trả JSON của FastAPI. `API_ORIGIN` đang tạm trỏ **Quick Tunnel** hiện tại (URL đổi mỗi lần `cloudflared` restart); ADR-026 sau đó chốt giữ nguyên Quick Tunnel nên `DOMAIN` và `CLOUDFLARE_TUNNEL_TOKEN` không còn là việc phải làm, `docs/DEPLOYMENT.md` §6 thành đường lên Named Tunnel khi nào có domain. Đã commit.
- Affected files/contracts: `frontend/worker/index.ts`, `frontend/worker/index.test.ts`, `frontend/wrangler.jsonc`, `frontend/public/_headers`, `frontend/package.json`, `frontend/tsconfig.app.json`, `frontend/vitest.config.ts`, `deploy/docker-compose.tunnel.named.yml`, `deploy/production.env.example`, `docs/DEPLOYMENT.md`

## ADR-026 - Tự động hoá release: gate trên `release`, Actions deploy Worker, systemd timer pull trên VPS
- Date: 2026-09-19
- Status: accepted (cả hai đường đã chạy thật - xem "Rollout")
- Context: ADR-025 đã cho frontend một public entry trên Cloudflare Workers nhưng việc đưa code lên production vẫn làm tay: `wrangler deploy` gõ tại máy dev, còn stack GCE phải SSH vào `git pull` + `docker compose build/up`. User yêu cầu "push lên là web tự cập nhật", kèm hai ràng buộc: không đưa credential SSH của VPS vào GitHub, và không dựng thêm hạ tầng (webhook receiver, CI runner tự host, Kubernetes). Vì thế cần một cơ chế deploy **một chiều, truy vết được theo Git SHA** cho cả hai phía, và một cổng chặn để `main` không tự động lên production.
- Decision:
  - **`release` là cổng duy nhất**: push vào `release` nghĩa là "đưa commit này lên production". `main` vẫn là nhánh tích hợp. Gate `release-gate` chạy trên PR vào `release` **và** trên push vào `main` (để biết `main` còn release-ready hay không).
  - **Frontend do GitHub Actions deploy** (`.github/workflows/deploy-worker.yml`, trigger `push: release` với `paths: frontend/**` + `workflow_dispatch` cho đường break-glass). Vì push thẳng vào `release` không đi qua PR, workflow **lặp lại** gate frontend (`lint` → `vitest` → `build`) ngay trước khi deploy, thay vì tin rằng gate đã chạy.
  - Worker deploy bằng `wrangler deploy --keep-vars --tag release-<sha12> --message "release <sha>"`. CI **không bao giờ** truyền `--var API_ORIGIN`: `keep_vars` giữ binding runtime, còn `--var` sẽ ghi đè nó bằng giá trị nằm trong log CI.
  - Sau deploy, **smoke tĩnh quyết định rollback**: `/` và một deep link SPA phải trả `200` + `text/html`. `/api/health` chỉ là **diagnostic** - `API_ORIGIN` đi qua tunnel, tunnel chết làm API lỗi trong khi static vẫn khoẻ, và rollback Worker không sửa được tunnel. Khi smoke tĩnh fail, workflow rollback về version đang nhận traffic trước đó (đọc bằng `wrangler deployments status --json`); parser này **cảnh báo chứ không fail job** khi shape response lạ, vì một parser đoán sai sẽ chặn mọi deploy trong khi production vẫn khoẻ.
  - **VPS tự kéo bằng systemd timer**, không dùng webhook và CI **không** SSH vào VPS: `vku-deploy.timer` (`OnBootSec=2min`, `OnUnitInactiveSec=1min`) gọi `vku-deploy.service` chạy `/usr/local/sbin/vku-auto-deploy`. Timer đo theo lúc service inactive nên không bao giờ chồng lấn. Đổi lại: không phải mở SSH cho runner, không cần secret SSH trong GitHub, không cần endpoint công khai, và deploy vẫn chạy được khi Actions hỏng.
  - **Deployer là bản copy root-owned ở `/usr/local/sbin/vku-auto-deploy`**, cài bằng `deploy/vps/install-auto-deploy.sh`. File trong repo không bao giờ được systemd thực thi trực tiếp: một commit xấu không được phép tự thay cơ chế recovery của chính nó. Cùng lý do, `scripts/backup_prod.sh` được đóng băng thành `/usr/local/sbin/vku-backup-prod` và `vku-backup.service` trỏ vào bản copy đó. Installer **không** bật timer: bật là bước bàn giao cuối, làm tay sau `--bootstrap-current` và `--dry-run`.
  - **Bất biến của một lượt deploy VPS**: image gắn tag bất biến theo SHA (`vku-challenge-api:<sha12>`) kèm label `org.opencontainers.image.revision`; sau `up` deployer **xác minh label** của container đang chạy đúng SHA mục tiêu rồi mới kiểm `/api/health`; sai ở bất kỳ bước nào thì rollback về **image cũ đã build của SHA trước** (không build lại source cũ - build lại là phép toán không xác định đúng lúc production đang lỗi). Mỗi SHA lỗi chỉ thử **một lần**; muốn thử lại phải push commit mới. Commit chỉ đổi `docs/`/`.github/`/`plans/` không chạm container, chỉ tiến mốc state.
  - **`up` luôn có `--no-build`, và rollback kiểm image cũ tồn tại trước khi đụng container.** Review đã tìm ra một blocker thật ở đây: `docker compose up` **tự build khi image vắng mặt**, mà lúc rollback thì working tree đang ở SHA mục tiêu - nên nếu image của SHA cũ không còn, compose sẽ build **source mới** rồi gắn tag + label của SHA cũ, và `verify_services` (chỉ đọc label) sẽ báo rollback thành công trong khi container chạy code mới. Đường tới đó không hiếm: commit docs-only và `--bootstrap-current` đều tiến `last-success` mà không build image nào. Đã kiểm chứng bằng Compose thật (image được tạo lại mang label SHA cũ) trước khi sửa. Hệ quả cần nhớ khi vận hành: `last-success-sha` là mốc **state**, không phải bằng chứng có image trên máy.
  - **`backend/**` deploy cả `api` và `web`**, không chỉ `api`: nginx trong `web` trỏ thẳng `proxy_pass http://api:8000` và không khai `resolver`, nên nó phân giải IP của `api` đúng một lần lúc khởi động; `api` được tạo lại mang IP mới và `web` cũ sẽ proxy vào IP đã chết. Đây là ràng buộc thật của cấu hình hiện tại, không phải lựa chọn cho chắc.
  - Deployer chỉ dùng `docker compose build/up/ps/exec` cộng `docker ps/logs/image/images/rmi`. Không `down`, không `down -v`, không prune, không chạm `mongo`, không đụng bind mount dữ liệu hay backups. `cloudflared` chỉ được **đọc**: không lệnh nào đổi trạng thái container này, vì restart nó là đổi URL công khai và làm chết `API_ORIGIN`.
  - **Production tiếp tục chạy Quick Tunnel, chưa lên Named Tunnel.** User chưa có domain, mà Cloudflare bắt buộc phải có zone ("Before you publish an application through your tunnel, you must add a website to Cloudflare") mới tạo được Published application - không có đường vòng chính thức. Hệ quả được chấp nhận có ý thức: hostname `*.trycloudflare.com` đổi mỗi lần `cloudflared` khởi động lại, và lúc đó `API_ORIGIN` của Worker trỏ vào URL chết. `deploy/docker-compose.tunnel.named.yml` vẫn được giữ và được `release-gate` kiểm cú pháp như đường lên Named Tunnel khi user mua domain.
  - **Deployer phát hiện hostname Quick Tunnel đổi** (`check_quick_tunnel`): mỗi lượt chạy thật - kể cả lượt "không có gì mới", vốn là lượt phổ biến nhất - nó đọc log container `cloudflared`, so với `quick-tunnel-url` đã lưu, và khi khác thì ghi `CẢNH BÁO` kèm URL cũ, URL mới, đường dẫn Dashboard cần sửa, cộng một dòng `result=tunnel-url-changed` vào `history.log`. Chỉ **báo**, cố ý **không tự sửa**: tự sửa đòi hỏi một token quản trị Worker thường trú trên VPS, tức nhân bản quyền Cloudflare sang máy thứ hai chỉ để phục vụ một sự kiện hiếm. Không tìm thấy URL trong log (log bị xoay, container vừa restart, hoặc đang chạy named tunnel) thì **giữ nguyên** giá trị đã lưu thay vì ghi đè bằng rỗng - ghi rỗng sẽ biến lượt sau thành báo động giả. Vì watchdog gọi `docker ps`/`docker logs` ở mọi lượt, bất biến của harness được phát biểu lại cho đúng bản chất: "không **mutate** container khi không có gì để deploy", chứ không phải "không gọi docker".
  - **Không bật Workers Builds song song** với workflow này: hai đường deploy cùng ghi vào một Worker sẽ tranh nhau version và làm mất provenance của Git SHA.
  - Secrets: `CLOUDFLARE_API_TOKEN` chỉ nằm ở GitHub environment `production` (branch protection cho `release`); `CLOUDFLARE_ACCOUNT_ID`/`WORKER_URL` là variables cùng environment. Token Worker tối thiểu quyền "Workers Scripts: Edit". Token tunnel chỉ nằm trong `/srv/vku-ai-challenge/.env` trên VM. Không token nào đi vào log, tài liệu hay chat.
- Consequences:
  - Một push vào `release` có thể cập nhật **cả hai phía**, và hai phía deploy độc lập chứ không phải một giao dịch nguyên tử: Worker thường lên trước VPS (build image chậm hơn). Hợp đồng `same-origin /api` sẵn có là thứ giữ cho khoảng lệch đó vô hại; đổi API theo cách phá vỡ tương thích ngược thì phải tách thành hai lần release.
  - Độ trễ push → production khoảng 1 phút (nhịp timer) cộng thời gian build; đổi lại mỗi ngày có ~1440 lượt `git fetch` rẻ tiền. Lượt không có gì mới thoát ngay và không ghi state.
  - `release-gate / frontend|backend|deploy-script` là tên required check trong branch protection: đổi `name:` của workflow hoặc `name:` của job sẽ làm check cũ không bao giờ xanh lại và chặn mọi PR vào `release`.
  - Worker và VPS rollback bằng hai đường khác nhau: `wrangler rollback` cho static, còn VPS tự rollback trong lượt deploy hỏng (hoặc deploy lại commit cũ). Không có rollback schema Mongo trong cả hai đường.
  - Sửa deployer trong repo **không** tự áp dụng lên VM: phải chạy lại `install-auto-deploy.sh` từ commit đã duyệt. Đây là đánh đổi có chủ ý (đổi lấy việc "commit xấu không tự thay cơ chế recovery").
  - Ghi chú cũ trong `docker-compose.prod.yml` và `docs/DEPLOYMENT.md` nói Settings của backend đặt `extra="forbid"` là **sai** (`backend/app/core/config.py` chỉ khai `env_file`), đã sửa lại: lý do `api` không nhận `env_file:` là quyền tối thiểu, không phải vì API sẽ chết lúc khởi động.
- Rollout: code + test + tài liệu đã xong và qua local gate (frontend `lint`/`vitest`/`build`/`cf:dry-run`; backend `pytest`; harness deployer 131 assert với `git` thật + `docker` giả, và đã kiểm chứng các assert của watchdog là load-bearing bằng cách tắt tính năng rồi xác nhận 7 assert đổ); `systemd-analyze verify`; compose `config --quiet`; cài thử installer trong sandbox). Đã push `main`, đã tạo `release`, đã giới hạn environment `production` cho đúng nhánh `release`, và **đã deploy Worker thật** qua `workflow_dispatch` (run `35441083752`, version `03c71a3f`; smoke tĩnh và `/api/health` đều `200`, `keep_vars` giữ nguyên `API_ORIGIN`). Cập nhật cùng ngày: đã chạy `deploy/vps/install-auto-deploy.sh` trên VM rồi `--bootstrap-current` + `--dry-run` + `systemctl enable --now vku-deploy.timer`, và **đã kiểm chứng đường VPS thật** bằng một lượt deploy qua timer (probe `POST /api/admin/competitions/<id>/reopen` qua hostname Worker trả `401 UNAUTHORIZED` trong khi đường dẫn bịa trả `404 NOT_FOUND` - 401 nghĩa là route mới đã live, tức deployer đã kéo release và image `api` đã build lại). Đổi lại, sửa deployer trong repo từ nay **không** tự áp dụng lên VM: phải chạy lại installer từ commit đã duyệt.
- Affected files/contracts: `.github/workflows/release-gate.yml`, `.github/workflows/deploy-worker.yml`, `.github/scripts/previous-version.mjs`, `deploy/vps/auto-deploy.sh`, `deploy/vps/install-auto-deploy.sh`, `deploy/vps/vku-deploy.service`, `deploy/vps/vku-deploy.timer`, `deploy/vps/tests/auto-deploy.test.sh`, `deploy/vku-backup.service`, `frontend/src/test/setup.ts`, `frontend/src/pages/CompetitionDetailPage.test.tsx`, `.gitignore`, `docker-compose.prod.yml`, `docs/DEPLOYMENT.md`, `docs/TEST_MATRIX.md`, `docs/DECISIONS.md`

## ADR-027 - `closed` không còn là terminal: mở lại được và xoá được
- Date: 2026-09-19
- Status: accepted
- Context: ADR-009 chốt `closed` là terminal và ghi rõ "Không reopen - nếu BTC cần, phải hỏi user trước khi thêm transition mới"; `DELETE` cũng chỉ nhận `draft` với lý do "giữ lịch sử thi". User yêu cầu đúng cái đã chừa chỗ đó: cuộc thi khi kết thúc vẫn phải xoá được và vẫn phải mở lại được. Đây là mệnh đề của ADR-009 bị thay thế, không phải một tính năng mới nằm ngoài nó.
- Decision:
  - **Thêm `POST /api/admin/competitions/{id}/reopen`**: `closed → published`. Chỉ đảo status - **không** kiểm tra lại readiness và **không** đụng `end_at`. Cuộc thi đã từng qua cổng publish nên reopen là *hoàn tác*, không phải publish mới; thêm gate sẽ chặn mở lại trong trường hợp ground truth bị mất ngoài luồng, đúng lúc cần mở lại nhất.
  - **`DELETE` nhận `draft` và `closed`, từ chối `published`** (409 `COMPETITION_NOT_DELETABLE`). "Đóng trước rồi xoá" được giữ làm bước xác nhận có chủ đích: cuộc thi đang chạy không bị xoá nhầm, và trạng thái `closed` là tín hiệu cuộc thi đã xong trước khi mất lịch sử thi. Hệ quả được chấp nhận có ý thức: `closed` **không** còn là bảo đảm dữ liệu thi còn nguyên - ADR-009 hứa điều đó, ADR-027 rút lại.
  - **Rào chắn xoá giữ nguyên, không thêm bước thứ hai**: modal bắt gõ đúng slug đã là xác nhận đủ mạnh; thêm nữa là nghi thức.
  - **Hai hệ quả của reopen phải được biết, không phải bug**: (1) `end_at` đã qua vẫn chặn join/nộp bài vì hai cổng đó enforce độc lập với status - muốn nhận bài lại thì PATCH `end_at` sau khi mở; (2) cấu hình chấm điểm/ground truth vẫn khoá nếu đã có submission `completed`, vì khoá đó theo dữ liệu chứ không theo status. Cả hai ghi trong `API_CONTRACT.md` và docstring endpoint.
- Consequences: `closed` giờ là trạng thái đảo được, nên mọi thứ suy ra từ nó cũng đảo theo - join, nộp bài, sửa config, đổi join-code đều mở lại; quyền sửa quay về mức của `published` (vẫn khoá `primary_metric`). Xoá cuộc thi `closed` **không** bị chặn bởi "đã có điểm" - admin phải tự biết mình đang xoá bảng điểm. `_transition` giữ nguyên cấu trúc chung; log của nó đổi sang bảng quá khứ tường minh vì `f"{action}d"` cho ra "reopend".
- Affected files/contracts: `backend/app/competitions/admin_router.py`, `backend/app/competitions/service.py`, `frontend/src/components/AdminCompetitionManagement.tsx`, `frontend/src/pages/AdminCompetitionDetailPage.tsx`, `frontend/src/pages/AdminCompetitionsPage.tsx`, `docs/API_CONTRACT.md` §5.2, `docs/DATA_MODEL.md` §3, `docs/TEST_MATRIX.md`

## ADR-028 - Artifact của submission nằm trong MinIO private, tải qua FastAPI
- Date: 2026-09-19
- Status: accepted
- Context: ADR-003 chốt "không external object storage ở MVP" và cho submission CSV nằm trên persistent disk. Yêu cầu mới đặt ra hai việc mà layout đó không còn phù hợp: (1) mỗi lượt nộp phải kèm **cả** CSV dự đoán **lẫn** notebook Jupyter, và BTC phải tải lại được artifact của bất kỳ đội nào để đối chiếu; (2) file bài nộp là dữ liệu do người dùng upload với tên do người dùng đặt, tức là thứ không nên nằm trong cùng cây thư mục với ground truth và content của hệ thống. Ghi thẳng vào `DATA_DIR` cũng làm tên file do client quyết định, và mọi lượt tải phải tự dựng lại đường dẫn từ DB.
- Decision:
  - **Hai artifact, một lượt nộp, một document.** `POST /api/competitions/{id}/submissions` nhận multipart hai part: `file` (CSV, ≤`MAX_UPLOAD_MB`=10 MiB) và `notebook` (`.ipynb`, ≤`MAX_NOTEBOOK_MB`=20 MiB). Notebook là **bắt buộc**, không phải tùy chọn: thiếu part, sai đuôi, JSON hỏng hoặc vượt trần đều trả 422 và **không** lưu object nào, **không** tiêu quota.
  - **MinIO là kho private, FastAPI là cổng duy nhất.** Bucket `submission-artifacts` chỉ nằm trong Docker network: không publish port ra host, không route Nginx, không console public, **không presigned URL**. Upload và download đều đi qua FastAPI để quota và authorization được enforce ở đúng một chỗ; URL tải không phải là một capability có thể chia sẻ ngoài phiên đăng nhập.
  - **Object key bất biến, một prefix cho mỗi submission.** `competitions/<competition_id>/accounts/<account_id>/submissions/<submission_id>/prediction.csv` và `.../notebook.ipynb` (đuôi trong key là hằng số, không lấy từ tên người dùng upload). Tên file gốc chỉ được lưu trong `submissions.artifacts.<kind>.original_filename` để hiển thị. Submission mới **không** ghi CSV vào `DATA_DIR` nữa.
  - **Tên khi tải do server đặt, không dùng tên client.** `{competition_slug}_{safe_account_name}_submission-{submission_no:04d}_prediction.csv` (tương tự `…_notebook.ipynb`; dấu phân cách là **một** `_` - đổi từ `__` ở ADR-031); record legacy thiếu `submission_no` thì dùng 8 ký tự cuối của ObjectId. Header gửi cả `filename=` ASCII và `filename*=UTF-8''…`; CR/LF, slash/backslash, ngoặc kép và control character bị loại trước khi ghép tên (chống header injection và path confusion).
  - **`submission_no` là số thứ tự thật**, cấp theo `(competition_id, account_id)`, chốt bằng unique **partial** index (`submission_no` tồn tại) nên record legacy không tham gia ràng buộc; trùng thì tính lại rồi thử tiếp, object đã upload không bị đụng giữa các lần thử.
  - **Record legacy vẫn đọc được.** Submission cũ chỉ có `file_path` trong `DATA_DIR` vẫn tải được CSV như trước (containment check + trần kích thước), và **không** có migration bắt buộc: đọc ưu tiên `artifacts`, chỉ rơi về `file_path` khi không có object. Notebook của record cũ trả 404 - dữ liệu đó chưa từng tồn tại.
  - **Validate notebook nhưng tuyệt đối không chạy và không render.** Dùng `json` stdlib (không `nbformat`, không import kernel): kiểm tra JSON UTF-8, là object cấp gốc, `nbformat == 4`, có `nbformat_minor`/`metadata`/`cells`, `cell_type` hợp lệ và `source` là chuỗi hoặc list chuỗi. Code trong notebook là **dữ liệu**, không bao giờ được thực thi - đây là lý do không dùng thư viện có khả năng execute.
  - **Credential tách đôi theo vai.** `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` chỉ đi vào `minio` và `minio-init`; `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` (app user) chỉ đi vào `api` và lệnh backup. Policy của app user chỉ có bucket stat/list + object get/put/delete trên đúng bucket này - không tạo/xoá bucket, không đụng policy/user khác. API không bao giờ nhận credential root.
  - **`/api/health` KHÔNG phụ thuộc MinIO.** Nó là oracle để auto-deployer quyết định rollback, nên nếu nó đỏ theo MinIO thì một sự cố MinIO sẽ kéo cả rollback nhầm một release đang chạy tốt. MinIO hỏng chỉ làm **endpoint artifact** trả 503 `ARTIFACT_STORAGE_UNAVAILABLE`.
  - **Backup phải gồm MinIO.** `scripts/backup_prod.sh` mirror toàn bộ bucket bằng `mc` pin đúng tag của compose vào thư mục backup timestamp, nén và ghi size + sha256 vào `MANIFEST.txt`. Retention 14 ngày chỉ chạy khi Mongo, app-data **và** MinIO đều thành công; lần chạy dở dang bị xoá thay vì để lại một bản backup trông như đã hoàn tất.
  - **MinIO nằm ngoài cơ chế deploy theo SHA.** `minio`/`minio-init` là hạ tầng pin theo tag, không tham gia override image `api`/`web` và không bị `prune_images` đụng tới. Trước khi thay `api`/`web`, auto-deployer kiểm `minio` healthy **và** `minio-init` đã exit 0; thiếu một trong hai thì dừng **trước khi** đổi container, in lệnh bootstrap, và **không** ghi `last-failed-sha` (lỗi ở thao tác tay, không ở commit - bootstrap xong là lượt timer sau deploy nốt chính SHA đó).
  - **Không làm trong ADR này**: verify thủ công, gói ZIP, tải Top-N, checkbox reproducibility, model artifact, chạy/render notebook, SHA-256 của artifact, versioning của MinIO, presigned URL.
- Consequences: Submission giờ phụ thuộc hai hệ lưu trữ (Mongo + MinIO) nên có thêm chế độ hỏng mới: object mất → 404 `ARTIFACT_NOT_FOUND`, MinIO không tới được → 503 `ARTIFACT_STORAGE_UNAVAILABLE`. Xoá cuộc thi dọn thêm prefix `competitions/<id>/` trên MinIO (best-effort, `files_removed:false` nếu dọn không sạch). Bucket phải được bootstrap (`minio-init`) trước release đầu tiên dùng artifact backend. Dev không cần MinIO chạy tay: `docker compose up` lo cả hai service, còn `scripts/minio_smoke.sh` kiểm chứng bucket private + quyền của app user trên một Compose project cô lập.
- Affected files/contracts: `backend/app/submission_artifacts/` (`storage.py`, `naming.py`, `validation.py`), `backend/app/submissions/router.py`, `backend/app/submissions/admin_router.py`, `backend/app/submissions/artifacts.py`, `backend/app/competitions/service.py`, `backend/app/memberships/admin_router.py`, `frontend/src/pages/SubmissionPage.tsx`, `frontend/src/lib/downloadArtifact.ts`, `frontend/src/components/ArtifactLinks.tsx`, `frontend/src/components/AdminSubmissionsPanel.tsx`, `frontend/src/pages/AdminSubmissionsPage.tsx`, `docker-compose.yml`, `docker-compose.prod.yml`, `scripts/minio_init.sh`, `scripts/backup_prod.sh`, `deploy/vps/auto-deploy.sh`, `docs/API_CONTRACT.md` §4-6, `docs/DATA_MODEL.md` §6, `docs/DEPLOYMENT.md` §MinIO, `docs/TEST_MATRIX.md`

## ADR-029 - Bảng bài nộp admin: sort đầy đủ, lọc tức thời và thống kê toàn cục
- Date: 2026-09-19
- Status: accepted
- Context: Trang `/admin/submissions` và panel Kết quả trong chi tiết cuộc thi chỉ sort được `created_at`/`team`/`primary_score`, phải bấm nút "Lọc" mới áp bộ lọc, và không có số liệu tổng quan. BTC phải so sánh đội theo F1/Precision/Recall, đối chiếu theo tên cuộc thi, và muốn thấy ngay quy mô dữ liệu đang xem.
- Decision:
  - **Sort mở rộng theo đúng hai allowlist tách biệt.** Route theo một cuộc thi nhận `created_at|team|primary_score|f1|precision|recall`; route toàn cục nhận thêm `competition`. `sort=competition` trên route scoped trả 422 vì đã khoá theo một cuộc thi thì sắp theo cuộc thi là vô nghĩa - allowlist chung sẽ âm thầm nhận giá trị này.
  - **Metric sort đi thẳng vào `metrics.<field>`**, không `$lookup`: `f1`/`precision`/`recall` là field sẵn có trên document. `team` và `competition` cần `$lookup` sang `accounts`/`competitions` vì sắp theo tên hiển thị. Mọi kiểu sort kết thúc bằng tie-break `created_at` rồi `_id` để phân trang xác định.
  - **Không thêm index cho metric sort.** Ba index mới cho một đường quản trị phụ không đáng chi phí ghi; sort `competition` cũng bắt buộc `$lookup` nên không thể index thuần. Ghi rõ quyết định này trong `DATA_MODEL.md` để lần sau không bị đọc thành thiếu sót.
  - **Bốn thống kê tính trên cả tập kết quả khớp bộ lọc**, không phải trang đang xem: `{total, competitions, teams, completed}`. Gộp chung một aggregation `$facet` với `total` của phân trang - cùng query filter, một lượt đọc, và `stats.total` luôn bằng `total`. Route scoped **không** trả `stats` và vẫn dùng `count_documents`.
  - **Lọc áp ngay, bỏ nút "Lọc".** Cuộc thi và trạng thái đổi là gọi lại server với `offset: 0`; ô tìm kiếm debounce 300 ms theo pattern `AdminAccountsPage` (Enter flush ngay). Đổi bộ lọc không được tạo request trùng: hàm đổi filter trả về chính object cũ khi giá trị không đổi, và effect debounce cũng vậy.
  - **Cột "Điểm chính" được highlight vàng ở cả hai chế độ.** Ý nghĩa không truyền chỉ bằng màu: header/cell có thêm border trái đậm và `aria-sort` vẫn là tín hiệu sắp xếp; rule hover riêng để hàng đang trỏ vẫn nhận ra được.
- Consequences: Response toàn cục có thêm field `stats` (optional ở type dùng chung vì route scoped không trả). Sort `competition` chậm hơn các sort khác do `$lookup`; chấp nhận vì đây là thao tác admin thủ công trên tập dữ liệu nhỏ. Bỏ nút "Lọc" làm số request tăng khi người dùng đổi nhiều bộ lọc liên tiếp, bù lại bằng debounce và chống request trùng.
- Affected files/contracts: `backend/app/submissions/service.py`, `backend/app/submissions/admin_router.py`, `frontend/src/api/results.ts`, `frontend/src/components/AdminSubmissionsPanel.tsx`, `frontend/src/pages/AdminSubmissionsPage.tsx`, `frontend/src/index.css`, `docs/API_CONTRACT.md` §5.5, `docs/DATA_MODEL.md` §6, `docs/TEST_MATRIX.md`

## ADR-030 - Notebook khung và trang Hướng dẫn dùng chung cho mọi cuộc thi
- Date: 2026-09-19
- Status: accepted
- Context: Mỗi cuộc thi phải tự mô tả lại cách nộp bài, và thí sinh không có điểm bắt đầu nào cho notebook tái lập - hai đội nộp hai notebook với mức tái lập rất khác nhau. Yêu cầu đặt ra một hướng dẫn chung và một notebook khung tải về được, "tạo cuộc thi là có sẵn".
- Decision:
  - **Notebook khung là tài nguyên built-in của nền tảng, không phải dữ liệu của cuộc thi.** Một tệp duy nhất `backend/app/competitions/starter_notebook.ipynb` nằm trong image, phục vụ ở `GET /api/starter-notebook`. Không có bản sao theo cuộc thi, không có document Mongo, admin **không** sửa/xoá/upload qua API - đổi notebook là đổi code rồi deploy. Đây là cái giá có ý thức để "mọi cuộc thi đều có sẵn" mà không cần hook lúc tạo cuộc thi và không cần migrate cuộc thi cũ.
  - **`competitions.resources` giữ nguyên schema.** Field đó tiếp tục chỉ chứa link Drive/Docs do admin khai báo (ADR-015); notebook built-in **không** được chèn vào đó. Block "Tài nguyên" render mục built-in trước danh sách link ngoài, badge đếm bằng `1 + số link hợp lệ`, nên cuộc thi không có resource ngoài vẫn thấy block. Mục built-in là `<button>` tải tại chỗ, không phải `<a target="_blank">` như link ngoài.
  - **Endpoint đọc công khai, không chạm Mongo/MinIO.** Không auth, không quota, không truy vấn DB. Trả `application/x-ipynb+json` + `nosniff` + cache public ngắn hạn, tên cố định `starter-notebook.ipynb`. Asset thiếu trên máy chủ → 500 `STARTER_NOTEBOOK_MISSING` (lỗi triển khai, không phải lỗi người dùng).
  - **Nội dung notebook là khung, không phải giải pháp**: tám bước theo trình tự chuẩn của một quy trình học máy - khai báo thư viện (`numpy`, `pandas`) và seed (`SEED = 42` cho `random`/`numpy`), cấu hình `ID_COLUMN`/`PREDICTION_COLUMN`, đọc dữ liệu, kiểm ID null/trùng, **tiền xử lý** và **huấn luyện mô hình** là hai bước `TODO` của thí sinh, sinh dự đoán, rồi dựng đúng hai cột và ghi `prediction.csv` với `index=False` kèm assert header/số dòng. Khung chạy được ngay khi chưa có mô hình để thí sinh kiểm tra đường ống nộp bài trước. Notebook **không** chứa checklist tái lập hay bảng lỗi thường gặp: nền tảng không kiểm chứng được nên không hứa. Notebook **không** được chạy hay render ở server - giống ADR-028, nội dung là dữ liệu.
  - **Trang `Hướng dẫn` là route công khai, không cần đăng nhập.** Đặt ngay sau `Tổng quan` trong mục lục cuộc thi và vẫn là `<Link>` + `aria-current="page"` - không giả lập `role="tab"` (giữ nguyên quyết định cũ của mục lục). Nội dung lấy từ cấu hình thật của cuộc thi (tên cột, dung lượng, cách tính điểm) nên hướng dẫn nói đúng cuộc thi đang xem thay vì một bản chung chung.
  - **Một nguồn dữ liệu cho hai trang.** Tên cột, bảng mẫu CSV và danh sách lỗi thường gặp nằm trong `frontend/src/lib/submissionRequirements.ts`, dùng chung bởi tab `Nộp bài` và trang `Hướng dẫn`; trước đây các mô tả này bị hardcode và có nguy cơ lệch nhau. Trang `Hướng dẫn` chỉ dùng phần tên cột và bảng mẫu - danh sách lỗi thường gặp chỉ hiện ở tab `Nộp bài`, nơi thí sinh đối chiếu ngay với thông báo lỗi.
- Consequences: Sửa notebook khung là sửa code backend và cần deploy, không thể vá nóng bằng UI - đổi lại không có đường nào để một cuộc thi có notebook khác nền tảng. `GET /api/starter-notebook` là endpoint công khai **không** truy vấn DB nên không ảnh hưởng `/api/health`. Trang Hướng dẫn hiển thị "chưa cấu hình" ở cuộc thi chưa thiết lập chấm điểm thay vì ẩn đi, để thí sinh biết lý do chưa nộp được.
- Affected files/contracts: `backend/app/competitions/starter_notebook.ipynb`, `backend/app/competitions/starter_notebook.py`, `backend/app/main.py`, `frontend/src/pages/CompetitionGuidePage.tsx`, `frontend/src/pages/CompetitionDetailPage.tsx`, `frontend/src/pages/SubmissionPage.tsx`, `frontend/src/lib/submissionRequirements.ts`, `frontend/src/components/CompetitionResources.tsx`, `frontend/src/App.tsx`, `docs/API_CONTRACT.md` §4-5.6, `docs/DATA_MODEL.md` §5c, `docs/DEPLOYMENT.md`, `docs/TEST_MATRIX.md`

## ADR-031 - Tên artifact tải về dùng một dấu gạch dưới làm phân cách
- Date: 2026-09-19
- Status: accepted
- Context: ADR-028 ghép tên file tải về bằng `__` giữa các segment. Tên thành `ai-challenge__Đội-01__submission-0009__prediction.csv`: dài, khó đọc, và `__` không phân biệt được với `_` vốn có sẵn trong slug/tên đội.
- Decision: Đổi **ba** dấu phân cách ghép tên thành một `_`: `{slug}_{account}_submission-{no:04d}_{prediction.csv|notebook.ipynb}`. Giữ nguyên toàn bộ phần còn lại của ADR-028: sanitization, fallback account/id, trần 180 ký tự, token `submission_no`/ObjectId rút gọn, header UTF-8 + ASCII, và `nosniff`. Thêm regression test với slug/tên đội chứa space, `_`, `__` và ký tự nguy hiểm để khẳng định tên kết quả **không bao giờ** chứa `__` và không có header/path injection.
- Consequences: Tên file đang lưu ở phía người dùng (đã tải về) không bị ảnh hưởng - đây chỉ là tên sinh ra lúc tải, không phải `object_key` hay dữ liệu lưu trữ, nên **không cần migration**. Không còn ký tự nào phân biệt ranh giới segment trong tên file; chấp nhận vì tên chỉ để đọc, mọi thao tác đều theo `submission_id`.
- Affected files/contracts: `backend/app/submission_artifacts/naming.py`, `docs/API_CONTRACT.md` §4, `docs/TEST_MATRIX.md`, `docs/DEPLOYMENT.md`

## ADR-032 - Tìm kiếm, sắp xếp và lọc danh sách cuộc thi ở phía client
- Date: 2026-09-20
- Status: accepted
- Context: Trang participant `/` chỉ có ô tìm kiếm theo tên và ba pill trạng thái. Người dùng không có cách nào xếp cuộc thi đang mở gần hạn lên trước, cũng không nhìn ra cuộc thi nào đang được nộp nhiều, và không lọc được theo việc mình đã tham gia hay chưa. Yêu cầu đặt ra tìm kiếm gõ tới đâu lọc tới đó (không nút submit), một nút **Lọc** mở dropdown gồm sắp xếp A–Z / sắp kết thúc / nhiều lượt nộp nhất, và lọc tham gia độc lập với lọc trạng thái.
- Decision:
  - **Toàn bộ search/sort/filter chạy ở client, không mở query param cho `/api/competitions`.** Endpoint trả **toàn bộ** competition visible trong một payload, không phân trang (ADR-014), nên giữ nguyên contract đó và để client quyết định thứ tự hiển thị. Thêm `?sort=` sẽ tạo hai nguồn sự thật về thứ tự (collation của Mongo so với collation tiếng Việt của JS) mà không đổi lại được gì ở quy mô này. Hệ quả: server vẫn `sort("name", 1)` chỉ như thứ tự mặc định của payload, frontend mới là nơi quyết định thứ tự người dùng thấy.
  - **`submission_count` chỉ có ở list, và là aggregate dùng chung.** Tách phần đếm submission ra khỏi `activity_counts()` thành `submission_counts(db, competition_ids)` để list public và bảng admin dùng cùng một đoạn code, không nhân bản truy vấn. List chạy **một** aggregation cho cả trang (không N+1) rồi gắn vào từng item; detail cố ý **không** có field này để không trả thêm một query cho mỗi lần mở trang chi tiết. Count đếm mọi document submission đã persist, **không** lọc `status`: yêu cầu là độ "hot" của cuộc thi, và bài bị reject vốn không tạo document nên không cần lọc thêm. Đây không phải rò dữ liệu mới - leaderboard participant đã trả `total_submissions` cho người đã đăng nhập - nhưng vẫn **không** kéo theo `member_count`/`inactive_member_count` (vẫn chỉ admin). Số này chỉ dùng để sắp xếp, **không** hiển thị trên thẻ.
  - **Bộ lọc tham gia của khách hiện nhưng bị khóa.** Khách không có membership nào, nên để họ chọn "Chưa tham gia" thì mọi cuộc thi đều khớp (vô nghĩa) còn "Đã tham gia" thì luôn rỗng (gây hiểu sai). Fieldset được `disabled` kèm dòng nhắc đăng nhập, và state participation bị **ép về `all` khi render** thay vì reset bằng effect - nhờ vậy logout giữa chừng không thể để lại một bộ lọc làm rỗng danh sách. Search, pill trạng thái và cả ba kiểu sắp xếp vẫn dùng được cho khách.
  - **Thứ tự phải tất định.** A–Z dùng `Intl.Collator("vi", { sensitivity: "base", numeric: true })` (tên tiếng Việt và số tự nhiên đúng thứ tự); mọi comparator kết thúc bằng tie-break tên → slug → id nên thứ tự không phụ thuộc thứ tự mảng đầu vào. `Sắp kết thúc` nhóm theo `status` (published trước, gần hạn nhất đứng đầu; closed sau, mới đóng gần đây trước) chứ **không** so với đồng hồ trang, để thứ tự không tự đổi theo thời gian và test không phụ thuộc thời điểm chạy; `end_at` thiếu/không parse được bị đẩy xuống cuối nhóm.
  - **Panel lọc dùng radio native trong `fieldset`, render qua portal.** Hai nhóm `Sắp xếp` / `Tham gia` dùng `fieldset` + `legend` + radio native nên hợp đồng bàn phím/đọc màn hình là của trình duyệt thay vì tự dựng `menuitemradio`; panel là non-modal dialog, Escape đóng và trả focus về trigger, click ngoài/scroll/resize đóng, Tab không bị trap (khác `RowActionMenu` của bảng admin vì ở đây kết quả hiện ngay tại chỗ). Panel neo `position: fixed` qua `createPortal` vì `.page-hero { overflow: hidden }` sẽ cắt dropdown nếu render tại chỗ. Trạng thái "đang lọc" hiện bằng viền đậm **kèm badge số**, không chỉ bằng màu.
- Consequences: Frontend phụ thuộc `submission_count` để sắp theo độ hot; field này optional trong type nên frontend chạy được với backend cũ (fallback `?? 0`, khi đó thứ tự rơi về A–Z) - đổi lại trong khoảng rollout lệch phiên bản, "Nhiều lượt nộp nhất" có thể trông giống A–Z. Danh sách không phân trang nghĩa là mọi kiểu sắp xếp/lọc vẫn là thao tác trên toàn bộ mảng trong bộ nhớ; khi số cuộc thi lớn lên, đây là chỗ đầu tiên cần chuyển sang server-side kèm phân trang (lúc đó phải chốt lại collation). Palette màu thẻ giữ nguyên quy tắc "theo vị trí đang render", nên đổi kiểu sắp xếp sẽ đổi màu thẻ - đúng như thiết kế hiện có.
- Affected files/contracts: `frontend/src/pages/DashboardPage.tsx`, `frontend/src/index.css`, `frontend/src/api/competitions.ts`, `backend/app/competitions/service.py`, `backend/app/competitions/router.py`, `docs/API_CONTRACT.md` §3, `docs/DATA_MODEL.md` §3, `docs/TEST_MATRIX.md`
