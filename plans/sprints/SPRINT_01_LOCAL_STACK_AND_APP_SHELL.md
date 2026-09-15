# SPRINT 01 - Local Docker Stack and Application Shell

## Mục tiêu
Biến repo thành một hệ thống chạy được local end-to-end bằng Docker Compose:

Browser -> Nginx/React -> `/api` -> FastAPI -> MongoDB

Chưa cần auth/business logic hoàn chỉnh. Sprint này tạo runtime foundation ổn định cho toàn bộ sprint sau.

## Điều kiện bắt đầu
SPRINT_00 hoàn thành và `docs/PROJECT_STATE.md` khớp repo.

## Đọc trước
- canonical docs
- file sprint này
- inspect toàn bộ frontend/backend/docker files hiện có

## Phạm vi
### A. Backend skeleton
Khởi tạo FastAPI tối thiểu:
- app startup/shutdown rõ ràng
- config load từ environment
- Mongo client factory/connection lifecycle
- `GET /api/health`
- structured error helper tối thiểu
- logging config cơ bản

`/api/health` phải cho biết API alive và Mongo reachable theo cách gọn, không expose secret.

Không tạo repository/service layer nhiều tầng nếu chưa cần.

### B. Frontend skeleton
Khởi tạo React + Vite + TypeScript:
- app shell
- router
- API client/wrapper nhỏ dùng relative `/api`
- global design tokens/CSS
- responsive layout cơ bản
- placeholder routes: login, dashboard, competition shell, admin shell

UI target:
- sạch, học thuật, khoảng trắng tốt
- một màu accent chính, status colors có tiết chế
- typography dễ đọc
- không dùng heavy component framework nếu không cần

Placeholder phải ghi rõ feature chưa có, không fake score/data như real.

### C. Nginx
Cấu hình:
- serve frontend static build
- SPA fallback
- reverse proxy `/api/` -> FastAPI
- không expose `/data`
- reasonable upload/body limit baseline, có thể sync config về sau

### D. Docker
Tạo:
- backend Dockerfile
- frontend/web multi-stage build hoặc pattern đơn giản nhất
- `docker-compose.yml`

Services local:
- `web`
- `api`
- `mongo`

`cloudflared` chưa bắt buộc local; nếu khai báo thì dùng profile production/disabled default.

Mongo:
- persistent named volume local
- app user init theo cách reproducible
- KHÔNG publish 27017 ra host trừ khi dev thực sự cần; nếu cần, bind localhost và ghi rõ.

### E. Dev commands
README có lệnh tối thiểu:
- copy env
- build/up
- down
- logs
- backend tests
- frontend build/typecheck

Có thể tạo `Makefile`/scripts nếu làm command gọn hơn; không bắt buộc.

## Environment variables introduced
Tối thiểu document:
- APP_ENV
- APP_NAME
- MONGO_HOST
- MONGO_PORT
- MONGO_DATABASE
- MONGO_APP_USER
- MONGO_APP_PASSWORD
- SESSION_SECRET placeholder for later
- data directory paths

## Acceptance criteria
1. `docker compose up --build` khởi động thành công 3 services.
2. Browser mở app qua web container.
3. `GET /api/health` qua cùng origin trả 200.
4. Health xác nhận Mongo reachable.
5. Frontend build/typecheck pass.
6. Backend smoke/test health pass.
7. MongoDB không public ra Internet.
8. Nginx không serve `/data`.
9. Repo không có credential thật.

## Suggested tests
- Backend health unit/integration nhỏ.
- Mongo unavailable -> health degraded/non-200 theo contract đã chốt.
- Frontend production build.
- `docker compose config`.
- curl thông qua Nginx, không chỉ curl trực tiếp api để xác minh reverse proxy.

## UX deliverable
App shell gồm:
- top header/logo placeholder text
- page container
- navigation skeleton
- loading/error component cơ bản
- 404 route

Không cần làm screenshot-like competition UI đầy đủ ở sprint này.

## Dừng và hỏi nếu
- Port 80/3000/8000 đang bị chiếm và cần đổi convention toàn repo.
- Repo đã có frontend/backend bootstrap khác đáng kể.
- Docker không khả dụng trên máy dev.

## Handoff
Cập nhật:
- exact compose services
- ports internal/external
- dev commands tested
- API health contract
- frontend route skeleton
- next sprint = Sprint 02

## Ngoài phạm vi
- Auth logic.
- Account CRUD.
- Competition data.
- Cloudflare/GCE production.

