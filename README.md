# AI Challenge Platform

Nền tảng AI Challenge dùng chung cho nhiều cuộc thi trên cùng một website. Ban Tổ chức (BTC) tạo competition và cấp tài khoản cho thí sinh; thí sinh đăng nhập, đọc đề bài render từ Markdown, nộp file CSV và nhận điểm F1/Precision/Recall, xem My Submissions và Leaderboard. Server không chạy model của thí sinh — chỉ chấm file kết quả.

## Architecture (một dòng)

React + Vite + TypeScript frontend, FastAPI + Python backend, MongoDB, Nginx same-origin (`/` SPA, `/api` backend) — tất cả trong Docker Compose trên 01 Google Compute Engine VM, public qua Cloudflare Tunnel.

## Current status

**Local stack shell** — Sprint 01 hoàn thành: Docker Compose chạy `web` (Nginx + React SPA), `api` (FastAPI), `mongo`. Có `GET /api/health`. Chưa có auth/nghiệp vụ. Xem `docs/PROJECT_STATE.md`.

## Chạy local (Docker)

```bash
cp .env.example .env          # sửa MONGO_USER/MONGO_PASSWORD thành giá trị thật
docker compose up --build -d  # web: http://localhost:8080
docker compose logs -f api    # xem log
docker compose down           # dừng (giữ volume)
```

- `GET http://localhost:8080/api/health` → 200 khi Mongo reachable, 503 khi không.
- Mongo KHÔNG publish ra host; api chỉ truy cập qua Nginx same-origin.

## Dev không Docker

```bash
# Backend (cần Python 3.12+, khuyến nghị uv)
cd backend && uv venv .venv && uv pip install -e . --group dev
.venv/bin/pytest                       # backend tests
.venv/bin/uvicorn app.main:app --port 8000

# Frontend (cần Node 20+)
cd frontend && npm install
npm run build        # typecheck strict + production build
npm run dev          # dev server (api gọi qua /api — cần proxy riêng khi không dùng Nginx)
```

## Sprint plan & canonical docs

- Sprint plans: `plans/` (bắt đầu từ `plans/sprints/SPRINT_01_LOCAL_STACK_AND_APP_SHELL.md`)
- Trạng thái dự án: `docs/PROJECT_STATE.md`
- Quyết định kiến trúc: `docs/DECISIONS.md`
- Contracts: `docs/API_CONTRACT.md`, `docs/DATA_MODEL.md`

## Lưu ý

- **Không commit `.env`** — repo chỉ chứa `.env.example` với placeholder. Production secret nằm trên server.
- Thư mục `data/` (Markdown, assets, ground truth, submissions, backups) bị gitignore và không bao giờ được serve trực tiếp qua Nginx.
