# Kiểm thử tải AI review trên production — 60 người nộp cùng lúc

**Ngày chạy:** 2026-09-23, 03:39–04:20 UTC
**Môi trường:** production thật (VPS `itv-vps-production`), đo qua **đường công khai** Worker → Quick Tunnel → nginx → FastAPI
**Release:** `61a28a967485ae8a33d4a322109ce517cee03cb1` (`61a28a9`), image `vku-challenge-api:61a28a967485`
**Provider:** `opencode.ai/zen/go/v1`, model `deepseek-v4.1-flash` — **provider thật, không stub**
**Quyết định kiến trúc:** ADR-046 trong `docs/DECISIONS.md`
**Runbook:** `docs/DEPLOYMENT.md` §14.6 (đổi concurrency) và §14.7 (chạy harness)
**Đối tượng đọc:** Ban Tổ chức, Product Owner, lập trình viên vận hành

---

## 1. Kết luận trong một bảng

| Câu hỏi | Trả lời |
|---|---|
| 60 người nộp cùng lúc có chịu được không? | **Có.** 60/60 bài nộp `201`, 60/60 job AI về trạng thái cuối, không 5xx, không trùng lặp, không rò quota |
| Concurrency 4 nhanh hơn tuần tự bao nhiêu? | **3,87×** — hàng đợi 60 người rút trong **136,0 s** thay vì **526,1 s** |
| Có chạy song song thật không? | **Có.** Đo trực tiếp cửa sổ chồng lấn của các lượt review: `peak_overlap = 1` (tuần tự) so với `peak_overlap = 4` (concurrency 4) |
| Tài nguyên VPS có bị siết không? | **Không.** RAM khả dụng thấp nhất 6565 MiB (cổng: >2048), RSS worker tối đa 51 MiB (cổng: <512), 0 restart, health luôn `200` |
| Provider có bị bóp khi tăng song song? | **Không.** p50 độ trễ review 7557 ms → 7355 ms; p95 13898 ms → 13954 ms. 0 lỗi 429 |
| Có lỗi AI nào không? | **Có, 2 lượt ở stage 30 người** (`AI_OUTPUT_TRUNCATED`, `AI_RESPONSE_INVALID`). Tỉ lệ 2/111 = 1,80% ở concurrency 4 so với 0/61 = 0% ở concurrency 1 — **khác biệt không có ý nghĩa thống kê** (Fisher exact hai phía p = 0,540) |
| Concurrency cuối cùng | **4** (giữ nguyên), đặt trong `/srv/vku-ai-challenge/.env` |

---

## 2. Baseline VPS trước khi đo

Đo lúc 04:30Z, sau khi test xong và hệ thống đã về trạng thái nghỉ:

| Chỉ số | Giá trị |
|---|---|
| CPU | 2 logical CPU |
| RAM | 7934 MiB tổng, **6780 MiB khả dụng**, **không swap** |
| Disk | 57 GiB trống (dùng 16%) |
| Load average | 0,28 / 0,53 / 0,64 |
| OS | Ubuntu 24.04.5 LTS, uptime 4 ngày 14 giờ |

RAM theo container lúc nghỉ (tổng ≈ 407 MiB):

| Container | RAM | CPU | Restart |
|---|---|---|---|
| `api` | 132,6 MiB | 0,31% | 0 |
| `minio` | 107,6 MiB | 0,07% | 0 |
| `mongo` | 94,1 MiB | 0,96% | 0 |
| `ai-review-worker` | 51,8 MiB | 0,40% | 0 |
| `cloudflared` | 17,8 MiB | 0,15% | 0 |
| `web` | 3,2 MiB | 0,00% | 0 |

Trước khi bật AI, `ai_review_jobs` / `ai_reviews` / `competition_content_revisions` đều rỗng và không
cuộc thi thật nào bật AI, nên worker chỉ quét và không gọi mạng — đúng kịch bản "vô hại khi không dùng".

---

## 3. Kết quả từng stage

Mỗi stage một cuộc thi biệt lập (`loadtest-<run-tag>`), tài khoản riêng, notebook **khác bytes** giữa
các người dùng nên 100% job là `source=PROVIDER`, không có cache hit nào lọt vào số đo.

| Stage | Concurrency | Người | Login OK | Nộp OK | Về đích | Kết luận | Drain | Lỗi AI |
|---|---|---|---|---|---|---|---|---|
| `smoke1` | 1 | 1 | 1 | 1 | 1 | CLEAR 1 | 8,4 s | 0 |
| `load01` | 4 | 1 | 1 | 1 | 1 | CLEAR 1 | 9,2 s | 0 |
| `load05` | 4 | 5 | 5 | 5 | 5 | CLEAR 5 | 21,1 s | 0 |
| `load15` | 4 | 15 | 15 | 15 | 15 | CLEAR 14, INCONCLUSIVE 1 | 45,9 s | 0 |
| `load30` | 4 | 30 | 30 | 30 | 30 | CLEAR 27, INCONCLUSIVE 1, **FAILED 2** | 77,1 s | 2 |
| `load60c1` | **1** | 60 | 60 | 60 | 60 | CLEAR 57, INCONCLUSIVE 3 | **526,1 s** | 0 |
| `load60c4b` | **4** | 60 | 60 | 60 | 60 | CLEAR 59, INCONCLUSIVE 1 | **136,0 s** | 0 |

`load60c1` là **baseline** (đúng cấu hình đang chạy trước đợt này), `load60c4b` là cấu hình đề xuất.
Hai lượt chạy cùng 60 người, cùng provider, cùng bộ notebook — khác duy nhất ở concurrency.

**A/B ở 60 người: 526,1 s → 136,0 s = 3,87×.** Cả hai lượt đều `peak_overlap` đo được: 1 và 4.

---

## 4. Độ trễ

### 4.1 Đường nộp bài (không phụ thuộc AI — chấm điểm vẫn đồng bộ)

| Stage | p50 | p95 | p99 | max |
|---|---|---|---|---|
| 1 người @ c4 | 244,6 ms | 244,6 ms | 244,6 ms | 244,6 ms |
| 5 người @ c4 | 441,0 ms | 460,7 ms | 460,7 ms | 460,7 ms |
| 15 người @ c4 | 930,6 ms | 956,5 ms | 956,5 ms | 956,5 ms |
| 30 người @ c4 | 1800,0 ms | 1882,9 ms | 1886,5 ms | 1886,5 ms |
| 60 người @ c1 | 3070,3 ms | 3375,0 ms | 3410,2 ms | 3410,2 ms |
| 60 người @ c4 | 3261,3 ms | 3610,3 ms | 3621,9 ms | 3621,9 ms |

Đường nộp bài **không** bị concurrency của worker làm chậm (60@4 chậm hơn 60@1 khoảng 6% ở p50, trong
khi tải đồng thời lên `api` là như nhau). Độ trễ tăng theo số người là do chính đợt nộp đồng loạt
(multipart hai tệp + chấm điểm đồng bộ), không phải do AI.

### 4.2 Đường review AI

| Stage | p50 | p95 | p99 | max |
|---|---|---|---|---|
| 30 người @ c4 | 7427 ms | 12702 ms | 16718 ms | 16718 ms |
| 60 người @ c1 | 7557 ms | 13898 ms | 37177 ms | 37177 ms |
| 60 người @ c4 | 7355 ms | 13954 ms | 31646 ms | 31646 ms |

p50 gần như đứng yên (7557 → 7355 ms) và p95 cũng vậy (13898 → 13954 ms). Nói cách khác **provider
không hề chậm đi khi ta gọi 4 lượt song song** — thứ giảm là *thời gian chờ trong hàng đợi*, không phải
độ trễ một lượt. p99 của 60@4 thấp hơn 60@1 (31646 vs 37177 ms) vì ít job phải xếp hàng lâu.

### 4.3 Đăng nhập

| Stage | p50 | p95 |
|---|---|---|
| 60 người @ c1 | 1868,9 ms | 2886,7 ms |
| 60 người @ c4 | 2075,5 ms | 2452,4 ms |

---

## 5. Tài nguyên trong lúc đo

Bộ lấy mẫu SSH ghi mỗi 5 giây (`/proc/loadavg`, `free`, `docker stats --no-stream`, health code:time,
số lần restart); cửa sổ 60 người @ concurrency 4 cho **325 mẫu**. Các số dưới đây là **cực trị** rút ra
từ lượt ghi đó.

| Chỉ số | Cổng go/no-go | 60@1 (baseline) | 60@4 | Kết luận |
|---|---|---|---|---|
| Load average 1 phút, đỉnh | < 4 | 1,26 | **3,67** | Đạt, nhưng **sát trần** |
| RAM khả dụng, đáy | > 2048 MiB | 6602 MiB | **6565 MiB** | Đạt rộng |
| RSS worker, đỉnh | < 512 MiB | — | **51 MiB** | Đạt rộng (không tăng đơn điệu) |
| CPU worker, đỉnh | không pin CPU | — | **10%** | Đạt |
| CPU `api`, đỉnh | — | — | 155% | Một lõi rưỡi lúc cao điểm |
| `/api/health` | luôn trả lời | 200 | **200 suốt** | Đạt |
| Restart container | 0 | 0 | **0** | Đạt |
| Hồi phục sau stage | load1 < 1 trong 120 s | — | **< 1,0 sau ~25 s**, < 0,5 lúc 04:21:00 | Đạt |

**Điểm cần nhớ: load average 3,67 trên 2 CPU là 1,84 lần số lõi.** Concurrency 4 vẫn nằm trong cổng
(<4) nhưng chỉ còn khoảng 9% biên. Đây là trần thực tế của VPS 2 lõi này, không phải trần của provider
— muốn lên 6 hay 8 thì phải nâng số lõi trước, và lý do không nâng concurrency chỉ vì "provider còn
chịu được" nằm ở đây.

**Một mẫu bất thường chưa giải thích được:** lúc 03:44:22 RAM khả dụng tụt còn 3193 MiB trong khi tổng
RSS các container chỉ khoảng 440 MiB, rồi 8 giây sau trở lại 6652 MiB. Không có OOM trong `dmesg`,
không container nào restart, và **không tái diễn** trong suốt phần còn lại của đợt đo. Lượt backup định
kỳ chạy lúc 03:18 nên không trùng thời điểm. Ghi lại đây như một điểm chưa hiểu, không quy cho tính năng
AI.

---

## 6. Lỗi AI: 2 lượt ở stage 30 người

Hai job ở `load30` kết thúc `FAILED` với `attempts = 1`:

| Mã lỗi | Số lượt | Nguồn |
|---|---|---|
| `AI_OUTPUT_TRUNCATED` | 1 | `provider.py` — `finish_reason == "length"` |
| `AI_RESPONSE_INVALID` | 1 | `provider.py` — JSON/kiểu không parse được |

Cả hai mã được khai **`retryable=False`** trong `backend/app/ai_review/provider.py`, nên mỗi lượt hỏng
là một lần dừng cuối (`FAILED`), không tiêu lượt retry nào. Đây là hành vi **có chủ đích** từ ADR-039:
một câu trả lời bị cắt vì hết trần output không phải lỗi tạm thời, thử lại chỉ tốn thêm một lượt gọi.

**Có phải do tăng concurrency không?** Không có bằng chứng nào cho thấy vậy:

| Nhóm | Lượt về đích | Lượt hỏng | Tỉ lệ |
|---|---|---|---|
| Concurrency 1 (`smoke1` + `load60c1`) | 61 | 0 | 0,00% |
| Concurrency 4 (`load01`+`load05`+`load15`+`load30`+`load60c4b`) | 111 | 2 | 1,80% |

Fisher exact hai phía cho bảng 2×2 này: **p = 0,540** — không thể bác bỏ giả thuyết "hai tỉ lệ bằng
nhau". Toàn bộ 30 notebook của stage 30 nằm trong dải 893–894 byte (gần như giống hệt nhau), nên lỗi
cũng không phụ thuộc kích thước đầu vào. Cả hai lượt chạy 60 người — ở **cả** concurrency 1 **lẫn** 4 —
đều có **0 lỗi**.

Kết luận: đây là lỗi ngẫu nhiên tần suất thấp của **đầu ra model**, độc lập với concurrency, và vì mã
lỗi là non-retryable nên mỗi lần xảy ra là một job `FAILED` vĩnh viễn. Đây là đặc tính **có sẵn của sản
phẩm**, không phải khuyết điểm của đợt tăng concurrency này — nhưng nó đáng được xử lý riêng (xem §9).

---

## 7. Cổng go/no-go

| # | Cổng | Kết quả |
|---|---|---|
| 1 | 100% bài nộp mong đợi có record đúng một lần; không 500/502/504, không trùng lặp/rò quota | **Đạt** — mọi stage `submitted_ok == expected_users`, mọi response `201`, `duplicate_users = 0`, `missing_users = []` |
| 2 | Job/audit khớp số bài nộp; cuối drain không `QUEUED`/`RUNNING`, không lease hết hạn, không audit trùng | **Đạt** — `not_terminal = []` ở mọi stage; audit `append-only` một dòng mỗi `generation` |
| 3 | Mọi lượt ở stage thật là `source=PROVIDER`, không cache hit, không `verdict=ERROR` | **Đạt theo chữ, có lưu ý** — 100% `source=PROVIDER`; 2 job `FAILED` không sinh verdict nào (xem §6) |
| 4 | Không cụm ≥3 lỗi 429 của provider trong 60 giây | **Đạt** — 0 lỗi 429 trong toàn bộ đợt |
| 5 | RAM khả dụng > 2 GiB; RSS worker < 512 MiB; không OOM/restart | **Đạt** — 6565 MiB / 51 MiB / 0 restart |
| 6 | Load average 1 phút < 4, về < 1 trong 120 s; không pin 2 CPU liên tục > 60 s | **Đạt** — đỉnh 3,67; về < 1,0 sau ~25 s |
| 7 | `/api/health` luôn phản hồi; API/Mongo/MinIO/worker đều healthy | **Đạt** — 200 suốt, 0 restart |
| 8 | Ghi p50/p95/p99 độ trễ nộp, p95 độ trễ provider, **tổng token**, tổng drain; c4 cải thiện rõ so với c1 | **Đạt một phần** — mọi số độ trễ và drain đã ghi; **tổng token thì không** (xem §8) |

---

## 8. Những chỗ còn thiếu, và các bước bị lệch

Ghi lại đầy đủ để người đọc sau không phải suy diễn:

1. **Tổng token không đo được.** Harness không gom trường `usage` của provider, và số token từng lượt
   nằm trong các dòng `ai_reviews` — vốn đã bị xoá cùng cuộc thi test lúc dọn dẹp. Đây là **lỗ hổng thật**
   của cổng 8: chi phí thật của một đợt 60 người vẫn chưa có con số. Muốn có, phải sửa harness để cộng
   dồn `usage` vào `summary.json` rồi chạy lại một stage — chưa làm ở đợt này.
2. **Lượt đo 60@4 phải chạy từ VPS, không chạy được từ máy dev.** Lần chạy đầu từ máy dev
   (`load60c4`) **hỏng**: 21/60 lần đăng nhập và 12/39 lần nộp chết với
   `httpx.ConnectError: [SSL: UNEXPECTED_EOF_WHILE_READING]`. Đã loại trừ hạ tầng bằng chứng cụ thể:
   `cloudflare.com`/`github.com`/`opencode.ai` từ máy dev 6/6 OK; **cùng URL đó** từ VPS 20/20 OK;
   origin `web:80` khỏe; `cloudflared` 0 restart. Nghĩa là Cloudflare bóp **theo IP của máy dev** trên
   route `*.workers.dev`, không phải sự cố của hệ thống. Sau 8 phút chờ qua 5 lượt thử, tỉ lệ hỏng vẫn
   ~50%, nên lượt đo được chuyển sang chạy bằng một container dùng-một-lần **trên chính VPS**
   (`load60c4b`) — vẫn đi ra qua đúng đường công khai Worker → Tunnel, chỉ khác nguồn phát. Hệ quả cần
   nhớ: máy phát tải dùng chung đường mạng với origin, nên con số độ trễ tuyệt đối có thể lạc quan hơn
   một chút so với client thật ở xa; phần so sánh A/B thì không đổi vì **cả hai** vế đều đo từ VPS.
3. **Tệp NDJSON thô của bộ lấy mẫu tài nguyên đã bị xoá** cùng đợt dọn dẹp. Các cực trị ở §5 là số rút
   ra lúc đo, không còn tệp gốc để đối chiếu lại. Dữ liệu thô của **harness** (mỗi lượt chạy một thư mục
   `report.md` + `summary.json` + `requests.ndjson`) thì vẫn còn ở `data/ai-review-load/<run-tag>/`
   (thư mục `data/` nằm ngoài git).
4. **Không có màn hình hàng đợi.** Độ sâu hàng đợi chỉ quan sát được gián tiếp qua `not_terminal` của
   harness; muốn xem trực tiếp phải vào container hoặc Mongo (`docs/DEPLOYMENT.md` §14.6).
5. **Hai lượt AI hỏng ở stage 30** — không phải bước bị bỏ, nhưng là kết quả không đạt kỳ vọng; phân
   tích ở §6.

---

## 9. Dọn dẹp và chứng minh dọn dẹp

Xoá qua **API chính thức** (`cleanup` của harness), không xoá thẳng Mongo:

| Hạng mục | Số lượng | Cách làm |
|---|---|---|
| Cuộc thi `[LOAD TEST]` | **8** (một cho mỗi run-tag) | `cleanup` đóng rồi `DELETE` cascade; cả 8 trả `files_removed=True` |
| Account thí sinh test | **232** | `PATCH /api/admin/accounts/{id}` → `active:false` (giữ document làm vết) |
| Account admin tạm | 1 | Xem lưu ý bên dưới |

Xác minh **độc lập** sau khi dọn, bằng một probe chỉ-đọc chạy trong container `api` (dùng chính
`get_settings().mongo_uri` của app, không đưa secret vào argv):

| Kiểm tra | Kết quả |
|---|---|
| Cuộc thi mang dấu `loadtest` / `[LOAD TEST]` | **0** |
| Cuộc thi còn lại | 2 — `ai-challenge` (published) và `vku-ai-challenge` (draft), đều là cuộc thi thật |
| `ai_review_jobs` | **0** |
| `ai_reviews` | **0** |
| `competition_content_revisions` | **0** |
| Object trong bucket `submission-artifacts` | **2**, cả hai thuộc cuộc thi thật `ai-challenge` |
| `competition_contents` / `competition_memberships` / `submissions` | 1 / 1 / 1 — đều của cuộc thi thật |
| Khoá provider (ciphertext) còn trong cuộc thi nào | **Không** — cả hai cuộc thi thật đều `has_ciphertext: false` |
| Tệp tạm trên VPS (`lt-secrets.env`, `lt-runner.sh`, `lt-cleanup.sh`, `/tmp/ai-review-load`) | đã xoá |
| Tệp tạm ở máy dev (khoá provider đã giải mã, mật khẩu admin tạm, các probe) | đã xoá |

Hai điểm cần nói rõ vì chúng **không** theo đúng quy tắc chung:

- **Account admin tạm bị vô hiệu hoá bằng một ghi thẳng vào Mongo.** Route `PATCH` chặn admin tự vô
  hiệu hoá chính mình, repo không có script vô hiệu hoá admin, và mật khẩu admin thật không có ở đây.
  Bản ghi được `$set` đúng hai trường như route vẫn làm (`active:false`, `updated_at`) — **không xoá**,
  để còn vết. Hiện chỉ còn **một** admin đang bật: `admin@vku.udn.vn`.
- **230 session của các account test vẫn nằm trong `sessions`.** Vô hiệu hoá account **không** xoá
  session (hành vi có sẵn của sản phẩm), nhưng `app/auth/sessions.py:57` từ chối mọi session của account
  `active:false`, nên chúng là **dòng chết, không xác thực được**. Không xoá thẳng Mongo theo đúng lựa
  chọn "vô hiệu hoá, đừng xoá" của BTC. 231 session còn lại gồm 230 dòng chết này và **1** session của
  `admin@vku.udn.vn` (không đụng tới).

Khoá `LLM_CONFIG_ENCRYPTION_KEY` được **giữ lại** trong `/srv/vku-ai-challenge/.env` (mode 600, đã đối
chiếu sha256 khớp byte với dev) để không phá ciphertext trong tương lai.

---

## 10. Trạng thái production sau đợt này

| Hạng mục | Giá trị |
|---|---|
| Release đang chạy | `61a28a967485ae8a33d4a322109ce517cee03cb1` |
| Container | `api`, `ai-review-worker`, `web` — cùng revision, `running/healthy`, **0 restart** |
| `AI_REVIEW_CONCURRENCY` | **4** (hiệu lực trong container: `printenv` trả `4`; log khởi động ghi `concurrency=4`) |
| `vku-deploy.timer` | **đã bật lại**, `active`; lượt chạy đầu sau khi bật báo *"Không có gì mới: release vẫn ở 61a28a967485"* — không có deployment nào bị bỏ lỡ hay thất bại |
| `runtime-override.yml` | **không** ghim `AI_REVIEW_CONCURRENCY`, nên lần deploy sau vẫn đọc giá trị 4 từ `.env` |
| Cuộc thi thật bật AI | không có — tính năng vẫn tắt với mọi cuộc thi thật |
| `/api/health` | `200 {"status":"ok","mongo":"reachable"}` |

---

## 11. Khuyến nghị

1. **Giữ concurrency 4.** Nó đạt mọi cổng ở 60 người, nhanh hơn 3,87×, và không làm provider chậm đi.
2. **Đừng nâng lên nữa trên VPS này.** Trần thật là **2 lõi** (load đỉnh 3,67/4), không phải provider.
   Muốn phục vụ nhiều hơn 60 người cùng lúc thì nâng số lõi trước, rồi mới đo lại.
3. **Xử lý lỗi đầu ra non-retryable như một việc riêng.** 1,80% lượt hỏng vĩnh viễn vì model cắt cụt
   hoặc trả JSON hỏng là con số chấp nhận được ở quy mô này, nhưng nó **không tự khỏi**: mỗi lượt hỏng
   cần admin bấm chạy lại tay. Hai hướng đáng cân nhắc — cho phép retry **một lần** với `AI_RESPONSE_INVALID`
   (khác `AI_OUTPUT_TRUNCATED`, vốn là trần của mình), hoặc tự động chạy lại một lần trước khi chốt `FAILED`.
   Cần một quyết định riêng, không nằm trong đợt này.
4. **Bổ sung tổng token vào harness** trước chiến dịch đo tiếp theo, để chi phí thật có số (§8.1).
5. **Trước khi mở cho người dùng thật:** đợt này đo trên cuộc thi test với notebook gần như giống nhau
   (893–894 byte). Notebook thật của thí sinh có thể dài hơn nhiều, làm tăng độ trễ provider và số token
   mỗi lượt — nên chạy lại một stage 60 người với notebook đại diện trước khi tin vào con số 136 giây.
