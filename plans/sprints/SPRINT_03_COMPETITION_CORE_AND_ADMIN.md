# SPRINT 03 - Competition Core and Admin Lifecycle

## Mục tiêu
Chuyển app từ một website chung thành nền tảng multi-competition thực sự. Admin có thể tạo và quản lý nhiều competition mà không sửa source code.

## Điều kiện bắt đầu
Auth/account Sprint 02 hoạt động, role guard đã test.

## Core model
Competition là root business entity.

Fields baseline:
- id
- slug unique
- name
- short_description
- status: draft|published|closed
- start_at/end_at
- join_mode
- primary_metric
- quota_per_day
- leaderboard_visible
- created_by
- timestamps

Nếu cần field mới có ảnh hưởng logic về sau, ghi decision.

## Phạm vi
### A. Mongo model/indexes
Implement `competitions` collection:
- unique slug
- timestamps UTC
- validation at API layer

Status transition MVP:
- create -> draft
- draft -> published
- published -> closed
- edit allowed according to clear rules

Không cần state machine framework.

### B. Admin competition API
Implement:
- list competitions including draft
- create
- get detail
- edit
- publish
- close
- clone/duplicate configuration baseline nếu đơn giản và an toàn

Clone KHÔNG copy submissions/memberships. Markdown/content clone có thể defer Sprint 04 nếu phụ thuộc content.

Validation:
- slug format and unique
- start/end order
- primary metric allowed set
- quota non-negative/sensible
- join mode allowed

### C. Participant competition API
Implement:
- list visible published/closed competitions theo rule
- competition detail by slug

Participant không thấy draft.
Chưa join vẫn có thể thấy public competition metadata nếu policy không cấm.

### D. Frontend participant dashboard
Dashboard thật:
- Available competitions
- Joined state placeholder/actual membership chưa có thì label `Not joined` có thể tinh chỉnh sau
- status badge
- dates
- CTA view competition

Competition detail shell:
- dynamic by slug
- header tên/mô tả/status/thời gian
- nav slots cho Overview/Problem/Rules/Submit/My Submissions/Leaderboard
- các tab content chưa có Sprint 04/05 có thể disabled/empty state rõ ràng

### E. Admin UI
Admin competitions page:
- table/cards
- create form
- edit form
- status actions publish/close có confirm
- clear validation messages

Form không đưa ra option chưa supported.

## Business rules cần chốt trong code/docs
- Date/time stored UTC; UI show local.
- Closed competition read-only for submissions.
- Draft never participant-visible.
- Primary metric limited to f1/precision/recall in MVP.

## Acceptance criteria
1. Admin tạo Competition A và B mà không deploy lại.
2. Slug unique enforced DB/API.
3. Draft không xuất hiện ở participant dashboard.
4. Publish -> participant thấy.
5. Close -> status update và API phản ánh.
6. Competition detail frontend load động theo slug.
7. UI/logic không hard-code AI Challenge 2026.
8. Participant không gọi admin competition API.
9. Validation date/status/metric/quota có test.
10. Canonical docs cập nhật.

## Required tests
Backend:
- create/list/detail/edit
- slug collision
- participant visibility
- admin guard
- invalid dates/status
- publish/close transition

Frontend:
- build/typecheck
- render dashboard from API
- dynamic slug route
- admin form core validation

## Dừng và hỏi nếu
- Competition status workflow cần reopen/archive ngay trong MVP.
- Quy tắc visibility khác published/closed.
- Clone behavior cần copy private ground truth/content ngay lập tức.

## Handoff
Ghi rõ:
- competition schema/indexes
- lifecycle rules
- admin/public endpoints
- frontend routes
- next Sprint 04 entry: competition core stable

## Ngoài phạm vi
- Membership/join.
- Markdown content upload/render.
- Ground truth/scoring.

