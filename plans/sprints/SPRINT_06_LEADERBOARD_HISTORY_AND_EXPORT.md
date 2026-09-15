# SPRINT 06 - My Submissions, Leaderboard, Results, Excel Export

## Mục tiêu
Biến score đã lưu thành trải nghiệm kết quả hoàn chỉnh cho participant và công cụ tổng hợp cho BTC.

## Điều kiện bắt đầu
Sprint 05 scoring đã có test fixture chuẩn và `submissions` data ổn định.

## Phạm vi A - My Submissions API/UI
Participant chỉ xem submissions của chính account trong competition hiện tại.

UI columns tối thiểu:
- submission/time
- filename display
- status
- F1
- Precision
- Recall
- primary score

Behavior:
- newest first
- pagination hoặc limit hợp lý nếu cần; quy mô nhỏ có thể simple pagination
- rejected/failed hiện reason an toàn
- không expose server path

## Phạm vi B - Leaderboard query
Leaderboard data chỉ trong competition.

Baseline ranking:
1. completed submissions only
2. mỗi account lấy best primary score
3. score DESC
4. nếu bằng nhau, thời điểm đạt best score sớm hơn đứng trước

API response nên có:
- rank
- account/team display name
- primary score
- optional F1/Precision/Recall của best submission nếu product cần
- best submission time

Không trả account email nếu không cần.

## Phạm vi C - Leaderboard visibility
Admin/competition config:
- `leaderboard_visible = true|false`

Participant:
- false -> trang hiện thông báo leaderboard chưa mở/ẩn
- true -> xem bảng

Nếu muốn freeze snapshot phức tạp, defer sau MVP trừ khi đã có field/design ở Sprint 03. Không tự ý thêm.

Admin luôn có thể xem ranking để vận hành.

## Phạm vi D - Competition results UI
Competition navigation hoàn thiện:
- content pages
- Submit
- My Submissions
- Leaderboard/Results

UX:
- current user row highlight nhẹ
- rank/score rõ
- responsive table
- loading/empty/error states
- không refresh page toàn bộ khi đổi tab nếu router đã có

## Phạm vi E - Admin submission view
Admin competition detail:
- list/filter submissions by team/status
- inspect metrics/error
- không cho xem ground truth qua browser
- optional download participant submitted CSV only if safe and needed

## Phạm vi F - Excel export
Admin export theo competition.

`.xlsx` tối thiểu sheets hoặc một sheet clean chứa:
- rank
- account/team id/name
- best score
- F1
- Precision
- Recall
- best submission time
- total submissions

Nếu cần lịch sử đầy đủ, có thể thêm second sheet `Submissions`, nhưng giữ đơn giản.

Export phải:
- đúng competition filter
- filename safe có competition slug/timestamp
- không chứa password/session/ground truth

## Phạm vi G - Query/index review
Kiểm tra leaderboard và history query có dùng indexes. Không tối ưu quá mức; chỉ thêm index nếu query thực tế cần.

## Acceptance criteria
1. Participant A không xem được submission history của B.
2. Competition A history/leaderboard không lẫn B.
3. Best score rule đúng với nhiều submissions của cùng team.
4. Tie-break deterministic và có test.
5. Hidden leaderboard không lộ data qua participant API.
6. Admin xem được submissions và export.
7. Excel mở được, cột đúng, score/rank đúng.
8. UI competition navigation hoàn chỉnh và thống nhất.
9. Không lộ server file path/private info.

## Required tests
Backend:
- best-score aggregation
- tie ranking
- visibility
- account isolation
- competition isolation
- export values

Frontend:
- my submissions states
- leaderboard hidden/visible/empty
- build/typecheck

## Dừng và hỏi nếu
- Product yêu cầu ranking dense vs competition rank khi tie khác baseline.
- Cần public/private leaderboard split.
- Cần downloadable participant CSV và quyền chưa rõ.

## Handoff
Cập nhật:
- ranking contract thực tế
- leaderboard response
- export columns/sheets
- indexes added
- competition nav routes
- next sprint = Sprint 07

## Ngoài phạm vi
- Production infra.
- Backup automation.
- New metric types.

