# AI Challenge Platform - Decision Log

Format theo ADR. Chỉ ghi quyết định có ảnh hưởng về sau; thay decision cũ thì đánh dấu superseded và link decision mới, không xóa lịch sử.

## ADR-001 - Single GCE VM + Docker Compose
- Date: 2026-09-15
- Status: accepted
- Context: MVP phục vụ 40-80 đội; cần chi phí và vận hành tối thiểu.
- Decision: Toàn bộ runtime trên 01 Google Compute Engine VM (Ubuntu Server LTS), điều phối bằng Docker Compose. Không Kubernetes, không multi-VM, không Cloud Run.
- Consequences: Đơn giản, rẻ, dễ backup cả VM/disk. Không HA — chấp nhận được cho MVP.
- Affected files/contracts: `plans/01_MASTER_CONTEXT.md` §3, `docs/DEPLOYMENT.md`

## ADR-002 - Same-origin frontend/API through Nginx
- Date: 2026-09-15
- Status: accepted
- Context: Tránh phức tạp CORS và expose backend trực tiếp ra public.
- Decision: Nginx là reverse proxy duy nhất: `/` → React SPA (static + fallback), `/api/` → FastAPI container. Không map `/data` ra web.
- Consequences: Không cần CORS production; một public origin qua Cloudflare Tunnel.
- Affected files/contracts: `plans/02_ARCHITECTURE_CONTRACTS.md` §2, `docs/API_CONTRACT.md` §1

## ADR-003 - MongoDB cho nghiệp vụ, persistent disk cho files
- Date: 2026-09-15
- Status: accepted
- Context: Cần lưu dữ liệu có cấu trúc (accounts, competitions, submissions) và files (Markdown, assets, ground truth, submissions CSV, backups).
- Decision: MongoDB lưu toàn bộ dữ liệu nghiệp vụ; files nằm trên persistent disk theo layout `/data/competitions/<id>/...` và `/data/submissions/<id>/...`. Không external object storage ở MVP.
- Consequences: Backup phải cover cả Mongo dump lẫn `/data`. Private files (ground truth, scoring config) tuyệt đối không được Nginx serve.
- Affected files/contracts: `plans/01_MASTER_CONTEXT.md` §11-12, `docs/DATA_MODEL.md`

## ADR-004 - Server-side sessions, no Firebase Auth
- Date: 2026-09-15
- Status: accepted
- Context: Tài khoản do BTC cấp, no self-registration; cần kiểm soát đầy đủ và đơn giản.
- Decision: Auth = account trong MongoDB + Argon2id password hash + server-side session. Transport bằng cookie HttpOnly + Secure (production) + SameSite. Session token là opaque random, entropy cao; DB lưu hash của token. Không Firebase/Firestore/OAuth ở MVP.
- Consequences: Restart backend không mất session (lưu DB). Cần TTL index dọn session hết hạn.
- Affected files/contracts: `plans/01_MASTER_CONTEXT.md` §3, §13; `plans/02_ARCHITECTURE_CONTRACTS.md` §6

## ADR-005 - Competition-centric multi-competition model
- Date: 2026-09-15
- Status: accepted
- Context: Một website chạy nhiều cuộc thi; không hard-code từng mùa thi.
- Decision: `competition` là entity trung tâm; mọi dữ liệu nghiệp vụ (memberships, content, submissions, scoring config, ground truth path, leaderboard, export) đều gắn `competition_id`. Không hard-code tên competition vào logic.
- Consequences: Mọi query/API phải scope theo competition; adding competition mới không cần deploy.
- Affected files/contracts: `plans/01_MASTER_CONTEXT.md` §5, `docs/DATA_MODEL.md`

## ADR-006 - Markdown content tách khỏi source code
- Date: 2026-09-15
- Status: accepted
- Context: Đề bài/rules thay đổi theo từng competition, do BTC quản lý, không nên đổi code mỗi kỳ thi.
- Decision: Markdown lưu trên disk (`/data/competitions/<id>/content/`), metadata (title, slug, order, visibility, markdown_path) lưu trong `competition_contents`. Frontend render GFM có sanitize; asset chỉ lấy từ thư mục assets của competition, cấm path traversal.
- Consequences: Cần validate path khi đọc file; HTML nguy hiểm phải sanitize/disable.
- Affected files/contracts: `plans/01_MASTER_CONTEXT.md` §9, §11; `plans/02_ARCHITECTURE_CONTRACTS.md` §8

## ADR-007 - MVP scoring: classification CSV only
- Date: 2026-09-15
- Status: accepted
- Context: MVP chỉ cần chấm bài phân loại bằng F1/Precision/Recall; schema khác sẽ xuất hiện ở các kỳ thi sau.
- Decision: Submission chỉ nhận `.csv`. Scoring engine hỗ trợ classification với config: `id_column`, `prediction_column`, `label_column`, `average` (binary/macro/weighted), `pos_label`, `primary_metric`, `higher_is_better=true`. Align theo ID, `zero_division=0`. Leaderboard lấy best valid submission mỗi account.
- Consequences: Nếu kỳ thi thực tế cần schema/scoring khác, phải dừng và hỏi người dùng trước khi mở rộng engine.
- Affected files/contracts: `plans/01_MASTER_CONTEXT.md` §10, `plans/02_ARCHITECTURE_CONTRACTS.md` §9-10

## ADR-008 - Session representation & per-request resolution
- Date: 2026-09-15
- Status: accepted
- Context: ADR-004 chốt server-side session, DB lưu hash token, nhưng chưa chốt chi tiết representation và luồng resolve.
- Decision: Session `_id` = sha256 hex của raw token `secrets.token_urlsafe(32)`; `account_id` là ObjectId khớp `accounts._id`. Mọi request đi qua middleware resolve session → account (check `expires_at` + `active`) và gắn vào `request.state.account`; dependency `get_current_account`/`get_current_admin` chỉ đọc state đó. TTL index trên `expires_at` là cơ chế dọn dẹp, không phải cơ chế enforcement.
- Consequences: Disable account có hiệu lực tức thì với mọi session hiện có. Login sai email và sai password trả cùng response 401 generic. Không log raw token/password. `SESSION_SECRET` hiện không dùng (token opaque, không cần ký).
- Affected files/contracts: `docs/DATA_MODEL.md` §2, `docs/API_CONTRACT.md` §2, `backend/app/auth/`
