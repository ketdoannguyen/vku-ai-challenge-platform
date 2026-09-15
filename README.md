# AI Challenge Platform

Nền tảng AI Challenge dùng chung cho nhiều cuộc thi trên cùng một website. Ban Tổ chức (BTC) tạo competition và cấp tài khoản cho thí sinh; thí sinh đăng nhập, đọc đề bài render từ Markdown, nộp file CSV và nhận điểm F1/Precision/Recall, xem My Submissions và Leaderboard. Server không chạy model của thí sinh — chỉ chấm file kết quả.

## Architecture (một dòng)

React + Vite + TypeScript frontend, FastAPI + Python backend, MongoDB, Nginx same-origin (`/` SPA, `/api` backend) — tất cả trong Docker Compose trên 01 Google Compute Engine VM, public qua Cloudflare Tunnel.

## Current status

**Bootstrap only** — Sprint 00 hoàn thành. Chưa có code nghiệp vụ, chưa có runtime. Xem `docs/PROJECT_STATE.md` để biết chính xác cái gì đã có.

## Sprint plan & canonical docs

- Sprint plans: `plans/` (bắt đầu từ `plans/sprints/SPRINT_01_LOCAL_STACK_AND_APP_SHELL.md`)
- Trạng thái dự án: `docs/PROJECT_STATE.md`
- Quyết định kiến trúc: `docs/DECISIONS.md`
- Contracts: `docs/API_CONTRACT.md`, `docs/DATA_MODEL.md`

## Lưu ý

- **Không commit `.env`** — repo chỉ chứa `.env.example` với placeholder. Production secret nằm trên server.
- Thư mục `data/` (Markdown, assets, ground truth, submissions, backups) bị gitignore và không bao giờ được serve trực tiếp qua Nginx.
