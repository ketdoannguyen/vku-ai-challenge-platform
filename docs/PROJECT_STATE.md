# AI Challenge Platform - Current Project State

## 1. Current checkpoint
- Date: 2026-09-19
- Branch: `main` (tích hợp), `release` = `0864b80` (đang chạy trên VM)
- Commit/working tree status: HEAD `b1b66ea` (fix backup bucket rỗng + ngắt giữa đường). **ADR-028 đã lên production**: `release` `1cd5945` (artifact submission + trang quản trị bài nộp) rồi `0864b80` (fix backup). Working tree còn một đợt thay đổi **chưa commit và không thuộc đợt này** (backend + frontend: tên tải về `__`→`_`, sort/thống kê bảng toàn cục, tính năng starter notebook) - một thay đổi khác đang được viết song song, xem §11
- Overall state: **đã rollout ADR-028 lên production** - 266 backend test + 378 frontend test (30 file) + 157 assert harness deployer + 27 case harness backup pass; MinIO đã bootstrap trên VM (bucket private, app credential least-privilege); smoke artifact 17/17 + legacy 7/7 + case âm 4/4 qua đúng đường người dùng (Worker → Tunnel → nginx → FastAPI); backup thật + restore drill chạy trọn trên đường production; `vku-deploy.timer` đang bật và đã deploy `0864b80` với `services=none`; `vku-backup.timer` cũng đang bật (hằng ngày ~03:20 UTC) và lượt chạy qua đúng unit systemd đã thành công với đủ 4 tệp

## 2. Implemented capabilities
- Sprint 01-07: local Compose stack, auth Argon2id + server-side session, admin accounts, competition lifecycle, membership/join modes, safe Markdown content/assets, participant portal, scoring + ground truth private, submission policy/quota, my submissions, leaderboard, XLSX export, login rate limit + error envelope + CSP Report-Only
- Sprint 08 (ADR-014): đọc công khai cho khách (danh sách, chi tiết, nội dung `public`, assets)
- Vận hành cuộc thi (ADR-015→ADR-019):
  - **Tài nguyên tải về**: `competitions.resources` là link Google Drive (tối đa 10, https, host Drive/Docs, không credentials); không host dataset/binary. Admin quản lý trực tiếp tại tab **Tài nguyên** trong chi tiết cuộc thi (dialog chỉ nhập khi tạo mới); block participant nằm dưới "Mục lục nội dung" trong tab Tổng quan, dùng cùng card shell VKU và format đánh số, ẩn khi rỗng, link ngoài có `rel="noopener noreferrer nofollow"` (ADR-015)
  - **Publish chỉ khi chấm được**: `app/scoring/readiness.py` là một nguồn sự thật, đọc và parse lại ground truth thật; thiếu/sai → 422 với code cụ thể và giữ nguyên `draft`. Admin detail trả `publish_ready`/`publish_blocked_reason` (ADR-017)
  - **Join từ publish đến hết `end_at`**: non-member sau `end_at` → 422 `JOIN_DEADLINE_PASSED`; không kiểm tra `start_at`; membership hiện có luôn idempotent kể cả sau deadline/closed (ADR-017)
  - **Privacy payload**: bỏ `created_by` khỏi representation public; `pos_label` chỉ trả cho admin và thành viên active (ADR-016); datetime naive/aware chuẩn hoá qua một helper dùng chung
  - **Quota trước khi nộp**: `GET /api/competitions/{slug}` trả `quota {per_day,used_today,remaining,resets_at}` cho thành viên active; UI hiện "Còn X/Y lượt" và khoá form khi hết lượt (ADR-019)
  - **Leaderboard phân trang**: `limit`/`offset`/`has_more` + `me` (hạng toàn cục, tìm trên full list trước khi cắt trang, không có account id) (ADR-019)
  - **Đường thoát**: participant `POST /leave` (soft deactivate, giữ điểm; trigger danger-ghost đỏ và modal xác nhận danger); admin xoá cứng member chỉ khi chưa có bài `completed`, ngược lại 409 `MEMBER_HAS_SUBMISSIONS`; admin `DELETE` competition cascade con-trước-cha-sau và dọn file best-effort (ADR-018)
  - **Countdown sống**: formatter thuần + hook dùng chung, dashboard dùng một page-level clock, nhịp 30 giây trên 1 ngày và 1 giây dưới 1 ngày, resync khi tab visible
- Tổng quan participant: tab Tổng quan là trang thật với thể lệ/quy cách bài nộp/danh sách tài liệu, không tự nhảy sang tài liệu đầu tiên
- Trang tĩnh công khai (ADR-021→ADR-024): `/gioi-thieu` và `/ho-tro` là route tĩnh đọc công khai, **không gọi API** và không đụng backend; navbar có thêm hai mục qua `useNavItems()` (dùng chung navbar desktop và drawer). Cả hai đã redesign sang design system VKU (lưới ô full-width, một cột dưới 1200px, light mode only). Từ ADR-024 **không trang nào còn trích dẫn nguồn thông tin**: `SOURCE_ACCESSED` và `VKU_SOURCES` đã bị xoá, chỉ còn hằng `VKU_DEPARTMENT_URL`; dữ kiện VKU vẫn nằm một chỗ ở `frontend/src/lib/vkuInfo.ts`
- Public entry (ADR-025): Worker `vku-ai-challenge-platform` (Workers Static Assets) phục vụ `dist/` và proxy `/api/*` same-origin, nên cookie phiên host-only + `credentials: "same-origin"` vẫn là hợp đồng duy nhất - không CORS rộng, không JWT. `API_ORIGIN` là runtime variable (không phải biến `VITE_*`, không khai trong `wrangler.jsonc`) nên browser không bao giờ biết địa chỉ backend; `keep_vars` giữ giá trị qua các lần deploy. Proxy **không đọc body**, trả nguyên `Response` của upstream nên `Set-Cookie`, `Content-Disposition` và upload multipart đi nguyên trạng. `frontend/public/_headers` giữ 5 security header cho static (Nginx giữ cho `/api/*`)
- Release tự động (ADR-026): `release` là cổng duy nhất, `main` vẫn là nhánh tích hợp; `release-gate` chạy trên PR vào `release` và trên push vào `main`. Actions deploy Worker (smoke tĩnh quyết định rollback, `/api/health` chỉ là diagnostic); VPS tự kéo bằng `vku-deploy.timer` (`OnUnitInactiveSec=1min`), deployer là bản copy root-owned ở `/usr/local/sbin/vku-auto-deploy` để commit xấu không tự thay cơ chế recovery. Image gắn tag bất biến theo SHA + label `org.opencontainers.image.revision`, `up` luôn `--no-build`, rollback dùng image cũ và kiểm image tồn tại trước khi đụng container
- `closed` không còn terminal (ADR-027): `POST /api/admin/competitions/{id}/reopen` (closed → published, **không** kiểm lại readiness và **không** đụng `end_at`), `DELETE` nhận cả `draft` lẫn `closed` (từ chối `published` bằng 409 `COMPETITION_NOT_DELETABLE`)
- Artifact submission trên MinIO private (ADR-028): mỗi lượt nộp cần **cả** CSV dự đoán **lẫn** notebook `.ipynb`; thiếu/sai một trong hai thì không upload object nào, không tạo document và không tiêu quota. Hai object nằm trong bucket private `submission-artifacts` dưới prefix bất biến `competitions/<cid>/accounts/<aid>/submissions/<sid>/prediction.csv|notebook.ipynb`, một document Mongo liên kết chúng qua `submission_no` + `artifacts`. **Mọi** đường vào/ra đều qua FastAPI: không presigned URL, không public bucket, không port publish, không route Nginx. Tên file tải về do server đặt (`{slug}__{account}__submission-NNNN__...`) nên không phụ thuộc tên client; record legacy (CSV trên `DATA_DIR`) vẫn đọc/tải được, không migration bắt buộc. Notebook chỉ được validate bằng `json` stdlib, **không bao giờ execute/render**. `/api/health` cố ý **không** phụ thuộc MinIO - MinIO hỏng chỉ làm endpoint artifact trả 503
- Trang quản trị bài nộp toàn cục `/admin/submissions`: lọc theo cuộc thi/account/status, sắp xếp theo thời gian/đội/điểm (default `created_at`/`desc`), phân trang server-side; BTC tải được artifact của bất kỳ đội nào. Tab kết quả theo từng cuộc thi giữ nguyên và dùng chung component tải artifact

## 3. Not implemented yet (đúng kế hoạch)
- **Pilot với người dùng thật chưa chạy**: hạ tầng đã sẵn sàng (MinIO bootstrapped, backup + drill đã kiểm), nhưng chưa có cuộc thi nào chạy thật với người dùng ngoài
- **Chưa có snapshot ngoài máy**: backup nằm cùng boot disk với dữ liệu, chỉ cứu được lỗi thao tác - cần snapshot GCE hoặc bản sao ngoài (đã ghi ở đầu `scripts/backup_prod.sh`)
- Named Tunnel: chưa có domain nên production tiếp tục dùng Quick Tunnel, hostname đổi mỗi lần `cloudflared` restart và lúc đó `API_ORIGIN` của Worker trỏ vào URL chết
- Public/private leaderboard split - **tạm hoãn có chủ đích** (ADR-020); không giải quyết bằng cách nhân đôi competition

## 4. Repository structure that matters
- `backend/app/submission_artifacts/{storage,validation,naming}.py`: MinIO client qua `run_in_threadpool`, validate notebook bằng `json` stdlib, tên file tải về + `Content-Disposition` (đây là chỗ duy nhất biết `object_key`)
- `backend/app/submissions/artifacts.py`: `artifact_response` dùng chung cho 4 route tải, đọc record mới (MinIO) lẫn record legacy (`DATA_DIR`), chặn path thoát ra ngoài
- `backend/app/submissions/router.py`: POST hai part (`file` + `notebook`), `_insert_with_sequence` (cấp `submission_no`), `_cleanup` (xoá object khi insert lỗi), map lỗi storage thành 503
- `backend/app/submissions/admin_router.py`: list theo cuộc thi (có `sort`/`order`) và `global_router` `/submissions` (bảng toàn cục) + hai route tải cho admin
- `backend/app/core/datetimes.py`: `as_utc`, `utc_day_bounds`, `iso_z` dùng chung (naive Mongo được hiểu là UTC)
- `backend/app/scoring/readiness.py`: `check_readiness` / `blocked_reason` cho publish + banner admin + endpoint scoring
- `backend/app/competitions/service.py`: `public_competition` vs `admin_competition`, `normalize_resources`, `delete_competition_cascade`, `remove_competition_files` (dọn cả prefix MinIO)
- `backend/app/memberships/{router,admin_router}.py`: join deadline policy, `POST /leave`, `DELETE member` có điều kiện (dọn object của bài chưa `completed`), `active_total`
- `backend/app/leaderboard/service.py`: `leaderboard_response` (participant, phân trang + `me`) vs `admin_leaderboard_response` (full list)
- `frontend/src/components/ArtifactLinks.tsx`, `frontend/src/lib/downloadArtifact.ts`: nút tải artifact dùng chung cho lịch sử participant, bảng admin theo cuộc thi và bảng toàn cục - nhận `basePath` nên cùng một component gọi được cả route participant lẫn route admin
- `frontend/src/components/AdminSubmissionsPanel.tsx`, `frontend/src/pages/AdminSubmissionsPage.tsx`: bảng toàn cục (lọc/sort/phân trang đều gửi lên server)
- `frontend/worker/index.ts`: proxy `/api/*` same-origin, fail closed khi thiếu/sai `API_ORIGIN`
- `deploy/vps/auto-deploy.sh` + `deploy/vps/tests/auto-deploy.test.sh`: deployer chạy bằng root trên VM; harness chạy nó trên repo tạm với `git` thật và `docker` giả, không cần Docker/mạng/credential
- `scripts/minio_init.sh` (idempotent, chạy một lần qua `minio-init`), `scripts/minio_smoke.sh` (kiểm chứng bucket private/quyền app trên Compose project cô lập), `scripts/backup_prod.sh`
- `backend/tests/fake_minio.py`: MinIO giả in-memory cho unit test - unit suite không cần container
- `backend/tests/helpers.py`: fixture dùng chung (`configure_scoring`, `publish_competition`) - `backend/tests` là package nên import qua `tests.helpers`

## 5. Runtime/services
- Kiến trúc web/api/mongo và volume `/data` giữ nguyên; **thêm một service `minio` + một job một lần `minio-init`** (cả trong `docker-compose.yml` và `docker-compose.prod.yml`). MinIO chỉ nằm trong network nội bộ compose: không publish port, không route Nginx, không console công khai
- Credential tách đôi: `MINIO_ROOT_USER/PASSWORD` chỉ service `minio` + `minio-init` nhận; `MINIO_ACCESS_KEY/SECRET_KEY` (app credential, quyền hạn chế trong đúng một bucket) chỉ API nhận
- Không có collection mới: `resources` nằm trong `competitions`, quota và `me` là dữ liệu derived. Artifact **không** nằm trong `DATA_DIR` nữa (chỉ record legacy còn ở đó)
- `minio`/`minio-init` nằm **ngoài** override theo SHA của auto-deploy: deployer không build/up chúng, chỉ kiểm chúng đã bootstrap chưa rồi mới deploy

## 6. Current API contract summary
- Mới (ADR-028): `POST /api/competitions/{slug}/submissions` nhận multipart **hai** phần bắt buộc (`file` = CSV dự đoán, `notebook` = `.ipynb`); `GET .../submissions/{id}/prediction` và `.../notebook` (participant, chỉ bài của mình); `GET /api/admin/submissions` (bảng toàn cục: `competition_id`/`account_id`/`status`/`sort`/`order`/`limit`/`offset`) và `GET /api/admin/submissions/{id}/{prediction,notebook}`
- Đổi (ADR-028): response 201 của submit thêm `submission_no` + `artifacts`; `GET .../submissions/me` trả metadata artifact (tên file + `available`) thay vì chỉ tên file; admin list theo cuộc thi thêm `sort`/`order`
- Error code mới (ADR-028): `INVALID_NOTEBOOK_TYPE`, `NOTEBOOK_INVALID`, `NOTEBOOK_UNSUPPORTED_VERSION`, `ARTIFACT_NOT_FOUND`, `ARTIFACT_STORAGE_UNAVAILABLE` (503)
- Mới (ADR-027): `POST /api/admin/competitions/{id}/reopen`
- Mới/đổi (ADR-015→ADR-019): `POST /api/competitions/{slug}/leave`; `DELETE /api/admin/competitions/{id}` (draft + closed + `confirm_slug`); `DELETE /api/admin/competitions/{id}/members/{account_id}`; `GET /api/competitions/{slug}` thêm `quota`; leaderboard participant thêm `limit`/`offset`/`has_more`/`me`; admin members thêm `active_total`; competition create/update thêm `resources`; `upload_limits` chỉ có ở admin detail
- `GET /api/health` **cố ý không** kiểm MinIO: nó là oracle rollback của auto-deployer, nên MinIO hỏng không được phép làm health đổi trạng thái
- Chi tiết: `docs/API_CONTRACT.md` §3-§6

## 7. Current data model and indexes
- `submissions.submission_no` (int, **absent ở record cũ**): số thứ tự thật theo `(competition_id, account_id)`, dùng làm token trong tên file khi tải
- `submissions.artifacts` (`{prediction|notebook: {object_key, original_filename, size_bytes}}`, absent ở record cũ): `object_key` **không bao giờ** trả về API; record cũ vẫn đọc bằng `file_path`/`original_filename`
- Index mới: unique partial `(competition_id, account_id, submission_no)` (`submission_no` tồn tại) - chốt số thứ tự, record legacy không tham gia ràng buộc; `(created_at DESC, _id DESC)` và `(primary_score DESC, created_at DESC, _id DESC)` cho bảng toàn cục
- `competitions.resources` (list `{label,url}`, default `[]`; document cũ thiếu field vẫn đọc được, không migration)
- Membership: `active=false` giờ cũng do participant tự đặt qua `/leave`; admin xoá cứng chỉ khi chưa có bài `completed`
- Sắp xếp `team` ở bảng toàn cục sắp theo **tên account** nên phải `$lookup` sang `accounts` trong aggregation; `total` vẫn đếm bằng `count_documents` trên cùng query
- Chi tiết: `docs/DATA_MODEL.md` §6, §9-§10

## 8. Environment variables in use
- Mới: `MAX_NOTEBOOK_MB` (mặc định 20); `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET` (mặc định `submission-artifacts`). Production phải đổi hết giá trị MinIO khỏi mặc định dev (`openssl rand -hex 24`)
- Giữ nguyên: `MAX_UPLOAD_MB` (10), `MAX_CONTENT_MB`, `MAX_ASSET_MB`, `DATA_DIR`
- Trần body hiệu lực ở Nginx là `client_max_body_size 32m` (đủ 20 MiB notebook + 10 MiB CSV + overhead multipart)
- Worker: `API_ORIGIN` là runtime variable của Cloudflare, **không** là biến `VITE_*`

## 9. Commands verified
- `cd backend && uv run pytest -q` - **266 passed** (178s)
- `cd frontend && npx vitest run --maxWorkers=1` - **378 passed (30 files)** (140s)
- `bash deploy/vps/tests/auto-deploy.test.sh` - **154 ok, 0 fail**
- `./scripts/minio_smoke.sh` - **MinIO smoke PASS** trên Compose project cô lập (`vku-minio-smoke`), chạy thật 2026-09-19: minio healthy, `minio-init` chạy lại không lỗi, anonymous list/GET đều `Access Denied`, app credential put/get/delete đúng bytes, MinIO không publish port ra host
- `cd frontend && npx tsc -b` - pass
- `cd frontend && npx oxlint src` - exit 0
- `cd frontend && npm run build` + `npm run cf:dry-run` - pass
- `bash -n` trên deployer/installer/harness/`backup_prod.sh`/`minio_init.sh`/`minio_smoke.sh` - pass (chạy trong `release-gate / deploy-script`)
- `docker compose -f docker-compose.prod.yml config --quiet` (base và base + override named tunnel) - pass với env giả
- Đường VPS thật: timer đã bật và đã có một lượt deploy thật qua timer (probe `POST .../reopen` trả `401 UNAUTHORIZED` trong khi đường dẫn bịa trả `404 NOT_FOUND` ⇒ route mới đã live, xem ADR-026 "Rollout")
- Browser smoke thật `node /tmp/uiverify/artifact-smoke.mjs` (Chromium headless trên stack dev có MinIO, đăng nhập thật, không mock `/api`) - **26/26 PASS** (2026-09-19): nộp hai tệp → `201` rồi tải lại đúng bytes, tên tệp `ai-challenge__Đội-01__submission-0009__{prediction.csv,notebook.ipynb}`, admin toàn cục `sort=primary_score`/`q=team1` đều gửi lên server và tải chéo được artifact của đội khác, không tràn ngang ở 1280 lẫn 375
- Backup + restore drill trên stack dev (2026-09-19, quy trình §10 `docs/DEPLOYMENT.md`) - **PASS**: `mongodump` → `gzip -t` + `mongorestore --dryRun`; `app-data.tar.gz` đọc lại được CSV legacy theo `file_path` trong DB; `mc mirror` (đúng tag pin) → `minio-artifacts.tar.gz` 6 object; Mongo restore sang DB tạm (65 document, index unique còn nguyên) → bucket test private → mirror ngược → hai artifact đọc lại theo `object_key` **trùng sha256** với tệp gốc; bucket test + DB tạm đã dọn
- Smoke artifact trên production (2026-09-19, qua `https://vku-ai-challenge-platform.ketdoannguyen.workers.dev`) - **17/17 + 7/7 + 4/4 PASS**: nộp multipart hai part rồi tải lại đúng byte cả hai artifact, đội khác `404 NOT_FOUND`, admin tải chéo được; đường legacy (tên tải 8 ký tự cuối ObjectId, notebook 404, shape `size_bytes: null`); case âm 422 không tạo submission nào
- Backup thật trên VM production (2026-09-19) - **PASS**: `20260919T221818Z` đủ ba archive + MANIFEST sha256 khớp; sau đó bucket rỗng nên lượt `20260919T224501Z` cũng PASS với `minio-artifacts.tar.gz` 120 B. Lượt bị `SIGTERM` giữa đường trả exit 143 và **không** để lại thư mục dở dang
- Restore drill trên **đường production** (2026-09-19, từ `20260919T221818Z`) - **PASS**: `mongorestore` sang DB tạm `ai_challenge_drill` (accounts=5, competitions=2, memberships=2, submissions=1), đọc `object_key` từ DB đã restore, dựng bucket drill private, mirror ngược rồi đọc lại hai artifact **trùng sha256** với tệp đã nộp (`f86105bb…` prediction 183 B, `559eb4ec…` notebook 550 B) và `ground_truth.csv` khớp byte với `/data/app` đang chạy; bucket drill + DB tạm đã xoá
- `bash deploy/vps/tests/backup-prod.test.sh` - **27 ok, 0 fail** (docker giả; bucket có object/rỗng, mirror lỗi, ngắt giữa đường, retention, chạy chồng lấn)
- `/api/health` khi container `minio` **đã dừng** (2026-09-19, production) - vẫn `200 {"status":"ok","mongo":"reachable"}`; MinIO bật lại lên `healthy`
- Lượt backup qua **đúng unit systemd** trên production (`sudo systemctl start vku-backup.service`, không gọi tay script) - **Result=success**, exit 0, `20260919T225043Z` đủ `mongo.archive.gz`/`app-data.tar.gz`/`minio-artifacts.tar.gz`/`MANIFEST.txt`; đây là đường `vku-backup.timer` chạy nên nó kiểm luôn `ExecStart` đóng băng + env của unit

## 10. Tests currently passing
- Backend: **266** - trong đó đợt ADR-028 thêm `test_submission_artifacts.py` (30), `test_submission_downloads.py` (11), `test_admin_submissions.py` (6) và các case artifact trong `test_submissions.py`, `test_competitions_delete.py`, `test_memberships.py`; `fake_minio.py` giữ unit suite không cần MinIO thật
- Frontend: **378 (30 file)** - đợt ADR-028 thêm `ArtifactLinks.test.tsx` (3) và `AdminSubmissionsPage.test.tsx` (9), cùng các case hai-tệp trong `SubmissionPage.test.tsx`/`MySubmissionsPage.test.tsx`
- Harness deployer: **157 assert**, gồm 3 case MinIO (chưa bootstrap / healthy / compose không có MinIO) và case `.env.example` chỉ là file mẫu trong repo
- Harness backup: **27 case** (`deploy/vps/tests/backup-prod.test.sh`), chạy trong `release-gate / deploy-script`
- Ma trận đầy đủ theo chức năng: `docs/TEST_MATRIX.md` (§13 là đợt ADR-028)

## 11. Known issues / technical debt (non-blocking)
- **Working tree đang có một đợt thay đổi chưa commit không thuộc ADR-028, và nó vẫn đang được viết** (mtime các file backend/frontend rơi vào lúc phiên ADR-028 đang chạy, 22:35-22:50 ngày 2026-09-19; không có file nào trong số này do phiên ADR-028 sửa). Ba nhóm: (1) `submission_artifacts/naming.py` đổi dấu phân cách tên tải về từ `__` sang `_` đơn, kèm `submissions/service.py` + `admin_router.py` thêm sort `f1`/`precision`/`recall`/`competition` và một `$facet` đếm thống kê cho bảng toàn cục; (2) tính năng mới **starter notebook** (`competitions/starter_notebook.py` + `.ipynb` + route công khai trong `main.py`); (3) gom nội dung dùng chung `frontend/src/lib/submissionRequirements.ts` cho tab Nộp bài và trang Hướng dẫn. `main` lẫn `release` **không** chứa chúng, production vì vậy vẫn theo hợp đồng `__` đã ghi ở ADR-028 và `docs/API_CONTRACT.md`. **Rủi ro cụ thể**: nếu nhóm (1) vào release mà không đối chiếu lại hợp đồng tên tệp thì tên tải về đổi so với thứ đã smoke trên production - phải sửa cả `docs/API_CONTRACT.md`/`docs/TEST_MATRIX.md` và chạy lại smoke tải về
- `mc` (bản pin trong compose) không có `grep`/`sed`/`wc`/`cmp`: mọi so sánh byte/sha256 khi diễn tập phải làm trên host, trong container chỉ kiểm mã thoát
- Restore drill cần credential **root** để tạo bucket drill: credential app là least-privilege (chỉ bucket `submission-artifacts`, chỉ get/put/delete object) nên `mc mb` bằng app bị `Access Denied` - đúng thiết kế, không phải lỗi
- `deploy/vps/install-auto-deploy.sh` chạy bằng root nên `git rev-parse` trong repo bị từ chối (`không đọc được git HEAD`): bản đóng băng vẫn được ghi và `cmp` khớp repo, nhưng log cài đặt không ghi lại SHA nguồn. Deployer truyền `-c safe.directory=*` cho từng lệnh git, installer thì chưa
- `TS` của `scripts/backup_prod.sh` chỉ có độ phân giải giây: hai lượt chạy trong cùng một giây sẽ dùng chung tên thư mục (lượt sau ghi đè lượt trước). `flock` đã chặn chạy song song và timer chỉ chạy mỗi phút nên thực tế không xảy ra
- Bảng toàn cục sắp theo `team` phải `$lookup` sang `accounts` nên không dùng được index; ở quy mô hiện tại (hàng nghìn bản ghi) chưa đáng lo, review nếu lớn hơn
- Record legacy (CSV trên `DATA_DIR`) không có migration: chúng vẫn đọc được nhưng thiếu `submission_no` (tên tải về rơi về ObjectId ngắn) và không có notebook
- Cờ `available` của bài legacy chỉ xét document có `file_path`, **không** stat đĩa: nếu tệp bị dọn tay khỏi `DATA_DIR` thì UI vẫn hiện nút tải và API trả 404, UI báo lỗi ngay trong dòng (bảng không hỏng). Bài nộp mới thì `available` phản ánh đúng vì object nằm trong MinIO
- Restore drill đã chạy trọn trên **cả** stack dev lẫn đường production, đối chiếu sha256 theo `object_key`; retention 14 ngày chỉ chạy sau khi cả Mongo, app-data và MinIO đều thành công (cố ý fail closed). Chưa kiểm: restore **thật** vào database đang phục vụ (drill chỉ restore sang DB tạm) - cần một lần diễn tập trên môi trường không phục vụ người dùng
- Limiter login process-local theo email (ADR-013): lockout 15 phút nếu kẻ xấu biết email; cần IP companion khi có Cloudflare trusted headers
- Limit 200 cho admin members: vượt 200 dòng sẽ truncate (có hiển thị total); admin accounts đã có phân trang (`limit=50` + `offset`, backend bound `1..200`/`>=0`)
- Leaderboard vẫn tính full ranking trong bộ nhớ: phù hợp 40-80 người; phân trang chỉ giảm payload/UI, không đổi độ phức tạp query
- Cascade xoá competition không có transaction (Mongo standalone): đã xoá con-trước-cha-sau + test failure injection, nhưng dọn file/object chỉ best-effort và có thể báo partial (`files_removed:false`)
- Race nhỏ giữa check `has_completed_submission` và xoá member với một submission đồng thời; backend vẫn enforce membership khi nộp nên không mất điểm đã chấm
- Quota check count-then-insert không transaction; UI quota có thể stale trên nhiều tab - backend 429 vẫn là authority
- Trần upload (`MAX_UPLOAD_MB`/`MAX_NOTEBOOK_MB`/`MAX_CONTENT_MB`/`MAX_ASSET_MB`) là cấu hình **theo môi trường, không lưu theo cuộc thi** (ADR-011); admin detail trả `upload_limits` để UI render hint đúng giá trị đang áp dụng
- Quick Tunnel đổi hostname mỗi lần `cloudflared` restart: deployer chỉ **cảnh báo** (kèm URL cũ/mới và đường Dashboard) chứ không tự sửa `API_ORIGIN`; tới lúc đó API qua hostname Workers trả lỗi cho tới khi sửa tay
- Cookie phiên là host-only nên session **không** dùng chung giữa hostname Workers và hostname tunnel; tại một thời điểm chỉ dùng một public origin cho người dùng thật
- UI/UX audit trình duyệt chỉ chạy ở light mode: sản phẩm có chủ đích chỉ có light mode (không dark mode, không `prefers-color-scheme`)
- Lint warnings set-state-in-effect/Fast Refresh là pattern có sẵn; không có lint error
- Branch protection **chưa bật** cho `release` lẫn `main` (kiểm 2026-09-19: `gh api .../branches/*/protection` trả `Branch not protected`), trong khi `docs/DEPLOYMENT.md` §5.1 mô tả như đã bật. Gate hiện chỉ do workflow tự chạy; bật protection là thao tác một lần trên GitHub
- Link Drive không được kiểm tra còn truy cập được (chủ đích, ADR-015) - BTC tự đảm bảo quyền chia sẻ

## 12. Decisions made this sprint
- ADR-021→024: hai trang tĩnh công khai, redesign Help Center và Giới thiệu, bố cục lưới ô full-width và bỏ hẳn khối nguồn thông tin
- ADR-025: public entry là Cloudflare Workers Static Assets + proxy `/api/*` same-origin, giữ nguyên hợp đồng cookie host-only
- ADR-026: `release` là cổng duy nhất; Actions deploy Worker, VPS tự kéo bằng systemd timer, deployer là bản copy root-owned, rollback theo image cũ đã build
- ADR-027: `closed` đảo được (`reopen`) và xoá được; `closed` không còn là bảo đảm còn lịch sử thi
- ADR-028: artifact submission (CSV + notebook) nằm trong MinIO private, tải qua FastAPI; notebook là bắt buộc; record legacy vẫn đọc được; `/api/health` không phụ thuộc MinIO. ADR-028 **thay thế một phần** ADR-003 (artifact), phần còn lại của ADR-003 giữ nguyên

## 13. Preconditions for next sprint
- Backup định kỳ **đã bật sẵn** (`vku-backup.timer` `enabled`/`active`, chạy hằng ngày ~03:20 UTC, lượt kế tiếp 2026-09-20T03:20:05Z) nên không cần thao tác gì thêm. Điều còn phải theo dõi: lượt `03:21` ngày 2026-09-19 vẫn là bản **trước** ADR-028 (chỉ 3 archive, không có `minio-artifacts.tar.gz`), nên lượt rạng sáng 2026-09-20 là lượt timer đầu tiên chạy bản backup có MinIO - kiểm bằng `journalctl -u vku-backup.service` và `ls /srv/vku-ai-challenge/backups/<timestamp>`
- Snapshot ngoài máy (GCE snapshot hoặc copy backup ra ngoài): backup cùng boot disk chỉ cứu được lỗi thao tác
- Bật branch protection cho `release` (và `main`) trên GitHub - xem §11
- Chốt đợt thay đổi đang viết dở trong working tree trước khi mở release tiếp theo (tên tải về `__`→`_`, starter notebook, nội dung dùng chung) - xem §11

## 14. Exact next sprint
- Sprint 09: pilot - chạy một cuộc thi thật với người dùng ngoài, xác nhận lượt backup định kỳ đầu tiên có `minio-artifacts.tar.gz`, và diễn tập restore **vào môi trường không phục vụ người dùng**

## 15. Handoff notes for the next AI agent
- Muốn "public/private leaderboard" thì đọc ADR-020 trước: **không** nhân đôi competition; hướng đúng là một ground truth có partition và một submission sinh hai score
- Mọi thay đổi publish/join phải đi qua `app/scoring/readiness.py` và giữ thứ tự policy trong `memberships/router.py`
- Xoá dữ liệu: luôn con-trước-cha-sau, dọn file/object sau khi DB xong, không thêm force flag cho published/member đã có bài `completed`
- Artifact: chỉ `backend/app/submission_artifacts/storage.py` biết `object_key`; mọi thứ khác (API, UI, tên file) đi qua `artifact_metadata`/`download_filename`. Không thêm presigned URL, không publish bucket, **không** cho `/api/health` phụ thuộc MinIO
- Không render/execute/import nội dung notebook ở bất kỳ đâu; validate chỉ bằng `json` stdlib
- Không expose `created_by`/`pos_label` ra representation public; field mới phải chọn rõ bên public hay admin
- Mọi error code mới phải vào `docs/API_CONTRACT.md` §6
- Đổi deployer/backup trong repo **không** tự áp dụng lên VM: phải chạy lại `install-auto-deploy.sh` từ commit đã duyệt

---

Rules:
- Không ghi suy đoán.
- Không ghi secret.
- Nếu một chức năng đang partial, nói rõ partial ở đâu.
- Mỗi endpoint/schema đã thay đổi phải đồng bộ sang contract file.
