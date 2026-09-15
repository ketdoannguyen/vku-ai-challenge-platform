# SPRINT 04 - Markdown Competition Content and Membership/Join

## Mục tiêu
Hoàn thành trải nghiệm competition có nội dung động giống contest portal: admin upload Markdown, participant xem đề/rules trên UI; account join theo policy của competition.

Đây là sprint biến platform thành sản phẩm tái sử dụng được cho nhiều đề thi.

## Điều kiện bắt đầu
Competition dynamic routes và Admin lifecycle Sprint 03 đã hoạt động.

## Phạm vi A - Membership
Implement `competition_memberships`:
- competition_id
- account_id
- active
- joined_at
- unique compound index

Join modes:
### open
Authenticated participant bấm Join -> membership.

### code
Participant gửi join code -> backend verify hash -> membership.
Join code raw không lưu/trả về nếu có thể hash.

### invite_only
Admin thêm membership; participant không tự join.

Rules:
- disabled account không join.
- draft không join.
- duplicate join idempotent hoặc clear response.
- membership inactive -> không submit.

Admin membership UI/API:
- list members
- add participant
- deactivate/reactivate member

## Phạm vi B - Markdown metadata/storage
Implement `competition_contents` collection và disk content.

Admin có thể:
- create content page metadata
- upload/replace `.md`
- set title/slug/order/visibility
- reorder
- delete content safely
- optional upload images/assets used by Markdown

Storage:
- backend generate safe file names/paths
- atomic-ish write where practical
- no path traversal
- no direct Nginx mapping to private

## Phạm vi C - Content API
Participant:
- list visible content pages for competition
- get Markdown page by content slug

Authorization:
- public-to-authenticated competition content policy phải consistent.
- Nếu nội dung chỉ cho member, field visibility hỗ trợ `public`/`members` tối thiểu; nếu không cần distinction thì chốt một policy và document.

## Phạm vi D - Markdown frontend
Dùng một renderer an toàn, nhẹ:
- Markdown headings
- paragraphs
- ordered/unordered lists
- tables
- fenced code blocks
- links
- images từ approved competition assets
- GFM features cần thiết
- sanitize raw HTML/XSS

UI target:
- competition header trên cùng
- tabs/chính navigation rõ ràng
- left-side content menu khi đang đọc tài liệu
- main white content panel
- typography giống technical/contest documentation
- code blocks và tables readable
- toc/anchor heading nếu thư viện hỗ trợ nhẹ; không cần phức tạp

Không hard-code page `Problem`, `Rules`; admin có thể sắp xếp content. Tuy nhiên frontend có thể có các system tabs Submit/My Submissions/Leaderboard riêng.

## Phạm vi E - Competition overview/join UX
Dashboard:
- not joined -> Join CTA theo join mode
- code -> dialog/input
- invite-only -> status/instruction
- joined -> Enter Competition

Competition page:
- display membership status
- content nav
- system nav stubs for submission/results

## Security requirements
- Markdown sanitize.
- Safe link handling; external link rel safety.
- Asset endpoint validates competition/path.
- `..`, absolute paths, symlink escape bị chặn.
- `.md` file size limit reasonable.
- Admin role required upload/edit.

## Acceptance criteria
1. Admin tạo 2 competition và upload các bộ Markdown khác nhau.
2. UI của mỗi competition tự render đúng bộ content của nó.
3. Admin thay Markdown -> frontend thay nội dung không cần rebuild/redeploy source.
4. `open`, `code`, `invite_only` join behavior đúng.
5. Membership không lẫn giữa competition.
6. XSS payload trong Markdown không execute.
7. Path traversal bị từ chối.
8. Sidebar/menu sắp xếp theo `order`.
9. Account không được phép không thể bypass join policy bằng API.
10. Dynamic UI đạt phong cách contest portal rõ ràng.

## Required tests
Backend:
- membership unique/isolation
- each join mode
- wrong join code
- content CRUD metadata
- file extension/path guards
- visibility/authorization

Frontend:
- markdown render representative fixture (heading/table/code/link/image)
- malicious HTML sanitized
- join states
- responsive build/typecheck

## Dừng và hỏi nếu
- User muốn content editor trực tiếp trong browser thay vì upload file `.md`.
- Asset upload cần loại file/size chưa rõ.
- Content visibility policy cần public không login.

## Handoff
Cập nhật state với:
- join modes implemented
- membership API/schema
- Markdown library/sanitizer chosen
- content storage paths
- admin content workflow
- exact UI routes
- next sprint = Sprint 05

## Ngoài phạm vi
- CSV scoring.
- Leaderboard calculation.
- Export.

