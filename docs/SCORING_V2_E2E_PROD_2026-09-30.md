# Bộ chấm Python v2 trên production — 1/10/15/20 bài nộp cùng lúc

**Ngày chạy:** 2026-09-30, 00:09–00:16 UTC
**Môi trường:** production thật (VPS `itv-vps-production`), đo qua **đường công khai**
Cloudflare Quick Tunnel → nginx → FastAPI → `evaluator-runner` → container chấm dùng một lần
**Release:** `23676bf8bbed983abf21b7b869ec95f317f28972` (`23676bf8bbed`), xác nhận bằng nhãn
`org.opencontainers.image.revision` trên container `api`
**Release trước đó (deployer):** `ce6a72bb751f9bc8ad278a573723f8c279443539` (`ce6a72bb751f`)
**Image runtime:** `vku-evaluator-runtime:1`, định danh **nội dung**
`sha256:ebac286c4ee6f47dda01c80312ed9db010408dd204629312cfbff4c76b0be51f`
**Cấu hình đo:** `EVALUATOR_MAX_CONCURRENCY=2`, `EVALUATOR_TIMEOUT_SECONDS=30` (không đổi trong suốt đợt)
**Quyết định kiến trúc:** ADR-048 trong `docs/DECISIONS.md`
**Đối tượng đọc:** Ban Tổ chức, Product Owner, lập trình viên vận hành

---

## 1. Kết luận trong một bảng

| Câu hỏi | Trả lời |
|---|---|
| Commit `2c2d09b` (ADR-048) có ổn không? | **Có.** Release B `23676bf8bbed` chạy trên production, 4 stage đạt **mọi** cổng, 0 restart, 0 lỗi 5xx ngoài 503 có chủ đích |
| 10 bài nộp cùng lúc thì sao? | **2 × `201`, 8 × `503`.** Không mất quota, không xếp hàng, không bài nào chấm sai |
| 15 bài cùng lúc? | **2 × `201`, 13 × `503`** |
| 20 bài cùng lúc? | **2 × `201`, 18 × `503`** |
| Có chấm song song thật không? | **Có.** Đỉnh container con đo được = **2**, đúng bằng `EVALUATOR_MAX_CONCURRENCY` |
| 503 có phải sự cố không? | **Không.** Từ chối có kiểm soát `EVALUATOR_UNAVAILABLE`, trả trong ~0,7–1,5 s, **không tiêu lượt nộp** |
| Có xếp hàng chờ không? | **Không.** 503 về lúc 0,7–1,5 s, tức trước khi slot đầu tiên nhả (~4,5 s) — nếu xếp hàng thì phải về sau 4,5 s |
| Tài nguyên VPS? | Đỉnh load1 **2,48**/2 lõi, đáy RAM khả dụng **5,88 GiB**, **0 restart**, health `200` suốt |
| Bộ chấm có bị đổi sau lưng không? | **Không.** Cả 7 bài nộp lưu trong DB đều ghim **cùng một** `runtime_id` nội dung |
| Verdict | **GO** — kèm ba giới hạn ở §8, trong đó quan trọng nhất: **10/15/20 người bấm nộp cùng lúc thì đa số nhận 503 và phải tự bấm lại**, đó là lựa chọn công suất, không phải lỗi |

---

## 2. Baseline VPS trước khi đo

Đo lúc 00:09Z, hệ thống đang nghỉ:

| Chỉ số | Giá trị |
|---|---|
| CPU | 2 logical CPU |
| RAM | 7934 MiB tổng, **5,85–6,00 GiB khả dụng**, không swap |
| Load average | 0,45–0,93 trước mỗi stage |
| Container | `api`, `ai-review-worker`, `web`, `evaluator-runner` — đều `running/healthy`, **0 restart** |
| `evaluator-runner` `/health` | `{"status":"ok","docker":true,"image":"vku-evaluator-runtime:1","runtime_id":"sha256:ebac286c…"}` |

Trước đợt đo, dữ liệu thật gồm **1 account, 1 cuộc thi, 3 bài nộp, 0 membership**. Con số này được
đối chiếu lại sau khi dọn (§9) và **không đổi**.

---

## 3. Kết quả từng stage

Mỗi stage một cuộc thi biệt lập (`loadtest-e2e-v2-s<N>`), tên mang dấu `[LOAD TEST]`, `invite_only`,
leaderboard tắt, AI review tắt, quota 5/ngày, account riêng `@loadtest.example.com`. Cả bốn stage
dùng **cùng một** bộ chấm thử, nên `source_sha256` giống nhau ở cả bốn.

| Stage | Người | Login OK | `201` | `503` | Mã lỗi | Đỉnh container con | Burst |
|---|---|---|---|---|---|---|---|
| `e2e-v2-s1` | 1 | 1 | **1** | 0 | — | 1 | 4,35 s |
| `e2e-v2-s10` | 10 | 10 | **2** | **8** | `EVALUATOR_UNAVAILABLE` | 2 | 4,80 s |
| `e2e-v2-s15` | 15 | 15 | **2** | **13** | `EVALUATOR_UNAVAILABLE` | 2 | 5,01 s |
| `e2e-v2-s20` | 20 | 20 | **2** | **18** | `EVALUATOR_UNAVAILABLE` | 2 | 4,89 s |

**Đúng như dự đoán trong kế hoạch, không phải như mong đợi.** Kế hoạch ghi rõ `N−2` lượt 503 là
*dự báo nếu các lượt cùng chiếm slot*, và đây là kết quả đo: cả ba stage đều cho **đúng 2 thành
công**, vì 2 slot bị chiếm ngay từ đầu và mọi lượt còn lại bị từ chối tức thì. Đây **không** phải
"20 người nộp được 20 bài".

**Kiểm chứng mã lỗi độc lập.** Driver ghi `HTTP_503` vào NDJSON vì nó đọc sai đường dẫn trong phong
bì lỗi (xem §8.2). Mã thật lấy từ log `api`:

| Nguồn | s10 | s15 | s20 | Tổng |
|---|---|---|---|---|
| Driver đếm `503` | 8 | 13 | 18 | **39** |
| Log `api` đếm `code=EVALUATOR_UNAVAILABLE` | 8 | 13 | 18 | **39** |

Trong toàn bộ cửa sổ đo, `code=EVALUATOR_UNAVAILABLE` là **mã lỗi duy nhất** xuất hiện — không có
`SCORING_FAILED`, không `500`, không `502/504`, không lỗi lưu trữ.

---

## 4. Độ trễ

| Stage | `201` p50 | `201` max | `503` p50 | `503` max | Tất cả p50 |
|---|---|---|---|---|---|
| `e2e-v2-s1` | 4347 ms | 4347 ms | — | — | 4347 ms |
| `e2e-v2-s10` | 4091 ms | 4778 ms | **727 ms** | 739 ms | 727 ms |
| `e2e-v2-s15` | 4944 ms | 4965 ms | **857 ms** | 904 ms | 858 ms |
| `e2e-v2-s20` | 4588 ms | 4876 ms | **1384 ms** | 1505 ms | 1399 ms |

Ba điều đọc được từ bảng này:

1. **Đường `201` ổn định ở ~4,1–4,9 s** bất kể 1 hay 20 người cùng nộp. Bộ chấm thử ngủ 3,0 s, nên
   phần còn lại — container khởi động, Python khởi động, I/O, mạng — tốn ~1,1–1,9 s.
2. **Đường `503` nhanh hơn hẳn và không phình theo tải.** Từ 727 ms (10 người) lên 1384 ms
   (20 người) là do chính `api` phải nhận và parse 20 multipart request, **không phải** do chờ slot.
   Bằng chứng: ở stage 20, lượt 503 chậm nhất về lúc 1505 ms, trong khi slot đầu tiên mãi ~4587 ms
   mới nhả. Nếu có hàng đợi, con số này không thể nhỏ hơn 4,5 s.
3. **Không có suy giảm ở đường thành công khi tải tăng** — dấu hiệu của việc chặn ở cửa vào chứ
   không phải quá tải bên trong.

---

## 5. Tài nguyên trong lúc đo

Bộ lấy mẫu trên VPS ghi mỗi 0,5 s (`/proc/loadavg`, `/proc/meminfo`, số container con đang chạy,
số lần restart của `api` và `runner`). Cửa sổ stage 20 có **40 mẫu**.

| Chỉ số | Cổng go/no-go | s1 | s10 | s15 | s20 | Kết luận |
|---|---|---|---|---|---|---|
| Container con đồng thời, đỉnh | ≤ `EVALUATOR_MAX_CONCURRENCY` = 2 | 1 | **2** | **2** | **2** | Đạt — không lần nào vượt |
| Load average 1 phút, đỉnh | < 4 | 0,96 | 2,14 | **2,48** | 1,68 | Đạt, còn ~38% biên |
| RAM khả dụng, đáy | > 2048 MiB | 5993 MiB | 5952 MiB | 5965 MiB | **5882 MiB** | Đạt rộng |
| Container chạy đồng thời, đỉnh | — | 15 | 16 | 16 | 16 | 4 của VKU + 11–12 của stack khác |
| Restart `api` / `runner` | 0 | 0 / 0 | 0 / 0 | 0 / 0 | **0 / 0** | Đạt |
| `/api/health` trước–sau | luôn `200` | 200 | 200 | 200 | **200** | Đạt |
| Container con còn lại sau stage | 0 | 0 | 0 | 0 | **0** | Đạt |

Container con **luôn tự dọn sạch** sau mỗi stage — không có container mồ côi nào, kể cả ở stage 20
nơi 18 lượt bị từ chối.

**Điểm cần nhớ: đỉnh load 2,48 trên 2 lõi là 1,24 lần số lõi.** Concurrency 2 nằm gọn trong cổng
(< 4) và còn nhiều biên — nhưng biên đó **không** dùng để nâng số slot, vì lý do thật của trần nằm ở
chỗ khác: mỗi slot là một container Python riêng, và RAM khả dụng mới là thứ quyết định. Xem §10.

---

## 6. Bất biến quota — phép kiểm quan trọng nhất

Đây là thứ dễ hỏng nhất khi có nhiều lượt đồng thời: một lượt bị từ chối mà vẫn tiêu mất lượt nộp
của thí sinh.

Kiểm tra từng người một, so **phần tăng** chứ không so tổng (để chạy lại stage trên cùng run-tag
không tạo kết quả đỏ giả):

| Stage | Người | Tổng `used_today` tăng | Tổng bài nộp lưu thêm | Lượt `201` | Vi phạm |
|---|---|---|---|---|---|
| `e2e-v2-s1` | 1 | 1 | 1 | 1 | **0** |
| `e2e-v2-s10` | 10 | 2 | 2 | 2 | **0** |
| `e2e-v2-s15` | 15 | 2 | 2 | 2 | **0** |
| `e2e-v2-s20` | 20 | 2 | 2 | 2 | **0** |

Với **từng người**: `used_delta == stored_delta == (1 nếu 201, 0 nếu 503)`. Tổng cộng 46 người qua
bốn stage, **0 vi phạm**. Nói cách khác: 39 lượt bị từ chối vì hệ thống bận **không lấy mất lượt
nộp nào** của thí sinh — đúng như thiết kế "chấm trước, giữ quota sau" ở
`backend/app/submissions/router.py`.

---

## 7. Vân tay bộ chấm — hậu kiểm read-only trong Mongo

API **không** trả `scoring_ref` cho thí sinh (`public_submission` là bản chiếu an toàn, cố ý bỏ
vân tay nội bộ). Nên phần này kiểm thẳng trong DB, chỉ đọc, chỉ in khoá/hash/đếm:

| Cuộc thi | Số bài lưu | `scoring_ref.version` | `runtime_id` | `source_sha256` | `ground_truth_sha256` |
|---|---|---|---|---|---|
| `e2e-v2-s1` | 1 | 2 | `sha256:ebac286c…` | `e07f76db…` | `628a5ec7…` |
| `e2e-v2-s10` | 2 | 2 | `sha256:ebac286c…` | `e07f76db…` | `59be9530…` |
| `e2e-v2-s15` | 2 | 2 | `sha256:ebac286c…` | `e07f76db…` | `acb75fb9…` |
| `e2e-v2-s20` | 2 | 2 | `sha256:ebac286c…` | `e07f76db…` | `b09f712a…` |
| **Tổng** | **7** | | | | |

- `total_bai_nop = 7` — khớp **chính xác** 1+2+2+2 lượt `201` của bốn stage.
- `thieu_scoring_ref = 0`, `thieu_submission_sha256 = 0` — không bài nào thiếu vân tay.
- **Cả 7 bài ghim cùng một `runtime_id` nội dung.** Đây là điều ADR-048 hứa: định danh bộ chấm là
  *nội dung image*, không phải tag có thể bị build đè. `vku-evaluator-runtime:1` là tag; thứ ghi vào
  bằng chứng là `sha256:ebac286c…`.
- `source_sha256` giống nhau cả bốn (cùng một bộ chấm thử), `ground_truth_sha256` **khác nhau** cả
  bốn (mỗi run-tag sinh bộ id riêng) — đúng như thiết kế dữ liệu.

**Hạn chế của phép kiểm này:** cả 7 bài đều có `primary_score = 0,9083`. Đó là hệ quả của dữ liệu
diễn tập — bộ sinh lỗi `(index + user) % 11` cho hai người thắng slot cùng số lỗi (11/120), nên điểm
trùng nhau. Bằng chứng ở đây là **việc ghim vân tay**, không phải sự đa dạng của điểm.

---

## 8. Những chỗ còn thiếu, và các bước bị lệch

Ghi lại đầy đủ để người đọc sau không phải suy diễn:

1. **Bộ chấm thử không phải bộ chấm thật — đây là giới hạn lớn nhất.** Nó `time.sleep(3.0)` rồi đọc
   hai CSV bằng `csv` chuẩn, 120 dòng. Bộ chấm thật của admin có thể `import numpy/pandas/sklearn`,
   đọc dữ liệu lớn hơn nhiều, và tốn hàng chục giây. Đợt này đo **đường ống** (Cloudflare → nginx →
   api → runner → sandbox → lưu kết quả → quota), **không đo chi phí chấm thật**. Con số ~4,3 s cho
   một bài là **sàn**, không phải dự báo.
2. **Driver đọc sai đường dẫn mã lỗi.** `_error_code` đọc `body["code"]`, trong khi phong bì của API
   là `{"error": {"code": …, "message": …}}` (`backend/app/main.py::error_response`; `errors.py` chỉ
   dựng `HTTPException.detail`, còn handler mới là chỗ định hình body trên đường dây). Hệ quả: NDJSON
   ghi `HTTP_503` thay vì `EVALUATOR_UNAVAILABLE`. Đã sửa trong script **sau** khi đo; số liệu thô giữ
   nguyên và mã thật được đối chiếu từ log `api` (§3) — khớp từng stage.
3. **Stage 1 phải chạy lại một lần vì lỗi của chính harness.** Lượt đầu chết ở
   `AttributeError: 'Admin' object has no attribute 'run_tag'` (hàm `configure_v2` dùng nhầm thuộc
   tính), để lại một cuộc thi `draft` đã lưu cấu hình chấm nhưng chưa có ground truth. Cuộc thi đó
   được **xoá trước** lượt đo, và `configure_v2` được viết lại thành chạy-lại-được (đọc revision hiện
   tại thay vì giả định). **Chỉ lượt đo cuối cùng nằm trong bằng chứng.**
4. **`cleanup` khớp account theo chuỗi con, không theo run-tag chính xác.** `cleanup e2e-v2-s1` cũng
   vô hiệu hoá luôn account của `s10` và `s15` (26 = 1+10+15), vì `e2e-v2-s1` là tiền tố của chúng.
   Kết quả cuối vẫn đúng — cả **46** account thí sinh đều bị vô hiệu hoá — nhưng phạm vi của một lượt
   `cleanup` **không** chính xác như tên gọi. Việc xoá **cuộc thi** thì chính xác (khoá theo dấu
   `[LOAD TEST]` + slug). Bộ lọc còn chốt thêm đuôi `@loadtest.example.com`, nên không thể chạm
   account thật.
5. **Account admin của đợt diễn tập bị vô hiệu hoá bằng một ghi thẳng vào Mongo.** Route
   `PATCH /api/admin/accounts/{id}` chặn admin tự vô hiệu hoá chính mình, mà đây là admin duy nhất
   còn phiên; mật khẩu admin thật không có ở đây. Bản ghi được `$set` **đúng hai trường** như route
   vẫn làm (`active:false`, `updated_at`), khoá theo email — không xoá, để còn vết. Đây là chỗ **duy
   nhất** trong đợt không đi qua API chính thức, ngoài phần đọc.
6. **46 session chết còn nằm trong `sessions`.** Vô hiệu hoá account **không** xoá session (hành vi
   có sẵn của sản phẩm), nhưng `app/auth/sessions.py` từ chối mọi session của account `active:false`,
   nên chúng không xác thực được. Không xoá thẳng Mongo theo đúng lựa chọn "vô hiệu hoá, đừng xoá".
7. **Máy phát tải dùng chung đường mạng với origin.** Driver chạy trong container `api` trên chính
   VPS, nên độ trễ tuyệt đối **lạc quan hơn** một chút so với client thật ở xa. Phần so sánh giữa
   các stage thì không đổi vì cả bốn đều đo cùng cách. Lý do phải chạy trên VPS: mật khẩu admin
   không được rời khỏi VPS.
8. **Số liệu thô không vào repo.** Theo quy ước diễn tập, script nằm ở `/tmp` và chỉ bản tổng hợp
   vào `docs/`. Tệp thô ở `/tmp/vku-e2e/evidence/<run-tag>/` (mỗi stage: `driver/requests.ndjson`,
   `driver/summary.json`, `sampler.txt`, `sampler-summary.txt`), sha256 ghi ở §12.

---

## 9. Dọn dẹp và chứng minh dọn dẹp

Xoá qua **API chính thức** (`cleanup` của driver), trừ đúng một chỗ ở §8.5:

| Hạng mục | Số lượng | Cách làm |
|---|---|---|
| Cuộc thi `[LOAD TEST]` | **4** | `cleanup` đóng rồi `DELETE` cascade; cả 4 trả `files_removed=True` |
| Account thí sinh test | **46** | `PATCH /api/admin/accounts/{id}` → `active:false` (giữ document làm vết) |
| Account admin tạm | 1 | Ghi thẳng Mongo, hai trường — xem §8.5 |
| `scoring_load.py` + mật khẩu admin tạm trên VPS | — | `/root/vku-drill-admin.env` đã xoá; script trong `/tmp` |

Xác minh **độc lập** sau khi dọn, bằng probe chỉ-đọc chạy trong container `mongo` (đọc credential từ
chính biến môi trường của container, không đưa giá trị vào argv):

| Kiểm tra | Kết quả |
|---|---|
| Cuộc thi mang dấu `loadtest-` | **0** |
| Bài nộp của 4 cuộc thi diễn tập | **0** |
| Membership của 4 cuộc thi diễn tập | **0** |
| Account `@loadtest.example.com` còn **hoạt động** | **0** |
| Account `@loadtest.example.com` tổng (vết còn lại) | 47 = 46 thí sinh + 1 admin, **đều đã tắt** |
| Container con `vku-evaluator-*` còn lại | **0** |
| Tệp artifact mang tên `loadtest` trên `/srv/vku-ai-challenge/data` | **0** |
| `/root/vku-drill-admin.env` | **không còn** |
| **Dữ liệu thật:** account / cuộc thi / bài nộp | **1 / 1 / 3** — **đúng bằng trước đợt đo** |

---

## 10. Trạng thái production sau đợt này

| Hạng mục | Giá trị |
|---|---|
| Release đang chạy | `23676bf8bbed983abf21b7b869ec95f317f28972` |
| Container | `evaluator-runner`, `api`, `ai-review-worker`, `web` — cùng revision, `running/healthy`, **0 restart** |
| `EVALUATOR_MAX_CONCURRENCY` | **2** (không đổi suốt đợt — không nâng để ép 10/20 lượt thành công) |
| `EVALUATOR_RUNTIME_IMAGE` | `vku-evaluator-runtime:1` → `runtime_id sha256:ebac286c…` |
| `vku-deploy.timer` / `vku-backup.timer` | **active** cả hai |
| `/api/health` | `200 {"status":"ok","mongo":"reachable"}` |
| Cuộc thi thật dùng bộ chấm v2 | **0** — tính năng đã bật nhưng chưa cuộc thi thật nào dùng |

---

## 11. Cổng go/no-go

| # | Cổng | Kết quả |
|---|---|---|
| 1 | Mọi lượt nộp mong đợi có bản ghi đúng một lần; không `500/502/504`, không trùng lặp, không rò quota | **Đạt** — mọi stage `login_ok == users`, phân loại `201+503+khác == users`, 0 vi phạm quota |
| 2 | Mọi lượt bị từ chối là `EVALUATOR_UNAVAILABLE`, không phải lỗi khác | **Đạt** — 39/39 lượt; không mã lỗi nào khác trong cửa sổ đo |
| 3 | Số container con đồng thời không vượt `EVALUATOR_MAX_CONCURRENCY` | **Đạt** — đỉnh 2/2 ở cả ba stage tải |
| 4 | Không container con nào còn sống sau khi stage kết thúc | **Đạt** — 0 ở cả bốn stage |
| 5 | Mọi bài lưu trong DB ghim đúng một `runtime_id` nội dung, `version=2` | **Đạt** — 7/7 bài, cùng `sha256:ebac286c…` |
| 6 | RAM khả dụng > 2 GiB; load1 < 4; không OOM/restart | **Đạt** — 5882 MiB / 2,48 / 0 restart |
| 7 | `/api/health` luôn `200`; 4 service VKU đều healthy | **Đạt** — `200` trước và sau mọi stage |
| 8 | Dọn sạch cuộc thi + account + artifact; dữ liệu thật không đổi | **Đạt** — 0/0/0/0, dữ liệu thật vẫn 1/1/3 |
| 9 | Đo được p50/p95/p99, số `201`/`503`, đỉnh container con, tài nguyên | **Đạt** — đủ, xem §3–§5 |
| 10 | Hậu kiểm độc lập bằng đường chỉ-đọc, không dump PII/secret | **Đạt** — §7 và §9, chỉ in khoá/hash/đếm |

**Verdict: GO.** Không cổng nào trượt. Commit `2c2d09b` cùng hai commit nối production
(`ce6a72bb751f` cho deployer, `c916fd0` cho compose/tài liệu) đã được phát hành qua đúng runbook
(PR `main` → `release`, gate xanh), và hành vi thực tế trên production khớp với thiết kế ADR-048.

---

## 12. Bằng chứng thô và cách đối chiếu lại

Thư mục `/tmp/vku-e2e/evidence/`, mỗi stage một thư mục:

| Tệp | Nội dung | sha256 |
|---|---|---|
| `e2e-v2-s1/driver/summary.json` | tổng hợp stage 1 | `98972e44fce54e1ec07931eece2557bfa568ec2ddc44abca6cdd7fc413940843` |
| `e2e-v2-s10/driver/summary.json` | tổng hợp stage 10 | `9d54352e93ade5f44553e2d06bf2a8782e3d52817efdb2c1d39e3739a2b2e5da` |
| `e2e-v2-s15/driver/summary.json` | tổng hợp stage 15 | `25000382a7b1a29dbc9a14ce71bb663364dd6635a395a55243ba39dfceb8c985` |
| `e2e-v2-s20/driver/summary.json` | tổng hợp stage 20 | `8d0ffc679c73032be4f630e5df42de4568e34d5464fce93fa7f8f8928c7d497c` |
| `*/driver/requests.ndjson` | từng lượt: status, độ trễ, điểm, quota | `3961759b…`, `dea7f328…`, `8b205d3b…`, `1c4d6c16…` |
| `*/sampler.txt` | mẫu tài nguyên mỗi 0,5 s | `ef31ec2a…`, `fdacdd7b…`, `feedb7e4…`, `092b425e…` |
| `*/sampler-summary.txt` | đỉnh/tổng rút từ `sampler.txt` | `7365ee13…`, `fffb6824…`, `cd26f4a2…`, `7fd73e82…` |
| `*/sampler.txt.names` | tên mọi container con từng xuất hiện | `c4e62f4b…`, `fb3f96c0…`, `69729b54…`, `51e42e7c…` |

**Tình trạng kiểm thử tại thời điểm viết báo cáo** (khác với "lúc đầu đợt"):

| Bộ kiểm thử | Kết quả |
|---|---|
| `backend/` — full suite (`uv run pytest -q`) | **790 passed, 0 failed** (178 s) |
| `deploy/vps/tests/auto-deploy.test.sh` | **209 ok, 0 fail** |

Lúc bắt đầu đợt, full suite **đỏ 1 test**
(`test_ai_review_service.py::test_moc_hoan_tat_cua_luot_thanh_cong_la_luc_goi_provider_xong` — fixture
tạo `run_after` theo đồng hồ thực còn `run(..., now=…)` dùng mốc cố định 2026-09-23). Đã sửa ở
`fb2212a` bằng cách ghim hai mốc vào cùng một đồng hồ, **không** đánh dấu xanh khi còn lỗi.

---

## 13. Khuyến nghị

1. **Giữ `EVALUATOR_MAX_CONCURRENCY = 2`.** Concurrency 2 đạt mọi cổng ở 20 người, và trần thật
   không nằm ở load (đỉnh 2,48/4) mà ở chỗ mỗi slot là một container Python riêng. Nâng slot phải
   đo lại RAM, không chỉ nhìn load.
2. **Nói rõ với BTC rằng 503 khi đông là hành vi đã thiết kế, không phải lỗi.** Ở 20 người bấm cùng
   lúc, **18 người nhận "Hệ thống chấm đang bận"** và phải tự bấm lại. Điều an ủi là nó *sạch*: trả
   trong ~1,4 s, không xếp hàng, **không mất lượt nộp**. Nhưng nếu kỳ vọng là "cả lớp nộp một lúc
   trong giờ thi", thì cần một trong ba hướng: nâng slot kèm nâng RAM, cho thí sinh thấy hàng đợi
   thay vì từ chối, hoặc giãn giờ nộp.
3. **Đo lại bằng một bộ chấm thật trước khi tin vào con số độ trễ.** ~4,3 s/bài là sàn của đường
   ống với bộ chấm ngủ 3 s. Một bộ chấm thật `import pandas` + đọc dữ liệu lớn sẽ cho con số khác
   hẳn, và đó mới là con số dùng để chọn số slot.
4. **Cân nhắc cho client biết lượt bị từ chối là *thử lại được*.** Hiện thí sinh chỉ thấy câu
   "Hệ thống chấm đang bận, vui lòng thử lại sau." — đúng, nhưng không nói rằng **lượt nộp chưa bị
   trừ**. Một câu nói rõ điều đó sẽ giảm lo lắng và giảm số lần bấm lại dư.
5. **Sửa `cleanup` của harness cho khớp run-tag chính xác** (neo `-u\d{3}@` hoặc dùng đúng danh sách
   email đã tạo) nếu đợt diễn tập sau muốn dọn theo từng stage.
