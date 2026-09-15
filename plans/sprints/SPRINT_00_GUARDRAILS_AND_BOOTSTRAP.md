# SPRINT 00 - Guardrails, Repository Bootstrap, Canonical Project State

## Mục tiêu
Tạo nền móng dự án để các sprint sau có thể tiếp tục an toàn, không mất ngữ cảnh và không bị drift kiến trúc.

Sprint này chưa cần hoàn thiện nghiệp vụ. Mục tiêu là repo có structure rõ, conventions rõ, canonical docs rõ và có thể bắt đầu code mà không phải đoán.

## Đọc trước
- `plans/00_README_FIRST.md`
- `plans/01_MASTER_CONTEXT.md`
- `plans/02_ARCHITECTURE_CONTRACTS.md`
- `plans/03_PROJECT_STATE_TEMPLATE.md`

## Preflight
1. Inspect repo thực tế.
2. Chạy `git status`.
3. Xác định repo là empty, prototype hay đã có code.
4. Nếu đã có code mâu thuẫn với architecture locked, DỪNG và hỏi người dùng trước khi xóa/thay stack.
5. Không xóa file người dùng nếu chưa rõ mục đích.

## Phạm vi
### A. Repository skeleton
Mục tiêu sau sprint:

    frontend/
    backend/
    nginx/
    scripts/
    docs/
    plans/
    .env.example
    .gitignore
    .editorconfig
    README.md

Chỉ tạo folder/file cần thiết; không tạo boilerplate rỗng quá nhiều.

### B. Canonical docs
Tạo:
- `docs/PROJECT_STATE.md`
- `docs/DECISIONS.md`
- `docs/API_CONTRACT.md`
- `docs/DATA_MODEL.md`
- `docs/TEST_MATRIX.md`
- `docs/DEPLOYMENT.md`

Nội dung ban đầu phải phản ánh baseline trong Master Context và Contracts, không viết chi tiết chưa implement như thể đã tồn tại. Đánh dấu rõ `planned` vs `implemented`.

### C. Environment contract
Tạo `.env.example` với placeholder, tối thiểu các nhóm:
- app env/name
- Mongo host/port/database/app user/password
- session secret/lifetime/cookie flags
- upload limit
- data directories
- Cloudflare tunnel token production

Không đưa giá trị secret thật.

### D. Engineering baseline
Chốt convention đơn giản:
- Python formatter/linter/test tool nếu backend đã khởi tạo ở sprint này hoặc ghi planned.
- TypeScript strict mode khi frontend khởi tạo ở Sprint 01.
- Naming: snake_case backend/data, camelCase frontend state, REST path theo một convention thống nhất.
- UTC trong DB; format local timezone ở UI.
- API errors theo contract.

Không cần thêm pre-commit/husky/CI nếu repo chưa cần.

### E. README initial
README phải ngắn, gồm:
- project purpose 5-8 dòng
- architecture một dòng
- current status: bootstrap only
- sprint docs location
- note không commit `.env`

## Decisions cần ghi
Tạo ADR/decision entries tối thiểu:
1. Single GCE VM + Docker Compose.
2. Same-origin frontend/API through Nginx.
3. MongoDB + disk storage split.
4. Server-side sessions, no Firebase Auth.
5. Competition-centric multi-competition model.
6. Markdown content separated from source code.
7. MVP scoring classification CSV only.

## Acceptance criteria
- Repo có structure tối thiểu và không phá code hiện có.
- `.gitignore` loại `.env`, `data/`, local DB/artifact, Python/Node build caches.
- `.env.example` không có secret thật.
- 6 canonical docs tồn tại và rõ `implemented/planned`.
- `PROJECT_STATE.md` ghi `Last completed sprint: SPRINT_00` khi sprint xong.
- `PROJECT_STATE.md` chỉ rõ exact next sprint: Sprint 01.
- Không có business logic giả được viết chỉ để tick box.

## Tests/checks
- `git status` sạch/rõ thay đổi.
- Search repo đảm bảo không có credential/secret hard-code do sprint thêm.
- Validate Markdown docs có links/path đúng.

## Dừng và hỏi nếu
- Repo đã dùng stack khác (Next.js/Django/Postgres...) và người dùng chưa nói có thay hay không.
- Có existing production data/config có nguy cơ bị ghi đè.
- Cần đổi architecture locked.

## Handoff
Cập nhật `docs/PROJECT_STATE.md` với:
- repo structure
- docs created
- decisions locked
- files preserved from old repo
- blockers/technical debt nếu có

## Ngoài phạm vi
- Login.
- Competition CRUD.
- Docker runtime chạy thật.
- Deployment.

