# AI Challenge Platform - Decision Log

Format theo ADR. Chỉ ghi quyết định có ảnh hưởng về sau; thay decision cũ thì đánh dấu superseded và link decision mới, không xóa lịch sử.

## ADR-001 - Single GCE VM + Docker Compose
- Date: 2026-09-15
- Status: accepted
- Context: MVP phục vụ 40-80 đội; cần chi phí và vận hành tối thiểu.
- Decision: Toàn bộ runtime trên 01 Google Compute Engine VM (Ubuntu Server LTS), điều phối bằng Docker Compose. Không Kubernetes, không multi-VM, không Cloud Run.
- Consequences: Đơn giản, rẻ, dễ backup cả VM/disk. Không HA — chấp nhận được cho MVP.
- Affected files/contracts: `plans/01_MASTER_CONTEXT.md` §3, `docs/DEPLOYMENT.md`

## ADR-002 - Same-origin frontend/API through Nginx
- Date: 2026-09-15
- Status: accepted
- Context: Tránh phức tạp CORS và expose backend trực tiếp ra public.
- Decision: Nginx là reverse proxy duy nhất: `/` → React SPA (static + fallback), `/api/` → FastAPI container. Không map `/data` ra web.
- Consequences: Không cần CORS production; một public origin qua Cloudflare Tunnel.
- Affected files/contracts: `plans/02_ARCHITECTURE_CONTRACTS.md` §2, `docs/API_CONTRACT.md` §1

## ADR-003 - MongoDB cho nghiệp vụ, persistent disk cho files
- Date: 2026-09-15
- Status: accepted
- Context: Cần lưu dữ liệu có cấu trúc (accounts, competitions, submissions) và files (Markdown, assets, ground truth, submissions CSV, backups).
- Decision: MongoDB lưu toàn bộ dữ liệu nghiệp vụ; files nằm trên persistent disk theo layout `/data/competitions/<id>/...` và `/data/submissions/<id>/...`. Không external object storage ở MVP.
- Consequences: Backup phải cover cả Mongo dump lẫn `/data`. Private files (ground truth, scoring config) tuyệt đối không được Nginx serve.
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
- Status: accepted
- Context: Sprint 03 cần chốt status transition, quy tắc edit theo trạng thái, hành vi clone và participant visibility; sprint file yêu cầu "clear rules" nhưng không chỉ định chi tiết.
- Decision:
  - Lifecycle: create → `draft`; `draft` → `published` (publish); `published` → `closed` (close). `closed` là terminal — không reopen/archive ở MVP (sprint file: dừng và hỏi nếu cần).
  - Edit theo status: `draft` sửa mọi config field; `published` mọi field trừ `primary_metric` (ảnh hưởng leaderboard đã có); `closed` read-only. `slug`, `status`, `created_by` luôn immutable — status chỉ đổi qua endpoint publish/close.
  - Clone: copy config (name/mô tả/join_mode/metric/quota/leaderboard_visible) thành draft mới với slug tự sinh `<slug>-copy`; KHÔNG copy status, dates (now → +1 năm), submissions, memberships. Content/ground-truth clone defer Sprint 04.
  - Visibility participant: API public chỉ trả `published` + `closed`; `draft` trả 404 như không tồn tại (không tiết lộ sự tồn tại).
- Consequences: Quota 0-1000, slug ≤64 ký tự enforced ở API layer. Publish/close sai trạng thái → 422 `INVALID_TRANSITION`. Không reopen — nếu BTC cần, phải hỏi user trước khi thêm transition mới.
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
- Consequences: Thêm deps `python-multipart` (backend) và `react-markdown`/`remark-gfm`/`rehype-sanitize` (frontend). Env mới `MAX_CONTENT_MB=2`, `MAX_ASSET_MB=2` (dùng chung `MAX_UPLOAD_MB` cho submission Sprint 05). Nginx `client_max_body_size 12m` đã lớn hơn các limit.
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
- Context: Nút "quay lại" ở `/login` bấm được và `navigate("/")` chạy, nhưng `RequireAuth` đẩy ngược về `/login` vì `/` đòi phiên, và backend cũng trả 401 cho `GET /api/competitions` khi ẩn danh — người dùng không có lối về dashboard. User chọn hướng mở dashboard cho khách thay vì sửa nút quay lại.
- Decision:
  - Thêm `get_optional_account`/`OptionalAccount` (`backend/app/auth/dependencies.py`): trả `request.state.account` hoặc `None` thay vì 401. Middleware sẵn có chỉ set `request.state.account` khi có cookie phiên nên không cần đổi gì thêm.
  - Chuyển sang auth tuỳ chọn: `GET /api/competitions`, `GET /api/competitions/{slug}`, `GET /api/competitions/{slug}/contents`, `.../contents/{content_slug}`, `.../assets/{name}`.
  - Khách không có membership nào nên `membership = {active:false, joined_at:null}` và chỉ thấy content `visibility=public`; content `members` vẫn 404 (không tiết lộ tồn tại). Draft vẫn 404 với mọi đối tượng, ở cả list lẫn detail.
  - **Thay đổi so với ADR-010**, vốn ghi "public = mọi account đã đăng nhập (không anonymous API)". Từ ADR-014, `public` nghĩa là "mọi người, kể cả khách"; `members` không đổi.
  - Vẫn yêu cầu đăng nhập (401, dùng `CurrentAccount`): join, submissions, submissions/me, leaderboard. Frontend giữ ranh giới tương ứng: bỏ `RequireAuth` ở `/` và route cha `/competitions/:slug`, bọc lại cho 3 route con `submit`/`submissions`/`leaderboard`.
  - Điều hướng khách: navbar hiện mục "Cuộc thi"; drawer mobile (dưới 40rem nút "Đăng nhập" trên header bị ẩn) có thêm lối "Đăng nhập"; thẻ cuộc thi hiện CTA "Đăng nhập để tham gia" kèm `state.from` để quay lại đúng trang, thay vì bắn POST join rồi ăn 401. Ô thống kê "Đã tham gia" bị ẩn với khách vì luôn bằng 0.
- Consequences: `assets/{name}` trước đây chỉ đòi đăng nhập chứ không kiểm tra visibility của content; mở cho khách giữ nguyên mức phơi nhiễm với participant và mở rộng thêm cho khách — chấp nhận để ảnh trong nội dung public hiển thị. `Cache-Control: private, max-age=300` giữ nguyên. Leaderboard vẫn chặn đăng nhập vì nằm ngoài phạm vi user xác nhận.
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
- Consequences: Rủi ro chuyển sang phía BTC — link có thể private/hết hạn mà platform không biết; helper text yêu cầu bật "Bất kỳ ai có liên kết". Đổi lại không có file người dùng nào đi vào `/data`, không tốn dung lượng, không cần thêm hạ tầng.
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
- Context: Publish chỉ kiểm tra trạng thái nên BTC publish được một cuộc thi thiếu scoring config hoặc ground truth hỏng — mọi bài nộp sau đó đều 422 `SCORING_NOT_READY`. Ở chiều ngược lại, join chỉ chặn draft/closed nên thí sinh vẫn join được sau `end_at` cho tới khi admin bấm close thủ công.
- Decision:
  - `backend/app/scoring/readiness.py` là **một** nguồn sự thật: đọc và parse lại ground truth thật bằng chính code chấm điểm (không chỉ `is_file()`), trả `{ready, code, message}`. Publish, banner admin và endpoint scoring đều đi qua đây.
  - Thứ tự kiểm tra khi publish: join code (`JOIN_CODE_REQUIRED`) trước, readiness sau (`SCORING_CONFIG_REQUIRED`/`SCORING_CONFIG_INVALID`/`GROUND_TRUTH_REQUIRED`/`GROUND_TRUTH_INVALID`). Publish thất bại giữ nguyên `draft`; submission runtime vẫn map về code chung `SCORING_NOT_READY` để không phá contract cũ.
  - Admin detail trả `publish_ready`/`publish_blocked_reason`; list cố ý không, vì readiness phải đọc file (N+1). Nút Publish ở list vẫn gọi backend và hiển thị lỗi API.
  - Join mở từ lúc publish đến hết `end_at`. Không có khái niệm "hạn đăng ký". Không kiểm tra `start_at` — join sớm để chuẩn bị là hợp lệ, chỉ nộp bài mới phụ thuộc `start_at`.
  - Thứ tự policy join: draft/unknown → 404; inactive membership → 403; đã join → 200 idempotent (kể cả sau deadline/closed); closed → `JOIN_CLOSED`; `now > end_at` → `JOIN_DEADLINE_PASSED`; rồi mới tới invite/code. Membership hiện có được xử lý trước cửa sổ thời gian để UI luôn đọc được trạng thái của mình.
- Consequences: BTC phải có config + ground truth hợp lệ trước khi mở cuộc thi; đổi lại không còn tình huống publish xong mà không ai nộp được. `JOIN_CLOSED` và `JOIN_DEADLINE_PASSED` cùng 422 nhưng khác code để UI phân biệt "BTC đã đóng" với "đã quá hạn".
- Affected files/contracts: `backend/app/scoring/readiness.py`, `backend/app/competitions/admin_router.py`, `backend/app/memberships/router.py`, `frontend/src/components/JoinControl.tsx`, `docs/API_CONTRACT.md` §3+§5.2+§6

## ADR-018 - Xoá theo hướng giữ lịch sử thi
- Date: 2026-09-17
- Status: accepted
- Context: Thiếu cả ba đường thoát: participant không rời được cuộc thi, admin không xoá cứng được member, và không có `DELETE` cho competition. Đồng thời phải tránh việc dọn dữ liệu làm mất kết quả đã chấm.
- Decision:
  - Participant **rời** cuộc thi = soft deactivate (`active=false`) qua `POST /leave`, áp dụng cả published/closed, idempotent, giữ nguyên bài nộp/điểm/thứ hạng. Tự join lại vẫn bị 403 `MEMBERSHIP_INACTIVE`; muốn quay lại phải nhờ BTC kích hoạt.
  - Admin **xoá cứng member** chỉ khi account chưa có bài `completed` trong cuộc thi (`has_completed_submission`). Có bài đã chấm → 409 `MEMBER_HAS_SUBMISSIONS` và không xoá gì. Khi được phép: xoá record submission chưa hoàn thành + file (best-effort, containment-check) rồi xoá membership sau cùng. Không có "force" flag.
  - **Xoá competition chỉ cho `draft`** (`confirm_slug` phải khớp, sai → 422 `CONFIRM_SLUG_MISMATCH`, không phải draft → 409 `COMPETITION_NOT_DELETABLE`). Published/closed phải giữ lịch sử; muốn kết thúc thì Đóng cuộc thi.
  - Cascade không dùng transaction (Mongo standalone): xoá con trước, cha sau, để lỗi giữa đường vẫn retry được. File dọn **sau** khi DB xong, best-effort; không phục hồi DB nếu xoá file lỗi mà báo `files_removed:false`.
  - `member_count` của admin đổi nghĩa thành số membership đang hoạt động, thêm `active_total` bên cạnh `total` để UI không trộn hai con số.
- Consequences: Không có đường nào xoá mất điểm đã chấm. Đổi lại, dữ liệu membership inactive tồn tại vĩnh viễn (đúng chủ đích) và race nhỏ giữa check-vs-delete member với một submission đồng thời vẫn tồn tại — chấp nhận, backend vẫn enforce membership khi nộp (ghi ở technical debt).
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
- Consequences: Thêm một `count_documents` cho mỗi lần mở detail của thành viên — chấp nhận. Phân trang chỉ giảm payload/UI, không đổi độ phức tạp query; còn in-memory nên phải xem lại nếu vượt quy mô hiện tại. Countdown không còn đứng yên nhưng tốn timer chạy nền; nhịp thưa giữ chi phí thấp.
- Affected files/contracts: `backend/app/submissions/service.py` (`quota_status`), `backend/app/competitions/router.py`, `backend/app/leaderboard/{router,service}.py`, `frontend/src/hooks/useCountdown.ts`, `frontend/src/lib/countdown.ts`, `docs/API_CONTRACT.md` §3+§4

## ADR-020 - Tạm hoãn public/private leaderboard split (deferred)
- Date: 2026-09-17
- Status: deferred — không implement trong scope này
- Context: Cần bảng xếp hạng public và private (theo mùa thi). Đề xuất ban đầu là tạo hai competition, một public một private.
- Decision: Không làm theo hướng hai competition, và cũng chưa implement split trong scope hiện tại.
  - Hai competition không tương đương: join/quota/content/submission/export bị nhân đôi, một lần nộp không sinh được hai điểm đúng nghĩa, và thí sinh phải join hai lần.
  - Hướng đúng khi làm thật: **một** ground truth có partition public/private, một submission sinh hai score, private chỉ reveal/finalize sau khi close (hoặc theo cờ "final submission" do BTC chọn). Việc này chạm vào scoring nên phải là thay đổi riêng, có ADR mới.
- Consequences: Trong khi chờ, chỉ có một bảng xếp hạng duy nhất và nó bị `leaderboard_visible` bật/tắt. Ghi lại để lần sau không ai "giải quyết" bằng cách nhân đôi competition.
- Affected files/contracts: `docs/DECISIONS.md`, `docs/PROJECT_STATE.md` §3
