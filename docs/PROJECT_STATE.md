# AI Challenge Platform - Current Project State

## 1. Current checkpoint
- Last completed sprint: SPRINT_06
- Date: 2026-09-15
- Branch: main
- Commit/working tree status: Sprint 05 đã commit tại `10b8092`; Sprint 06 implemented trong working tree, chưa commit/push
- Overall state: green — 126 backend tests + 48 frontend tests pass; frontend production build, Compose config và Docker image build pass; API smoke Sprint 06 qua Nginx/Mongo/filesystem thật pass (xem Commands verified)

## 2. Implemented capabilities
- Sprint 01-04: local Compose stack, auth Argon2id + server-side session, admin accounts, competition lifecycle, membership/join modes, safe Markdown content/assets và participant portal
- Scoring config (ADR-011): `competitions.primary_metric` + `quota_per_day` giữ ở top-level; embedded `scoring_config` chỉ có id/prediction/label columns, binary|macro|weighted, pos_label và `higher_is_better=true`; không dùng config JSON
- Ground truth admin: GET scoring readiness/metadata, PUT config, PUT/replace private CSV; validate ngay; metadata không chứa labels; không có public download route
- Scoring lock: closed competition hoặc đã có submission completed thì không đổi config/ground truth; published chưa có điểm vẫn cấu hình được
- CSV validation: UTF-8/UTF-8 BOM, non-empty, ≤1.000.000 dòng, required columns/values, unique IDs, exact ID set, prediction thuộc ground-truth labels; align bằng ID
- Metrics: scikit-learn synchronous F1/Precision/Recall cùng average/pos_label, `zero_division=0`; DB lưu raw float, `primary_score` lấy metric top-level của competition
- Submission policy: auth active → published → active membership → start/deadline → readiness → quota completed/ngày UTC → `.csv`/10 MiB → validation/scoring → atomic file write → Mongo completed record
- Rejected validation chỉ trả error rõ cho participant; không lưu record/file và không trừ quota
- File isolation: `<DATA_DIR>/submissions/<competition_id>/<account_id>/<submission_id>.csv`; original filename chỉ lưu basename, không dùng làm path
- Frontend: admin tab Chấm điểm có readiness/config/ground-truth metadata/locked state; participant tab Nộp bài có rules, selected file, loading, metrics result, quota remaining và backend errors
- My Submissions: history current account/current competition, newest-first, limit/offset; safe filename/status/metrics/optional error, không lộ account id/server path
- Leaderboard: completed-only, best score/account, score DESC → best time ASC → stable id fallback; participant visibility enforce backend, current-user highlight; admin luôn xem được
- Admin Kết quả: ranking, submission list/filter theo name/email/status và safe inspection; không có submitted-CSV download/ground-truth exposure
- Excel: một sheet `Results` gồm rank/account id/name/best score/F1/Precision/Recall/best time/completed count; safe filename và formula/control-character neutralization
- Competition navigation đã bật `/submissions` và `/leaderboard` với loading/empty/error/responsive tables

## 3. Not implemented yet
- Login/join rate limiting và release hardening — Sprint 07
- Production deploy — Sprint 08; backup/restore/pilot — Sprint 09

## 4. Repository structure that matters
- `backend/app/scoring/service.py`: config validation, CSV parser, ground-truth validation, ID alignment, scikit-learn metrics
- `backend/app/scoring/storage.py`: path containment, symlink guard và private ground-truth read/readiness dùng chung
- `backend/app/scoring/admin_router.py`: admin scoring status/config/ground-truth endpoints và lock policy
- `backend/app/submissions/service.py`: indexes, quota UTC/day, public completed response
- `backend/app/submissions/router.py`: participant guards, upload/score/persist flow
- `backend/app/submissions/admin_router.py`: admin submission list/filters và `.xlsx` export
- `backend/app/leaderboard/service.py` + `router.py`: ranking dùng chung, participant visibility/privacy
- `backend/tests/test_scoring.py` (23), `test_scoring_admin.py` (11), `test_submissions.py` (9), `test_results.py` (6)
- `frontend/src/pages/SubmissionPage.tsx` + test (4)
- `frontend/src/pages/MySubmissionsPage.tsx`, `LeaderboardPage.tsx` + tests (6)
- `frontend/src/pages/AdminCompetitionDetailPage.tsx`: tab Chấm điểm + Kết quả; test file hiện có 9 test
- `.claude/plans/2026-09-15-sprint-05-submission-validation-scoring.md`: implementation plan

## 5. Runtime/services
- Kiến trúc web/api/mongo và volume `/data` giữ nguyên
- Backend runtime dependencies đáng chú ý: `scikit-learn>=1.5,<2` cho scoring, `openpyxl>=3.1,<4` cho XLSX; dev dependency `httpx2>=2.13` cho Starlette TestClient hiện tại

## 6. Current API contract summary
- Participant competition list/detail thêm safe `submission_config {ready,id_column,prediction_column,average,pos_label,max_upload_mb}`
- `POST /api/competitions/{id}/submissions` — implemented; 201 completed metrics hoặc error ổn định, không persist validation reject
- `GET /api/competitions/{id}/submissions/me` — implemented; own history limit/offset
- `GET /api/competitions/{id}/leaderboard` — implemented; 403 khi hidden, participant-safe entries khi visible
- Admin: `GET|PUT /api/admin/competitions/{id}/scoring`, `PUT /api/admin/competitions/{id}/ground-truth` — implemented
- Admin: `GET .../{id}/submissions`, `GET .../{id}/leaderboard`, `GET .../{id}/export.xlsx` — implemented
- Ground truth không có participant/public route
- Chi tiết: `docs/API_CONTRACT.md`

## 7. Current data model and indexes
- `competitions` thêm optional `scoring_config` và `ground_truth` metadata; config/metadata chỉ xuất hiện sau khi admin cấu hình
- `submissions`: implemented completed records với competition/account/path/original filename/metrics/primary score/created_at
- Sprint 06 không thêm persisted field; history/ranking/export là derived data
- Indexes Sprint 06 khớp exact sort: participant history `(competition_id,account_id,created_at DESC,_id DESC)`; leaderboard `(competition_id,status,primary_score DESC,created_at ASC,account_id ASC,_id ASC)`; admin history có/không status filter
- Files: ground truth private theo competition; submissions private theo competition + account
- Chi tiết: `docs/DATA_MODEL.md`

## 8. Environment variables in use
- Không có env mới; `MAX_UPLOAD_MB=10` là limit chung cho ground truth và submission CSV
- `MAX_CONTENT_MB=2`, `MAX_ASSET_MB=2`, `DATA_DIR` và auth/Mongo env giữ nguyên

## 9. Commands verified
- `cd backend && .venv/bin/pytest` — 126 passed
- `cd frontend && npm test` — 48 passed (12 files)
- `cd frontend && npm run build` — pass (strict TS + Vite production build)
- `cd frontend && npm run lint` — exit 0, chỉ warning fetch-on-mount/Fast Refresh đã biết
- `docker compose config --quiet` — pass
- `docker compose up --build -d` — pass (image chứa openpyxl 3.1.5)
- Sprint 06 live smoke qua Nginx (2026-09-15): admin config scoring (pos_label string) + ground truth + publish; participant join + submit valid (F1=1.0, reordered rows) + invalid ID mismatch 422 không persist; `submissions/me` newest-first 2 records; participant leaderboard rank/best/marker đúng; hidden published → participant 403 `LEADERBOARD_HIDDEN`, admin 200; admin submissions filter `q`/`status` không lộ `file_path`; `export.xlsx` content-type/filename đúng, sheet `Results` rank/score/metrics/count đúng; export bằng participant 403; unauth 401; smoke data đã dọn (Mongo + /data)

## 10. Tests currently passing
- Backend cũ Sprint 01-04: 77
- Backend Sprint 05: 43 (scoring pure 23, scoring admin 11, submissions 9)
- Backend Sprint 06: 6 result API/export tests
- Frontend: 48 (Sprint 06 thêm 6 participant result tests + 1 admin/nav integration test; các test cũ giữ pass)

## 11. Known issues / technical debt
- Chưa thao tác UI Sprint 05 thủ công trong browser; component tests và API smoke qua Nginx/Mongo/filesystem thật đã pass
- Quota check là count rồi insert, không transaction; hai request thật sự đồng thời có thể cùng vượt qua slot cuối (MVP traffic thấp, cần harden nếu client gửi concurrent uploads)
- Scoring synchronous đọc/parse ground truth lại mỗi submission; phù hợp limit 10 MiB/MVP, cần đo trước khi tăng limit
- Leaderboard/admin result query aggregate trong application memory; phù hợp 40-80 đội/MVP, cần đo trước khi tăng quy mô lớn
- Lint warnings set-state-in-effect/Fast Refresh là pattern hiện có, thêm 2 fetch-on-mount warnings cho Sprint 06; không có lint error
- Chưa thao tác UI Sprint 06 thủ công trong browser
- Full E2E open/code/invite_only qua Nginx vẫn chưa chạy; upload/render Markdown đã được user verify ở Sprint 04
- Thay đổi riêng chưa commit ở `scripts/dev_up.sh` đặt default passwords là `1`, ngắn hơn policy 10 ký tự; giữ nguyên theo yêu cầu user và cần override env nếu dùng script

## 12. Decisions made this sprint
- ADR-012: derived ordinal ranking + deterministic tie-break, backend visibility/privacy, one-sheet safe XLSX; tiếp tục không persist validation reject

## 13. Preconditions for next sprint
- Sprint 07 có stable auth/join/content/submission/result APIs và complete participant/admin result UI
- Trước production nên kiểm tra UX Sprint 05-06 thủ công trên browser desktop/mobile; không chặn bắt đầu Sprint 07

## 14. Exact next sprint
- `plans/sprints/SPRINT_07_HARDENING_ADMIN_UX_AND_RELEASE_CANDIDATE.md`

## 15. Handoff notes for the next AI agent
- Giữ participant hidden leaderboard enforcement ở backend; frontend banner chỉ là UX
- Giữ `primary_metric` top-level là nguồn ranking; `higher_is_better` MVP vẫn luôn true
- Validation rejects vẫn không tồn tại trong DB theo ADR-011; không giả định status filter sẽ có record rejected hiện tại
- Không expose `file_path`, account id/email, ground-truth path/data hoặc account secrets ở participant API
- Không có participant/admin submitted-CSV download; nếu Sprint sau cần, phải chốt quyền và path containment trước

---

Rules:
- Không ghi suy đoán.
- Không ghi secret.
- Nếu một chức năng đang partial, nói rõ partial ở đâu.
- Mỗi endpoint/schema đã thay đổi phải đồng bộ sang contract file.
