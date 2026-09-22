# Deployment - AI Challenge Platform

Status: **Sprint 08** - backend/MongoDB/Nginx chạy trên GCE bằng `docker-compose.prod.yml`, public
tạm qua Cloudflare **Quick Tunnel**; frontend đã có thêm public entry trên **Cloudflare Workers
Static Assets** (ADR-025). Đường deploy tự động (`release` → Actions deploy Worker + timer kéo về VM,
ADR-026) **đã bật trên production** và đã có lượt deploy thật qua timer - xem §5-§7. MinIO thì **chưa**
bootstrap trên VM, nên release đầu tiên chạm artifact backend sẽ bị preflight dừng lại (§3.1, §12).

## 1. Kiến trúc và nguyên tắc same-origin

### Đang chạy (fallback, luôn giữ được)

```
USER → https://<random>.trycloudflare.com   (Quick Tunnel, URL đổi mỗi lần restart)
       └→ cloudflared → web:80 (Nginx) ─┬→ /            → React SPA (static + SPA fallback)
                                        └→ /api/*       → api:8000 (FastAPI) ─┬→ mongo:27017
                                                                              └→ minio:9000 (nội bộ)
```

### Sau khi rollout Workers (ADR-025)

```
USER → Cloudflare Worker `vku-ai-challenge-platform`   (workers.dev hoặc custom domain)
       ├→ /api/*  → Worker proxy → API_ORIGIN
       │            = https://origin-api.<DOMAIN>  (Named Tunnel)
       │            → cloudflared → web:80 (Nginx) → api:8000 ─┬→ mongo:27017
       │                                                       └→ minio:9000 (nội bộ)
       └→ còn lại → Static Assets trên Cloudflare CDN (+ SPA fallback cho route con)
```

Nguyên tắc bắt buộc - đổi kiến trúc nào cũng phải giữ:

- Browser chỉ thấy **một** origin. Frontend luôn gọi `` fetch(`/api${path}`, { credentials: "same-origin" }) ``;
  không có URL tuyệt đối, không `credentials: "include"`, không CORS, không JWT, không token trong
  `localStorage`.
- Cookie phiên `aic_session` là **host-only** (`HttpOnly`, `Secure` ở production, `SameSite=Lax`,
  không có thuộc tính `Domain`). Hệ quả: session gắn với đúng hostname đã đăng nhập - đổi public
  origin là phải đăng nhập lại, và chỉ nên có một public origin cho người dùng thật tại một thời điểm.
- `API_ORIGIN` là **runtime variable của Worker**, không phải biến `VITE_*`: nó chỉ tồn tại ở phía
  server Worker. Tuyệt đối không đặt `API_ORIGIN` bằng public hostname của chính app (proxy loop).
- `origin-api.<DOMAIN>` trỏ vào `web:80` (Nginx) chứ không vào `api:8000`: giữ nguyên giới hạn body
  32m, header bảo mật và hành vi cookie hiện có của Nginx.
- MinIO (`minio:9000`) chỉ nằm trong Docker network nội bộ, **không** đi qua Worker, tunnel hay Nginx:
  mọi lượt tải artifact đều là `/api/*` (ADR-028).

## 2. Provision VM (một lần)

```bash
# Trên VM, qua SSH key-only (tài khoản có NOPASSWD sudo, KHÔNG thêm vào group docker).
sudo apt-get update && sudo apt-get -y upgrade
sudo reboot   # bắt buộc nếu apt báo libc6/reboot-required

# Docker Engine + Compose plugin từ repo chính thức
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo mkdir -p /srv/vku-ai-challenge/{repo,data/app,data/mongo,data/minio,backups}
sudo chown -R 999:999 /srv/vku-ai-challenge/data/mongo   # UID của user mongodb trong image
sudo chmod 700 /srv/vku-ai-challenge/backups
# data/minio: image MinIO chạy bằng root (UID 0) nên chỉ cần thư mục tồn tại và ghi được - không chown.
```

Không cần cài Python, pip, Node, Nginx hay cloudflared trên host - tất cả chạy trong container.

Layout trên VM:

```
/srv/vku-ai-challenge/
├── .env          # secret thật, mode 0600
├── repo/         # checkout detached tại release SHA
├── data/app/     # upload của app (mount vào /data của api)
├── data/mongo/   # dbpath (mount vào /data/db của mongo)
├── data/minio/   # dữ liệu MinIO (mount vào /data của minio) - artifact submission, ADR-028
└── backups/      # backup hằng ngày, mode 0700
```

## 3. Cấu hình env

```bash
sudo install -m 600 -o root -g root \
  /srv/vku-ai-challenge/repo/deploy/production.env.example /srv/vku-ai-challenge/.env
sudo nano /srv/vku-ai-challenge/.env
```

Sinh secret (không dán vào chat/log/repo):

```bash
openssl rand -hex 24    # -> MONGO_PASSWORD, MINIO_ROOT_PASSWORD, MINIO_SECRET_KEY (mỗi biến một lần)
```

| Biến | Ý nghĩa |
|---|---|
| `PROD_DATA_ROOT` | Thư mục dữ liệu trên host (`/srv/vku-ai-challenge/data`) |
| `MONGO_USER` / `MONGO_PASSWORD` | Credential Mongo; compose fail-fast nếu thiếu |
| `MONGO_DATABASE` | Mặc định `ai_challenge` |
| `SESSION_LIFETIME_HOURS` / `SESSION_COOKIE_NAME` | Vòng đời và tên cookie phiên |
| `SESSION_COOKIE_SECURE` / `SESSION_COOKIE_SAMESITE` | `auto` + `lax`; `auto` bật `Secure` khi `APP_ENV=production` |
| `MAX_UPLOAD_MB` / `MAX_CONTENT_MB` / `MAX_ASSET_MB` | Giới hạn dung lượng |
| `MAX_NOTEBOOK_MB` | Trần notebook `.ipynb` mỗi lượt nộp (mặc định 20) |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | Credential root của MinIO - **chỉ** service `minio` và `minio-init` nhận |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | Credential app của MinIO - **chỉ** `api` và lệnh backup nhận |
| `MINIO_BUCKET` | Mặc định `submission-artifacts` |
| `APP_NAME` | Tên hiển thị |
| `CLOUDFLARE_TUNNEL_TOKEN` | Chỉ dùng khi chạy kèm `deploy/docker-compose.tunnel.named.yml` (§6). Để trống với Quick Tunnel |
| `LLM_CONFIG_ENCRYPTION_KEY` + nhóm `AI_REVIEW_*` | **Tuỳ chọn**, xem §3.2. Thiếu hết vẫn deploy và chạy bình thường |

`APP_ENV=production`, `DATA_DIR=/data` và `MONGO_HOST=mongo` do compose đặt cứng, không khai trong `.env`.
`SESSION_SECRET` trong `.env.example` là config chết (ADR-008) - không dùng, không cần sinh.

`.env` chỉ vào Compose qua `--env-file`, **không** mount vào container. Settings của backend bỏ qua
khoá lạ, nên `env_file:` sẽ không làm API chết; lý do không dùng là quyền tối thiểu - `.env` chứa
credential của thành phần khác (`MONGO_*`, `CLOUDFLARE_TUNNEL_TOKEN`) và biến chỉ dành cho Compose,
không nên có mặt trong tiến trình API. Vì vậy `TUNNEL_TOKEN` chỉ được truyền cho service `cloudflared`
trong file override, không truyền cho `api`.

Kiểm tra cú pháp compose mà không in secret:

```bash
cd /srv/vku-ai-challenge/repo
sudo docker compose --env-file /srv/vku-ai-challenge/.env \
  -f docker-compose.prod.yml config --quiet && echo OK
```

Không chạy `docker compose config` rồi lưu/chia sẻ output đầy đủ - kết quả nội suy có chứa secret.

### 3.2 Nhóm AI Notebook Review (ADR-036/ADR-037) - tuỳ chọn

Toàn bộ nhóm này đọc bằng `${VAR:-}` trong `docker-compose.prod.yml`, **không** phải `${VAR:?}`: để
trống thì stack vẫn lên đủ, nộp bài vẫn chấm điểm và xếp hạng bình thường - chỉ tính năng AI là không
bật được. Đây là điều kiện để một sự cố cấu hình AI không bao giờ chặn deploy.

| Biến | Ý nghĩa |
|---|---|
| `LLM_CONFIG_ENCRYPTION_KEY` | Khoá Fernet mã hoá API key provider lưu trong Mongo. Rỗng = không lưu được key, nên không bật được AI. Sinh bằng `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `AI_REVIEW_ALLOWED_PRIVATE_HOSTS` | Mở cho host nội bộ, khớp **chính xác**. **Chỉ dùng khi phát triển** với provider tự dựng |
| `AI_REVIEW_ALLOWED_HTTP_HOSTS` | Cho phép `http://` thay vì bắt buộc `https://`. **Chỉ dùng khi phát triển** |
| `AI_REVIEW_ALLOWED_PORTS` | Mặc định `443` |
| `AI_REVIEW_POLL_INTERVAL_SECONDS` / `AI_REVIEW_LEASE_SECONDS` / `AI_REVIEW_HEARTBEAT_SECONDS` | Nhịp của worker. **`HEARTBEAT` bắt buộc nhỏ hơn `LEASE`**, nếu không worker thoát mã 2 ngay lúc khởi động |
| `AI_REVIEW_MAX_ATTEMPTS` / `AI_REVIEW_CONNECT_TIMEOUT_SECONDS` / `AI_REVIEW_REQUEST_TIMEOUT_SECONDS` | Trần retry và timeout gọi provider |
| `AI_REVIEW_MAX_OUTPUT_TOKENS` | Ngân sách output của **một** lượt review (ADR-039), mặc định `8000`. Trần này là của mình, không phải giới hạn của model: đặt thấp hơn nhu cầu thật thì câu trả lời bị cắt giữa chừng và lượt đó hỏng với `AI_OUTPUT_TRUNCATED`. Tăng khi đổi sang model dài dòng hơn |

Cấu hình **provider** (Base URL, model, API key) **không** nằm trong `.env`: nó do admin nhập ở tab
`Cài đặt` của cuộc thi và lưu trong Mongo, dưới dạng ciphertext. Đổi máy chủ thì phải nhập lại key;
đổi `LLM_CONFIG_ENCRYPTION_KEY` sau khi đã lưu key làm ciphertext cũ không giải mã được.

Từ ADR-037 **không còn allowlist host**: admin trỏ provider tới bất kỳ hostname/IP công khai nào ngay
trong tab `Cài đặt`, không cần khai `.env` và không cần restart service. Vẫn bị chặn: host phân giải
vào dải private/loopback/link-local/metadata, port ngoài `AI_REVIEW_ALLOWED_PORTS`, và `http://` trên
production. Thứ thay cho allowlist là ô **xác nhận chuyển dữ liệu** theo từng host - admin phải nói rõ
notebook của thí sinh sẽ đi tới đâu trước khi bật AI.

Hai host ở `AI_REVIEW_ALLOWED_PRIVATE_HOSTS`/`_HTTP_HOSTS` chỉ nên có mặt trên môi trường phát triển;
đây là danh sách **mở khoá**, nên một entry ở đây nới rộng biên chứ không thu hẹp nó.

### 3.1 MinIO: bootstrap bucket và credential (ADR-028)

Artifact của submission (CSV dự đoán + notebook) nằm trong MinIO private, không có route Nginx, không
publish port, không console public, không presigned URL - mọi lượt tải đi qua FastAPI.

Object key đọc được bằng mắt (ADR-033): `competitions/<slug cuộc thi>/accounts/<slug đội>/submissions
/submission-NNNN/<prediction.csv|notebook.ipynb>`, nên `mc ls` bucket là đủ để biết object thuộc cuộc
thi/đội nào mà không phải tra Mongo. Bài nộp trước ADR-033 vẫn nằm dưới prefix theo ObjectId
(`competitions/<id>/accounts/<id>/submissions/<id>/`) - hai layout cùng tồn tại, không có migration.

Hai service mới trong `docker-compose.prod.yml`, **không** nằm trong cơ chế override theo SHA:

| Service | Vai | Ghi chú |
|---|---|---|
| `minio` | server, giữ dữ liệu ở `${PROD_DATA_ROOT}/minio` | image pin theo tag; healthcheck `mc ready local` |
| `minio-init` | one-shot: tạo bucket private + app user + policy | chỉ service này (cùng `minio`) nhận credential root |

Credential tách đôi theo vai (ADR-028): `MINIO_ROOT_*` chỉ vào `minio`/`minio-init`; `MINIO_ACCESS_KEY`
/`MINIO_SECRET_KEY` chỉ vào `api` và lệnh backup. Policy của app user chỉ cho bucket stat/list +
object get/put/delete trên đúng bucket này.

Chuẩn bị thư mục dữ liệu **trước** lần `up` đầu tiên (image chạy bằng root nên chỉ cần thư mục tồn tại
và ghi được):

```bash
sudo mkdir -p /srv/vku-ai-challenge/data/minio
```

Bootstrap (chạy một lần, và chạy lại mỗi khi xoay credential app):

```bash
cd /srv/vku-ai-challenge/repo
sudo docker compose --env-file /srv/vku-ai-challenge/.env \
  -f docker-compose.prod.yml up -d minio minio-init
sudo docker compose --env-file /srv/vku-ai-challenge/.env \
  -f docker-compose.prod.yml ps -a minio minio-init     # minio: healthy, minio-init: Exited (0)
```

`minio-init` idempotent: tạo/ghi đè bucket, policy và app user rồi thoát. Exit code khác 0 nghĩa là
bucket **chưa** sẵn sàng - đừng deploy tiếp.

Kiểm chứng bucket private + quyền của app user trên một Compose project cô lập (không cần `.env`,
không chạm stack production):

```bash
./scripts/minio_smoke.sh
```

Script dựng đúng hai service trên với credential sinh tại chỗ, kiểm anonymous bị từ chối ở cả list
lẫn GET, app credential put/get/delete được, và byte round-trip khớp - rồi `down -v` đúng project của nó.

Đổi `MINIO_SECRET_KEY` trong `.env` thì phải chạy lại `minio-init` (lệnh `up -d minio minio-init` ở
trên) rồi tạo lại container `api` để nó nhận credential mới.

## 4. Phát triển và kiểm thử ở local

### Frontend

```bash
cd frontend
npm ci
npm run lint          # oxlint
npm test              # vitest (jsdom)
npm run build         # tsc -b && vite build -> dist/
npm run cf:dry-run    # wrangler deploy --dry-run, phải chạy SAU npm run build
```

`npm run cf:dry-run` cần `dist/` tồn tại vì `wrangler.jsonc` đặt `assets.directory: ./dist`; chạy
trước `npm run build` sẽ báo không tìm thấy thư mục assets.

`npm test` chạy song song nhiều worker; nếu thấy test flake ở `CompetitionDetailPage.test.tsx`,
chạy lại tuần tự để có kết quả xác định:

```bash
npx vitest run --maxWorkers 1
```

Dev server (giữ nguyên như trước, không liên quan Workers):

```bash
npm run dev           # Vite :5173, proxy /api -> http://localhost:8080 (Nginx của compose dev)
```

Muốn chạy thử chính Worker ở local: build `dist/` trước, tạo `frontend/.dev.vars` (đã ignore, không
commit) với `API_ORIGIN=http://localhost:8080`, rồi:

```bash
npx wrangler dev
```

### Backend

```bash
cd backend
uv run pytest
```

### Bất biến phải giữ khi sửa frontend

- `src/api/client.ts` không đổi: URL tương đối `/api...`, `credentials: "same-origin"`.
- Không thêm biến `VITE_*` nào chứa địa chỉ backend.
- `src/markdown/resolveMarkdownAssetUrl.ts` trả path tương đối `/api/competitions/...` - giữ nguyên.

## 5. Deploy frontend lên Cloudflare Workers

### 5.1 Deploy tự động bằng GitHub Actions

`.github/workflows/deploy-worker.yml` là **cơ chế deploy Worker duy nhất** (ADR-026). **Không** bật
thêm Workers Builds trong Dashboard: hai đường deploy cùng ghi vào một Worker sẽ tranh nhau version và
làm mất provenance của Git SHA.

| Trigger | Điều kiện | Kết quả |
|---|---|---|
| `push` vào `release` | có file đổi trong `frontend/**` hoặc chính file workflow | chạy gate frontend rồi deploy |
| `workflow_dispatch` | bấm tay trên nhánh bất kỳ | deploy lại đúng commit đang có (break-glass) |
| PR vào `release` | mọi PR | **chỉ** chạy `release-gate`; không deploy |

Trình tự trong job deploy: kiểm tra cấu hình (thiếu secret thì fail **trước** khi đụng production) →
`npm ci` → `lint` → `vitest` → `build` → đọc version đang nhận traffic → `wrangler deploy --keep-vars
--tag release-<sha12> --message "release <sha>"` → smoke tĩnh → rollback nếu smoke tĩnh fail. Gate được
lặp lại ngay trước deploy vì push thẳng vào `release` không đi qua PR.

Cấu hình một lần trên GitHub (Settings → Environments → `production`):

| Loại | Tên | Giá trị |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Token tối thiểu quyền **Workers Scripts: Edit** (My Profile → API Tokens) |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | `793cbf09a7355d16f35bac9abccd5fc4` |
| Variable | `WORKER_URL` | `https://vku-ai-challenge-platform.ketdoannguyen.workers.dev` |

- Giới hạn deployment branch của environment `production` là `release` để secret không dùng được từ
  nhánh khác.
- Branch protection của `release` đặt required check `release-gate / frontend`, `release-gate / backend`
  và `release-gate / deploy-script`. Đổi `name:` của workflow hoặc của job sẽ làm check cũ không bao giờ
  xanh lại và **chặn mọi PR vào `release`** - đổi tên thì phải cập nhật branch protection cùng lúc.
  **[Kiểm 2026-09-19: chưa bật - `gh api .../branches/release/protection` trả `Branch not protected`,
  và `main` cũng vậy.]** Hiện chỉ workflow tự chạy gate; GitHub không chặn push thẳng vào `release`,
  nên quy tắc "không push thẳng" dựa hoàn toàn vào quy trình. Bật protection là thao tác một lần trên
  GitHub, không phải việc của code.
- Access policy của Worker phải **OFF**: bật Cloudflare Access sẽ chặn cả người dùng cuối.
- Token **không** bao giờ dán vào chat/log/issue. Nghi ngờ lộ thì thu hồi ngay (My Profile → API
  Tokens → Revoke) rồi tạo token mới - token cũ đã lộ thì mọi thứ khác đều vô nghĩa.

Smoke tĩnh của workflow chỉ kiểm `/` và một deep link SPA phải trả `200` + `text/html`. `/api/health`
trong workflow chỉ là **diagnostic**: `API_ORIGIN` đi qua tunnel nên tunnel chết làm API lỗi trong khi
static vẫn khoẻ, và rollback Worker không sửa được tunnel - vì vậy nó không bao giờ được dùng để quyết
định rollback.

### 5.2 Runtime variable `API_ORIGIN`

Dashboard → Worker → Settings → Variables and Secrets → **Plaintext**:

| Tên | Giá trị |
|---|---|
| `API_ORIGIN` | `https://origin-api.<DOMAIN>` - hostname Named Tunnel ở §6, KHÔNG có `/api`, KHÔNG có dấu `/` cuối |

Quy tắc:

- Đây là **runtime variable**, không phải build variable và không phải `VITE_*`. Giá trị chỉ được
  Worker đọc ở phía server nên browser không bao giờ thấy địa chỉ backend.
- Không khai `API_ORIGIN` trong `wrangler.jsonc`: biến trong file sẽ ghi đè giá trị đặt ngoài file ở
  mỗi lần deploy. `keep_vars: true` trong file giữ nguyên runtime variable qua các lần deploy - **đã
  kiểm chứng thật**: deploy lại bằng `npx wrangler deploy` không kèm `--var`, `/api/health` vẫn `200`
  (nếu binding mất, Worker sẽ fail closed và trả `500`). Lưu ý `keep_vars` **không** làm điều đó thành
  vĩnh viễn: nó chỉ giữ biến không bị xoá khi deploy; vẫn nên đặt qua Dashboard để có chỗ xem lại.
- Cách đặt nhanh không cần Dashboard (dùng khi CI/CLI):
  `npx wrangler deploy --var API_ORIGIN:https://origin-api.<DOMAIN>`; các lần deploy sau không cần lặp
  lại `--var` nhờ `keep_vars`.
- **Không** đặt bằng public hostname của chính app (ví dụ `https://app.example.com`) - Worker sẽ gọi
  lại chính nó và tạo vòng lặp proxy. Worker chủ động từ chối cấu hình này (trả `500`).
- Trong lúc chưa có domain, có thể dùng tạm hostname Quick Tunnel (`https://<random>.trycloudflare.com`)
  làm `API_ORIGIN`. Nhược điểm: URL này **đổi mỗi lần `cloudflared` restart**, khi đó phải sửa lại
  runtime variable và chờ deploy mới nhất áp dụng (không cần build lại).
- Thiếu hoặc sai `API_ORIGIN` thì Worker trả `500` với body `{"error":{"code":"INTERNAL_ERROR",...}}`
  và **không** gọi upstream - fail closed, không lộ giá trị cấu hình.

### 5.3 Deploy thủ công (break-glass)

```bash
cd frontend
npm ci
npm run build
npm run cf:dry-run        # bắt buộc: kiểm tra config + assets trước khi đẩy thật
npx wrangler login        # hoặc export CLOUDFLARE_API_TOKEN (token KHÔNG commit, KHÔNG dán vào chat)
npx wrangler deploy
```

Lần deploy **đầu tiên** sẽ tạo Worker nếu tài khoản chưa có Worker tên đó (`wrangler deploy` không
hỏi lại); các lần sau cập nhật đúng Worker đang có. Nhờ `keep_vars: true` và việc `API_ORIGIN` chỉ
nằm ngoài `wrangler.jsonc`, deploy không ghi đè origin.

### 5.4 Kiểm tra sau deploy

```bash
curl -sI https://<public-host>/            # 200 + 5 header bảo mật ở §8.5
curl -fsS https://<public-host>/api/health # {"status":"ok","mongo":"reachable"}
curl -sI https://<public-host>/assets/<tên-file-có-hash>.js  # Cache-Control: immutable
```

Kết quả của bản deploy đã chạy (để đối chiếu khi lần sau lệch):

| Kiểm tra | Kết quả đúng |
|---|---|
| `/` | `200`, đủ 5 header bảo mật |
| `/competitions/<slug>` (deep link SPA) | `200` + `index.html`, không phải `404` |
| `/api/health` | `200` `{"status":"ok","mongo":"reachable"}` |
| `/api/auth/me` khi chưa đăng nhập | `401` `{"error":{"code":"UNAUTHORIZED",...}}` |
| `/api/khong-ton-tai` | `404` JSON của FastAPI, **không** phải HTML của SPA |
| `/assets/<hash>.js` | `Cache-Control: public, max-age=31536000, immutable` |
| `/data/bat-ky` | `200` + HTML của SPA - đúng như ADR-025 mô tả, không phải rò rỉ dữ liệu |

`_headers` được Wrangler **đọc làm cấu hình**, không được upload như một asset: `--dry-run` liệt kê
`dist/_headers` trong input nhưng danh sách asset đẩy lên không có nó, còn response thật thì có đủ 5
header. Đừng đi tìm `_headers` trong danh sách file đã upload - không thấy là đúng.

## 6. Cloudflare Tunnel: Quick → Named

Chỉ đổi tầng tunnel trên VM, không đụng tới Worker, backend hay dữ liệu. Base stack Quick Tunnel
không bị sửa nên luôn quay lại được.

**Điều kiện:** đã có domain trong Cloudflare (nameserver do Cloudflare quản lý).

1. Zero Trust Dashboard → Networks → Tunnels → **Create a tunnel** → chọn `Cloudflared` → đặt tên
   (ví dụ `vku-challenge-prod`) → copy **token** ở bước Install connector.
2. Trong tunnel vừa tạo, thêm **Public Hostname**: subdomain `origin-api`, domain `<DOMAIN>`, service
   `http://web:80`. Không bật Access cho hostname này (Worker gọi vào bằng HTTP, không qua browser).
3. Trên VM, thêm token vào `.env` (file đã `chmod 600`, không commit):

```bash
sudo nano /srv/vku-ai-challenge/.env      # CLOUDFLARE_TUNNEL_TOKEN=<token>
```

4. Chạy lại **chỉ** service `cloudflared` với override additive:

```bash
cd /srv/vku-ai-challenge/repo
sudo docker compose --env-file /srv/vku-ai-challenge/.env \
  -f docker-compose.prod.yml -f deploy/docker-compose.tunnel.named.yml \
  up -d cloudflared
```

Override thay **toàn bộ** `command` (bỏ `--url http://web:80` vì ingress giờ do Dashboard quản lý),
giữ `--metrics 127.0.0.1:20241` nên healthcheck kế thừa từ base vẫn dùng được. Token chỉ được truyền
cho `cloudflared`, không truyền cho `api`.

5. Kiểm tra:

```bash
sudo docker compose --env-file /srv/vku-ai-challenge/.env \
  -f docker-compose.prod.yml -f deploy/docker-compose.tunnel.named.yml ps   # cloudflared healthy
curl -fsS https://origin-api.<DOMAIN>/api/health             # {"status":"ok",...}
curl -sI  https://origin-api.<DOMAIN>/ | head -n 8           # 5 header bảo mật
```

6. Cập nhật `API_ORIGIN` của Worker thành `https://origin-api.<DOMAIN>` (§5.2) rồi chạy lại §8.
7. Quay về Quick Tunnel: chạy `up -d cloudflared` chỉ với `docker-compose.prod.yml`, rồi trỏ
   `API_ORIGIN` về hostname trycloudflare mới.

Đổi public origin làm cookie phiên cũ vô hiệu (cookie host-only): mọi người dùng phải đăng nhập lại,
đó là hành vi mong đợi chứ không phải lỗi.

## 7. Deploy một release (backend + Nginx)

### 7.1 Đường tự động: push vào `release`

`release` là cổng duy nhất: push vào `release` nghĩa là "đưa commit này lên production". Một lần push
cập nhật **cả hai phía**, và hai phía deploy độc lập chứ không phải một giao dịch nguyên tử - Worker
thường lên trước vì build image chậm hơn. Hợp đồng same-origin `/api` là thứ giữ cho khoảng lệch đó vô
hại; thay đổi API phá vỡ tương thích ngược phải tách thành hai lần release.

Luồng thường ngày: PR `main` → `release` (chờ `release-gate` xanh) → merge → Actions deploy Worker,
timer trên VM kéo commit về trong khoảng 1 phút.

Từ ADR-036 stack có **ba** container chạy code: `api`, `ai-review-worker` và `web`. Worker dùng
**chung image** với `api` (`vku-challenge-api:prod`, cùng build context) và chỉ khác `command`, nên
hai bên không thể lệch code. Deployer biết điều đó: một thay đổi ở `backend/*` hoặc ở
`docker-compose.prod.yml` bật cả `api` lẫn `ai-review-worker` lẫn `web`, nhưng chỉ **build image
backend một lần** (`BUILD_SERVICES` cố ý bỏ worker ra - `build api ai-review-worker` là build lại
đúng source đó lần thứ hai). Cả hai container nhận cùng nhãn revision của SHA đang deploy, nên
"worker đang chạy bản nào" trả lời được bằng `docker ps`.

**VM: cài đặt một lần**

```bash
# Trên VM, từ commit đã duyệt trên nhánh release
cd /srv/vku-ai-challenge/repo
sudo git fetch origin release && sudo git checkout --detach origin/release
sudo git status --short                       # phải trống
sudo deploy/vps/install-auto-deploy.sh        # copy deployer + unit, KHÔNG bật timer
sudo /usr/local/sbin/vku-auto-deploy --bootstrap-current   # ghi mốc SHA đang chạy
sudo /usr/local/sbin/vku-auto-deploy --dry-run             # xem sẽ deploy gì, không đổi gì
sudo systemctl enable --now vku-deploy.timer               # bật
```

`--bootstrap-current` bắt buộc chạy trước: chưa có mốc thì deployer từ chối deploy để không build lại
toàn bộ stack ngoài kế hoạch.

**VM: vận hành**

```bash
systemctl list-timers vku-deploy.timer     # lần chạy kế tiếp
systemctl status vku-deploy.service        # lượt gần nhất
journalctl -u vku-deploy.service -n 100 --no-pager
sudo systemctl stop vku-deploy.timer       # tạm dừng auto-deploy
sudo systemctl start vku-deploy.service    # chạy một lượt ngay
cat /var/lib/vku-deploy/history.log        # lịch sử mọi lượt (SHA, kết quả, service)
```

Deployer giữ state ở `/var/lib/vku-deploy` (quyền `0700`): `last-success-sha`, `last-failed-sha`,
`history.log`, `last-failure.txt`, `quick-tunnel-url` và hai file override sinh tự động. **Không sửa state bằng tay** -
muốn thử lại một SHA đã lỗi thì push commit mới (mỗi SHA lỗi chỉ thử một lần để timer không quay lại
build cùng một commit hỏng mỗi phút).

Một điểm cần biết trước: `last-success-sha` là mốc **state**, không phải bằng chứng có image trên máy.
Commit chỉ đổi `docs/` tiến mốc mà không build image nào, nên ngay sau đó có thể **không có image để
rollback**. Gặp trường hợp đó deployer **từ chối rollback** và báo `không có image của <sha>` - cố ý,
vì `docker compose up` tự build khi image vắng mặt, và build lúc này là build **source mới** dưới tag
của SHA cũ, tạo ra một container mang nhãn bản cũ nhưng chạy code mới. Khi thấy thông báo đó: dừng
timer, deploy lại commit trước bằng đường thủ công (§7.2).

Commit chỉ đổi `docs/`, `.github/`, `plans/`, `scripts/` không chạm container: deployer chỉ tiến mốc
state rồi thoát, không build. Đường dẫn chưa được phân loại thì deployer **dừng và báo tên file** -
đó là chủ ý, để thêm một thư mục mới là quyết định có ý thức chứ không phải mặc định.

Trước khi build, deployer còn một cổng preflight cho MinIO (ADR-028): release nào cần artifact backend
(compose của nó khai `minio`) thì `minio` phải healthy **và** `minio-init` phải đã exit 0, nếu không
deployer dừng trước khi thay `api`/`web` và in lệnh bootstrap. Chi tiết ở §12.

Vì production đang chạy **Quick Tunnel** (§6 mục điều kiện), mỗi lượt deployer còn đọc log container
`cloudflared` để phát hiện hostname `*.trycloudflare.com` thay đổi. Hostname đó đổi mỗi khi container
`cloudflared` khởi động lại (VPS reboot, Docker daemon restart), và lúc đó `API_ORIGIN` của Worker trỏ
vào URL đã chết ⇒ mọi `/api/*` trả `502`. Deployer **chỉ báo, không tự sửa**: nó ghi ra
`CẢNH BÁO: Quick Tunnel URL đã đổi` kèm URL cũ, URL mới và đường dẫn Dashboard cần sửa, đồng thời ghi
một dòng `result=tunnel-url-changed` vào `history.log`. Tự sửa đòi hỏi một token quản trị Worker
thường trú trên VPS - nhân bản quyền Cloudflare sang máy thứ hai chỉ để phục vụ một sự kiện hiếm, nên
đây là chủ ý. Đọc log là thao tác chỉ đọc: watchdog không bao giờ đổi trạng thái `cloudflared`.

Sửa deployer trong repo **không** tự áp dụng lên VM: phải chạy lại `install-auto-deploy.sh` từ commit
đã duyệt. Bản chạy thật là copy root-owned ở `/usr/local/sbin/vku-auto-deploy`, không phải file trong
repo - một commit xấu không được phép tự thay cơ chế recovery của chính nó.

### 7.2 Đường thủ công (break-glass)

Nguyên tắc: chỉ deploy một commit đã qua release gate, không build từ working tree bẩn.

```bash
# Trên máy dev: tạo bundle từ commit release rồi chuyển sang VM
git bundle create /tmp/vku-release.bundle <release-sha>
scp /tmp/vku-release.bundle nkd@<vm>:/tmp/

# Trên VM
cd /srv/vku-ai-challenge/repo
sudo git fetch /tmp/vku-release.bundle <release-sha>
sudo git checkout --detach <release-sha>
sudo git status --short          # phải trống
sudo rm -f /tmp/vku-release.bundle

# Build (tuần tự để giảm peak RAM) rồi mới up
sudo COMPOSE_PARALLEL_LIMIT=1 docker compose --env-file /srv/vku-ai-challenge/.env \
     -f docker-compose.prod.yml build
sudo docker compose --env-file /srv/vku-ai-challenge/.env \
     -f docker-compose.prod.yml up -d
```

Đặt `COMPOSE=...` cho gọn tay (thêm `-f deploy/docker-compose.tunnel.named.yml` khi đã bật named tunnel):

```bash
alias dcp='sudo docker compose --env-file /srv/vku-ai-challenge/.env -f /srv/vku-ai-challenge/repo/docker-compose.prod.yml'
```

## 8. Smoke test sau deploy

### 8.1 SPA và deep link (trên public hostname của Worker)

```bash
HOST=https://<public-host>

curl -sI $HOST/ | head -n 1                    # 200
curl -s  $HOST/competitions/ai-challenge-2026 | grep -c '<div id="root"'   # 1 -> SPA fallback OK
curl -s  $HOST/ho-tro                          | grep -c '<div id="root"'   # 1
```

### 8.2 API qua Worker

```bash
curl -fsS $HOST/api/health                                  # {"status":"ok","mongo":"reachable"}
curl -sI  $HOST/api/auth/me | head -n 1                     # 401 (chưa đăng nhập)
curl -s   $HOST/api/khong-ton-tai | head -c 120             # JSON 404 của FastAPI, KHÔNG phải HTML của SPA
```

### 8.3 Phiên đăng nhập: cookie, giữ phiên, logout

Không dán mật khẩu hay token vào dòng lệnh (lộ trong `ps`/history) - dùng file tạm quyền 600 và
cookie jar:

```bash
umask 077
# Trường định danh của `/api/auth/login` tên là `identifier` (KHÔNG phải `email`); gửi sai tên
# trường sẽ bị FastAPI trả 422 VALIDATION_ERROR trước khi tới bước kiểm tra mật khẩu.
printf '{"identifier":"%s","password":"%s"}' '<email>' '<password>' > /tmp/aic-login.json

curl -si -c /tmp/aic.jar -o /dev/null $HOST/api/auth/login \
  -H 'Content-Type: application/json' -d @/tmp/aic-login.json | grep -i '^HTTP/'

grep aic_session /tmp/aic.jar            # cookie được lưu, KHÔNG có cột domain
curl -s -b /tmp/aic.jar $HOST/api/auth/me | head -c 200          # 200, đúng tài khoản

curl -si -X POST -b /tmp/aic.jar $HOST/api/auth/logout | grep -i '^HTTP/\|^set-cookie'
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/aic.jar $HOST/api/auth/me   # 401 sau logout

rm -f /tmp/aic.jar /tmp/aic-login.json
```

Kiểm tra thêm bằng mắt trên DevTools → Application → Cookies: `aic_session` phải có `HttpOnly`,
`Secure`, `SameSite=Lax` và **không** có `Domain`.

### 8.4 Upload, asset Markdown, download

```bash
# multipart CSV -> body phải đi nguyên trạng qua Worker
curl -s -b /tmp/aic.jar -F 'file=@/tmp/accounts.csv' \
  $HOST/api/admin/competitions/<id>/accounts/import | head -c 200

# asset Markdown: path tương đối /api/competitions/<slug>/assets/<file>
curl -sI $HOST/api/competitions/<slug>/assets/<file>.png | head -n 1

# download: Content-Disposition và Content-Type phải giữ nguyên qua proxy
curl -sI -b /tmp/aic.jar $HOST/api/admin/competitions/<id>/export.xlsx \
  | grep -i 'content-disposition\|content-type'
```

Artifact của submission (ADR-028) - nộp một lượt thật rồi tải lại cả hai file:

```bash
# Nộp: HAI part bắt buộc, thiếu notebook là 422
curl -s -b /tmp/aic.jar \
  -F 'file=@/tmp/prediction.csv' -F 'notebook=@/tmp/notebook.ipynb' \
  $HOST/api/competitions/<id>/submissions | head -c 300

# Tải: tên file chuẩn hoá + filename*=UTF-8''; phải đi qua FastAPI, KHÔNG phải URL MinIO
curl -sI -b /tmp/aic.jar $HOST/api/competitions/<id>/submissions/<submission_id>/prediction \
  | grep -i 'content-disposition\|content-type\|cache-control'
curl -sI -b /tmp/aic.jar $HOST/api/admin/submissions/<submission_id>/notebook | head -n 1

# Bảng toàn cục của admin (ADR-029): sort theo cuộc thi/điểm, kèm stats của cả bộ lọc
curl -s -b /tmp/aic.jar "$HOST/api/admin/submissions?limit=5&sort=competition&order=asc" | head -c 300
curl -s -b /tmp/aic.jar "$HOST/api/admin/submissions?limit=1" | grep -o '"stats":{[^}]*}'
```

Notebook khung dùng chung (ADR-030) - endpoint công khai, **không** cần cookie và không truy vấn DB:

```bash
curl -sI $HOST/api/starter-notebook | grep -i 'content-type\|content-disposition\|cache-control\|nosniff'
# Phải là application/x-ipynb+json, tên cố định starter-notebook.ipynb, và tải về mở được bằng Jupyter
curl -s $HOST/api/starter-notebook -o /tmp/starter.ipynb && python3 -c \
  "import json;nb=json.load(open('/tmp/starter.ipynb'));print(nb['nbformat'], len(nb['cells']))"
```

`/api/health` **không** được đỏ vì MinIO (ADR-028). Kiểm tra đúng chỗ: dừng `minio` rồi gọi
`/api/health` (phải vẫn 200) và một endpoint artifact (phải 503 `ARTIFACT_STORAGE_UNAVAILABLE`), sau
đó `up -d minio` lại. MinIO không có route Nginx nên **không** kiểm được bằng `curl $HOST` vào cổng
9000/9001 - đúng như thiết kế.

### 8.5 Header bảo mật

```bash
for u in $HOST/ $HOST/api/health; do
  echo "== $u"
  curl -sI "$u" | grep -iE 'x-content-type-options|x-frame-options|referrer-policy|permissions-policy|content-security-policy-report-only'
done
```

Static lấy header từ `_headers`; `/api/*` lấy từ Nginx - cả hai đều phải đủ 5 header.

### 8.6 Những thứ chỉ đúng trên origin (Nginx), không có trên Workers

```bash
ORIGIN=https://origin-api.<DOMAIN>

curl -sI $ORIGIN/data/bat-ky | head -n 1        # 404 - Nginx chặn /data/
curl -s  $ORIGIN/healthz                        # ok
curl -sI $ORIGIN/api/health | head -n 1         # 200
```

Trên hostname Workers, `/data/x` trả `index.html` (SPA fallback) - đúng thiết kế và không lộ file,
nên đừng dùng hostname Workers để kiểm tra `/data/`.

### 8.7 Không lộ port trên VM

```bash
ss -lntp     # chỉ thấy sshd; không có 80, 8000 hay 27017
```

## 9. Admin và tài khoản

```bash
# Mật khẩu nhập ở prompt ẩn - KHÔNG truyền qua tham số dòng lệnh (lộ trong ps/history)
dcp exec api python scripts/create_admin.py admin@vku.udn.vn "ADMIN NKD"
```

Đăng nhập sai quá 10 lần cho cùng một email sẽ bị khoá 15 phút (`429 RATE_LIMITED`). Bộ đếm nằm
trong RAM của tiến trình API, không lưu vào Mongo, nên restart `api` sẽ xoá bộ đếm.

Script idempotent: email đã tồn tại thì thoát code 1 và không ghi đè. Import thí sinh hàng loạt bằng
`dcp exec api python scripts/import_accounts.py <file.csv>` (header `email,name,password`, policy ≥10 ký tự);
copy CSV vào container bằng `docker compose cp` rồi xoá file tạm sau khi import.

## 10. Backup và restore

Timer systemd chạy `scripts/backup_prod.sh` mỗi ngày (xem `deploy/vku-backup.timer`):

```bash
sudo install -m 644 /srv/vku-ai-challenge/repo/deploy/vku-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now vku-backup.timer
systemctl list-timers vku-backup.timer
sudo /srv/vku-ai-challenge/repo/scripts/backup_prod.sh   # chạy tay để kiểm tra
```

Mỗi lần chạy tạo `/srv/vku-ai-challenge/backups/<UTC-timestamp>/` gồm `mongo.archive.gz`,
`app-data.tar.gz`, `minio-artifacts.tar.gz`, `MANIFEST.txt` (kích thước + sha256). Script chỉ dọn
backup cũ hơn `RETENTION_DAYS` (mặc định 14) sau khi **cả ba** phần đã xong: Mongo, app-data và MinIO.

`minio-artifacts.tar.gz` là mirror toàn bộ bucket `submission-artifacts` (CSV dự đoán + notebook của
mọi lượt nộp) bằng đúng tag `mc` mà compose pin, chạy trong container dùng một lần trên network của
`minio`. Credential app đọc từ `.env` và truyền qua env file tạm 600 đã xoá ngay sau đó - **không**
mount cả `.env` production vào container này, và secret không xuất hiện trong `ps` của host. Nếu
`minio` không chạy, script **dừng** và xoá thư mục backup dở dang: một bản backup thiếu artifact trông
y như bản đầy đủ, nên nó không được phép tồn tại.

Sau khi sửa `scripts/backup_prod.sh`, phải chạy lại installer để bản đóng băng
`/usr/local/sbin/vku-backup-prod` được cập nhật:

```bash
sudo /srv/vku-ai-challenge/repo/deploy/vps/install-auto-deploy.sh
```

Diễn tập restore MinIO. Ba bước, **đối chiếu bằng key Mongo tham chiếu** chứ không chỉ đếm object:

```bash
TS=20260918T031700Z
sudo tar -tzf /srv/vku-ai-challenge/backups/$TS/minio-artifacts.tar.gz | wc -l   # số object đã mirror

# 1. Giải nén mirror ra chỗ tạm (KHÔNG giải nén đè vào ${PROD_DATA_ROOT}/minio: đó là dữ liệu sống).
mkdir -p /tmp/minio-drill && sudo tar -xzf /srv/vku-ai-challenge/backups/$TS/minio-artifacts.tar.gz -C /tmp/minio-drill

# 2. Lấy key thật của một prediction + một notebook từ Mongo (không đoán đường dẫn).
dcp exec mongo sh -c "mongosh --quiet $MONGO_AUTH --eval '
  db.getSiblingDB(\"ai_challenge\").submissions.findOne({submission_no: 1}, {artifacts: 1})'"

# 3. Dựng bucket test private rồi mirror ngược từ backup vào đó, đọc lại đúng key ở bước 2.
#    Credential root cần cho `mb`/`anonymous set`; đây là bucket test, không phải bucket thật.
sudo docker run --rm --network <network-của-minio> --env-file /srv/vku-ai-challenge/.env \
  -v /tmp/minio-drill:/backup --entrypoint /bin/sh <mc-image-pin> -c '
    export MC_HOST_root="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@minio:9000"
    mc mb --ignore-existing root/submission-artifacts-drill
    mc anonymous set none root/submission-artifacts-drill
    mc mirror --overwrite /backup/minio-artifacts root/submission-artifacts-drill
    mkdir -p /backup/restored
    mc cat "root/submission-artifacts-drill/<object_key-của-prediction>" > /backup/restored/prediction.csv
    mc cat "root/submission-artifacts-drill/<object_key-của-notebook>" > /backup/restored/notebook.ipynb'

cmp /tmp/minio-drill/restored/prediction.csv <tệp CSV gốc đã nộp>
cmp /tmp/minio-drill/restored/notebook.ipynb <notebook gốc đã nộp>

# Dọn: bucket test và thư mục tạm
sudo docker run --rm --network <network-của-minio> --env-file /srv/vku-ai-challenge/.env \
  --entrypoint /bin/sh <mc-image-pin> -c '
    export MC_HOST_root="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@minio:9000"
    mc rb --force root/submission-artifacts-drill'
rm -rf /tmp/minio-drill
```

Đã chạy trọn quy trình này trên stack dev (2026-09-19, `docs/TEST_MATRIX.md` §13): Mongo restore vào
DB tạm, `app-data` giải nén đọc lại được CSV legacy theo `file_path` trong DB, và hai artifact của một
lượt nộp đọc lại từ bucket test **trùng sha256** với tệp gốc.

Diễn tập restore vào database tạm (làm trước khi cần thật, không chờ sự cố):

```bash
TS=20260918T031700Z   # thư mục backup muốn kiểm tra
dcp cp /srv/vku-ai-challenge/backups/$TS/mongo.archive.gz mongo:/tmp/restore-check.gz

# Biến này được container mở rộng, nên mật khẩu không đi qua argv của tiến trình trên host
MONGO_AUTH='--username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'

dcp exec mongo sh -c "mongorestore --host 127.0.0.1 $MONGO_AUTH \
  --archive=/tmp/restore-check.gz --gzip --nsFrom 'ai_challenge.*' --nsTo 'restore_check.*'"
dcp exec mongo sh -c "mongosh --quiet $MONGO_AUTH --eval 'db.getSiblingDB(\"restore_check\").submissions.countDocuments()'"
dcp exec mongo sh -c "mongosh --quiet $MONGO_AUTH --eval 'db.getSiblingDB(\"ai_challenge\").submissions.countDocuments()'"

# Đối chiếu hai số trên khớp nhau, rồi dọn database tạm và file tạm trong container
dcp exec mongo sh -c "mongosh --quiet $MONGO_AUTH --eval 'db.getSiblingDB(\"restore_check\").dropDatabase()'"
dcp exec mongo rm -f /tmp/restore-check.gz
```

Không bao giờ restore đè lên database đang chạy. `mongorestore --nsFrom/--nsTo` đọc archive từ stdin
chạy được **khi có `-T`** (đã kiểm chứng trên `mongo:7.0.43`, 2026-09-19: pipe `mongo.archive.gz` vào
`docker compose exec -T mongo mongorestore --archive --gzip --nsFrom … --nsTo …`, 65 document vào DB
tạm); thiếu `-T` thì Docker mở TTY và nuốt stdin nên lệnh trông như treo - xem đoạn ngay dưới.

Khi chạy các lệnh trên trong script/CI (không phải gõ tay), thêm `-T` và `</dev/null` cho mỗi
`docker compose exec`: thiếu `-T`, Docker mở TTY và `exec` sẽ đọc hết stdin còn lại - nếu script được
pipe qua `ssh 'bash -s'`, mọi lệnh phía sau bị nuốt mất và script dừng giữa chừng mà không báo lỗi.

## 11. Cảnh báo và giới hạn

- **Quick Tunnel chỉ để pilot.** URL `*.trycloudflare.com` đổi mỗi lần `cloudflared` restart, giới hạn
  200 kết nối đồng thời, không SLA, Cloudflare xếp là công cụ test. Muốn production thật phải có domain
  trong Cloudflare → chuyển sang named tunnel (§6).
- **Dữ liệu và backup cùng một boot disk** (`/srv/vku-ai-challenge`). Backup chỉ cứu được lỗi thao tác
  (xoá nhầm, migrate hỏng), **không** cứu được khi mất disk/VM. Cần một trong: snapshot schedule của GCE,
  copy sang object storage, hoặc persistent disk riêng.
- Không chạy `docker compose down -v`; không xoá `/srv/vku-ai-challenge/data`.
- Cookie `Secure` bật khi `APP_ENV=production`, nên **không thể** kiểm thử đăng nhập qua HTTP thuần -
  mọi smoke test auth phải đi qua URL HTTPS.
- **Header bảo mật nằm ở hai nơi**: `frontend/nginx.conf` (cho `/api/*`) và `frontend/public/_headers`
  (cho static). Đổi một nơi phải đổi nơi còn lại; `_headers` **không** áp dụng cho response do Worker sinh.
- **`/data/` chỉ bị chặn ở Nginx.** Trên hostname Workers, `/data/<x>` rơi vào SPA fallback và trả
  `index.html` - không lộ dữ liệu nhưng đừng nhầm là đã chặn.
- **Một public origin tại một thời điểm.** Cookie phiên là host-only nên session của hostname Workers và
  của hostname tunnel là hai cookie jar độc lập; đổi origin là toàn bộ người dùng phải đăng nhập lại.
- **`client_max_body_size 32m` của Nginx vẫn là giới hạn body hiệu lực.** Một lượt nộp gửi cả CSV
  (10 MiB) lẫn notebook (20 MiB) trong cùng một request multipart, nên trần phải phủ tổng hai file;
  backend vẫn là nơi chốt giới hạn thật của từng file. Workers không cấu hình body limit trong
  `wrangler.jsonc`; vượt ngưỡng thì lỗi là `413` từ Nginx.
- **MinIO là thành phần phải bootstrap trước, không tự mọc.** Release đầu tiên dùng artifact backend
  cần `minio` healthy **và** `minio-init` đã exit 0 (§3.1). Auto-deployer dừng trước khi thay
  `api`/`web` nếu thiếu một trong hai và in lệnh bootstrap - xem §12.
- **MinIO không có route nào từ ngoài.** Không publish 9000/9001, không có `location` trong Nginx,
  không presigned URL. Nếu thấy cổng 9000 mở trên host thì đó là hồi quy, không phải tiện lợi.
- **`npm ci` của frontend kéo thêm `wrangler` + `workerd`** (~100 MB) vào stage build của image `web`,
  nên build trên VM lâu hơn một chút. Runtime không đổi: chỉ `dist/` được copy sang stage Nginx.
- Ngoài scope, không thêm: Redis, queue, Kubernetes, Terraform, R2, D1, Durable Objects.

## 12. Rollback

Từng tầng rollback độc lập:

**Worker (frontend):** Dashboard → Workers & Pages → `vku-ai-challenge-platform` → Deployments → chọn
bản deploy trước → **Rollback**. Không cần đụng tới VPS và không ảnh hưởng API. Workflow deploy cũng
tự rollback khi smoke tĩnh fail; rollback bằng tay cần thiết khi lỗi chỉ lộ ra sau khi smoke đã qua.

Revert frontend bằng Git cũng là một đường rollback hợp lệ và để lại dấu vết: `git revert <sha>` rồi
merge vào `release`; Actions deploy lại bản đã revert.

**`API_ORIGIN`:** nếu origin mới lỗi, sửa runtime variable về giá trị cũ (ví dụ hostname Quick Tunnel)
trong Settings → Variables and Secrets. Đổi biến không cần build lại.

**Tunnel:** bỏ file override để quay về Quick Tunnel:

```bash
sudo docker compose --env-file /srv/vku-ai-challenge/.env \
  -f docker-compose.prod.yml up -d cloudflared
```

**Backend/Nginx (đường tự động):** deployer tự rollback trong lượt deploy hỏng - nó đưa container về
**image cũ đã build** của SHA trước, không build lại source cũ (build lại là phép toán không xác định
đúng lúc production đang lỗi). Mọi lệnh `up` đều có `--no-build` và rollback kiểm tra image cũ tồn tại
trước khi đụng vào container, nên không có đường nào dựng lại source mới dưới nhãn SHA cũ. Rollback chỉ
được coi là xong sau khi deployer đã xác minh label revision của container khớp SHA cũ, nên "rollback
thành công" là trạng thái đã kiểm chứng, không phải suy đoán.

**Worker AI (`ai-review-worker`) có một quy tắc riêng.** Nó chỉ tồn tại từ release giới thiệu nó
(ADR-036), nên khi deployer lùi về một SHA **chưa từng khai** service này, nó sẽ `rm -sf
ai-review-worker` thay vì `up` nó bằng image cũ - image cũ không có module `app.ai_review.worker`, và
chạy nó sẽ tạo một container crash-loop làm `--wait` cháy hết thời gian chờ, tức là rollback thất bại
vì một service mà người dùng cuối không cần để làm việc. Đây là **ngoại lệ duy nhất** của nguyên tắc
"deployer chỉ dùng `build/up/ps/exec`" và nó chỉ xoá đúng container của chính nó. Deployer đọc file
compose **của SHA cũ** bằng `git show` để quyết định, chứ không đọc bản trong working tree - lúc
rollback working tree đang ở SHA mục tiêu nên nó luôn khai worker.

Việc dọn này chỉ ảnh hưởng worker: `api` và `web` vẫn về image cũ bình thường, dữ liệu AI trong Mongo
không bị đụng, và các bài nộp cũ giữ nguyên điểm. Muốn có lại AI thì deploy tiếp một SHA có worker.

**MinIO không nằm trong rollback theo SHA.** `minio`/`minio-init` là hạ tầng pin theo tag, không có
image theo SHA để lùi về, và deployer không bao giờ build/up chúng. Vì vậy có thêm một cổng preflight
(ADR-028): nếu SHA mục tiêu cần artifact backend (compose của nó khai `minio`) mà `minio` không
healthy hoặc `minio-init` chưa exit 0, deployer dừng **trước khi** thay `api`/`web`, trả working tree về
mốc đang chạy và in đúng lệnh cần chạy:

```bash
sudo mkdir -p /srv/vku-ai-challenge/data/minio
sudo docker compose --env-file /srv/vku-ai-challenge/.env \
  -f /srv/vku-ai-challenge/repo/docker-compose.prod.yml up -d minio minio-init
```

Lỗi này **không** ghi `last-failed-sha` - nó không nằm ở commit, mà ở một thao tác tay còn thiếu. Chạy
bootstrap xong thì lượt timer kế tiếp deploy nốt chính SHA đó, không cần push commit mới. Đổi lại,
`history.log` sẽ ghi lại lỗi này mỗi phút cho tới lúc bootstrap xong.

Khi deployer báo **rollback cũng thất bại**, phải can thiệp tay: xem `last-failure.txt` và
`history.log` trong `/var/lib/vku-deploy`, rồi deploy lại commit trước bằng đường thủ công ở §7.2.
Dừng timer (`systemctl stop vku-deploy.timer`) trước khi sửa tay để timer không giành quyền chạy.

**Backend/Nginx (thủ công):**

```bash
cd /srv/vku-ai-challenge/repo
sudo git checkout --detach <sha-truoc>
sudo COMPOSE_PARALLEL_LIMIT=1 docker compose ... build && sudo docker compose ... up -d
```

Dữ liệu nằm ở bind mount ngoài repo nên rollback code không đụng tới dữ liệu; **không** rollback
database và không sửa trực tiếp dữ liệu để "ép chạy". Chạy backup thành công **trước** mỗi lần đổi code.

## 13. Troubleshooting

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `/api/*` trả `500` `INTERNAL_ERROR` | Thiếu/sai `API_ORIGIN`, hoặc giá trị trùng host của request public | Kiểm runtime variable ở §5.2; giá trị phải là origin thuần, không `/api`, không dấu `/` cuối |
| `/api/*` trả `502` | Worker không gọi được origin: cloudflared chết, ingress sai, service `web` down | `dcp ps`, `dcp logs cloudflared`, `curl -fsS https://origin-api.<DOMAIN>/api/health` |
| Trình duyệt báo vòng lặp redirect / lỗi 5xx lạ | `API_ORIGIN` trỏ về chính public hostname của app | Đổi về hostname tunnel, không dùng public hostname |
| `413` khi upload | Vượt `client_max_body_size 32m` (Nginx) hoặc trần theo loại file của backend (`MAX_UPLOAD_MB` cho CSV, `MAX_NOTEBOOK_MB` cho notebook) | Giảm kích thước file; nâng giới hạn thì phải sửa cả hai nơi, và giữ Nginx ≥ tổng hai trần cộng overhead multipart |
| Đăng nhập xong vẫn bị coi là chưa đăng nhập | Cookie `Secure` + đang truy cập HTTP; hoặc vừa đổi hostname | Dùng đúng HTTPS của public origin hiện hành, đăng nhập lại |
| Cookie không có `Secure`/`HttpOnly` | `SESSION_COOKIE_SECURE`/`APP_ENV` sai trên VM | `APP_ENV=production` do compose đặt cứng; kiểm `.env` và `dcp config --quiet` |
| Route con của SPA trả 404 | Mất `not_found_handling: single-page-application` trong `wrangler.jsonc` | Khôi phục cấu hình rồi deploy lại |
| `/api` (không có dấu `/`) trả HTML của SPA | Đúng thiết kế: `run_worker_first: ["/api/*"]` chỉ bắt `/api/...` | Không cần xử lý; client không bao giờ gọi path này |
| Redirect `307` trỏ về hostname origin | Client gọi path có dấu `/` cuối bị FastAPI redirect | Gọi đúng `/api/...` không dấu `/` cuối |
| Static thiếu header bảo mật | `dist/_headers` không có trong bundle đã deploy | Chạy `npm run build` rồi kiểm `dist/_headers`, sau đó deploy lại |
| Asset cũ vẫn được phục vụ | Cache `immutable` cho file **không** có hash | Chỉ đặt cache immutable cho `/assets/*`; file trong `public/` phải có hash hoặc không cache |
| Deploy Worker fail ngay ở bước "Kiểm tra cấu hình" | Thiếu secret/variable ở environment `production`, hoặc `WORKER_URL` không phải `https://...` | Đối chiếu bảng ở §5.1; đây là fail có chủ ý để production chưa bị đụng tới |
| Push vào `release` mà VPS không cập nhật | Timer bị dừng, hoặc SHA đó đã lỗi một lần nên bị bỏ qua | `systemctl status vku-deploy.timer`; xem `history.log`; SHA lỗi thì push commit mới |
| Deployer báo "working tree production đang bẩn" | Có ai đó sửa trực tiếp file trong `/srv/vku-ai-challenge/repo` | Sửa bằng commit rồi `git checkout --detach origin/release`, không sửa tay trên VM |
| Deployer báo đường dẫn "chưa được phân loại" | Commit đổi thư mục mà deployer chưa biết nên map vào service nào | Thêm vào `map_changed_paths` trong `auto-deploy.sh` rồi chạy lại `install-auto-deploy.sh`; deployer dừng là đúng, không phải lỗi |
| Deployer báo rollback cũng thất bại | Cả bản mới lẫn bản cũ đều không lên được | Dừng timer, đọc `last-failure.txt`, deploy lại commit trước bằng đường thủ công (§7.2) |
| `/api/*` trả `502` sau khi VPS reboot | Quick Tunnel cấp hostname mới, `API_ORIGIN` của Worker vẫn trỏ URL cũ | `journalctl -u vku-deploy.service \| grep 'CẢNH BÁO'` để lấy URL mới, sửa `API_ORIGIN` (§5.2). Đăng nhập lại vì cookie host-only không còn khớp origin |
| `ai-review-worker` `unhealthy` hoặc restart liên tục | Vòng lặp worker đã chết, hoặc `AI_REVIEW_HEARTBEAT_SECONDS >= AI_REVIEW_LEASE_SECONDS` (worker thoát mã 2 ngay lúc khởi động) | `dcp logs --tail=50 ai-review-worker`; đối chiếu hai biến nhịp ở §3.2; worker không ảnh hưởng điểm hay lượt nộp nên đây không phải sự cố khẩn cấp |
| Admin bật AI nhưng PUT trả `AI_ENCRYPTION_KEY_MISSING` | `.env` thiếu `LLM_CONFIG_ENCRYPTION_KEY` (hoặc deploy chưa nạp lại env) | Tab `Cài đặt` hiện cảnh báo này ở khối `runtime`; điền biến ở §3.2 rồi `dcp up -d api ai-review-worker` |
| Admin nhập Base URL hợp lệ nhưng PUT trả `AI_ENDPOINT_INVALID` / `AI_PRIVATE_HOST_NOT_ALLOWED` | Port ngoài `AI_REVIEW_ALLOWED_PORTS`, URL sai cú pháp, hoặc host phân giải vào dải nội bộ | Từ ADR-037 host công khai không cần khai allowlist nữa; nếu đích thật sự nội bộ thì khai tường minh ở `AI_REVIEW_ALLOWED_PRIVATE_HOSTS` |
| Bài nộp mãi ở `QUEUED`/`RUNNING` | Worker đang down, hoặc job đang chờ backoff sau lỗi tạm thời | `dcp ps ai-review-worker`, `dcp logs --tail=50 ai-review-worker`. **Không** sửa tay document để "đẩy" job: lease hết hạn được `recover_expired` thu hồi ở lượt sau |
| Lượt kiểm tra trả `ERROR` liên tục | Cấu hình provider sai (key/model/host) hoặc provider chặn mạng ra | Xem tab `Cài đặt` → kiểm tra kết nối; sửa cấu hình rồi bấm **Chạy lại AI** trong modal chi tiết. Điểm và lượt nộp không bị ảnh hưởng |
| Audit row có `error.code = AI_OUTPUT_TRUNCATED` | Model cần nhiều token hơn `AI_REVIEW_MAX_OUTPUT_TOKENS` nên câu trả lời bị cắt giữa chừng (ADR-039) | Tăng `AI_REVIEW_MAX_OUTPUT_TOKENS` ở §3.2 rồi `dcp up -d ai-review-worker`, sau đó **Chạy lại AI**. Thử lại mà không đổi ngân sách sẽ hỏng y nguyên - đây là lỗi terminal, không phải lỗi tạm thời |

Không bao giờ dán `CLOUDFLARE_TUNNEL_TOKEN`, mật khẩu Mongo, mật khẩu admin hay session token vào
chat/log/issue.

## 14. Worker AI review (ADR-036)

`ai-review-worker` là tiến trình **thứ ba** trong stack, dùng chung image với `api`
(`vku-challenge-api:prod`) và chỉ khác `command`:

```bash
dcp ps ai-review-worker
dcp logs --tail=50 -f ai-review-worker
```

Nó **không** expose port nào, không phục vụ request, và không bao giờ nằm trên đường trả lời của một
lượt nộp bài: nộp bài chỉ ghi một job vào Mongo rồi trả điểm về ngay. Worker chết **không** làm hỏng
điểm, lượt nộp, quota hay bảng xếp hạng - nó chỉ làm các lượt kiểm tra AI nằm chờ.

### 14.1 Health

Healthcheck đọc **mtime của `/tmp/ai-review-worker.heartbeat`**, một file worker ghi lại mỗi vòng lặp
kể cả khi hàng đợi rỗng. Mất dấu quá **300 s** là vòng lặp đã chết, không phải "đang chạy job dài"
(một lượt gọi provider tối đa `AI_REVIEW_REQUEST_TIMEOUT_SECONDS`, mặc định 60 s).

```bash
dcp ps ai-review-worker                       # mong đợi: Up ... (healthy)
dcp exec ai-review-worker python -c \
  "import os,time;p='/tmp/ai-review-worker.heartbeat';print('stale_s', int(time.time()-os.stat(p).st_mtime))"
```

Đổi `AI_REVIEW_HEARTBEAT_FILE` thì phải đổi **cả** đường dẫn trong healthcheck của
`docker-compose.prod.yml` - hai chỗ đó phải trỏ cùng một file.

### 14.2 Chạy một lượt bằng tay

Hữu ích khi vừa sửa cấu hình provider và muốn hàng đợi được xử lý ngay thay vì chờ vòng poll kế tiếp:

```bash
dcp exec ai-review-worker python -m app.ai_review.worker --once
dcp exec ai-review-worker python -m app.ai_review.worker --once --max-jobs 5
```

Tiến trình tay này là **tiến trình thứ hai** cùng tranh hàng đợi với worker đang chạy; điều đó an
toàn vì claim job là một `find_one_and_update` nguyên tử trên Mongo - không job nào bị chạy hai lần.
Lệnh chỉ chạy một lượt rồi thoát, không để lại tiến trình nào.

### 14.3 Restart

```bash
dcp restart ai-review-worker
```

`stop_grace_period: 120s` cho worker dừng ở **ranh giới job**: nó không cắt ngang một lượt gọi
provider. Hết ân hạn thì job bị cắt, lease hết hạn và được `recover_expired` thu hồi ở lượt sau -
chậm hơn nhưng không sai, và không sinh audit row trùng.

Restart worker **không** cần restart `api`: hai bên chỉ gặp nhau qua Mongo.

### 14.4 Trước khi deploy release giới thiệu worker

Release đầu tiên có `ai-review-worker` **bắt buộc** phải chạy lại deployer trên VM trước khi push:

```bash
cd /srv/vku-ai-challenge/repo
sudo git fetch origin release && sudo git checkout --detach origin/release
sudo deploy/vps/install-auto-deploy.sh
```

Bản deployer đang chạy trên VM là bản cũ **không biết** service `ai-review-worker`: nó sẽ build image
backend và `up` `api`/`web` rồi thôi, để worker không bao giờ được khởi động dù compose đã khai. Đây
đúng là lý do đã ghi ở §7.1: sửa deployer trong repo không tự áp dụng lên VM, vì bản chạy thật là
copy root-owned ở `/usr/local/sbin/vku-auto-deploy`.

Sau khi cài lại, xác nhận deployer đã nhận worker trước khi push:

```bash
sudo /usr/local/sbin/vku-auto-deploy --dry-run   # danh sách service phải có ai-review-worker
```

Từ release đó trở đi không cần cài lại nữa; deployer tự đưa worker vào mọi lượt deploy có thay đổi
`backend/*` hoặc `docker-compose.prod.yml`.

### 14.5 Smoke sau deploy

Kiểm tra có bằng chứng thật, không chỉ "container đang chạy":

1. `dcp ps ai-review-worker` → `Up ... (healthy)` và `dcp logs --tail=20 ai-review-worker` có dòng vòng lặp.
2. Cấu hình provider ở tab `Cài đặt` của một cuộc thi **nháp** (không dùng cuộc thi thật), bấm **Kiểm tra kết nối** → phải trả host/model/độ trễ.
3. Nộp một bài có notebook và xác nhận **response trả về ngay** với `status:"completed"`, điểm đã có, kèm `ai_review.state:"QUEUED"`.
4. `dcp logs --tail=50 ai-review-worker` → thấy job được claim và kết thúc; mở modal chi tiết trong bảng admin thấy lượt mới.
5. Bấm **Chạy lại AI** → `generation` tăng, điểm không đổi.
6. Mở modal chi tiết của lượt vừa chạy → mỗi lượt trong lịch sử phải ghi `prompt ai-review-v3` (ADR-040). Thấy `ai-review-v2` nghĩa là worker/image chưa được cập nhật, không phải cache.
7. Lượt review mới phải có **gợi ý ngắn cho thí sinh** hiện ngay dưới tóm tắt dài. Verdict `FLAGGED` mà gợi ý trống là bình thường (model quyết định không có gì để nói) - nhưng nếu **mọi** lượt đều trống thì nghi prompt không tới được model.
8. Bấm **Không chấp nhận** một bài có verdict `FLAGGED`: ô lý do phải **điền sẵn** gợi ý kèm dòng nhắc *"Lý do dưới đây do AI soạn nháp…"*. Sửa lại vài chữ rồi gửi → mở lịch sử của **thí sinh** và xác nhận em đọc đúng **bản đã sửa**, không phải bản của model.

Bài nộp và điểm số ở bước 3 phải đúng **dù AI có hỏng**: đây là tính chất quan trọng nhất cần xác
nhận trước khi bật AI cho cuộc thi chính thức. Lượt smoke đầy đủ trên stack dev (bao gồm cache, thu
hồi lease, redaction) nằm ở `docs/TEST_MATRIX.md` §17.

**Cảnh báo cho lượt deploy có ADR-040**: `PROMPT_VERSION` đổi `ai-review-v2` → `ai-review-v3` nên
**mọi** notebook đã từng chấm sẽ trượt cache đúng một lần và được gọi provider lại (kể cả lượt chạy
tự động). Đây là chủ ý - giữ nguyên version thì audit row cũ được phục vụ lại **không có** gợi ý, và
admin chỉ thấy ô lý do trống mà không có lỗi nào để lần. Nếu muốn tránh đợt gọi provider ồ ạt, chạy
deploy vào lúc vắng; không có cách "vá cache" nào khác ngoài việc chấp nhận lượt gọi lại.

## Vận hành thường ngày

```bash
dcp ps                     # trạng thái + health
dcp logs -f api            # log API (đã bật json-file rotation 10m x 3)
dcp logs --tail=50 cloudflared
dcp restart web            # restart một service
df -h /                    # backup cùng disk nên phải theo dõi dung lượng
```

Theo dõi thêm trên Cloudflare: Workers → Metrics (số request, lỗi 5xx) và Deployments (lịch sử build).
