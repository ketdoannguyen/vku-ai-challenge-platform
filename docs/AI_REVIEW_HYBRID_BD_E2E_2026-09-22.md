# Chiến dịch E2E AI Notebook Review sau Hybrid B + D

**Ngày:** 2026-09-22
**Trạng thái:** Đã chạy xong trên provider thật, queue thật, worker thật; **không mock, không fake**
**Phạm vi:** 25/25 notebook của `ai_challenge_testcases_extended.zip`
**Đối tượng đọc:** Ban Tổ chức, Product Owner, lập trình viên
**Báo cáo trước (baseline):** `docs/AI_REVIEW_DEEP_ANALYSIS_2026-09-22.md`
**Quyết định kiến trúc:** ADR-045 trong `docs/DECISIONS.md`

---

## 1. Kết quả trong một bảng

| Chỉ số | Trước (prompt v4, verifier v1) | Sau (prompt v5, verifier v2) |
|---|---|---|
| Kết luận cuối đúng theo strict mapping | **13/25 — 52%** | **25/25 — 100%** |
| Case vi phạm ra `FLAGGED` | 8/20 | **20/20** |
| Case sạch ra `CLEAR` | 5/5 | **5/5** |
| Vi phạm bị hạ thành `INCONCLUSIVE` | 12/20 — 60% | **0** |
| Finding đối chiếu được quy định | 46/115 — 40% | **158/158 — 100%** |
| Finding `traceable` | 0 (mọi `FLAGGED` đều bị hạ) | **44** |
| Lượt lỗi | 0 | **0** |

Đây là cùng một bộ 25 notebook, cùng ground truth, cùng tiêu chí chấm. Khác biệt duy nhất là hợp
đồng trích dẫn quy định giữa model và backend.

### 1.1 Ma trận nhầm lẫn

**Trước**

| Kỳ vọng \ Kết luận | CLEAR | FLAGGED | INCONCLUSIVE |
|---|---|---|---|
| 20 FAIL | 0 | 8 | 12 |
| 5 PASS | 5 | 0 | 0 |

**Sau**

| Kỳ vọng \ Kết luận | CLEAR | FLAGGED | INCONCLUSIVE |
|---|---|---|---|
| 20 FAIL | 0 | **20** | 0 |
| 5 PASS | **5** | 0 | 0 |

---

## 2. Vì sao trước đây mất 12 kết luận

Model nhận đúng cả 25/25, nhưng backend hậu kiểm bằng cách **tìm chuỗi con gần-nguyên-văn** của
Markdown thô. Chỉ cần model bỏ `**bold**`, bỏ backtick, bỏ bullet hoặc ghép heading với nội dung là
không tìm thấy quy định — và khi rule không khớp thì backend **không kiểm bằng chứng và hạ verdict**.

Hệ quả: 60% vi phạm bị biến thành “Chưa đủ căn cứ” dù model đã chỉ đúng. Ban Tổ chức nhìn danh sách
`FLAGGED` sẽ bỏ sót 12 bài thật sự vi phạm.

Hybrid B + D thay cách đối chiếu đó:

- **B** — chuẩn hóa tất định (Unicode NFC, bỏ marker trình bày, unwrap inline) để `rule_quote` của
  model và block nguồn so sánh được với nhau; **không fuzzy, không edit-distance, không embedding**.
- **D** — backend tự sinh `rule_ref` từ revision bất biến và đưa ref đó vào prompt. Model chỉ nhắc lại
  một ID; title, slug và văn bản luật luôn do backend điền lại từ revision.

---

## 3. Chiến dịch đã chạy

### 3.1 Môi trường

- Stack Compose dev (`api`, `ai-review-worker`, `web`, `mongo`, `minio`), ảnh build từ cây làm việc
  đang chứa Hybrid B + D.
- Provider thật đã cấu hình sẵn trên hệ thống; harness chỉ đọc cấu hình đang lưu, không nhập lại key.
- Sáu version ghi trên mọi audit row:
  `prompt=ai-review-v5`, `normalization=notebook-v2`, `context_policy=context-v2`,
  `canonicalization=rule-text-v1`, `rule_ref=rule-ref-v1`, `verifier=verifier-v2`.
- Mỗi lượt đều là **manual rerun** với `bypass_cache=true` trên đúng revision ban đầu, nên không có
  kết luận nào đến từ cache cũ.

### 3.2 Cách chạy

Harness: `backend/scripts/ai_review_e2e.py`.

```bash
# Bước 1 — smoke 5 case trên competition C (nhiều kiểu Markdown nhất)
uv run python backend/scripts/ai_review_e2e.py \
  --archive ai_challenge_testcases_extended.zip --run-tag hybrid-bd-smoke-20260922 \
  --competition ai-review-real-c-20260922 \
  --case C/case_01.ipynb ... --case C/case_05.ipynb

# Bước 2 — đủ 25 case, một campaign trên cùng một version code
uv run python backend/scripts/ai_review_e2e.py \
  --archive ai_challenge_testcases_extended.zip --run-tag hybrid-bd-20260922 \
  --competition ai-review-real-a-20260922 ... --competition ai-review-real-e-20260922
```

Tài khoản admin và Mongo URI truyền qua tham số/biến môi trường; harness **không** suy Mongo URI từ
`.env` vì cổng trong `.env` là cổng nội bộ mạng Compose, suy diễn sai nghĩa là đọc nhầm môi trường.
Không có mật khẩu, key, raw prompt hay raw response nào được ghi ra đĩa.

### 3.3 Smoke 5 case (bước chặn lỗi sớm)

| Chỉ số | Giá trị |
|---|---|
| Đúng | **5/5** |
| Hạ cấp | 0 |
| Finding resolve bằng `REFERENCE` | 23/23 |
| Token | 16.026 |
| Thời gian | tổng 27,9 s · lâu nhất 7,1 s |

Smoke đã phát hiện đúng một lỗi thật của **harness** (không phải của hệ thống): hàm dựng lại dòng
kết quả đọc NDJSON sai kiểu, làm bước tổng hợp báo cáo nổ sau khi 5 case đã chạy xong. Đã sửa, bổ
sung test khoá đúng hình dạng trên đĩa, và chạy lại nhánh `--resume` để chứng minh báo cáo dựng lại
được từ đĩa mà không gọi lại provider. Đây là lý do quy trình chạy smoke trước.

### 3.4 Campaign 25 case

| Chỉ số | Giá trị |
|---|---|
| Terminal | **25/25** |
| Lỗi | **0** |
| Nguồn | **25 PROVIDER · 0 CACHE** |
| Token | 119.212 |
| Thời gian | tổng 235,4 s · lâu nhất 22,1 s |

---

## 4. Các cổng bắt buộc

| Cổng | Kết quả | Bằng chứng |
|---|---|---|
| 25/25 terminal, không case nào lỗi | ĐẠT | `summary.json` |
| Mọi lượt từ provider, không phải cache | ĐẠT | `source=PROVIDER`, `bypass_cache=true` |
| 20/20 FAIL → `FLAGGED` | ĐẠT | ma trận nhầm lẫn §1.1 |
| 5/5 PASS → `CLEAR` | ĐẠT | ma trận nhầm lẫn §1.1 |
| 0 hạ cấp do định dạng Markdown | ĐẠT | `downgraded = 0` |
| Mọi `FLAGGED` có ≥1 finding `traceable` | ĐẠT | 44 finding `traceable` |
| Cổng `traceable` không bị nới | ĐẠT | `traceable = verified ∧ VIOLATION ∧ CHECKABLE`, giữ nguyên |
| Chuỗi SHA archive = submission = audit row | ĐẠT | 25/25 khớp |
| Sáu version đúng trên mọi lượt | ĐẠT | audit row 25/25 |
| Không notebook bị cắt | ĐẠT | `truncated = 0` |
| Stored rule/title/slug đến từ revision, không từ prose model | ĐẠT | §4.1 - 181 finding, 100% khớp nguyên văn |
| Participant payload đúng bốn khóa, không lộ field AI | ĐẠT | §4.2 - gọi API thật bằng phiên thí sinh |

### 4.1 Kiểm provenance trực tiếp trên revision thật

Báo cáo tự nó không đủ để khẳng định "văn bản luật lưu trữ đến từ revision". Đã kiểm riêng, chỉ đọc,
trên 30 audit row v5 (25 campaign + 5 smoke):

- 181 finding có `rule_ref`; dựng lại `RuleIndex` từ đúng revision mà audit row trỏ tới.
- **100%** `rule_text` đã lưu bằng **nguyên văn** block trong revision.
- **100%** `source_content_slug` khớp slug trang trong revision.
- Mọi finding `traceable` đều có snippet do backend dựng lại.

Nếu verifier lỡ tin câu chữ model gửi, phép đo này đã trượt.

### 4.2 Kiểm projection của thí sinh trên dữ liệu thật

Gọi thẳng API bằng phiên của đội sở hữu bài nộp, trên chính competition vừa chạy campaign
(`participant_visible: true`): 5/5 bài nộp trả về `ai_review` với **đúng bốn khóa**
`{state, verdict, summary, updated_at}`. Không có `findings`, `rule_ref`, `evidence`, `rule_text`,
`provider`, `model`, `base_url`, `api_key` hay bất kỳ field version nào trong toàn bộ payload.

### 4.3 Kiểm rò rỉ

Quét toàn bộ `data/ai-review-e2e/**`: không có mật khẩu, API key, `Authorization`, `Bearer`, raw
prompt hay raw response. Báo cáo tổng hợp chỉ chứa số, mã và tên case — kiểu dữ liệu `Row` không có
trường văn bản tự do nào, và có test khoá tính chất đó.

---

## 5. Đọc kết quả này cho đúng

**Điều đã chứng minh.** Trên đúng bộ 25 notebook và đúng tiêu chí chấm, Hybrid B + D giữ được toàn bộ
20 kết luận vi phạm mà trước đây bị hạ, không nới bất kỳ cổng an toàn nào, và mọi văn bản luật lưu
trữ đều truy được về revision.

**Điều chưa chứng minh.**

- Chỉ chạy **một** campaign. Chưa đo phương sai giữa các lần chạy; 25/25 là kết quả của một lần.
- Tỉ lệ "46/115 → 158/158" **không** phải cùng một phép đo. Con số cũ đếm khớp chuỗi con trên Markdown
  thô; con số mới đếm resolve `rule_ref` chính xác. Phép đo mới chặt hơn (ID mờ, không substring),
  nhưng mẫu số cũng khác vì prompt v5 chỉ ưu tiên finding `VIOLATION`/`UNCLEAR` thay vì liệt kê mọi
  quy định tuân thủ.
- Chạy trên stack dev, chưa phải production.
- Chưa có case nào rơi vào `NOT_CHECKABLE_FROM_NOTEBOOK` hay `UNCLEAR` trong bộ này, nên các nhánh đó
  chỉ được phủ bằng unit test, không phải bằng dữ liệu thật.
- Nhánh `--resume` mới chạy ở smoke, chưa chạy giữa campaign 25 case.

**Dữ liệu thô.** `data/ai-review-e2e/hybrid-bd-20260922/` (`rows.ndjson`, `summary.json`,
`report.md`), gitignored. Audit row trong Mongo **không bị xoá**; các competition test được giữ nguyên
để đối chiếu trước/sau.

---

## 6. Bằng chứng tự động kèm theo

| Kiểm tra | Kết quả |
|---|---|
| `uv run pytest -q` (backend) | **675 passed** — 208,55 s |
| `npm test -- --maxWorkers=1` (frontend) | **491 passed** (34 file) — 120 s |
| `npx tsc -b` | exit 0 |
| `npm run lint` | 0 error, 25 warning có sẵn |
| `npm run build` | OK |
| `docker compose config --quiet` | OK |

25 test của harness (`tests/test_ai_review_e2e_harness.py`) khoá phần thuần: ánh xạ nghiêm ngặt
(`INCONCLUSIVE` trên case FAIL là **sai**), chuỗi SHA ba mắt xích, dừng lại khi một notebook khớp
nhiều bài nộp, và hình dạng dòng ghi ra đĩa.
