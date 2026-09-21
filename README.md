# AI Challenge Platform

Nền tảng AI Challenge dùng chung cho nhiều cuộc thi trên cùng một website. Ban Tổ chức (BTC) tạo competition và cấp tài khoản cho thí sinh; thí sinh đăng nhập, đọc đề bài render từ Markdown, nộp file CSV và nhận điểm F1/Precision/Recall, xem My Submissions và Leaderboard. Server không chạy model của thí sinh - chỉ chấm file kết quả.

## Architecture (một dòng)

React + Vite + TypeScript frontend, FastAPI + Python backend, MongoDB, Nginx same-origin (`/` SPA, `/api` backend) - tất cả trong Docker Compose trên 01 Google Compute Engine VM, public qua Cloudflare Tunnel.

## Current status

**Release candidate** - Sprint 07 hoàn thành: toàn bộ MVP flow (login → competition → join → Markdown → submit → scoring → history → leaderboard → export) chạy được, kèm hardening: login rate limiting, error contract ổn định, audit log an toàn, security headers + CSP enforce + HSTS (ADR-034), admin UX hoàn thiện. Production deploy thuộc Sprint 08. Xem `docs/PROJECT_STATE.md`.

## Chạy local (Docker)

Một lệnh duy nhất để test thủ công - tự tạo `.env`, up stack, chờ healthy, seed admin + 2 participant mẫu (idempotent), smoke test login qua Nginx, in tài khoản test:

```bash
./scripts/dev_up.sh           # up + seed + smoke test → http://localhost:8080
./scripts/dev_up.sh --down    # dừng, giữ account
./scripts/dev_up.sh --clean   # xóa sạch volume (mất hết account test)
```

User không có group docker thì script tự dùng `sudo docker` (hoặc fix một lần: `sudo usermod -aG docker nkd` + re-login).

Làm thủ công nếu muốn:

```bash
cp .env.example .env          # sửa MONGO_USER/MONGO_PASSWORD thành giá trị thật
docker compose up --build -d  # web: http://localhost:8080
docker compose logs -f api    # xem log
docker compose down           # dừng (giữ volume)
```

- `GET http://localhost:8080/api/health` → 200 khi Mongo reachable, 503 khi không.
- Mongo KHÔNG publish ra host; api chỉ truy cập qua Nginx same-origin.

## Bootstrap tài khoản (cần Mongo đang chạy)

```bash
cd backend
.venv/bin/python scripts/create_admin.py <email> <name> <password>        # admin đầu tiên
.venv/bin/python scripts/import_accounts.py <file.csv>                    # participant hàng loạt
```

CSV format: header `email,name,password` - mỗi dòng một account. Duplicate email được báo rõ và bỏ qua (không ghi đè).

## Dev không Docker

```bash
# Backend (cần Python 3.12+, khuyến nghị uv)
cd backend && uv venv .venv && uv pip install -e . --group dev
.venv/bin/pytest                       # backend tests
.venv/bin/uvicorn app.main:app --port 8000

# Frontend (cần Node 20+)
cd frontend && npm install
npm test            # vitest + testing-library
npm run build       # typecheck strict + production build
npm run dev         # dev server; /api được proxy sẵn về http://localhost:8080 (Nginx của compose)
                    # cần stack đang chạy; đổi target bằng VITE_API_PROXY_TARGET=http://localhost:8000
```

## Sprint plan & canonical docs

- Sprint plans: `plans/` (bắt đầu từ `plans/sprints/SPRINT_01_LOCAL_STACK_AND_APP_SHELL.md`)
- Trạng thái dự án: `docs/PROJECT_STATE.md`
- Quyết định kiến trúc: `docs/DECISIONS.md`
- Contracts: `docs/API_CONTRACT.md`, `docs/DATA_MODEL.md`, `docs/TEST_MATRIX.md`
- Production deploy: `docs/DEPLOYMENT.md`

## Lưu ý

- **Không commit `.env`** - repo chỉ chứa `.env.example` với placeholder. Production secret nằm trên server.
- Thư mục `data/` (Markdown, assets, ground truth, submissions, backups) bị gitignore và không bao giờ được serve trực tiếp qua Nginx.
