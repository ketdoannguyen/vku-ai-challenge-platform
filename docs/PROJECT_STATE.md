# AI Challenge Platform - Current Project State

## 1. Current checkpoint
- Date: 2026-09-17
- Branch: `feat/admin-competitions-ui`
- Commit/working tree status: HEAD `48169c3` (Sprint 08 + UI admin/participant đã commit); thay đổi **chưa commit** trong working tree: block "Vận hành cuộc thi" (ADR-015→ADR-020) và phần tổng quan participant
- Overall state: **release candidate** — 177 backend tests + 114 frontend tests pass; typecheck, production build, lint và Compose config pass. Vòng này chỉ chạy test tự động, **chưa** chạy lại live E2E smoke trên stack Compose (xem §9)

## 2. Implemented capabilities
- Sprint 01-07: local Compose stack, auth Argon2id + server-side session, admin accounts, competition lifecycle, membership/join modes, safe Markdown content/assets, participant portal, scoring + ground truth private, submission policy/quota, my submissions, leaderboard, XLSX export, login rate limit + error envelope + CSP Report-Only
- Sprint 08 (ADR-014): đọc công khai cho khách (danh sách, chi tiết, nội dung `public`, assets)
- Vận hành cuộc thi (working tree, ADR-015→ADR-019):
  - **Tài nguyên tải về**: `competitions.resources` là link Google Drive (tối đa 10, https, host Drive/Docs, không credentials); không host dataset/binary. Block nằm dưới "Mục lục nội dung" trong tab Tổng quan, ẩn khi rỗng, link ngoài có `rel="noopener noreferrer nofollow"` (ADR-015)
  - **Publish chỉ khi chấm được**: `app/scoring/readiness.py` là một nguồn sự thật, đọc và parse lại ground truth thật; thiếu/sai → 422 với code cụ thể và giữ nguyên `draft`. Admin detail trả `publish_ready`/`publish_blocked_reason` (ADR-017)
  - **Join từ publish đến hết `end_at`**: non-member sau `end_at` → 422 `JOIN_DEADLINE_PASSED`; không kiểm tra `start_at`; membership hiện có luôn idempotent kể cả sau deadline/closed (ADR-017)
  - **Privacy payload**: bỏ `created_by` khỏi representation public; `pos_label` chỉ trả cho admin và thành viên active (ADR-016); datetime naive/aware chuẩn hoá qua một helper dùng chung
  - **Quota trước khi nộp**: `GET /api/competitions/{slug}` trả `quota {per_day,used_today,remaining,resets_at}` cho thành viên active; UI hiện "Còn X/Y lượt" và khoá form khi hết lượt (ADR-019)
  - **Leaderboard phân trang**: `limit`/`offset`/`has_more` + `me` (hạng toàn cục, tìm trên full list trước khi cắt trang, không có account id) (ADR-019)
  - **Đường thoát**: participant `POST /leave` (soft deactivate, giữ điểm); admin xoá cứng member chỉ khi chưa có bài `completed`, ngược lại 409 `MEMBER_HAS_SUBMISSIONS`; admin `DELETE` competition chỉ với `draft` + `confirm_slug`, cascade con-trước-cha-sau và dọn file best-effort (ADR-018)
  - **Countdown sống**: formatter thuần + hook dùng chung, dashboard dùng một page-level clock, nhịp 30 giây trên 1 ngày và 1 giây dưới 1 ngày, resync khi tab visible
- Tổng quan participant (working tree, user làm song song): tab Tổng quan là trang thật với thể lệ/quy cách bài nộp/danh sách tài liệu, không tự nhảy sang tài liệu đầu tiên

## 3. Not implemented yet (đúng kế hoạch)
- Production deploy (GCE, Cloudflare Tunnel, compose prod, HSTS, CSP enforce, edge/IP-based rate limit) — Sprint 08
- Backup/restore/pilot — Sprint 09
- Public/private leaderboard split — **tạm hoãn có chủ đích** (ADR-020); không giải quyết bằng cách nhân đôi competition

## 4. Repository structure that matters
- `backend/app/core/datetimes.py`: `as_utc`, `utc_day_bounds`, `iso_z` dùng chung (naive Mongo được hiểu là UTC)
- `backend/app/scoring/readiness.py`: `check_readiness` / `blocked_reason` cho publish + banner admin + endpoint scoring
- `backend/app/competitions/service.py`: `public_competition` vs `admin_competition`, `normalize_resources`, `delete_competition_cascade`, `remove_competition_files`
- `backend/app/memberships/{router,admin_router}.py`: join deadline policy, `POST /leave`, `DELETE member` có điều kiện, `active_total`
- `backend/app/leaderboard/service.py`: `leaderboard_response` (participant, phân trang + `me`) vs `admin_leaderboard_response` (full list)
- `frontend/src/lib/countdown.ts`, `frontend/src/hooks/useCountdown.ts`: formatter thuần + clock sống
- `frontend/src/components/CompetitionResources.tsx`: block tài nguyên, tự lọc URL trước khi render anchor
- `backend/tests/helpers.py`: fixture dùng chung (`configure_scoring`, `publish_competition`) — `backend/tests` là package nên import qua `tests.helpers`

## 5. Runtime/services
- Kiến trúc web/api/mongo và volume `/data` giữ nguyên; không thêm dependency, service hay collection mới
- Không có collection mới: `resources` nằm trong `competitions`, quota và `me` là dữ liệu derived

## 6. Current API contract summary
- Mới: `POST /api/competitions/{slug}/leave`; `DELETE /api/admin/competitions/{id}` (draft + `confirm_slug`); `DELETE /api/admin/competitions/{id}/members/{account_id}`
- Đổi: `GET /api/competitions/{slug}` thêm `quota`; leaderboard participant thêm `limit`/`offset`/`has_more`/`me`; admin members thêm `active_total`; competition create/update thêm `resources`; join thêm `JOIN_DEADLINE_PASSED`
- Error code mới: `JOIN_DEADLINE_PASSED`, `GROUND_TRUTH_REQUIRED`, `CONFIRM_SLUG_MISMATCH`, `COMPETITION_NOT_DELETABLE`, `MEMBER_HAS_SUBMISSIONS`
- Chi tiết: `docs/API_CONTRACT.md` §3-§6

## 7. Current data model and indexes
- `competitions.resources` (list `{label,url}`, default `[]`; document cũ thiếu field vẫn đọc được, không migration)
- Membership: `active=false` giờ cũng do participant tự đặt qua `/leave`; admin xoá cứng chỉ khi chưa có bài `completed`
- Không thêm index mới (các truy vấn mới đều dùng index sẵn có)
- Chi tiết: `docs/DATA_MODEL.md` §9-§10

## 8. Environment variables in use
- Không env mới. `MAX_UPLOAD_MB`, `MAX_CONTENT_MB`, `MAX_ASSET_MB`, `DATA_DIR` giữ nguyên

## 9. Commands verified
- `cd backend && .venv/bin/pytest -q` — **177 passed**
- `cd frontend && npx vitest run` — **114 passed (17 files)**
- `cd frontend && npx tsc -b --force` — pass (không lỗi)
- `cd frontend && npm run build` — pass
- `cd frontend && npx oxlint src` — exit 0, chỉ warnings có sẵn (set-state-in-effect, Fast Refresh, `Date.now` trong JoinControl)
- `docker compose config --quiet` — pass
- **Chưa chạy lại vòng này**: live E2E smoke qua Nginx + Mongo thật, `docker compose build/up`, log review. Kết quả smoke gần nhất vẫn là của Sprint 07/08 (xem git history). Các luồng mới (leave, xoá member/competition, quota, phân trang) mới có test tự động, chưa smoke trên stack thật.

## 10. Tests currently passing
- Backend: 177 (con số 133 ghi ở Sprint 07; tăng do Sprint 08 và block vận hành — file mới `test_datetimes.py` 6 test, `test_competitions_delete.py` 4 test, còn lại rải trong `test_competitions_{admin,public}.py`, `test_memberships.py`, `test_results.py`, `test_scoring_admin.py`, `test_submissions.py`)
- Frontend: 114 (17 files; file mới `lib/countdown.test.ts`, `hooks/useCountdown.test.tsx`, `pages/CompetitionOverview.test.tsx`, cộng các case thêm trong page/component tests)

## 11. Known issues / technical debt (non-blocking)
- Limiter login process-local theo email (ADR-013): lockout 15 phút nếu kẻ xấu biết email; cần IP companion khi có Cloudflare trusted headers
- Limit 200 cho admin accounts/members: vượt 200 dòng sẽ truncate (có hiển thị total); thêm pagination khi quy mô vượt
- Leaderboard vẫn tính full ranking trong bộ nhớ: phù hợp 40-80 người; phân trang chỉ giảm payload/UI, không đổi độ phức tạp query — review nếu vượt quy mô
- Cascade xoá competition không có transaction (Mongo standalone): đã xoá con-trước-cha-sau + test failure injection, nhưng file cleanup chỉ best-effort và có thể báo partial (`files_removed:false`)
- Race nhỏ giữa check `has_completed_submission` và xoá member với một submission đồng thời; backend vẫn enforce membership khi nộp nên không mất điểm đã chấm
- Quota check count-then-insert không transaction; UI quota có thể stale trên nhiều tab — backend 429 vẫn là authority
- Modal chưa có focus trap đầy đủ (chỉ focus ban đầu + Escape + restore)
- Lint warnings set-state-in-effect/Fast Refresh là pattern có sẵn; không có lint error
- Link Drive không được kiểm tra còn truy cập được (chủ đích, ADR-015) — BTC tự đảm bảo quyền chia sẻ

## 12. Decisions made this sprint
- ADR-015: resources là link Drive, không host binary
- ADR-016: tách representation public/admin; không lộ `created_by`/`pos_label`
- ADR-017: publish readiness là một nguồn sự thật; join mở đến hết `end_at`
- ADR-018: xoá theo hướng giữ lịch sử (leave soft, hard-delete member có điều kiện, delete competition chỉ draft)
- ADR-019: quota hiển thị trước khi nộp; leaderboard phân trang nhưng hạng vẫn toàn cục
- ADR-020: tạm hoãn public/private leaderboard split (deferred)

## 13. Preconditions for next sprint
- Sprint 08 cần: GCE VM, domain, Cloudflare Tunnel token, production `.env` (danh sách trong `docs/DEPLOYMENT.md`)
- Trước khi deploy nên chạy lại live smoke cho các luồng vận hành mới (§9)

## 14. Exact next sprint
- `plans/sprints/SPRINT_08_PRODUCTION_GCE_DOCKER_CLOUDFLARE_DEPLOY.md`

## 15. Handoff notes for the next AI agent
- Muốn "public/private leaderboard" thì đọc ADR-020 trước: **không** nhân đôi competition; hướng đúng là một ground truth có partition và một submission sinh hai score
- Mọi thay đổi publish/join phải đi qua `app/scoring/readiness.py` và giữ thứ tự policy trong `memberships/router.py`
- Xoá dữ liệu: luôn con-trước-cha-sau, dọn file sau khi DB xong, không thêm force flag cho published/closed/member đã có bài `completed`
- Không expose `created_by`/`pos_label` ra representation public; field mới phải chọn rõ bên public hay admin
- Mọi error code mới phải vào `docs/API_CONTRACT.md` §6

---

Rules:
- Không ghi suy đoán.
- Không ghi secret.
- Nếu một chức năng đang partial, nói rõ partial ở đâu.
- Mỗi endpoint/schema đã thay đổi phải đồng bộ sang contract file.
