# Data Model - AI Challenge Platform

Nguộc sự thật về MongoDB collections và indexes. Trạng thái `implemented` = có code tạo/migration + được dùng thật; `planned` = baseline từ `plans/02_ARCHITECTURE_CONTRACTS.md`, chưa code.

Quy ước chung:
- Thời gian lưu UTC trong DB; UI format theo local timezone.
- Motor đọc về naive datetime: mọi chỗ so sánh/format đi qua `backend/app/core/datetimes.py` (`as_utc`, `utc_day_bounds`, `iso_z`), naive được hiểu là UTC (ADR-016).
- Naming snake_case.
- Mọi dữ liệu nghiệp vụ gắn `competition_id` (ADR-005).
- Files không nằm trong Mongo: content Markdown, asset và ground truth theo layout `/data/` ở `plans/01_MASTER_CONTEXT.md` §11; artifact của submission (CSV dự đoán + notebook) nằm trong MinIO private (ADR-028), key ghép từ slug theo ADR-033.

## 1. accounts - implemented (Sprint 02)

Fields:
- `_id` (ObjectId)
- `email` (login identifier, lưu lowercase, strip)
- `name`
- `password_hash` (Argon2id, argon2-cffi defaults)
- `role`: `admin` | `participant`
- `active`: bool - khóa toàn nền tảng (disable hủy hiệu lực mọi session)
- `slug` (str | absent ở account cũ) - dùng làm segment đường dẫn artifact trên MinIO (ADR-033). Sinh tự động từ `name` ở **lần nộp bài đầu tiên**, không nhập tay, không bao giờ sinh lại (đổi `name` không đổi slug). Trùng thì thêm `-` + 3 ký tự random. Không có trong representation nào trả về API.
- `created_at`, `updated_at` (UTC, timezone-aware)

Indexes:
- unique trên `email` - tạo idempotent ở app startup (`ensure_indexes`)
- unique **sparse** trên `slug` - sparse để account cũ chưa có field này không cùng rơi vào giá trị null và chặn nhau (ADR-033)

## 2. sessions - implemented (Sprint 02)

Fields:
- `_id`: sha256 hex của raw session token (token gốc là `secrets.token_urlsafe(32)`, chỉ tồn tại trong cookie)
- `account_id` (ObjectId → accounts._id)
- `created_at` (UTC, timezone-aware)
- `expires_at` (UTC, timezone-aware)

Indexes:
- TTL trên `expires_at` (`expireAfterSeconds=0`) - tạo idempotent ở app startup
- `account_id`

Lưu ý: Mongo TTL chỉ dọn định kỳ; `resolve_session` vẫn check `expires_at` từng request nên session hết hạn bị từ chối ngay.

## 3. competitions - implemented (Sprint 03)

Fields:
- `_id` (ObjectId)
- `slug` (unique) - format `[a-z0-9]+(-[a-z0-9]+)*`, tối đa 64 ký tự, immutable sau tạo
- `name`
- `short_description`
- `status`: `draft` | `published` | `closed` - lifecycle: draft → published → closed ⇄ published (`/reopen`). Xoá được ở `draft` và `closed`. Xem ADR-009 + ADR-027
- `start_at`, `end_at` (UTC, timezone-aware; API nhận ISO, trả ISO `...Z`)
- `join_mode`: `open` | `code` | `invite_only`
- `join_code_hash` (luôn None ở Sprint 03 - join là Sprint 04; không bao giờ trả về API)
- `primary_metric`: `f1` | `precision` | `recall`
- `quota_per_day` (0-1000)
- `leaderboard_visible` (bool)
- `resources` (list, default `[]` | absent ở document cũ) - link Google Drive cho participant tải, xem §9
- `scoring_config` (object | absent) - Sprint 05; chỉ chứa CSV/metric behavior, xem §7
- `ground_truth` (object | absent) - Sprint 05; metadata/path private, xem §8
- `created_by` (email của admin tạo) - chỉ trả trong represent admin, không bao giờ lộ cho guest/participant (ADR-016)
- `created_at`, `updated_at` (UTC, timezone-aware)

Indexes:
- unique trên `slug` - tạo idempotent ở app startup (`ensure_indexes`)

Derived field (không lưu DB):
- `submission_count` - **không** là field của document. `GET /api/competitions` chạy một aggregation `$match competition_id` + `$group _id` trên `submissions` cho cả trang rồi gắn vào từng item (ADR-032). Đếm mọi document submission đã persist, không phụ thuộc `status` **lẫn `review`**, nên bài bị reject (không tạo document) không được tính, còn bài đã persist mà admin từ chối thì vẫn tính - nó vẫn là một lượt đã tiêu (ADR-035). Không migration, không index mới: index có prefix `competition_id` của `submissions` (§6) đã phục vụ `$match` này. Detail và endpoint admin không dùng lại field này - admin đã có `submission_count` từ `activity_counts`.

## 4. competition_memberships - implemented (Sprint 04)

Fields:
- `_id` (ObjectId)
- `competition_id` (ObjectId → competitions._id)
- `account_id` (ObjectId → accounts._id)
- `active`: bool - khóa trong riêng một competition (participant không tự kích hoạt lại; admin reactivate giữ `joined_at`). Từ ADR-018, participant tự đặt `false` bằng `POST /leave` (soft deactivate); admin xoá cứng được bằng `DELETE .../members/{account_id}` **chỉ khi** account chưa có bài `completed` - document bị xoá hẳn trong trường hợp đó.
- `joined_at` (UTC, timezone-aware)
- `updated_at` (UTC, timezone-aware)
- `submission_seq` (int | absent ở membership cũ) - counter cấp `submission_no` cho cặp (cuộc thi, account) này, tăng nguyên tử bằng `$inc` **trước** khi upload (ADR-033). Membership chưa có thì lần cấp đầu tiên seed bằng `submission_no` lớn nhất đã cấp cho cặp đó; số nhảy cách nếu upload fail sau khi đã cấp.
- `quota_day` (str `YYYY-MM-DD` UTC | absent ở membership cũ) + `quota_used` (int | absent) - bộ đếm lượt nộp theo ngày, nguồn sự thật của hạn mức thay cho phép đếm submission (ADR-034). `quota_used` chỉ được tăng/giảm qua `find_one_and_update` có điều kiện nên không bao giờ vượt `quota_per_day`; sang ngày mới (hoặc membership chưa có field) thì seed lại từ số bài `completed` thật trong ngày. Bài không ghi được (upload/insert lỗi) được trả lại lượt.

Indexes:
- unique compound `(competition_id, account_id)` - enforce race-safe idempotent join
- `account_id` - batch lookup membership cho dashboard

## 5. competition_contents - implemented (Sprint 04)

Fields:
- `_id` (ObjectId - sinh trước insert, dùng làm tên file)
- `competition_id` (ObjectId)
- `title`
- `slug` (format như competition slug, unique trong competition)
- `order` (int 0-9999, default max+10)
- `visibility`: `public` (mọi account đã đăng nhập) | `members` (membership active)
- `markdown_path` (relative trong DATA_DIR: `competitions/<cid>/content/<content_id>.md` - backend sinh, không dùng input user)
- `size_bytes` (int | null - null = chưa upload file)
- `created_at`, `updated_at` (UTC, timezone-aware)

Indexes:
- unique `(competition_id, slug)`
- sort `(competition_id, order)`

## 5b. Competition assets (filesystem, không có collection)

`<DATA_DIR>/competitions/<competition_id>/assets/<uuid4>.<ext>` - PNG/JPEG/GIF/WebP ≤2 MiB (sniff magic bytes, không SVG). List bằng cách đọc directory (số lượng nhỏ); serve qua API có authz + `nosniff`.

## 5c. Starter notebook (asset đóng gói, không có collection)

`backend/app/competitions/starter_notebook.ipynb` là **một** tệp cố định nằm trong image backend (Dockerfile `COPY app ./app`), phục vụ ở `/api/starter-notebook`. Không có document Mongo, không có bản sao theo cuộc thi, không ghi vào `competitions.resources` và admin không sửa được qua API - đổi notebook là đổi code rồi deploy (ADR-030). Không chạy/không render nội dung này ở server.

## 6. submissions - implemented (Sprint 05; artifact trên MinIO từ ADR-028)

Fields:
- `_id`
- `competition_id`
- `account_id`
- `submission_no` (int | absent ở record cũ) - số thứ tự thật của bài nộp theo `(competition_id, account_id)`, dùng làm token trong tên file khi tải **và** trong object key trên MinIO. Từ ADR-033 số được cấp trước khi upload từ counter `submission_seq` của membership; record tạo trước ADR-028 không có field này.
- `artifacts` (object | absent ở record cũ) - hai artifact của lượt nộp, mỗi kind một entry:
  - `prediction` / `notebook`: `{object_key, original_filename, size_bytes}`
  - `object_key` là đường dẫn trong bucket MinIO `submission-artifacts`, không bao giờ trả về API (chỉ `filename`/`size_bytes`/`available` đi ra qua `artifact_metadata`)
- `file_path` (chỉ record cũ) - CSV trên persistent disk theo layout ADR-003; vẫn đọc được khi tải, không có migration bắt buộc
- `original_filename` (chỉ record cũ, đi cùng `file_path`)
- `status`: `completed` (chỉ persist bài validation/scoring thành công)
- `metrics`: `{f1, precision, recall}` raw float
- `primary_score`
- `created_at`
- `review` (object | absent ở record cũ) - quyết định xét duyệt **hậu kiểm** của admin, là trục **độc lập** với `status` (ADR-035):
  - `status`: `rejected` | `accepted`
  - `note` (str | null) - lý do từ chối, participant đọc được; luôn `null` khi `accepted`
  - `reviewed_by` (ObjectId → accounts._id), `reviewed_at` (UTC, timezone-aware)
  - Ghi **cả object** trong một `$set` trên một document nên không bao giờ trộn metadata của hai lần xét duyệt; chỉ giữ quyết định **gần nhất**, không có event history. `reviewed_by`/`reviewed_at` không bao giờ đi ra endpoint participant.

Policy: validation-rejected không tạo record và file không được lưu (ADR-011). Một lượt nộp hợp lệ cần **cả** CSV lẫn notebook; thiếu một trong hai thì không upload object nào và không tiêu quota. `quota_remaining` là response-derived field, không lưu DB. Hạn mức/ngày đọc từ bộ đếm `quota_day`/`quota_used` trên membership (§4), seed từ số bài `completed` theo `created_at` trong ngày UTC khi sang ngày mới (ADR-034).

Document thiếu `review` (mọi record cũ và mọi bài chưa từng bị xét duyệt) mặc định là **được tính kết quả**: predicate dùng chung là `status == "completed" AND review.status != "rejected"`, và `$ne` khớp cả document thiếu field nên **không cần migration hay backfill**. Từ chối và khôi phục đều không đụng `status`, `metrics`, `primary_score`, `artifacts`, `submission_no`, `created_at` hay counter quota - nhờ vậy quota, scoring lock, bảo vệ xoá member và việc giữ artifact giữ nguyên hành vi; khôi phục cũng không chấm lại vì metrics đã nằm trong document.

Artifact mới **không** nằm dưới `<DATA_DIR>`: object key là `competitions/<slug cuộc thi>/accounts/<slug account>/submissions/submission-0001/prediction.csv|notebook.ipynb`, bucket private, chỉ FastAPI đọc/ghi (ADR-028, layout slug từ ADR-033). Token `submission-{no:04d}` sinh từ cùng một hàm với tên file tải về nên hai chỗ không lệch nhau. Record tạo trước ADR-033 giữ nguyên key theo ObjectId (`competitions/<id>/accounts/<id>/submissions/<id>/…`) vì `object_key` lưu nguyên văn trong document - **không có migration**, hai layout cùng tồn tại. Xoá cuộc thi dọn **cả hai** prefix `competitions/<slug>/` và `competitions/<id>/`; xoá member dọn object của các bài chưa `completed` - xem §10.

Indexes:
- unique partial `(competition_id, account_id, submission_no)` (`submission_no` tồn tại) - chốt số thứ tự, record legacy không tham gia ràng buộc
- `(competition_id, account_id, created_at DESC, _id DESC)` - participant history exact sort
- `(competition_id, primary_score)`
- `(competition_id, status, primary_score DESC, created_at ASC, account_id ASC, _id ASC)` - leaderboard completed/best-score exact sort
- `(competition_id, status, created_at DESC, _id DESC)` - admin history có status filter
- `(competition_id, created_at DESC, _id DESC)` - admin history không filter status
- `(created_at DESC, _id DESC)` - trang `/admin/submissions` toàn cục sắp xếp không kèm `competition_id`
- `(primary_score DESC, created_at DESC, _id DESC)` - sắp xếp theo điểm ở trang toàn cục

`review` **không có index riêng**: đường đọc chính của leaderboard/export vẫn đi qua prefix `competition_id` + `status` của index có sẵn rồi lọc `review` trên tập đã thu hẹp, còn bộ lọc `review` của bảng admin là đường quản trị phụ. Thêm index khi có bằng chứng đo được, không thêm trước (ADR-035).

Sắp xếp của trang toàn cục: `created_at` (default, desc) và `primary_score` dùng index ở trên; `team` sắp theo **tên account** nên phải `$lookup` sang `accounts`, `competition` sắp theo tên rồi slug nên `$lookup` sang `competitions` (ADR-029). Hai metric còn lại (`f1`, `precision`, `recall`) sắp trực tiếp trên `metrics.<field>` và không có index riêng: đây là đường quản trị phụ, thêm ba index nữa không đáng so với chi phí ghi. Mọi kiểu sort đều kết thúc bằng tie-break `created_at` rồi `_id` để phân trang không trùng/mất dòng.

`stats` của trang toàn cục là **derived**, không lưu DB và không có collection riêng: một aggregation `$facet` trên cùng query filter trả về `total`, số `competition_id` khác nhau, số `account_id` khác nhau và số document **được tính kết quả** (`status=completed` + `review.status != rejected`) - nên nhãn của thẻ này là "Được tính kết quả", không phải "Đã chấm điểm" (ADR-035). Route theo một cuộc thi vẫn dùng `count_documents` và không chạy aggregation này.

Sprint 06 không thêm field persistence. My Submissions, leaderboard, admin view và export đều là dữ liệu derived từ `submissions` + safe account fields. `total_submissions` chỉ đếm record **được tính kết quả**, nhất quán với ADR-011 và ADR-035.

## 7. Scoring config (embedded trong competitions)

`competitions.scoring_config`:
- `id_column`, `prediction_column`, `label_column`
- `average`: `binary` | `macro` | `weighted`
- `pos_label` (nếu binary)
- `higher_is_better`: `true` (MVP)

Không lưu `scoring_config.json`. `primary_metric` và `quota_per_day` dùng top-level competition fields hiện có. `MAX_UPLOAD_MB` chỉ đến từ environment, không lưu Mongo (ADR-011).

## 8. Ground truth metadata (embedded trong competitions)

`competitions.ground_truth`:
- `path`: relative `competitions/<competition_id>/private/ground_truth.csv`
- `row_count`
- `columns`: danh sách header, không chứa row/label values
- `uploaded_at` (UTC)

File thật private trên persistent disk. Scoring ready khi có `scoring_config`, metadata path hợp lệ và file thường tồn tại (không chấp nhận symlink). Config/ground truth khóa khi competition closed hoặc có submission completed.

Readiness dùng cho publish là **một** hàm dùng chung (`backend/app/scoring/readiness.py`) đọc và parse lại ground truth thật, không chỉ kiểm tra file tồn tại (ADR-017).

## 9. Competition resources (embedded trong competitions)

`competitions.resources`: list `{label, url}`, tối đa 10 phần tử, label ≤120 ký tự, url ≤2048 ký tự và phải là `https` trên `drive.google.com`/`docs.google.com` (không credentials). Đây là link ngoài, không phải file trên hệ thống - không có collection, không có thư mục trong `<DATA_DIR>` (ADR-015).

Document tạo trước thay đổi này không có field; serializer trả `[]` nên không cần migration Mongo. `clone` copy nguyên list.

## 10. Deletion semantics (ADR-018)

Không dùng Mongo transaction (standalone). Thứ tự xoá luôn là con trước – cha sau để lỗi giữa đường vẫn còn bản ghi gốc cho lần gọi lại:

- `DELETE /api/admin/competitions/{id}` (`draft` + `closed`; `published` → 409 `COMPETITION_NOT_DELETABLE`): `submissions` → `competition_memberships` → `competition_contents` → `competitions`, sau đó best-effort `rmtree` hai root `<DATA_DIR>/competitions/<id>` và `<DATA_DIR>/submissions/<id>` **và** dọn hai prefix MinIO `competitions/<slug>/` + `competitions/<id>/` (ADR-028, ADR-033). Một bước dọn lỗi ⇒ `files_removed:false`, DB đã xoá xong. `accounts` và `sessions` không bị đụng.
- `DELETE /api/admin/competitions/{id}/members/{account_id}`: xoá record submission chưa `completed` của account (kèm object MinIO/file legacy, best-effort) rồi xoá membership cuối cùng. Bài `completed` không bao giờ bị xoá - vướng thì trả 409 và dừng.
- `POST /api/competitions/{slug}/leave`: chỉ `update` `active=false`, không xoá gì.

Xoá competition `published` không có trong phạm vi: cuộc thi đang chạy phải Kết thúc trước. `draft` và `closed` xoá được (cascade), nên "đã kết thúc" không phải là bảo đảm còn dữ liệu - muốn giữ lịch sử thi thì đừng xoá (ADR-027).
