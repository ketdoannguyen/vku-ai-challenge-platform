# SPRINT 07 - Admin Completion, Security Hardening, UX Polish, Release Candidate

## Mục tiêu
Biến feature-complete MVP thành release candidate có thể đưa lên production: quyền rõ, input an toàn, UI nhất quán, failure mode dễ debug, test matrix đủ.

## Điều kiện bắt đầu
Core flow đã hoạt động:
login -> competition -> join -> markdown -> submit -> score -> history -> leaderboard -> export.

## Phạm vi A - Admin workflow completion
Review admin không theo kiểu thêm feature mới, mà đảm bảo một BTC có thể vận hành competition mà không chạm code/database.

Admin competition detail nên có các khu vực rõ:
- General/status/dates
- Join/members
- Content Markdown
- Scoring/ground truth readiness
- Submission/leaderboard
- Export

Điền vào các khoảng trống còn thiếu từ Sprint 03-06.

## Phạm vi B - UX consistency
Participant:
- loading, empty, error, success patterns thống nhất
- form validation rõ
- competition status/deadline rõ
- submit disabled/reason rõ khi không hợp lệ
- Markdown typography polish
- tables scroll responsive
- keyboard/focus basics
- confirm destructive admin actions

Không redesign lớn nếu UI hiện tại đã tốt.

## Phạm vi C - Security review
Bắt buộc review và test:

### Auth/session
- cookie flags production
- expired session
- logout
- disabled account
- admin guard
- no session token logs

### Authorization
- competition membership checks backend
- cross-competition IDs
- participant trying admin API
- participant trying other account resources

### Upload/path
- file size limit
- extension/content parse
- filename/path traversal
- symlink/path escape defense nếu applicable
- no direct static access private directories

### Markdown/XSS
- script/raw HTML payload
- javascript links
- unsafe image/path
- external link safety

### Nginx/basic headers
Add/review practical headers without breaking app:
- X-Content-Type-Options
- frame policy/CSP strategy as appropriate
- Referrer-Policy
- other minimal security headers

Không tạo CSP quá chặt gây vỡ Markdown/assets. Nếu CSP cần decision, test kỹ.

### Login abuse
Chọn giải pháp nhẹ:
- Nginx/Cloudflare rate limit planned, hoặc
- backend simple limit nếu đã có infrastructure.

Không thêm Redis chỉ để rate limit 40-80 users.

## Phạm vi D - Validation/error consistency
Review all API errors:
- stable error code
- human-readable message
- correct 400/401/403/404/409/422/413 etc
- no stack traces to production user

Frontend map lỗi quan trọng thành message rõ.

## Phạm vi E - Logging/observability
Log tối thiểu:
- startup/health failures
- login failures without secrets
- admin competition lifecycle actions
- content upload
- join
- submission accepted/rejected/scoring failed
- export

Không log passwords, cookies, join raw secret, ground truth.

Health endpoint production-useful, không leak config.

## Phạm vi F - Tests and regression
Hoàn thiện `docs/TEST_MATRIX.md`.

Release-blocking scenarios:
- auth positive/negative
- admin role
- competition create/publish/close
- each join mode
- Markdown safe render
- scoring happy path + malformed CSV
- deadline/quota
- cross competition isolation
- leaderboard/tie
- export
- private ground truth unreachable

Chạy full backend test suite + frontend build/typecheck + Docker build/compose smoke.

## Phạm vi G - Documentation for deploy
Hoàn thiện `docs/DEPLOYMENT.md` phần prerequisites và production env list, nhưng chưa cần tạo VM thật.

README production section chỉ link sang deployment doc thay vì duplicate.

## Acceptance criteria
1. End-to-end local MVP flow pass.
2. Tất cả release-blocking tests pass.
3. Không có known critical security issue.
4. Participant/admin authorization isolation test pass.
5. Markdown malicious fixture không execute.
6. Private ground truth không reachable qua Nginx/API participant.
7. Docker images build clean.
8. UI không còn placeholder functional từ sprint cũ.
9. `PROJECT_STATE` đánh dấu release candidate và ghi rõ known non-blocking debt.

## Dừng và hỏi nếu
- Hardening yêu cầu external service mới.
- CSP/Cloudflare policy có thể ảnh hưởng domain/embed cần người dùng quyết.
- Phát hiện architecture flaw cần migration lớn.

## Handoff
State phải có:
- release candidate version/tag suggestion
- exact full test commands/results
- production env variables required
- unresolved issues severity
- next Sprint 08 deploy preconditions

## Ngoài phạm vi
- Tạo GCE VM thật.
- Domain DNS/tunnel credential.
- Feature mới ngoài MVP.

