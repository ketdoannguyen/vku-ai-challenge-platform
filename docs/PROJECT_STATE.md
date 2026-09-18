# AI Challenge Platform - Current Project State

## 1. Current checkpoint
- Date: 2026-09-17
- Branch: `feat/admin-competitions-ui`
- Commit/working tree status: HEAD `88456ed` (Sprint 08 + UI admin/participant + block "Vận hành cuộc thi"); thay đổi **chưa commit** trong working tree: đợt remediation P0/P1/P2 theo plan `declarative-honking-bee.md` (Waves 2–6)
- Overall state: **release candidate** — 186 backend tests + 216 frontend tests pass; typecheck, production build, lint và Compose config pass. Vòng này đã chạy lại live smoke (`scripts/dev_up.sh`) và kiểm chứng bằng trình duyệt trên bundle mới (xem §9)

## 2. Implemented capabilities
- Sprint 01-07: local Compose stack, auth Argon2id + server-side session, admin accounts, competition lifecycle, membership/join modes, safe Markdown content/assets, participant portal, scoring + ground truth private, submission policy/quota, my submissions, leaderboard, XLSX export, login rate limit + error envelope + CSP Report-Only
- Sprint 08 (ADR-014): đọc công khai cho khách (danh sách, chi tiết, nội dung `public`, assets)
- Vận hành cuộc thi (working tree, ADR-015→ADR-019):
  - **Tài nguyên tải về**: `competitions.resources` là link Google Drive (tối đa 10, https, host Drive/Docs, không credentials); không host dataset/binary. Admin quản lý trực tiếp tại tab **Tài nguyên** trong chi tiết cuộc thi (dialog chỉ nhập khi tạo mới); block participant nằm dưới "Mục lục nội dung" trong tab Tổng quan, dùng cùng card shell VKU và format đánh số, ẩn khi rỗng, link ngoài có `rel="noopener noreferrer nofollow"` (ADR-015)
  - **Publish chỉ khi chấm được**: `app/scoring/readiness.py` là một nguồn sự thật, đọc và parse lại ground truth thật; thiếu/sai → 422 với code cụ thể và giữ nguyên `draft`. Admin detail trả `publish_ready`/`publish_blocked_reason` (ADR-017)
  - **Join từ publish đến hết `end_at`**: non-member sau `end_at` → 422 `JOIN_DEADLINE_PASSED`; không kiểm tra `start_at`; membership hiện có luôn idempotent kể cả sau deadline/closed (ADR-017)
  - **Privacy payload**: bỏ `created_by` khỏi representation public; `pos_label` chỉ trả cho admin và thành viên active (ADR-016); datetime naive/aware chuẩn hoá qua một helper dùng chung
  - **Quota trước khi nộp**: `GET /api/competitions/{slug}` trả `quota {per_day,used_today,remaining,resets_at}` cho thành viên active; UI hiện "Còn X/Y lượt" và khoá form khi hết lượt (ADR-019)
  - **Leaderboard phân trang**: `limit`/`offset`/`has_more` + `me` (hạng toàn cục, tìm trên full list trước khi cắt trang, không có account id) (ADR-019)
  - **Đường thoát**: participant `POST /leave` (soft deactivate, giữ điểm; trigger danger-ghost đỏ và modal xác nhận danger); admin xoá cứng member chỉ khi chưa có bài `completed`, ngược lại 409 `MEMBER_HAS_SUBMISSIONS`; admin `DELETE` competition chỉ với `draft` + `confirm_slug`, cascade con-trước-cha-sau và dọn file best-effort (ADR-018)
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
- Đổi: `GET /api/competitions/{slug}` thêm `quota`; leaderboard participant thêm `limit`/`offset`/`has_more`/`me`; admin members thêm `active_total`; competition create/update thêm `resources`; join thêm `JOIN_DEADLINE_PASSED`; admin competition detail và mọi response mutate thêm `upload_limits`; `/api/admin/accounts` chặn `limit`/`offset` ngoài khoảng bằng 422
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
- `cd backend && .venv/bin/pytest -q` — **186 passed**
- `cd frontend && npx vitest run` — **216 passed (19 files)**, chạy 3 lần liên tiếp đều sạch
- `cd frontend && npx tsc -b --force` — pass (không lỗi)
- `cd frontend && npm run build` — pass; entry 437.29 kB (gzip 120.84 kB) + chunk `MarkdownView` 159.71 kB (gzip 48.18 kB), không còn cảnh báo >500 kB
- `cd frontend && npx oxlint src` — exit 0, chỉ warnings có sẵn (set-state-in-effect, Fast Refresh, `Date.now` trong JoinControl)
- `bash -n scripts/dev_up.sh` — pass
- `./scripts/dev_up.sh` — chạy live: login 200, `/auth/me` role=admin, admin API 200, login sai 401 generic
- `docker compose config --quiet` — pass
- Kiểm chứng trình duyệt trên bundle đã rebuild (`index-3_0qCuvI.js`, hash khớp bản build cục bộ): drawer/picker/title/H1/nav công khai, touch target ở 375/768/1280, hint upload động ở 375/768/1280/1440, phân trang accounts 230 dòng ở 375/1280 — tất cả PASS

## 10. Tests currently passing
- Backend: 186 (nền 177 của Sprint 08 + block vận hành; đợt remediation thêm 6 test clone slug/race + 3 test `upload_limits` trong `test_competitions_admin.py` và 1 test bound query trong `test_admin_accounts.py`)
- Frontend: 216 (19 files; đợt remediation thêm `api/client.test.ts`, `auth/returnTo.test.ts` và các case trong `App`, `LoginPage`, `RequireAuth`, `SubmissionPage`, `MySubmissionsPage`, `LeaderboardPage`, `AdminAccountsPage`, `AdminCompetition*`, `CompetitionDetailPage`, `MarkdownView`)

## 11. Known issues / technical debt (non-blocking)
- Limiter login process-local theo email (ADR-013): lockout 15 phút nếu kẻ xấu biết email; cần IP companion khi có Cloudflare trusted headers
- Limit 200 cho admin members: vượt 200 dòng sẽ truncate (có hiển thị total); thêm pagination khi quy mô vượt. **Admin accounts đã có phân trang** (`limit=50` mặc định + `offset`, backend bound `1..200`/`>=0`) nên danh sách tài khoản không còn bị cắt ở 200
- Leaderboard vẫn tính full ranking trong bộ nhớ: phù hợp 40-80 người; phân trang chỉ giảm payload/UI, không đổi độ phức tạp query — review nếu vượt quy mô
- Cascade xoá competition không có transaction (Mongo standalone): đã xoá con-trước-cha-sau + test failure injection, nhưng file cleanup chỉ best-effort và có thể báo partial (`files_removed:false`)
- Race nhỏ giữa check `has_completed_submission` và xoá member với một submission đồng thời; backend vẫn enforce membership khi nộp nên không mất điểm đã chấm
- Quota check count-then-insert không transaction; UI quota có thể stale trên nhiều tab — backend 429 vẫn là authority
- Trần upload (`MAX_UPLOAD_MB`/`MAX_CONTENT_MB`/`MAX_ASSET_MB`) là cấu hình **theo môi trường, không lưu theo cuộc thi** (ADR-011); admin detail trả `upload_limits` để UI render hint đúng giá trị đang áp dụng thay vì hardcode, list/public cố ý không mang field này
- UI/UX audit trình duyệt chỉ chạy ở light mode: sản phẩm có chủ đích chỉ có light mode (không dark mode, không `prefers-color-scheme`)
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
