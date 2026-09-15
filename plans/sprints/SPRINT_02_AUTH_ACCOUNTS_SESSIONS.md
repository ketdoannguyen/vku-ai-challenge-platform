# SPRINT 02 - Authentication, Sessions, Account Administration

## Mục tiêu
Hoàn thành danh tính người dùng và luồng đăng nhập an toàn mà không dùng external auth service.

BTC cấp tài khoản; user không có sign-up.

## Điều kiện bắt đầu
Sprint 01 stack chạy ổn định và Mongo reachable.

## Locked behavior
- Roles: `admin`, `participant`.
- No self-registration.
- Password hash Argon2id.
- Opaque server-side session.
- Cookie HttpOnly; Secure ở production; SameSite theo decision; Path=/.
- Backend là nơi quyết định authorization.

## Phạm vi
### A. Account data
Implement `accounts` collection và indexes.
Required capabilities:
- create account
- lookup by login/email
- active/disabled
- role
- password reset by admin
- password verify

Không bao giờ trả `password_hash` về API.

### B. Session data
Implement `sessions` collection:
- create random high-entropy token
- store session reference/hash
- account_id
- expires_at
- TTL index
- logout delete session
- reject expired/disabled account

Tạo helper/dependency gọn để:
- require authenticated account
- require admin

### C. Auth API
Implement/finalize:
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

Rules:
- login sai không tiết lộ email/account có tồn tại hay không
- disabled account không login
- logout idempotent nếu hợp lý
- auth errors theo common error contract

### D. Admin account API
Tối thiểu:
- list/search accounts
- create participant account
- reset password
- enable/disable

Không cần full generic CRUD nếu không có use case.

### E. Bootstrap scripts
Tạo script/command:
- create initial admin
- optional bulk import participant accounts từ CSV

Scripts phải:
- rõ input format
- không in password_hash
- tránh duplicate im lặng
- fail rõ ràng

### F. Frontend auth
Implement:
- login page clean
- no register link
- auth bootstrap qua `/auth/me`
- protected routes
- admin-only navigation
- logout
- disabled/expired session UX

Tài khoản participant có thể đăng nhập nhưng dashboard competition chưa cần có data thật trước Sprint 03.

### G. Security basics
- Cookie config based on env.
- Session secret/session token handling không log.
- Generic login error.
- Minimum password policy cho account admin tạo; đơn giản nhưng rõ.
- Rate limiting login: chỉ implement nếu có pattern nhẹ và không tăng phức tạp; nếu defer, ghi rõ Sprint 07.

## Data/index acceptance
`docs/DATA_MODEL.md` phải ghi fields/indexes thực tế, đặc biệt TTL session.

## Acceptance criteria
1. Admin bootstrap tạo được admin.
2. Participant account tạo được từ admin/script.
3. Login đúng -> cookie session -> `/auth/me` trả account safe fields.
4. Login sai -> 401/generic message.
5. Disabled account bị từ chối.
6. Logout làm session vô hiệu.
7. Participant không vào admin endpoint.
8. Admin vào được account admin page.
9. Password trong Mongo là hash, không plaintext.
10. Session expiration có test.
11. Không có self-registration endpoint/UI.

## Required tests
Backend:
- password hashing/verify
- correct/incorrect login
- disabled account
- session create/expire/logout
- role guard
- admin create/reset/disable

Frontend:
- build/typecheck
- login form error/loading
- protected route behavior ở mức có thể test đơn giản

## Dừng và hỏi nếu
- User muốn login bằng team code thay email và mapping chưa được xác nhận.
- Cần đổi role model lớn hơn admin/participant.
- Existing account data cần migration.

## Handoff
Cập nhật state với:
- cookie name/options
- account fields/indexes
- session representation
- bootstrap command
- exact auth/admin endpoints
- tests pass
- next sprint = Sprint 03

## Ngoài phạm vi
- Competition permissions.
- Join.
- Markdown.
- Submission.

