# Final Release Checklist - AI Challenge Platform MVP

Chỉ dùng checklist này sau Sprint 08/09.

## A. Infrastructure
- [ ] Production VM identified and documented.
- [ ] Docker Engine/Compose healthy.
- [ ] `web`, `api`, `mongo`, `cloudflared` running.
- [ ] Mongo 27017 not Internet-accessible.
- [ ] API not directly public unless explicitly intended.
- [ ] Cloudflare Tunnel active.
- [ ] HTTPS domain works.
- [ ] Persistent data survives container recreate.

## B. Secrets
- [ ] No production `.env` committed.
- [ ] No session secret/Mongo password/Tunnel token in Git history introduced by project work.
- [ ] No plaintext participant password in MongoDB.
- [ ] Logs do not contain credentials/session tokens.

## C. Authentication and authorization
- [ ] No self-registration.
- [ ] Admin login works.
- [ ] Participant login works.
- [ ] Wrong password generic error.
- [ ] Disabled account blocked.
- [ ] Logout invalidates session.
- [ ] Participant cannot access admin APIs.
- [ ] Cross-account access blocked.
- [ ] Cross-competition access blocked.

## D. Competition lifecycle
- [ ] Admin creates draft without code change.
- [ ] Draft hidden from participants.
- [ ] Publish works.
- [ ] Close blocks new submissions.
- [ ] Two competition pilot proves isolation.

## E. Membership
- [ ] Open join works.
- [ ] Code join works; wrong code fails.
- [ ] Invite-only works.
- [ ] Inactive member cannot submit.

## F. Markdown/content
- [ ] Upload/replace `.md` works.
- [ ] Content order/menu works.
- [ ] Heading/list/table/code/link/image render correctly.
- [ ] Malicious HTML/script does not execute.
- [ ] Path traversal blocked.
- [ ] Private data cannot be served as asset.

## G. Submission/scoring
- [ ] Valid CSV scores.
- [ ] F1 expected fixture matches.
- [ ] Precision expected fixture matches.
- [ ] Recall expected fixture matches.
- [ ] Reordered IDs same score.
- [ ] Duplicate/missing/extra IDs rejected per contract.
- [ ] Wrong columns clear error.
- [ ] Quota enforced backend.
- [ ] Deadline/status enforced backend.
- [ ] Ground truth never downloadable by participant.

## H. Results
- [ ] My Submissions shows own data only.
- [ ] Best score logic correct.
- [ ] Tie-break deterministic.
- [ ] Leaderboard hidden/visible config works.
- [ ] Excel export matches leaderboard/data.

## I. Operations
- [ ] Health endpoint works through production domain where appropriate.
- [ ] Logs usable.
- [ ] Backup Mongo succeeds.
- [ ] Backup competition files succeeds.
- [ ] Backup submissions succeeds.
- [ ] Restore drill completed.
- [ ] Disk usage procedure documented.
- [ ] Deploy/update procedure tested.
- [ ] Rollback code procedure documented.

## J. Documentation
- [ ] README current.
- [ ] PROJECT_STATE current.
- [ ] API_CONTRACT current.
- [ ] DATA_MODEL current.
- [ ] TEST_MATRIX current.
- [ ] DEPLOYMENT current.
- [ ] OPERATIONS current.
- [ ] Known limitations listed.

## Release gate
Chỉ đánh dấu release ready khi tất cả mục critical A-H và backup/restore đã pass. Mục nào defer phải có lý do và risk được người dùng chấp nhận rõ ràng.

