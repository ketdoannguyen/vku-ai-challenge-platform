# API Contract - AI Challenge Platform

Nguồn sự thật về API. Mỗi endpoint đánh dấu `implemented` (đã có trong code và có test) hoặc `planned` (baseline từ `plans/02_ARCHITECTURE_CONTRACTS.md`, chưa code).

Quy ước chung:
- Toàn bộ route dưới `/api`, same-origin với frontend qua Nginx (ADR-002).
- Auth bằng session cookie (`aic_session`); `GET /api/auth/me` là nguồn frontend biết account hiện tại.
- Unauthorized → HTTP 401; authenticated but forbidden → HTTP 403.
- Error response thống nhất:

```json
{
  "error": {
    "code": "SUBMISSION_SCHEMA_INVALID",
    "message": "File submission thiếu cột prediction."
  }
}
```

## 1. Health

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/health` | implemented | Trả `{"status":"ok","mongo":"reachable"}` + 200 khi Mongo reachable; `{"status":"degraded","mongo":"unreachable"}` + 503 khi không. Không expose thông tin nội bộ. |

## 2. Auth

| Method | Path | Status | Mô tả |
|---|---|---|---|
| POST | `/api/auth/login` | implemented | Body: `{identifier, password}` (identifier = email). Đúng: 200 + account safe fields (id, email, name, role, active) + set cookie `aic_session` (HttpOnly, SameSite=lax, Secure ở production). Sai: 401 `INVALID_CREDENTIALS` (generic, không tiết lộ email tồn tại). Account disabled: 403 `ACCOUNT_DISABLED`. |
| POST | `/api/auth/logout` | implemented | Xóa session server-side + clear cookie. Idempotent: 200 kể cả khi không có session. Trả `{"ok":true}`. |
| GET | `/api/auth/me` | implemented | Trả account safe fields hoặc 401 `UNAUTHORIZED`. Session hết hạn hoặc account bị disable cũng trả 401. |

## 3. Participant - competitions

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/competitions` | implemented | List competition `published` + `closed`, sort theo tên. Yêu cầu đăng nhập (401 nếu không). Trả `{competitions: [public fields]}` — không bao giờ trả `join_code_hash`. |
| GET | `/api/competitions/{slug}` | implemented | Chi tiết competition theo slug. Draft → 404 `NOT_FOUND` (kể cả khi tồn tại). Không trả join_code. |
| POST | `/api/competitions/{id}/join` | planned (Sprint 04) | Join theo mode: open/code/invite_only. Body chứa code nếu mode=code. |
| GET | `/api/competitions/{id}/contents` | planned (Sprint 04) | List content page metadata theo `order`. |
| GET | `/api/competitions/{id}/contents/{content_slug}` | planned (Sprint 04) | Metadata + Markdown content (đã kiểm tra visibility). |

## 4. Submissions & leaderboard

| Method | Path | Status | Mô tả |
|---|---|---|---|
| POST | `/api/competitions/{id}/submissions` | planned | Upload CSV. Backend check membership/deadline/quota/size/schema rồi scoring. |
| GET | `/api/competitions/{id}/submissions/me` | planned | Lịch sử submission của account hiện tại. |
| GET | `/api/competitions/{id}/leaderboard` | planned | Best valid submission mỗi account, theo ranking contract. |

## 5. Admin (`/api/admin/...`)

### 5.1 Accounts (implemented — Sprint 02)

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/admin/accounts` | implemented | Query: `q` (search email/name, email exact match nếu dạng email), `limit` (≤200, default 50), `offset`. Trả `{accounts: [safe fields], total, limit, offset}`. |
| POST | `/api/admin/accounts` | implemented | Body: `{email, name, password, role}` (role: admin\|participant, default participant). Password tối thiểu 10 ký tự, không space đầu/cuối. 201 + account safe fields; 409 `ACCOUNT_EXISTS`; 422 `VALIDATION_ERROR`. |
| POST | `/api/admin/accounts/{id}/reset-password` | implemented | Body: `{password}` (cùng policy). 200 `{"ok":true}`; session hiện tại giữ nguyên; 404 `NOT_FOUND`. |
| PATCH | `/api/admin/accounts/{id}` | implemented | Body: `{active: bool}`. Disable account hủy hiệu lực mọi session của account đó (login bị chặn 403). Không thể tự disable chính mình (422). 200 + account safe fields. |

Mọi endpoint admin yêu cầu role `admin`: 401 `UNAUTHORIZED` nếu chưa đăng nhập, 403 `FORBIDDEN` nếu participant.

### 5.2 Competitions (implemented — Sprint 03)

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/admin/competitions` | implemented | List TẤT CẢ competition (kể cả draft), sort theo tên. Trả `{competitions: [...]}`. |
| POST | `/api/admin/competitions` | implemented | Body: `{slug, name, short_description?, start_at, end_at, join_mode?, primary_metric?, quota_per_day?, leaderboard_visible?}`. Defaults: join_mode=open, primary_metric=f1, quota_per_day=5, leaderboard_visible=true. Validate: slug `[a-z0-9-]` ≤64 ký tự, start < end, metric f1\|precision\|recall, quota 0-1000, join_mode open\|code\|invite_only. 201 + public fields; 409 `SLUG_EXISTS`; 422 `VALIDATION_ERROR`. Tạo xong luôn `draft`. |
| GET | `/api/admin/competitions/{id}` | implemented | Chi tiết theo id (admin xem được mọi status). 404 nếu không tồn tại/id sai. |
| PATCH | `/api/admin/competitions/{id}` | implemented | Sửa config. Rule theo status (ADR-009): draft sửa mọi field trừ slug/status; published không đổi `primary_metric`; closed từ chối mọi sửa đổi (422). 200 + public fields. |
| POST | `/api/admin/competitions/{id}/publish` | implemented | draft → published. Sai trạng thái → 422 `INVALID_TRANSITION`. |
| POST | `/api/admin/competitions/{id}/close` | implemented | published → closed (terminal, không reopen ở MVP). Sai trạng thái → 422 `INVALID_TRANSITION`. |
| POST | `/api/admin/competitions/{id}/clone` | implemented | Clone config thành draft mới, slug tự sinh `<slug>-copy` (-copy2... nếu trùng), dates = now → +1 năm. KHÔNG copy status/submissions/memberships. 201 + clone. |

### 5.3 Memberships, contents, ground truth, submissions view, export

Planned — chi tiết endpoint chốt ở Sprint 04+ khi code thật. Tên endpoint cụ thể tinh chỉnh trong sprint nhưng phải cập nhật file này ngay; không để hai convention song song.

## 6. Error codes

- `UNAUTHORIZED` (401), `FORBIDDEN` (403) — implemented
- `INVALID_CREDENTIALS` (401), `ACCOUNT_DISABLED` (403), `ACCOUNT_EXISTS` (409) — implemented
- `SLUG_EXISTS` (409), `INVALID_TRANSITION` (422) — implemented (Sprint 03)
- `NOT_FOUND` (404), `VALIDATION_ERROR` (422) — implemented
- `SUBMISSION_SCHEMA_INVALID`, `SUBMISSION_QUOTA_EXCEEDED`, `SUBMISSION_DEADLINE_PASSED` — planned (Sprint 05)
