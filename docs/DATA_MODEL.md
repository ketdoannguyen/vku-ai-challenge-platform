# Data Model - AI Challenge Platform

Nguộc sự thật về MongoDB collections và indexes. Trạng thái `implemented` = có code tạo/migration + được dùng thật; `planned` = baseline từ `plans/02_ARCHITECTURE_CONTRACTS.md`, chưa code.

Quy ước chung:
- Thời gian lưu UTC trong DB; UI format theo local timezone.
- Naming snake_case.
- Mọi dữ liệu nghiệp vụ gắn `competition_id` (ADR-005).
- Files không nằm trong Mongo — xem layout `/data/` ở `plans/01_MASTER_CONTEXT.md` §11.

## 1. accounts — implemented (Sprint 02)

Fields:
- `_id` (ObjectId)
- `email` (login identifier, lưu lowercase, strip)
- `name`
- `password_hash` (Argon2id, argon2-cffi defaults)
- `role`: `admin` | `participant`
- `active`: bool — khóa toàn nền tảng (disable hủy hiệu lực mọi session)
- `created_at`, `updated_at` (UTC, timezone-aware)

Indexes:
- unique trên `email` — tạo idempotent ở app startup (`ensure_indexes`)

## 2. sessions — implemented (Sprint 02)

Fields:
- `_id`: sha256 hex của raw session token (token gốc là `secrets.token_urlsafe(32)`, chỉ tồn tại trong cookie)
- `account_id` (ObjectId → accounts._id)
- `created_at` (UTC, timezone-aware)
- `expires_at` (UTC, timezone-aware)

Indexes:
- TTL trên `expires_at` (`expireAfterSeconds=0`) — tạo idempotent ở app startup
- `account_id`

Lưu ý: Mongo TTL chỉ dọn định kỳ; `resolve_session` vẫn check `expires_at` từng request nên session hết hạn bị từ chối ngay.

## 3. competitions — implemented (Sprint 03)

Fields:
- `_id` (ObjectId)
- `slug` (unique) — format `[a-z0-9]+(-[a-z0-9]+)*`, tối đa 64 ký tự, immutable sau tạo
- `name`
- `short_description`
- `status`: `draft` | `published` | `closed` — lifecycle: draft → published → closed (terminal), xem ADR-009
- `start_at`, `end_at` (UTC, timezone-aware; API nhận ISO, trả ISO `...Z`)
- `join_mode`: `open` | `code` | `invite_only`
- `join_code_hash` (luôn None ở Sprint 03 — join là Sprint 04; không bao giờ trả về API)
- `primary_metric`: `f1` | `precision` | `recall`
- `quota_per_day` (0-1000)
- `leaderboard_visible` (bool)
- `created_by` (email của admin tạo)
- `created_at`, `updated_at` (UTC, timezone-aware)

Indexes:
- unique trên `slug` — tạo idempotent ở app startup (`ensure_indexes`)

## 4. competition_memberships — planned

Fields:
- `competition_id`
- `account_id`
- `active`: bool — khóa trong riêng một competition
- `joined_at`

Indexes:
- unique compound `(competition_id, account_id)`

## 5. competition_contents — planned

Fields:
- `_id`
- `competition_id`
- `title`
- `slug`
- `order`
- `markdown_path`
- `visibility`
- `created_at`, `updated_at`

Indexes:
- unique `(competition_id, slug)`
- sort `(competition_id, order)`

## 6. submissions — planned

Fields:
- `_id`
- `competition_id`
- `account_id`
- `file_path`
- `original_filename`
- `status`: `completed` | `rejected` | `failed`
- `metrics`: `{f1, precision, recall}` khi completed
- `primary_score`
- `error_code` / `error_message` khi rejected/failed
- `created_at`

Indexes:
- `(competition_id, account_id, created_at)`
- `(competition_id, primary_score)`

## 7. Scoring config (file, không phải collection)

`/data/competitions/<competition_id>/private/scoring_config.json`:
- `id_column`, `prediction_column`, `label_column`
- `average`: `binary` | `macro` | `weighted`
- `pos_label` (nếu binary)
- `primary_metric`: `f1` | `precision` | `recall`
- `higher_is_better`: `true` (MVP)
