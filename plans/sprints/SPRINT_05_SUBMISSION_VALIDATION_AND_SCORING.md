# SPRINT 05 - CSV Submission, Validation, Ground Truth, Scoring

## Mục tiêu
Hoàn thành core nghiệp vụ quan trọng nhất: participant nộp CSV -> validate -> score F1/Precision/Recall -> persist kết quả an toàn trong đúng competition.

## Điều kiện bắt đầu
- Auth stable.
- Competition stable.
- Membership/join stable.
- Data directories stable.

## Phạm vi A - Scoring configuration
Mỗi competition có scoring config classification MVP.

Required config:
- `id_column`
- `prediction_column`
- `label_column`
- `average`: binary|macro|weighted (chỉ giá trị được chấp nhận)
- `pos_label` nullable/non-null for binary as needed
- `primary_metric`: f1|precision|recall
- max upload MB
- daily quota

Single source of truth phải rõ.
Nếu lưu `scoring_config.json`, backend là thành phần duy nhất ghi/read và Mongo competition chỉ lưu fields cần list/display. Không để hai bản config có thể drift mà không có rule.

## Phạm vi B - Admin ground truth/scoring
Admin UI/API:
- upload/replace ground truth CSV
- configure scoring
- validate ground truth ngay lúc upload/config
- show metadata safe: row count, columns, uploaded time
- KHÔNG expose labels/file download cho participant

Ground truth path:
`/data/competitions/<competition_id>/private/ground_truth.csv`

Publication/scoring readiness:
- Admin UI phải cho biết competition scoring ready/not ready.
- Nếu participant submit mà scoring chưa ready -> lỗi rõ, không crash.

## Phạm vi C - Submission upload
Endpoint:
`POST /api/competitions/{id}/submissions`

Backend checks theo thứ tự hợp lý:
1. authenticated active account
2. competition exists/published/open for submit
3. active membership
4. deadline/status
5. daily quota
6. upload size/extension
7. save to safe temp/path
8. validate CSV
9. score
10. persist submission result

File path backend-generated:
`/data/submissions/<competition_id>/<account_id>/<submission_id>.csv`

Không dùng filename user làm path.

## Phạm vi D - CSV validation
Reject rõ ràng nếu:
- empty/unreadable
- missing columns
- duplicate IDs
- null required values
- extra/missing IDs vi phạm contract
- prediction values invalid for configured labels/metric
- row count unreasonable

Align submission to ground truth by ID, not row order.

Không silently drop rows để tính score.

## Phạm vi E - Metrics
Dùng trusted metric implementation, ví dụ scikit-learn.
Tính:
- F1
- Precision
- Recall

Cùng `average`/`pos_label` config.
Document `zero_division` behavior.
Round chỉ ở display; DB lưu precision numeric đủ để ranking.

`primary_score` = configured metric raw numeric.

## Phạm vi F - Submission persistence
`submissions` record:
- competition_id/account_id
- path/original_filename
- status
- metrics
- primary_score
- error code/message if relevant
- created_at

Decision cần chốt:
- validation reject có lưu record hay không. Khuyến nghị lưu rejected metadata nếu hữu ích audit, nhưng không cần lưu file xấu lâu dài. Nếu implementation khác, document rõ.

## Phạm vi G - Frontend Submit
Competition Submit page:
- display rule summary từ competition config
- choose CSV
- show selected file name/size
- submit button/loading
- result card: F1/Precision/Recall + primary metric
- validation error rõ ràng
- quota/remaining if API provides

Không fake progress nếu scoring synchronous và rất nhanh.

## Performance constraints
- Scoring synchronous trong FastAPI MVP.
- Không queue.
- Giới hạn upload để không ăn RAM.
- Nếu CSV thực tế quá lớn khiến sync unsafe, DỪNG và hỏi trước khi thêm queue.

## Acceptance criteria
1. Valid CSV được score chính xác.
2. F1/Precision/Recall khớp script/test fixture chuẩn.
3. Row order thay đổi nhưng score không thay đổi.
4. Missing/extra/duplicate ID reject.
5. Account không membership không submit.
6. Closed/deadline/quota rule enforce backend.
7. Ground truth không tải được qua public routes.
8. Submission competition A không dùng ground truth competition B.
9. File path safe và isolated.
10. UI hiện score/error rõ.

## Required tests
Tạo fixtures nhỏ deterministically:
- binary classification perfect
- some FP/FN
- macro case nếu supported
- reordered rows
- missing IDs
- duplicate IDs
- wrong columns
- quota exceeded
- closed competition
- unauthorized membership

Scoring test là release-blocking.

## Dừng và hỏi nếu
- CSV schema thực tế không phải id + prediction.
- Multi-label/multi-class rule cụ thể không khớp baseline.
- Public/private split leaderboard cần làm ngay.
- File quá lớn cần async/streaming strategy mới.

## Handoff
Ghi rõ:
- exact scoring config schema
- ground truth readiness rule
- upload limits
- validation codes
- file persistence policy
- metrics behavior
- test fixture expected values
- next sprint = Sprint 06

## Ngoài phạm vi
- Full leaderboard UX.
- Excel export.
- Production deployment.

