# Sprint 05 Submission Validation and Scoring Implementation Plan

**Goal:** Cho phép admin cấu hình chấm điểm và upload ground truth riêng cho từng competition; participant hợp lệ có thể upload CSV, nhận F1/Precision/Recall và lưu submission completed an toàn.

**Architecture:** MongoDB giữ cấu hình nghiệp vụ không trùng lặp: `competitions.primary_metric`, `competitions.quota_per_day`, `competitions.scoring_config` và metadata ground truth. `MAX_UPLOAD_MB` trong environment là giới hạn upload duy nhất cho toàn hệ thống. Ground truth và submission CSV nằm trong `/data`, mọi path do backend sinh. Scoring chạy đồng bộ bằng scikit-learn; validation reject chỉ trả lỗi, không lưu record hoặc file.

**Tech Stack:** FastAPI, MongoDB/Motor, Python CSV, scikit-learn, React, TypeScript, Vitest, pytest.

---

### Task 1: Scoring engine và CSV validation

**Files:**
- Create: `backend/app/scoring/__init__.py`
- Create: `backend/app/scoring/service.py`
- Create: `backend/tests/test_scoring.py`
- Modify: `backend/pyproject.toml`

1. Viết test fixtures deterministic cho binary perfect, FP/FN, macro, row reorder và các lỗi schema/ID/value.
2. Chạy `cd backend && .venv/bin/pytest tests/test_scoring.py -q` và xác nhận fail do module chưa tồn tại.
3. Thêm scikit-learn và implement parser/validator/scorer tối thiểu với `zero_division=0`.
4. Chạy lại test scoring đến khi pass.

### Task 2: Admin scoring config và ground truth

**Files:**
- Create: `backend/app/scoring/admin_router.py`
- Create: `backend/tests/test_scoring_admin.py`
- Modify: `backend/app/competitions/service.py`
- Modify: `backend/app/main.py`

1. Viết test API cho role guard, config validation, upload/replace CSV, readiness metadata, competition isolation và lock sau completed submission.
2. Chạy test và xác nhận fail vì route chưa tồn tại.
3. Implement `GET|PUT /api/admin/competitions/{id}/scoring` và `PUT /api/admin/competitions/{id}/ground-truth`.
4. Chỉ lưu metadata an toàn; không có endpoint download ground truth. Closed competition hoặc competition đã có submission completed trả `SCORING_LOCKED`.
5. Chạy lại test admin scoring.

### Task 3: Submission upload, validation, quota và persistence

**Files:**
- Create: `backend/app/submissions/__init__.py`
- Create: `backend/app/submissions/service.py`
- Create: `backend/app/submissions/router.py`
- Create: `backend/tests/test_submissions.py`
- Modify: `backend/app/main.py`

1. Viết test API cho auth, active membership, published/time window, readiness, global size limit, quota UTC/day, safe path, scoring, validation rejection không persistence và competition isolation.
2. Chạy test và xác nhận fail vì route chưa tồn tại.
3. Implement indexes và `POST /api/competitions/{id}/submissions` theo thứ tự guard đã chốt.
4. Chỉ ghi file và record `completed` sau khi validation/scoring thành công; dọn file nếu DB insert lỗi.
5. Chạy test submission và toàn bộ backend suite.

### Task 4: Admin scoring UI

**Files:**
- Modify: `frontend/src/pages/AdminCompetitionDetailPage.tsx`
- Modify: `frontend/src/pages/AdminCompetitionDetailPage.test.tsx`
- Modify: `frontend/src/index.css`

1. Viết test tab Chấm điểm: readiness, form config, ground truth metadata/upload và locked state.
2. Chạy test và xác nhận fail vì UI chưa có.
3. Implement panel nhỏ, dùng API thật, hiển thị giới hạn global 10 MiB và không render label data.
4. Chạy lại test trang admin.

### Task 5: Participant Submit page

**Files:**
- Create: `frontend/src/pages/SubmissionPage.tsx`
- Create: `frontend/src/pages/SubmissionPage.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/CompetitionDetailPage.tsx`
- Modify: `frontend/src/api/competitions.ts`
- Modify: `frontend/src/index.css`

1. Viết test cho rule summary, chọn file, loading, metrics result và validation error.
2. Chạy test và xác nhận fail vì page chưa tồn tại.
3. Implement nested route `submit`; giữ `submissions` và `leaderboard` disabled cho Sprint 06.
4. Chạy frontend test, lint và build.

### Task 6: Contracts, state và final verification

**Files:**
- Modify: `docs/PROJECT_STATE.md`
- Modify: `docs/API_CONTRACT.md`
- Modify: `docs/DATA_MODEL.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/TEST_MATRIX.md`
- Modify: `README.md` nếu lệnh setup thay đổi do dependency.

1. Ghi exact config ownership, readiness/lock rules, error codes, persistence policy và fixture results.
2. Chạy fresh: backend full pytest, frontend tests/lint/build, Docker image build và `docker compose config --quiet`.
3. Review `git diff`, bảo toàn thay đổi có sẵn trong `scripts/dev_up.sh` và `.claude/reports/`.
4. Báo cáo đúng Sprint 05 và đề xuất commit message; không commit/push.
