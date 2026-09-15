# Architecture and Contracts - Baseline v1

Tài liệu này là baseline để các sprint không tự ý đổi contract. Nếu implementation cần thay đổi, AI phải ghi lý do vào `docs/DECISIONS.md` và cập nhật contract sau khi được chấp nhận.

## 1. Repository target structure

    ai-challenge/
      frontend/
      backend/
      nginx/
      scripts/
      docs/
      plans/
      data/                 # local dev only; gitignored
      docker-compose.yml
      docker-compose.prod.yml   # nếu cần tách production overrides
      .env.example
      .gitignore
      README.md

Backend target:

    backend/app/
      main.py
      core/
      auth/
      accounts/
      competitions/
      memberships/
      content/
      submissions/
      scoring/
      leaderboard/
      admin/

Không ép tạo folder rỗng. Chỉ tạo module khi sprint bắt đầu sử dụng.

## 2. Public URL model
Frontend và API cùng origin:

    https://challenge.example.vn/
    https://challenge.example.vn/api/...

Nginx:
- `/` -> React static/SPA fallback.
- `/api/` -> FastAPI container.
- Không map `/data/private` hoặc host file system ra web.

Mục tiêu: không cần CORS production.

## 3. Frontend route contract
Baseline:
- `/login`
- `/` -> dashboard/list competitions
- `/competitions/:slug`
- `/competitions/:slug/content/:contentSlug`
- `/competitions/:slug/submit`
- `/competitions/:slug/submissions`
- `/competitions/:slug/leaderboard`
- `/admin`
- `/admin/accounts`
- `/admin/competitions`
- `/admin/competitions/:id`

Route có thể tinh gọn nhưng không được hard-code một competition.

## 4. API namespace contract
Tất cả backend route dưới `/api`.

### Health
- `GET /api/health`

### Auth
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### Participant competitions
- `GET /api/competitions`
- `GET /api/competitions/{slug}`
- `POST /api/competitions/{id}/join`
- `GET /api/competitions/{id}/contents`
- `GET /api/competitions/{id}/contents/{content_slug}`

### Submissions
- `POST /api/competitions/{id}/submissions`
- `GET /api/competitions/{id}/submissions/me`
- `GET /api/competitions/{id}/leaderboard`

### Admin
Namespace `/api/admin/...`.
Tối thiểu:
- accounts CRUD cần thiết
- competitions create/edit/clone/publish/close
- memberships
- contents upload/order/delete
- ground truth/scoring config
- submissions view
- export xlsx

Tên endpoint cụ thể có thể tinh chỉnh trong sprint, nhưng phải cập nhật `docs/API_CONTRACT.md` và không để hai convention song song.

## 5. MongoDB baseline
### accounts
Fields:
- `_id`/`account_id`
- `email` or login identifier
- `name`
- `password_hash`
- `role`: admin|participant
- `active`
- `created_at`, `updated_at`

Indexes:
- unique login/email

### sessions
- `_id`: session token hash/id
- `account_id`
- `created_at`
- `expires_at`

Indexes:
- TTL on `expires_at`
- `account_id`

### competitions
- `_id`
- `slug` unique
- `name`
- `short_description`
- `status`
- `start_at`, `end_at`
- `join_mode`
- `join_code_hash` nullable
- `primary_metric`
- `quota_per_day`
- `leaderboard_visible`
- `created_by`
- `created_at`, `updated_at`

### competition_memberships
- `competition_id`
- `account_id`
- `active`
- `joined_at`

Index:
- unique compound `(competition_id, account_id)`

### competition_contents
- `_id`
- `competition_id`
- `title`
- `slug`
- `order`
- `markdown_path`
- `visibility`
- timestamps

Index:
- unique `(competition_id, slug)`
- sort `(competition_id, order)`

### submissions
- `_id`
- `competition_id`
- `account_id`
- `file_path`
- `original_filename`
- `status`: completed|rejected|failed
- `metrics`: `{f1, precision, recall}` when completed
- `primary_score`
- `error_code`/`error_message` for rejected/failed as appropriate
- `created_at`

Indexes:
- `(competition_id, account_id, created_at)`
- `(competition_id, primary_score)`

## 6. Session contract
- Login tạo opaque random session token.
- Cookie name được cấu hình, ví dụ `aic_session`.
- Cookie: HttpOnly; Secure production; SameSite=Lax hoặc Strict theo implementation đã xác nhận; Path=/.
- DB nên lưu hash của raw session token thay vì raw token nếu implementation không tăng phức tạp đáng kể.
- `/auth/me` là nguồn frontend biết account hiện tại.
- Unauthorized -> HTTP 401.
- Authenticated but forbidden -> HTTP 403.

## 7. Error response
Dùng một format nhất quán, ví dụ:

    {
      "error": {
        "code": "SUBMISSION_SCHEMA_INVALID",
        "message": "File submission thiếu cột prediction."
      }
    }

Không cần framework lỗi phức tạp. Quan trọng là code và message ổn định, dễ frontend hiển thị và test.

## 8. Markdown contract
Backend trả metadata và nội dung Markdown của content page.
Frontend render bằng thư viện có hỗ trợ GFM và sanitize.

Nội dung không được phép:
- script
- inline event handler
- raw iframe không được phép
- path ra ngoài competition asset directory

## 9. Scoring contract v1
Classification only.

Input:
- Ground truth CSV private.
- Submission CSV participant.

Process:
1. Read CSV với giới hạn kích thước.
2. Validate schema.
3. Validate duplicate/missing/extra IDs theo config.
4. Join/align by ID.
5. Calculate F1, Precision, Recall cùng một average/pos_label config.
6. Persist metrics.
7. Primary score = metric được competition cấu hình.

Nếu validation fail, không tạo điểm hợp lệ trên leaderboard.

## 10. Ranking contract v1
- Mỗi account có best completed submission theo `primary_score`.
- Higher is better.
- Tie-break baseline: primary_score DESC, sau đó thời điểm đạt best score sớm hơn đứng trước.
- Nếu thay đổi tie-break phải cập nhật contract và test.

## 11. File naming/storage contract
Backend tự sinh filename an toàn, không dùng trực tiếp filename user làm path.

Suggested:

    /data/submissions/<competition_id>/<account_id>/<submission_id>.csv

Content:

    /data/competitions/<competition_id>/content/<content_id>.md
    /data/competitions/<competition_id>/assets/<safe_name>
    /data/competitions/<competition_id>/private/ground_truth.csv
    /data/competitions/<competition_id>/private/scoring_config.json

## 12. Config/environment baseline
Repository chỉ có `.env.example`.
Expected families:
- application/env
- Mongo connection/app credentials
- session secret/lifetime
- upload limits
- data directories
- Cloudflare tunnel token (production only)

Không đặt production secrets trong frontend build.

