# Hàng đợi chấm bền trên production — 24/25 lượt đồng thời, hạn 60 giây, 4 slot

Báo cáo cho phần **bổ sung hàng đợi** của ADR-048 (`docs/DECISIONS.md`), tiếp nối
`docs/SCORING_V2_E2E_PROD_2026-09-30.md` (đợt đo trước hàng đợi: 20 người nộp cùng lúc thì 18 người
nhận `503` và phải tự bấm lại). Đợt này đo trên **VPS production thật**, qua đúng đường công khai
Cloudflare → nginx → API → hàng đợi → worker → runner → container dùng một lần.

## 1. Kết luận trong một bảng

| Câu hỏi | Trả lời đo được |
|---|---|
| 20 người bấm nộp cùng lúc thì sao? | **20/20 được nhận** (`202`), tất cả `COMPLETED`, lượt cuối xong sau **33,5 s** - trước hàng đợi là 2 nhận + 18 người phải bấm lại |
| Vượt trần thì sao? | 24 người → **20 nhận + 4 `503 SCORING_QUEUE_FULL`**; 25 người → **21 nhận + 4 `503`**; 4 lượt bị từ chối **không tạo document, không tiêu quota** |
| Chờ có đúng thứ tự không? | Vị trí chờ FIFO đơn điệu (`1,2,3,3,4,4,5,5,6,6,7,7,8,9,9,10,10,13,13,15`), không lượt nào chen |
| Quá 60 giây thì sao? | 12 lượt × 25 s chấm: **4 `COMPLETED`** (còn 30,5-32,7 s trước hạn) + **8 `EXPIRED`** kèm `SUBMISSION_EXPIRED`, **hoàn quota**, **0 bài** được ghi |
| Quota có bị trừ oan không? | **0 vi phạm** trên mọi stage: `quota_used` của từng tài khoản đúng bằng số lượt đã tính |
| Trần 4 slot có bị vượt không? | Không: đếm container chấm đồng thời theo từng giây - **đỉnh 2** ở giai đoạn 2 slot, **đỉnh 4** ở giai đoạn 4 slot |
| Máy 2 lõi có chịu nổi không? | RAM khả dụng đáy **5446 MiB**, **0 restart**, **0 OOM**; load1 đỉnh 5,26 nhưng toàn bộ container cộng lại chỉ ~0,6/2 lõi (xem §7) |
| Có lượt nào kẹt không? | **0** `RESOLVING`, **0** lượt giữ chỗ hàng đợi, **0** dấu quota còn lại sau khi dọn |
| Verdict | **GO**, 12/12 cổng đạt - kèm **5 giới hạn** ở §8 phải đọc trước khi tin số liệu |

## 2. Phát hành

Hai release nối tiếp qua đúng runbook (`main` → PR → `release`, `release-gate` xanh trước merge):

- **Release A** - deployer biết service thứ năm `scoring-worker` (PR #27, #28). Cài deployer đóng
  băng từ SHA này **trước** khi timer nhận Release B, đúng thứ tự bắt buộc ở `docs/DEPLOYMENT.md` §3.3.
- **Release B** - hàng đợi: PR #30 vào `main` (`a31c7af`), rồi PR #31 vào `release`
  (`6ce4ce82a7fa`, merge lúc `2026-09-30T07:43:39Z`). `release-gate`: **backend 809 passed** (82 s),
  frontend (lint + vitest + build + `cf:dry-run`) và deploy-script đều pass.
- Image đang chạy đều ghim đúng SHA đó: `vku-challenge-api:6ce4ce82a7fa`,
  `vku-challenge-runner:6ce4ce82a7fa`, `vku-challenge-web:6ce4ce82a7fa`.
- Cấu hình chấm trên VPS (`/srv/vku-ai-challenge/.env`): `EVALUATOR_MAX_CONCURRENCY=4` và
  `SCORING_WORKER_CONCURRENCY=4`; `SCORING_QUEUE_CAPACITY=20`, `SCORING_DEADLINE_SECONDS=60`,
  `EVALUATOR_TIMEOUT_SECONDS=30` giữ nguyên mặc định của code. Hai service được tạo lại **chỉ**
  `evaluator-runner` + `scoring-worker` bằng đúng lệnh compose của deployer; 13 container còn lại
  không đổi.
- Deployer sau đợt đo vẫn `active` và **đứng yên**: `release vẫn ở 6ce4ce82a7fa`.

## 3. Kết quả từng stage

Mỗi stage là một cuộc thi biệt lập `[LOAD TEST]`, một thí sinh một tài khoản, bắn đúng N request qua
một rào khởi chạy, không retry, poll theo nhịp thật của `SubmissionPage.tsx` (1,5 s). "Nộp" là độ trễ
POST; "kết quả" là từ lúc bấm nộp đến trạng thái cuối.

| run-tag | slot | lượt | nhận | từ chối | trạng thái cuối | nộp p50/p95 | kết quả p50/p95/max |
|---|---|---|---|---|---|---|---|
| qp-1u | 2 | 1 | 1 | 0 | 1 `COMPLETED` | 0,1s/0,1s | 3,6s/3,6s/3,6s |
| qp-peak | 2 | 1 | 1 | 0 | 1 `COMPLETED` | 0,1s/0,1s | 6,5s/6,5s/6,5s |
| qp-10u | 2 | 10 | 10 | 0 | 10 `COMPLETED` | 0,6s/0,8s | 11,4s/17,7s/17,7s |
| qp-15u | 2 | 15 | 15 | 0 | 15 `COMPLETED` | 0,8s/1,1s | 14,3s/23,5s/25,2s |
| qp-20u | 2 | 20 | 20 | 0 | 20 `COMPLETED` | 1,3s/1,8s | 21,3s/33,3s/33,5s |
| qp-20r | 2 | 20 | 20 | 0 | 20 `COMPLETED` | 1,8s/2,1s | 19,3s/30,8s/32,0s |
| qp-24r | 4 | 24 | 20 | 4 `SCORING_QUEUE_FULL` | 20 `COMPLETED` | 2,2s/2,8s | 13,3s/21,2s/22,5s |
| qp-25r | 4 | 25 | 21 | 4 `SCORING_QUEUE_FULL` | 21 `COMPLETED` | 2,1s/2,5s | 13,5s/21,4s/21,6s |
| qp-dl | 4 | 12 | 12 | 0 | 4 `COMPLETED` + 8 `EXPIRED` | 0,6s/0,7s | 28,6s/28,8s/28,8s (lượt xong) |
| qp-dl2 (hạn) | 4 | 12 | 12 | 0 | 4 xong + 8 hết hạn | - | xem §5 |

Mọi lượt được nhận đều đi tới trạng thái cuối; không lượt nào bị bỏ quên. Hai lượt `FAILED` duy nhất
nằm ở **qp-dl** (`08:14:29`, mã `EVALUATOR_UNAVAILABLE`, đã hoàn quota, không ghi bài - xem §8b).

**Số lượt không khớp với bảng trên, và đó là chuyện bình thường.** Driver đếm lượt theo *pha* nó chủ
động bắn (single + concurrent), nhưng mỗi stage còn tạo thêm lượt ở các pha kiểm tra: replay cùng
`Idempotency-Key` (trả `202` nhưng **không** tạo lượt mới) và pha "khôi phục" (nộp một lượt mới rồi
đọc danh sách lượt chưa kết thúc). Đối chiếu ba nguồn độc lập:

| Nguồn | Số | Cách đọc |
|---|---|---|
| Log truy cập `api` | **168** `202` | 159 lượt thật + **9** replay idempotent (một per stage có hàng đợi) |
| Snapshot Mongo trước khi dọn | **159** lượt | 141 `COMPLETED` + 16 `EXPIRED` + 2 `FAILED` |
| Log `scoring-worker` (từ 08:08:11) | **74** lượt đã xử lý | 23 + 24 + 15 + 12 = đúng bốn stage pha 2 (qp-24r, qp-25r, qp-dl, qp-dl2) |

85 lượt còn lại là của bảy stage pha 1 (1/10/15/20 người, 2 slot) - tất cả `COMPLETED`.

**So với trước hàng đợi:** cùng 20 người bấm nộp một lúc, đợt trước (2 slot, từ chối ngay) cho
**2 nhận + 18 `503`**; đợt này cho **20 nhận, 20 xong**, chậm nhất 33,5 s - thí sinh chỉ phải đợi,
không phải bấm lại. Đây là thay đổi sản phẩm mà yêu cầu đặt ra, và nó đã đo được.

## 4. Hàng đợi: chỗ chờ, thứ tự, trần

- **Thứ tự FIFO đo bằng `queue_position`** trả về lúc POST: qp-24r `1,2,3,3,4,4,5,5,6,6,7,7,8,9,9,
  10,10,13,13,15`; qp-25r `1,2,3,3,4,4,6,6,7,7,9,9,10,11,12,12,13,14,16,17`. Vị trí không giảm và
  các số nhảy cách là do lượt phía trước đã được nhấc lên chạy - đúng "chỗ chờ là tài nguyên được
  nhả khi vào chạy", không phải hàng đợi ảo.
- **Trần 20 chờ + 4 chạy = 24 lượt trong hệ thống.** 24 người bấm cùng lúc vẫn thấy 4 `503` vì lúc
  chùm request ập tới, worker chưa kịp nhấc lượt nào (nhịp claim ~1 s), nên cả 24 cùng tranh 20 chỗ
  chờ. 25 người thì một chỗ được nhả kịp nên nhận 21. Đây là hành vi **đúng thiết kế** (trần là trần,
  không phải count-rồi-insert), nhưng là **giới hạn sản phẩm có thật**: bấm cùng lúc quá trần thì vẫn
  phải bấm lại.
- **Lượt bị từ chối không để lại dấu vết nào**: đối chiếu Mongo sau stage - không document
  `scoring_attempts`, không `quota_used`, không file staging.
- **Trần slot không bị vượt ở bất kỳ giây nào**: đếm container `vku-evaluator-*` đang chạy theo từng
  giây từ cgroup: giai đoạn 2 slot **đỉnh 2**, giai đoạn 4 slot **đỉnh 4**, riêng cửa sổ qp-24r và
  qp-dl2 đều **đỉnh 4** - đúng bằng `EVALUATOR_MAX_CONCURRENCY`, không lần nào vượt.

## 5. Hạn 60 giây: ai xong, ai hết hạn, quota hoàn

Stage `qp-dl2`: 12 lượt, mỗi lượt chấm ngủ 25 s, 4 slot, hạn 60 s.

| Nhóm | Số lượt | Đo được |
|---|---|---|
| `COMPLETED` | 4 | xong sau 27,0-28,9 s, tức **còn 30,5-32,7 s** trước hạn; `quota_used=1` |
| `EXPIRED` | 8 | mã `SUBMISSION_EXPIRED`, đóng ở 49,4-51,0 s, tức **sớm 8,5-9,8 s** so với hạn (cửa sổ ghi 10 s của worker); `quota_used=0`, **0 bài** được ghi |

Điều phải hiểu đúng: 20 chỗ chờ **không** hứa 20 lượt cùng thành công trong 60 s. Với bộ chấm 25 s và
4 slot, chỉ 4 lượt đầu kịp; 8 lượt sau hết hạn và được hoàn quota - đúng như thiết kế đã nói trước
khi đo. Con số 60 s là hạn của **trọn** một lượt (nhận request → xếp hàng → chấm → lưu), không phải
thời gian chờ tối đa.

Kiểm chứng độc lập bằng Mongo: 8 lượt `EXPIRED` có `quota_charged=false`, `submission_no=null`, và
**không** submission nào được ghi cho chúng (`expired_wrote_submission: 0`).

## 6. Bất biến quota

Phép kiểm chạy trong container `api`, đối chiếu từng tài khoản: số lượt `quota_charged=true` so với
`competition_memberships.quota_used` cùng ngày UTC.

- qp-dl2: 12/12 tài khoản **đúng** (`quota_used` = 1 với 4 lượt `COMPLETED`, = 0 với 8 lượt `EXPIRED`).
- qp-24r, qp-25r: **0 lệch** - 4 lượt bị `503` không tạo lượt nên không tiêu suất.
- Toàn cục sau đợt đo: `scoring_attempts` 141 `COMPLETED` / 16 `EXPIRED` / 2 `FAILED` = **159 lượt**,
  **0** dấu `quota_claims` còn lại trên membership, **0** lượt còn giữ `queue_slot`.

Một chi tiết của công cụ kiểm phải nói rõ để không đọc sai: script đối chiếu đếm **số lượt** và so với
`quota_used`, nên 8 lượt `EXPIRED` hiện ra là "LỆCH" - đó là giới hạn của phép kiểm (nó không mô hình
hoá việc hoàn quota), không phải sai lệch thật. Bất biến đúng là `quota_used == số lượt charged`, và
nó đúng 159/159.

## 7. Tài nguyên, và cách quy trách nhiệm cho `load1`

Sampler đọc thẳng file cgroup v2 (`memory.current`, `memory.peak`, `cpu.stat`) mỗi giây, không dùng
`docker stats` (bản `--no-stream` trước đó tự nó đã tạo tải giả và làm số đo nhiễu): **881 tick** từ
`07:59:55` đến `08:21:28`, phủ cả hai giai đoạn.

| Chỉ số | Giá trị | Cổng |
|---|---|---|
| load1 đỉnh | **5,26** (trung vị 1,96; 108 tick > 3,5; 78 tick > 4) | cổng < 4 → **vượt** |
| RAM khả dụng đáy | **5446 MiB** (trung vị 5679 MiB) | cổng > 2 GiB → đạt |
| Restart / OOM | **0 / 0** trên mọi container | đạt |
| Container chấm đồng thời | đỉnh 2 (2 slot) rồi đỉnh 4 (4 slot) | đạt |

**`load1` vượt cổng là do chính máy phát tải, không phải do đường chấm.** Cửa sổ đỉnh là
`08:12:14-08:12:36` (stage 24-25 người), và trong đúng cửa sổ đó, cộng **toàn bộ** container trên máy:

| Container | Nhịp CPU trong cửa sổ đỉnh |
|---|---|
| `api` (gồm cả 24-25 luồng driver chạy bằng `docker exec`) | 0,323 core |
| `mongo` | 0,130 core |
| `evaluator-runner` | 0,023 core |
| `scoring-worker` | 0,022 core |
| `minio`, `cloudflared`, `web`, `ai-review-worker`, `coresearch-*` | 0,08 core |
| **tổng** | **~0,6 / 2 lõi** |

Container chấm dùng một lần: **đỉnh RSS 6,9 MiB, CPU ~0,00 core-s mỗi container**. Nguồn của `load1`
là phần không nằm trong container nào: 24-25 luồng driver Python + hàng chục lượt tạo/huỷ container
trong vài phút (docker daemon, overlay mount) + chính sampler 1 Hz. Nói cách khác: **đường chấm không
tạo ra độ dài hàng đợi đó**, và đợt đo này không trả lời được câu "bộ chấm thật ăn bao nhiêu CPU trên
máy 2 lõi" - xem §8a.

Ghi chú kỹ thuật để lần sau đọc lại được: sampler 1 Hz bỏ sót container sống ngắn, nên **93** container
chấm quan sát được là **cận dưới** của 141 lượt `COMPLETED` - không được đọc 93 thành "số lượt chấm".

## 8. Những chỗ còn thiếu và giới hạn

**(a) Bộ chấm thử vẫn là `sleep`, nên đợt này đo đường ống chứ không đo chi phí chấm thật.** Mọi số
độ trễ ở §3 là **sàn**. Con số duy nhất đang có cho bộ chấm thật (pandas + scikit-learn, 60 000 dòng)
là cổng tài nguyên trên **máy dev** (ADR-048): 6,1-7,4 s CPU, 145-192 MiB RSS mỗi lượt, 4 lượt đồng
thời trên 2 lõi xong trong 7,2-7,5 s (+18% so với chạy một mình). Máy production chỉ có 2 lõi và **chưa
có cuộc thi v2 nào** (cuộc thi thật duy nhất, `tabular-lightweight`, chấm bằng v1 **trong tiến trình**,
không sinh container chấm), nên 4 slot hiện chưa có phơi nhiễm thật. **Điều kiện đo lại:** khi cuộc
thi v2 đầu tiên có bộ chấm nặng được đưa lên, đo lại CPU/RAM với chính bộ chấm đó trước khi tin 4 slot.

**(b) Hai lượt `FAILED` trong qp-dl là một hạn chế đã biết, không phải hồi quy.** Bằng chứng: log
worker `08:14:29` ghi hai `POST http://evaluator-runner:8100/evaluate → 503 Service Unavailable` rồi
ngay sau đó `attempt=6abcc4e436c0c33960d2de27 outcome=FAILED` và `attempt=…de28 outcome=FAILED`. Cơ
chế: worker cắt `client_timeout` theo thời gian còn lại, nên khi gần hạn nó bỏ dở lượt gọi runner;
container chấm của lượt đó vẫn chạy tới hạn riêng của nó và **giữ một slot** của runner, nên lượt kế
tiếp nhận `503 EVALUATOR_UNAVAILABLE` - và vì lượt này còn nhiều thời gian, nó thành `FAILED` chứ
không phải `EXPIRED`. Cả hai lượt đều được **hoàn quota** và không ghi bài nào. Sửa được, nhưng phải
đổi code + test, nên đợt này chỉ ghi nhận.

**(c) Chùm request nhanh hơn nhịp claim vẫn thấy `503`.** Xem §4: trần 20 chỗ chờ là trần thật. Muốn
"24 người cùng lúc, không ai phải bấm lại" thì phải nâng `SCORING_QUEUE_CAPACITY`, và đó là quyết định
dung lượng, không phải sửa lỗi.

**(d) Log chẩn đoán bị cụt.** `evaluator_client` ghi `"Không gọi được runner chấm điểm: %s"` với
`str(httpx.ReadTimeout)` **rỗng**, nên log hiện ra dấu hai chấm rồi hết - 8 lượt hết hạn ở qp-dl2 đều
đi qua đường này. Đổi sang `%r` là một dòng, nhưng cần một release mới; chưa làm trong đợt này.

**(e) Máy phát tải dùng chung đường mạng với origin**, nên độ trễ tuyệt đối lạc quan hơn thí sinh ở xa.

## 9. Dọn dẹp và chứng minh dọn dẹp

- **10 cuộc thi `[LOAD TEST]` đã xoá** (`qp-1u`, `qp-peak`, `qp-10u`, `qp-15u`, `qp-20u`, `qp-20r`,
  `qp-24r`, `qp-25r`, `qp-dl`, `qp-dl2`); mỗi lượt xoá trả `{"deleted": true, "files_removed": true}`
  - cascade dọn cả `scoring_attempts`, membership, artifact và file staging MinIO. Driver **từ chối
  xoá** nếu tên cuộc thi không mang dấu `[LOAD TEST]`.
- **188 tài khoản diễn tập → 0 còn hoạt động** (vô hiệu hoá, **không** xoá); admin tạm
  `drill-admin-qp@loadtest.example.com` cũng đã vô hiệu hoá bằng đúng hai field mà endpoint
  `set_active` ghi.
- **Hậu kiểm Mongo chỉ-đọc sau dọn:** 0 cuộc thi `loadtest-*`, 0 `scoring_attempts`, 0 dấu
  `quota_claims`, 0 lượt giữ `queue_slot`; dữ liệu thật nguyên vẹn: **1 cuộc thi**
  (`tabular-lightweight`), **1 tài khoản thật + 188 diễn tập (đều inactive)**, **3 bài nộp thật**.
- **Script và credential của diễn tập đã xoá khỏi VPS và khỏi container `api`** (`/tmp/queue_e2e.py`,
  `/tmp/e2e-evidence`, các script kiểm tra, sampler, `/root/vku-drill-admin.env`,
  `/root/env.before-phase2`); sampler đã dừng; không còn container `vku-evaluator-*` nào sót.
- Không dùng `docker compose down -v`, không đụng `/srv/vku-ai-challenge/data`.

## 10. Trạng thái production sau đợt này

- **15/15 container `healthy`** (10 của VKU + 5 của `coresearch-*`), 0 restart, 0 OOM.
- Image ghim `6ce4ce82a7fa`; deployer `active`, mỗi phút báo `release vẫn ở 6ce4ce82a7fa` (không có
  gì mới để triển khai).
- `/srv/vku-ai-challenge/.env`: 4 slot (`EVALUATOR_MAX_CONCURRENCY=4`, `SCORING_WORKER_CONCURRENCY=4`)
  - **giữ lại có chủ ý**, kèm điều kiện đo lại ở §8a. Hạ về 2 slot là đổi đúng hai dòng đó rồi tạo lại
  `evaluator-runner` + `scoring-worker`.
- Không còn dấu vết nào của diễn tập trên máy (xem §9).

## 11. Cổng go/no-go

| # | Cổng | Kết quả |
|---|---|---|
| 1 | Mọi lượt được nhận đều tới trạng thái cuối, không lượt mồ côi | đạt |
| 2 | Lượt vượt trần bị từ chối bằng đúng `SCORING_QUEUE_FULL`, không tạo document | đạt |
| 3 | Thứ tự chờ FIFO, không chen | đạt |
| 4 | Quá hạn 60 s → `EXPIRED`, hoàn quota, không ghi bài | đạt |
| 5 | `quota_used` khớp số lượt charged trên từng tài khoản | đạt |
| 6 | Trần slot không bị vượt ở bất kỳ giây nào | đạt |
| 7 | Không còn `RESOLVING` / lượt kẹt / chỗ chờ bị giữ sau đợt | đạt |
| 8 | RAM khả dụng không xuống dưới 2 GiB | đạt (đáy 5446 MiB) |
| 9 | 0 restart, 0 OOM, healthcheck xanh suốt | đạt |
| 10 | `release-gate` xanh trên commit đã phát hành | đạt (backend 809 passed) |
| 11 | Dọn sạch, dữ liệu thật không đổi | đạt |
| 12 | `load1` đỉnh dưới 4 | **không đạt - 5,26**, quy được cho máy phát tải (§7), không phải đường chấm |

**Verdict: GO.** Cổng 12 là cổng duy nhất không đạt, và nó không đạt vì chính dụng cụ đo: trong đúng
cửa sổ đỉnh, toàn bộ container cộng lại dùng ~0,6/2 lõi, còn container chấm thì ~0 CPU. Không có bằng
chứng nào cho thấy đường chấm gây quá tải, nhưng cũng **không** có số đo bộ chấm thật trên máy 2 lõi -
đó là lý do §8a là điều kiện bắt buộc trước khi tin cấu hình 4 slot cho một bộ chấm nặng.

## 12. Bằng chứng thô và cách đối chiếu lại

- Bộ sinh tải là script `/tmp` **không nằm trong repo** (đúng nguyên tắc của các đợt trước); bằng chứng
  JSON của từng stage (`summary.json` + `requests.ndjson`) nằm ngoài repo, chỉ số tổng hợp được ghi ở
  đây.
- Đối chiếu lại từ Mongo (chỉ đọc, chạy trong container `api`): đếm `scoring_attempts` theo trạng thái,
  đếm lượt còn giữ `queue_slot`, đếm dấu `quota_claims`, và join từng tài khoản với
  `competition_memberships.quota_used`.
- Đối chiếu lại từ log: `docker logs vku-challenge-scoring-worker-1` (outcome từng lượt),
  `docker logs vku-challenge-evaluator-runner-1` (503 khi hết slot), `docker logs vku-challenge-api-1`
  (mã lỗi trả cho thí sinh).
- Số đo tài nguyên: file sampler cgroup v2 (1 Hz) - đọc lại bằng chính các file
  `/sys/fs/cgroup/system.slice/docker-<id>.scope/{memory.peak,cpu.stat}` nếu cần kiểm chứng.

## 13. Khuyến nghị

1. **Giữ 4 slot**, kèm điều kiện ở §8a: cuộc thi v2 đầu tiên có bộ chấm nặng phải được đo lại
   CPU/RAM trên chính máy 2 lõi trước khi tin cấu hình này. Trên máy chỉ 2 lõi, tăng slot **không**
   làm tăng thông lượng khi bộ chấm ngốn CPU - nó chỉ làm tăng độ sâu hàng đợi; giá trị thật của 4 slot
   nằm ở bộ chấm bị chặn bởi độ trễ (mạng, I/O) như bộ chấm thử.
2. Sửa một dòng log `%s` → `%r` ở `evaluator_client` (§8d) trong lần đụng code tiếp theo.
3. Ghi lại hạn chế container mồ côi giữ slot (§8b) như một việc có tên trong `docs/PROJECT_STATE.md`,
   để lần sau không ai phải dò lại từ log.
4. Nếu người dùng thật phàn nàn "bấm cùng lúc vẫn phải bấm lại", nâng `SCORING_QUEUE_CAPACITY` (20)
   là đòn rẻ nhất - trần chỗ chờ là một con số cấu hình, không phải ràng buộc kỹ thuật.
