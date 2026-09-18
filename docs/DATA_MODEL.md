# Data Model - AI Challenge Platform

Nguộc sự thật về MongoDB collections và indexes. Trạng thái `implemented` = có code tạo/migration + được dùng thật; `planned` = baseline từ `plans/02_ARCHITECTURE_CONTRACTS.md`, chưa code.

Quy ước chung:
- Thời gian lưu UTC trong DB; UI format theo local timezone.
- Motor đọc về naive datetime: mọi chỗ so sánh/format đi qua `backend/app/core/datetimes.py` (`as_utc`, `utc_day_bounds`, `iso_z`), naive được hiểu là UTC (ADR-016).
- Naming snake_case.
- Mọi dữ liệu nghiệp vụ gắn `competition_id` (ADR-005).
- Files không nằm trong Mongo - xem layout `/data/` ở `plans/01_MASTER_CONTEXT.md` §11.

## 1. accounts - implemented (Sprint 02)

Fields:
- `_id` (ObjectId)
- `email` (login identifier, lưu lowercase, strip)
- `name`
- `password_hash` (Argon2id, argon2-cffi defaults)
- `role`: `admin` | `participant`
- `active`: bool - khóa toàn nền tảng (disable hủy hiệu lực mọi session)
- `created_at`, `updated_at` (UTC, timezone-aware)

Indexes:
- unique trên `email` - tạo idempotent ở app startup (`ensure_indexes`)

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
- `status`: `draft` | `published` | `closed` - lifecycle: draft → published → closed (terminal), xem ADR-009
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

## 4. competition_memberships - implemented (Sprint 04)

Fields:
- `_id` (ObjectId)
- `competition_id` (ObjectId → competitions._id)
- `account_id` (ObjectId → accounts._id)
- `active`: bool - khóa trong riêng một competition (participant không tự kích hoạt lại; admin reactivate giữ `joined_at`). Từ ADR-018, participant tự đặt `false` bằng `POST /leave` (soft deactivate); admin xoá cứng được bằng `DELETE .../members/{account_id}` **chỉ khi** account chưa có bài `completed` - document bị xoá hẳn trong trường hợp đó.
- `joined_at` (UTC, timezone-aware)
- `updated_at` (UTC, timezone-aware)

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

## 6. submissions - implemented (Sprint 05)

Fields:
- `_id`
- `competition_id`
- `account_id`
- `file_path`
- `original_filename`
- `status`: `completed` (Sprint 05 chỉ persist bài validation/scoring thành công)
- `metrics`: `{f1, precision, recall}` raw float
- `primary_score`
- `created_at`

Policy: validation-rejected không tạo record và file không được lưu (ADR-011). `quota_remaining` là response-derived field, không lưu DB. Quota đếm completed theo `created_at` trong ngày UTC.

Indexes:
- `(competition_id, account_id, created_at DESC, _id DESC)` - participant history exact sort
- `(competition_id, primary_score)`
- `(competition_id, status, primary_score DESC, created_at ASC, account_id ASC, _id ASC)` - leaderboard completed/best-score exact sort
- `(competition_id, status, created_at DESC, _id DESC)` - admin history có status filter
- `(competition_id, created_at DESC, _id DESC)` - admin history không filter status

Sprint 06 không thêm field persistence. My Submissions, leaderboard, admin view và export đều là dữ liệu derived từ `submissions` + safe account fields. `total_submissions` chỉ đếm record `completed`, nhất quán với ADR-011.

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

- `DELETE /api/admin/competitions/{id}` (chỉ `draft`): `submissions` → `competition_memberships` → `competition_contents` → `competitions`, sau đó best-effort `rmtree` hai root `<DATA_DIR>/competitions/<id>` và `<DATA_DIR>/submissions/<id>`. `accounts` và `sessions` không bị đụng.
- `DELETE /api/admin/competitions/{id}/members/{account_id}`: xoá record submission chưa `completed` của account (kèm file, best-effort) rồi xoá membership cuối cùng. Bài `completed` không bao giờ bị xoá - vướng thì trả 409 và dừng.
- `POST /api/competitions/{slug}/leave`: chỉ `update` `active=false`, không xoá gì.

Xoá competition/published/closed không có trong phạm vi: lịch sử thi là dữ liệu phải giữ.
