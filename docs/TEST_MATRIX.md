# Test Matrix - AI Challenge Platform

Ma trận test theo chức năng. `Status`: `planned` (chưa có test), `passing` (test tồn tại và pass), `failing` (test tồn tại nhưng fail). Cập nhật cuối mỗi sprint.

## 1. Bootstrap / repo hygiene (Sprint 00)

| Check | Status | Cách verify |
|---|---|---|
| Không có secret/credential hard-code trong repo | passing | `grep -rIiE "(password|secret|token|api[_-]?key)\s*[:=]\s*['\"]?[A-Za-z0-9+/]{16,}" --exclude-dir=plans --exclude-dir=.git .` không match giá trị thật |
| `.env` bị gitignore, `.env.example` không chứa secret thật | passing | `git check-ignore .env` + review `.env.example` |
| Docs links/paths hợp lệ | passing | Review thủ công các tham chiếu `plans/...`, `docs/...` |

## 2. Health / local stack (Sprint 01)

| Check | Status | Cách verify |
|---|---|---|
| `GET /api/health` trả 200 khi Mongo reachable | passing | `backend/tests/test_health.py` (TestClient, mock ping) |
| Health degraded 503 khi Mongo unreachable | passing | `backend/tests/test_health.py` |
| 404 API trả error format contract | passing | `backend/tests/test_health.py` |
| Frontend build thành công (strict TS) | passing | `cd frontend && npm run build` |
| `docker compose config` hợp lệ | passing | `docker compose config --quiet` |
| `docker compose up` chạy web+api+mongo | blocked | User dev không có group docker (`docker.sock` permission denied) — cần `sudo usermod -aG docker nkd` rồi chạy lại để verify |
| curl `/api/health` qua Nginx same-origin | blocked | Như trên — chưa verify end-to-end qua container web |
| Mongo không publish public | passing | `docker-compose.yml`: mongo chỉ `expose 27017`, không có `ports` |
| Nginx không serve `/data` | passing | `frontend/nginx.conf`: `location /data/ { return 404; }` |

## 3. Auth & accounts (Sprint 02)

| Check | Status | Cách verify |
|---|---|---|
| Login đúng → cookie + `/auth/me` safe fields | passing | `backend/tests/test_auth.py` (mongomock-motor) |
| Login sai → 401 generic, sai email/sai password trả cùng response | passing | `backend/tests/test_auth.py` |
| Disabled account: login 403 + session hiện có bị từ chối | passing | `backend/tests/test_auth.py` |
| Logout hủy session server-side, idempotent | passing | `backend/tests/test_auth.py` |
| Session hết hạn bị từ chối (kể cả khi doc còn trong DB) | passing | `backend/tests/test_auth.py` |
| Argon2id hash password, không plaintext; verify đúng/sai; malformed hash không crash | passing | `backend/tests/test_passwords.py` |
| DB lưu sha256(token), không lưu raw token | passing | `backend/tests/test_auth.py::test_db_stores_token_hash_not_raw_token` |
| Admin API role guard: 401 chưa login, 403 participant | passing | `backend/tests/test_admin_accounts.py` |
| Admin create/duplicate 409/weak password 422/invalid role 422 | passing | `backend/tests/test_admin_accounts.py` |
| Admin reset password: mật khẩu cũ hết dùng, mới login được | passing | `backend/tests/test_admin_accounts.py` |
| Admin disable: session chết ngay + login bị chặn; không tự disable chính mình | passing | `backend/tests/test_admin_accounts.py` |
| Password policy (≥10 ký tự, không space đầu/cuối) | passing | `backend/tests/test_passwords.py` |
| Login form: error message, loading state, không có link đăng ký | passing | `frontend/src/pages/LoginPage.test.tsx` (vitest) |
| Protected routes: chưa login → /login; participant → không vào admin | passing | `frontend/src/auth/RequireAuth.test.tsx` |
| Login end-to-end qua Nginx với Mongo thật + cookie | blocked | Docker permission máy dev (Sprint 01, mục 2); chạy lại sau `sudo usermod -aG docker nkd` |
| Bootstrap scripts tạo admin/import thật với Mongo | blocked | Như trên — usage/error path đã verify, đường tạo thật cần Mongo chạy |
| Login rate limiting | planned | Defer Sprint 07 (sprint file cho phép) |

## 4. Competition core & admin (Sprint 03) — planned

| Check | Status |
|---|---|
| CRUD + clone + publish/close lifecycle | planned |
| Slug unique | planned |
| Draft không visible cho participant | planned |

## 5. Markdown content & membership (Sprint 04) — planned

| Check | Status |
|---|---|
| Render GFM + sanitize (script/iframe/event handler bị chặn) | planned |
| Path traversal bị chặn (asset/content) | planned |
| Join mode open/code/invite_only đúng policy | planned |
| Join code không trả về participant API | planned |

## 6. Submission & scoring (Sprint 05) — planned

| Check | Status |
|---|---|
| Validate: extension, cột, duplicate ID, missing/extra ID, null prediction | planned |
| F1/Precision/Recall tính đúng với average/pos_label config | planned |
| Align theo ID không theo thứ tự dòng | planned |
| Quota/day + deadline check backend | planned |
| Upload size limit | planned |
| Ground truth không public | planned |

## 7. Leaderboard/history/export (Sprint 06) — planned

| Check | Status |
|---|---|
| Best valid submission mỗi account | planned |
| Tie-break: score DESC → đạt sớm hơn đứng trước | planned |
| My Submissions hiển thị đúng lịch sử | planned |
| Excel export đúng dữ liệu | planned |

## 8. Hardening (Sprint 07) — planned

| Check | Status |
|---|---|
| Security headers cơ bản qua Nginx | planned |
| Log không chứa password/cookie/secret/ground truth | planned |
| Mongo không expose public | planned |

## 9. Production deploy (Sprint 08) — planned

| Check | Status |
|---|---|
| Docker Compose prod chạy trên GCE | planned |
| Cloudflare Tunnel serve HTTPS | planned |
| Smoke test production | planned |

## 10. Backup/restore & pilot (Sprint 09) — planned

| Check | Status |
|---|---|
| Backup + restore Mongo + /data | planned |
| Runbook pilot | planned |
