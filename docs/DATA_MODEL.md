# Data Model - AI Challenge Platform

Nguộc sự thật về MongoDB collections và indexes. Trạng thái `implemented` = có code tạo/migration + được dùng thật; `planned` = baseline từ `plans/02_ARCHITECTURE_CONTRACTS.md`, chưa code.

Quy ước chung:
- Thời gian lưu UTC trong DB; UI format theo local timezone.
- Naming snake_case.
- Mọi dữ liệu nghiệp vụ gắn `competition_id` (ADR-005).
- Files không nằm trong Mongo — xem layout `/data/` ở `plans/01_MASTER_CONTEXT.md` §11.

## 1. accounts — planned

Fields:
- `_id`
- `email` (login identifier)
- `name`
- `password_hash` (Argon2id)
- `role`: `admin` | `participant`
- `active`: bool — khóa toàn nền tảng
- `created_at`, `updated_at`

Indexes:
- unique trên `email`

## 2. sessions — planned

Fields:
- `_id`: hash của raw session token
- `account_id`
- `created_at`
- `expires_at`

Indexes:
- TTL trên `expires_at`
- `account_id`

## 3. competitions — planned

Fields:
- `_id`
- `slug` (unique)
- `name`
- `short_description`
- `status`: `draft` | `published` | `closed`
- `start_at`, `end_at`
- `join_mode`: `open` | `code` | `invite_only`
- `join_code_hash` (nullable; không trả về participant API)
- `primary_metric`: `f1` | `precision` | `recall`
- `quota_per_day`
- `leaderboard_visible`
- `created_by`
- `created_at`, `updated_at`

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
