# Test Matrix - AI Challenge Platform

Ma trận test theo chức năng. `Status`: `planned` (chưa có test), `passing` (test tồn tại và pass), `failing` (test tồn tại nhưng fail). Cập nhật cuối mỗi sprint.

## 1. Bootstrap / repo hygiene (Sprint 00)

| Check | Status | Cách verify |
|---|---|---|
| Không có secret/credential hard-code trong repo | passing | `grep -rIiE "(password|secret|token|api[_-]?key)\s*[:=]\s*['\"]?[A-Za-z0-9+/]{16,}" --exclude-dir=plans --exclude-dir=.git .` không match giá trị thật |
| `.env` bị gitignore, `.env.example` không chứa secret thật | passing | `git check-ignore .env` + review `.env.example` |
| Docs links/paths hợp lệ | passing | Review thủ công các tham chiếu `plans/...`, `docs/...` |

## 2. Health / local stack (Sprint 01) — planned

| Check | Status |
|---|---|
| `GET /api/health` trả 200 | planned |
| `docker compose up` chạy web+api+mongo | planned |
| Frontend build thành công (strict TS) | planned |

## 3. Auth & accounts (Sprint 02) — planned

| Check | Status |
|---|---|
| Login đúng → cookie + `/auth/me` | planned |
| Login sai → 401, không leak thông tin | planned |
| Logout hủy session server-side | planned |
| Argon2id hash password | planned |
| Admin CRUD accounts + role check 403 | planned |

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
