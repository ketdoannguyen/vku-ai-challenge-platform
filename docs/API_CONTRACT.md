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
| GET | `/api/health` | planned | Liveness check; trả trạng thái backend (và Mongo connection nếu hợp lý). Sprint 01. |

## 2. Auth

| Method | Path | Status | Mô tả |
|---|---|---|---|
| POST | `/api/auth/login` | planned | Body: identifier + password. Thành công: set session cookie, trả account info. |
| POST | `/api/auth/logout` | planned | Hủy session hiện tại, clear cookie. |
| GET | `/api/auth/me` | planned | Trả account hiện tại hoặc 401. |

## 3. Participant - competitions

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/competitions` | planned | List competition user được thấy (published + đã join tùy trạng thái). |
| GET | `/api/competitions/{slug}` | planned | Chi tiết một competition. KHÔNG trả join_code sau khi publish. |
| POST | `/api/competitions/{id}/join` | planned | Join theo mode: open/code/invite_only. Body chứa code nếu mode=code. |
| GET | `/api/competitions/{id}/contents` | planned | List content page metadata theo `order`. |
| GET | `/api/competitions/{id}/contents/{content_slug}` | planned | Metadata + Markdown content (đã kiểm tra visibility). |

## 4. Submissions & leaderboard

| Method | Path | Status | Mô tả |
|---|---|---|---|
| POST | `/api/competitions/{id}/submissions` | planned | Upload CSV. Backend check membership/deadline/quota/size/schema rồi scoring. |
| GET | `/api/competitions/{id}/submissions/me` | planned | Lịch sử submission của account hiện tại. |
| GET | `/api/competitions/{id}/leaderboard` | planned | Best valid submission mỗi account, theo ranking contract. |

## 5. Admin (`/api/admin/...`)

Namespace planned, chi tiết endpoint chốt ở Sprint 03+ khi code thật. Tối thiểu phải cover:
- accounts CRUD cần thiết (tạo tài khoản, active/deactive, reset password)
- competitions create/edit/clone/publish/close
- memberships quản lý
- contents upload/order/delete
- ground truth + scoring config
- submissions view
- export `.xlsx`

Tên endpoint cụ thể tinh chỉnh trong sprint nhưng phải cập nhật file này ngay; không để hai convention song song.

## 6. Error codes

Baseline planned (mở rộng dần theo sprint, giữ format ổn định):
- `UNAUTHORIZED`, `FORBIDDEN`
- `SUBMISSION_SCHEMA_INVALID`, `SUBMISSION_QUOTA_EXCEEDED`, `SUBMISSION_DEADLINE_PASSED`
- `NOT_FOUND`, `VALIDATION_ERROR`
