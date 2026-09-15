# SPRINT 09 - Pilot, Backup/Restore, Operations, Final Handover

## Mục tiêu
Chứng minh hệ thống không chỉ deploy được mà còn vận hành và khôi phục được. Kết thúc MVP với pilot, backup/restore, runbook và bàn giao.

## Điều kiện bắt đầu
Production deployment Sprint 08 healthy.

## Phạm vi A - Backup design
Cần backup 3 nhóm:
1. MongoDB business data.
2. `/data/competitions` including Markdown/assets/private ground truth/config.
3. `/data/submissions`.

Backup destination baseline trên persistent disk backup area, sau đó có thể kết hợp GCE disk snapshot.

Tạo scripts nhỏ, rõ:
- backup Mongo via `mongodump`
- archive/copy file data safely
- timestamped backup folder
- retention đơn giản nếu được chốt

Script:
- fail fast
- exit non-zero on failure
- log no secrets
- không xóa backup mới nếu backup đang chạy fail

## Phạm vi B - Scheduled backup
Chọn host cron hoặc systemd timer, không cần container scheduler phức tạp.

Schedule đề xuất trong thời gian competition active:
- daily baseline
- trước/sau mốc quan trọng có manual backup

Không hard-code schedule nếu người dùng muốn khác; document.

## Phạm vi C - Restore drill
Đây là release acceptance quan trọng.

Thực hiện restore test an toàn trên pilot/test data:
- restore Mongo
- restore competition content/private
- restore submissions
- verify app reads restored records/files
- verify a known submission/score/history still consistent

Không restore đè lên production data live nếu có nguy cơ; dùng test path/environment hoặc backup copy strategy.

## Phạm vi D - GCE snapshot procedure
Document/thực hiện nếu có quyền:
- create persistent disk snapshot
- naming convention
- when to snapshot
- how to recover VM/disk at high level

Không cần automate GCP snapshot bằng code nếu manual schedule đủ cho MVP.

## Phạm vi E - Pilot with two competitions
Mục đích xác minh tái sử dụng thật.

Tạo 2 pilot competitions có:
- slug/name khác
- Markdown bộ nội dung khác
- scoring config/ground truth khác
- memberships khác

Test:
- same account có thể join 1/2 theo policy
- submissions không lẫn
- content không lẫn
- leaderboard không lẫn
- export không lẫn

Đây là test bắt buộc cho tuyên bố multi-competition.

## Phạm vi F - Operational runbook
Tạo `docs/OPERATIONS.md` ngắn, thực dụng:

### Daily/competition operations
- health check
- container status/logs
- disk usage
- backup status

### Open a new competition
- create accounts if needed
- create competition
- set dates/join
- upload Markdown/assets
- upload ground truth/config
- validate readiness
- publish
- test account dry run

### During competition
- monitor logs/disk
- handle reset password/member lock
- investigate rejected submission
- manual backup at important times

### Close competition
- close submission
- verify leaderboard/export
- final backup/snapshot
- export official results

### Incident basics
- website down
- API unhealthy
- Mongo unhealthy
- disk full warning
- scoring errors
- rollback app code without deleting data

## Phạm vi G - Final docs cleanup
Ensure:
- README concise/current
- DEPLOYMENT matches real prod
- OPERATIONS complete
- API/DATA contracts current
- TEST_MATRIX reflects actual tests
- PROJECT_STATE final
- DECISIONS no stale contradictions

## Phạm vi H - Final release checklist
Run full smoke/regression using `92_FINAL_RELEASE_CHECKLIST.md`.

## Acceptance criteria
1. Backup command runs successfully.
2. Restore drill proves business data + files recoverable.
3. Two competition pilot passes isolation.
4. Final export works for both pilots.
5. Operations runbook đủ để một người kỹ thuật khác vận hành mà không cần đọc source trước.
6. Production remains healthy after restart/update simulation.
7. Final docs match actual commands/paths.
8. No high severity known issue left undocumented.

## Dừng và hỏi nếu
- Backup retention/storage destination policy not approved.
- Restore would touch live data destructively.
- GCP snapshot permission unavailable.
- Pilot needs real participant/ground truth data that user has not supplied.

## Handoff / project close
`docs/PROJECT_STATE.md` final:
- Last completed sprint SPRINT_09
- production hostname
- version/commit
- deployment/backup commands references
- known limitations
- post-MVP roadmap items only, no hidden unfinished MVP task

Suggested release tag:
`v1.0.0-mvp` after user approval.

## Ngoài phạm vi / post-MVP candidates
- public/private leaderboard split
- async scoring queue
- object storage
- more metric/task plugins
- notifications
- SSO
- HA

