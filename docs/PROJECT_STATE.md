# AI Challenge Platform - Current Project State

## 1. Current checkpoint
- Last completed sprint: SPRINT_05
- Date: 2026-09-15
- Branch: main
- Commit/working tree status: Sprint 05 implemented trong working tree; chưa commit/push
- Overall state: green — 120 backend tests + 41 frontend tests pass; frontend production build, Docker images/Compose config và submission API smoke qua Nginx + Mongo thật đều pass

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

## 3. Not implemented yet
- My Submissions, leaderboard best-score/tie-break, admin submission view và Excel export — Sprint 06
- Login/join rate limiting và release hardening — Sprint 07
- Production deploy — Sprint 08; backup/restore/pilot — Sprint 09

## 4. Repository structure that matters
- `backend/app/scoring/service.py`: config validation, CSV parser, ground-truth validation, ID alignment, scikit-learn metrics
- `backend/app/scoring/storage.py`: path containment, symlink guard và private ground-truth read/readiness dùng chung
- `backend/app/scoring/admin_router.py`: admin scoring status/config/ground-truth endpoints và lock policy
- `backend/app/submissions/service.py`: indexes, quota UTC/day, public completed response
- `backend/app/submissions/router.py`: participant guards, upload/score/persist flow
- `backend/tests/test_scoring.py` (23), `test_scoring_admin.py` (11), `test_submissions.py` (9)
- `frontend/src/pages/SubmissionPage.tsx` + test (4)
- `frontend/src/pages/AdminCompetitionDetailPage.tsx`: tab Chấm điểm; test file hiện có 8 test
- `.claude/plans/2026-09-15-sprint-05-submission-validation-scoring.md`: implementation plan

## 5. Runtime/services
- Kiến trúc web/api/mongo và volume `/data` giữ nguyên
- Backend thêm runtime dependency `scikit-learn>=1.5,<2`; dev dependency `httpx2>=2.13` cho Starlette TestClient hiện tại

## 6. Current API contract summary
- Participant competition list/detail thêm safe `submission_config {ready,id_column,prediction_column,average,pos_label,max_upload_mb}`
- `POST /api/competitions/{id}/submissions` — implemented; 201 completed metrics hoặc error ổn định, không persist validation reject
- Admin: `GET|PUT /api/admin/competitions/{id}/scoring`, `PUT /api/admin/competitions/{id}/ground-truth` — implemented
- Ground truth không có participant/public route
- My Submissions/leaderboard/admin export vẫn planned Sprint 06
- Chi tiết: `docs/API_CONTRACT.md`

## 7. Current data model and indexes
- `competitions` thêm optional `scoring_config` và `ground_truth` metadata; config/metadata chỉ xuất hiện sau khi admin cấu hình
- `submissions`: implemented completed records với competition/account/path/original filename/metrics/primary score/created_at
- Indexes: `(competition_id, account_id, created_at DESC)` và `(competition_id, primary_score DESC)`
- Files: ground truth private theo competition; submissions private theo competition + account
- Chi tiết: `docs/DATA_MODEL.md`

## 8. Environment variables in use
- Không có env mới; `MAX_UPLOAD_MB=10` là limit chung cho ground truth và submission CSV
- `MAX_CONTENT_MB=2`, `MAX_ASSET_MB=2`, `DATA_DIR` và auth/Mongo env giữ nguyên

## 9. Commands verified
- `cd backend && .venv/bin/pytest` — 120 passed
- `cd frontend && npm test` — 41 passed (10 files)
- `cd frontend && npm run build` — pass (strict TS + Vite production build)
- `cd frontend && npm run lint` — exit 0, chỉ warning fetch-on-mount/Fast Refresh đã biết
- `docker compose config --quiet` — pass
- `docker compose build api web` — pass
- `docker compose up -d --no-deps --force-recreate api web` + `curl http://localhost:8080/api/health` — pass, Mongo reachable
- One-off Sprint 05 smoke qua Nginx/Mongo/filesystem thật — pass: invalid không persist, reordered valid score 1.0, lock enforce, ground truth 404; artifacts tạm đã cleanup

## 10. Tests currently passing
- Backend cũ Sprint 01-04: 77
- Backend Sprint 05: 43 (scoring pure 23, scoring admin 11, submissions 9)
- Frontend: 41 (Sprint 05 thêm 4 Submit page + 4 admin scoring; các test cũ giữ pass)

## 11. Known issues / technical debt
- Chưa thao tác UI Sprint 05 thủ công trong browser; component tests và API smoke qua Nginx/Mongo/filesystem thật đã pass
- Quota check là count rồi insert, không transaction; hai request thật sự đồng thời có thể cùng vượt qua slot cuối (MVP traffic thấp, cần harden nếu client gửi concurrent uploads)
- Scoring synchronous đọc/parse ground truth lại mỗi submission; phù hợp limit 10 MiB/MVP, cần đo trước khi tăng limit
- Lint warnings set-state-in-effect/Fast Refresh là pattern cũ và một instance mới trong admin scoring fetch-on-mount; không có lint error
- Full E2E open/code/invite_only qua Nginx vẫn chưa chạy; upload/render Markdown đã được user verify ở Sprint 04

## 12. Decisions made this sprint
- ADR-011: Mongo/env/filesystem ownership không trùng, global upload 10 MiB, scoring lock sau điểm/closed, rejected không persistence, quota completed theo UTC, synchronous scikit-learn

## 13. Preconditions for next sprint
- Sprint 06 có completed submission schema + indexes, metrics/primary score và stable participant upload API
- Trước production nên kiểm tra UX Sprint 05 thủ công trên browser desktop/mobile; không chặn bắt đầu Sprint 06

## 14. Exact next sprint
- `plans/sprints/SPRINT_06_LEADERBOARD_HISTORY_AND_EXPORT.md`

## 15. Handoff notes for the next AI agent
- Leaderboard chỉ query `status=completed`; validation rejects không tồn tại trong DB
- Best submission theo `primary_score` cao nhất; tie-break created_at sớm hơn theo contract v1
- `primary_metric` top-level competition là nguồn ranking; `higher_is_better` hiện luôn true
- My Submissions route planned `/api/competitions/{id}/submissions/me`; frontend tab hiện vẫn disabled
- Không expose `file_path`, ground-truth path/data hoặc account secrets ở participant API
- Nếu Sprint 06 thêm admin submission view/download, phải giữ competition scoping và path containment như Sprint 05

---

Rules:
- Không ghi suy đoán.
- Không ghi secret.
- Nếu một chức năng đang partial, nói rõ partial ở đâu.
- Mỗi endpoint/schema đã thay đổi phải đồng bộ sang contract file.
