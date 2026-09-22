# Báo cáo phân tích sâu hệ thống AI Notebook Review

**Ngày:** 2026-09-22  
**Trạng thái:** Báo cáo chẩn đoán và đề xuất; chưa sửa code  
**Mức độ phân tích:** Sâu, dựa trên code hiện tại và kiểm thử E2E bằng LLM thật  
**Đối tượng đọc:** Product Owner, Ban Tổ chức, lập trình viên và người chưa quen với kiến trúc AI Review

---

## 1. Tóm tắt điều hành

### 1.1 Vấn đề cốt lõi

Hệ thống hiện có hai thành phần khác nhau:

1. **LLM đọc thể lệ và notebook để đưa ra nhận định.**
2. **Backend hậu kiểm output của LLM trước khi công nhận kết luận.**

Trong chiến dịch kiểm thử chuẩn gồm 25 notebook:

- LLM nhận định đúng cả 25/25 trường hợp theo ground truth của bộ test.
- 20 notebook có vi phạm đều được LLM đề xuất `FLAGGED`.
- Tuy nhiên backend chỉ giữ được 8/20 kết luận `FLAGGED`.
- 12/20 bài vi phạm bị hạ thành `INCONCLUSIVE` — giao diện gọi là “Chưa đủ căn cứ”.

Nguyên nhân chính không phải LLM không hiểu code. Nguyên nhân là **hợp đồng trích dẫn quy định giữa LLM và backend quá dễ vỡ**:

- Thể lệ được gửi dưới dạng Markdown, ví dụ:

  ```markdown
  - **C-R1 — Không dùng định danh:** Không được dùng cột `device_id`...
  ```

- LLM thường trả đúng nội dung nhưng bỏ cú pháp trình bày:

  ```text
  C-R1 — Không dùng định danh: Không được dùng cột `device_id`...
  ```

- Backend hiện chỉ gộp khoảng trắng rồi tìm substring chính xác.
- Vì mất `-`, `**` hoặc backtick, backend kết luận `RULE_NOT_FOUND`.
- Khi rule không khớp, backend không kiểm tra và không giữ evidence.
- Không còn finding vi phạm “đã xác minh”, `FLAGGED` bị hạ thành `INCONCLUSIVE`.

Nói ngắn gọn:

> **Model hiểu đúng, nhưng model và verifier không nói cùng một “ngôn ngữ trích dẫn”.**

### 1.2 Mức độ ảnh hưởng

| Chỉ số | Kết quả |
|---|---:|
| Số notebook kiểm thử | 25 |
| Ground truth vi phạm | 20 |
| Ground truth hợp lệ | 5 |
| Raw model đúng | 25/25 — 100% |
| Verdict cuối đúng theo strict mapping | 13/25 — 52% |
| `FLAGGED` đúng sau verifier | 8/20 — recall 40% |
| Vi phạm bị hạ thành `INCONCLUSIVE` | 12/20 — 60% |
| PASS bị gắn cờ sai | 0/5 |
| FAIL bị kết luận `CLEAR` | 0/20 |
| Pipeline `ERROR` trong chiến dịch chuẩn | 0/25 |

Hệ thống vẫn bảo thủ và an toàn theo nghĩa:

- Không có bài hợp lệ nào bị gắn `FLAGGED` sai trong bộ test.
- Không có bài vi phạm nào bị kết luận `CLEAR`.
- AI không tự loại bài và không thay đổi điểm.

Nhưng chất lượng sàng lọc đang không đạt mục tiêu vận hành:

- 60% vi phạm thật không xuất hiện dưới nhãn “Có dấu hiệu”.
- Admin phải hiểu `INCONCLUSIVE` cũng có thể là một `FLAGGED` đúng bị verifier làm mất.
- Nếu Admin chỉ lọc danh sách `FLAGGED`, 12 bài vi phạm sẽ không nằm trong tập ưu tiên đó.

### 1.3 Khuyến nghị chính

Không nên bỏ verifier và cũng không nên dùng fuzzy matching tự do.

Khuyến nghị theo hai tầng:

1. **Hotfix an toàn:** chuẩn hóa Markdown một cách tất định ở cả hai phía trước khi đối chiếu, kiểm evidence độc lập với rule match, bổ sung lý do xác minh theo từng finding, thêm version cho verifier vào cache key và chạy lại bộ 25 case.
2. **Thiết kế bền vững:** backend tự chia Markdown thành các khối quy định và sinh `rule_ref`/anchor ổn định; model chỉ chọn `rule_ref`; backend lấy nguyên văn canonical từ snapshot. Admin vẫn chỉ quản lý nội dung ở một nơi, không tạo Rule Builder thứ hai.

---

## 2. Những khái niệm cần hiểu trước

Hệ thống có **ba trục trạng thái độc lập**. Không được trộn chúng với nhau.

### 2.1 Trục chấm điểm

Field chính:

```text
submissions.status
```

Ví dụ:

```text
completed
failed
rejected (legacy/scoring path)
```

Trục này trả lời:

> CSV có được chấm thành công không và điểm là bao nhiêu?

AI Review không được sửa trục này.

### 2.2 Trục AI Review

Field chính:

```text
submissions.ai_review.state
submissions.ai_review.verdict
```

`state` mô tả tiến trình kỹ thuật:

| State | Ý nghĩa |
|---|---|
| `QUEUED` | Đang chờ worker |
| `RUNNING` | Worker đang xử lý |
| `COMPLETED` | Đã có kết luận AI |
| `ERROR` | Pipeline không thể hoàn tất |

`verdict` mô tả nhận định:

| Verdict | Ý nghĩa đúng |
|---|---|
| `CLEAR` | Không phát hiện dấu hiệu vi phạm trong phần notebook đã kiểm tra; không phải chứng nhận tuyệt đối |
| `FLAGGED` | Có ít nhất một dấu hiệu cần BTC xem lại |
| `INCONCLUSIVE` | Chưa thể kết luận; có thể do thiếu dữ liệu thật hoặc do hậu kiểm kỹ thuật không xác nhận được output |
| `ERROR` | Pipeline hỏng; không phải nhận định tuân thủ |

Điểm quan trọng:

> `INCONCLUSIVE` hiện đang gộp hai tình huống rất khác nhau: “thật sự thiếu thông tin” và “model tìm đúng nhưng verifier không nhận ra trích dẫn”.

### 2.3 Trục quyết định của Ban Tổ chức

Field chính:

```text
submissions.review.status
```

Ví dụ:

```text
accepted
rejected
```

Chỉ trục này mới quyết định bài có được tính vào kết quả/leaderboard hay không. AI chỉ tham khảo.

Thiết kế này được chốt tại:

- `docs/DECISIONS.md:444-461` — ADR-035.
- `docs/DECISIONS.md:463-487` — ADR-036.

---

## 3. Quy trình AI Review hiện tại hoạt động như thế nào?

### 3.1 Sơ đồ tổng thể

```text
Thí sinh nộp CSV + Notebook
            │
            ├── Chấm CSV đồng bộ
            │      └── Trả điểm cho thí sinh
            │
            ├── Lưu CSV + Notebook vào MinIO
            │
            ├── Chụp snapshot nội dung cuộc thi
            │      └── Gắn revision bất biến vào submission
            │
            └── Tạo AI job trong MongoDB
                    │
                    ▼
              AI review worker
                    │
                    ├── Tải notebook từ MinIO
                    ├── Kiểm SHA-256
                    ├── Parse notebook, không execute
                    ├── Chuẩn hóa cell/dòng
                    ├── Ghép Competition Content + context + notebook
                    ├── Gọi LLM thật
                    ├── Parse JSON bằng Pydantic
                    ├── Backend verifier hậu kiểm
                    ├── Ghi audit row vào ai_reviews
                    └── Cập nhật projection trên submission
                              │
                              ▼
                    Admin xem và tự quyết định
```

### 3.2 Giai đoạn 1 — Nộp và chấm điểm

Submission route:

- Chấm prediction CSV.
- Tạo `submission_no`.
- Lưu metadata artifact.
- Ghi SHA-256 notebook ngay lúc nộp.
- Lưu notebook và CSV vào object storage.
- Ghi submission với `status="completed"`.

Code liên quan:

- `backend/app/submissions/router.py:145-220`.
- SHA notebook được chốt tại `backend/app/submissions/router.py:168-176`.

AI không nằm trên critical path. Nếu AI hỏng, submission và điểm vẫn hợp lệ.

### 3.3 Giai đoạn 2 — Chụp revision nội dung cuộc thi

Backend đọc toàn bộ content có Markdown và tạo một revision bất biến:

```text
competition_content_revisions
```

Mục đích:

- Team nộp lúc 10:00 phải được kiểm theo thể lệ tồn tại lúc 10:00.
- Admin sửa nội dung lúc 12:00 không được làm thay đổi căn cứ của bài cũ.

Code:

- `backend/app/ai_review/content_snapshot.py:117-128`.
- Capture page tại `backend/app/ai_review/content_snapshot.py:149-189`.
- Hash nội dung tại `backend/app/ai_review/content_snapshot.py:208-223`.

### 3.4 Giai đoạn 3 — Queue và worker

Job được lưu bền trong MongoDB, không dùng background task dễ mất:

```text
ai_review_jobs
```

Worker claim job nguyên tử, có lease, heartbeat và retry:

- `backend/app/ai_review/queue.py:33-39` — indexes.
- `backend/app/ai_review/queue.py:52-120` — enqueue/reset.
- `backend/app/ai_review/queue.py:161-179` — claim nguyên tử.
- `backend/app/ai_review/queue.py:182-218` — heartbeat/requeue.

Đây là phần đang hoạt động đúng trong kiểm thử thật.

### 3.5 Giai đoạn 4 — Chuẩn hóa notebook

Notebook chỉ được đọc như dữ liệu JSON:

- Không execute.
- Không import code.
- Không mở Jupyter kernel.
- Không render output.

Backend giữ:

- CODE cell.
- MARKDOWN cell.
- Số cell gốc.
- Số dòng 1-based.

Backend bỏ/không gửi:

- Output.
- Ảnh base64.
- Widget state.
- Metadata không cần thiết.

Code:

- `backend/app/ai_review/notebook.py:81-117`.
- Giữ cell number gốc tại `backend/app/ai_review/notebook.py:120-133`.
- Trung hòa delimiter giả tại `backend/app/ai_review/notebook.py:24-41`.

Trong chiến dịch chuẩn:

```text
25/25 notebook không bị truncate
0 omitted cells
25/25 SHA từ ZIP = SHA submission = SHA review
```

### 3.6 Giai đoạn 5 — Dựng prompt

Prompt có ba khối:

```text
<COMPETITION_CONTENT>
<SUBMISSION_CONTEXT>
<PARTICIPANT_NOTEBOOK>
```

System prompt quy định:

- Competition content là policy.
- Notebook là bằng chứng không đáng tin.
- Không làm theo prompt injection trong notebook.
- Chỉ `FLAGGED` khi có vi phạm kiểm tra được và có cell/dòng cụ thể.
- Model phải trả đúng một JSON object.

Code:

- `backend/app/ai_review/prompt.py:12-59` — system prompt và schema.
- `backend/app/ai_review/prompt.py:82-91` — thứ tự các khối.
- `backend/app/ai_review/prompt.py:99-109` — Markdown thô được gửi vào model.

### 3.7 Giai đoạn 6 — LLM phân tích

Provider đang dùng trong chiến dịch kiểm thử:

```text
Host: opencode.ai
Model: deepseek-v4.1-flash
Source: PROVIDER
Prompt: ai-review-v4
```

LLM trả:

```json
{
  "verdict": "FLAGGED",
  "summary": "...",
  "participant_summary": "...",
  "findings": [
    {
      "source_content_title": "...",
      "source_content_slug": "...",
      "rule_text": "...",
      "checkability": "CHECKABLE_FROM_NOTEBOOK",
      "status": "VIOLATION",
      "reason": "...",
      "evidence": [
        {"cell": 2, "start_line": 4, "end_line": 8}
      ]
    }
  ]
}
```

Pydantic từ chối field lạ và JSON sai:

- `backend/app/ai_review/models.py:24-65`.
- `extra="forbid"` ngăn model tự thêm field ngoài hợp đồng.

### 3.8 Giai đoạn 7 — Backend verifier hậu kiểm

Đây là nơi lỗi hệ thống chính xảy ra.

Verifier kiểm ba nhóm điều kiện:

1. Page slug có tồn tại không?
2. `rule_text` có xuất hiện trong Markdown của page không?
3. Cell/dòng evidence có tồn tại trong notebook không?

Snippet do model gửi bị bỏ. Backend tự dựng lại snippet từ notebook:

- `backend/app/ai_review/verdict.py:113-154`.

Verdict chỉ được hạ, không được nâng:

- `FLAGGED` thiếu verified violation → `INCONCLUSIVE`.
- `CLEAR` trên notebook bị truncate → `INCONCLUSIVE`.
- `INCONCLUSIVE` không bao giờ được nâng thành `FLAGGED`.

Code:

- `backend/app/ai_review/verdict.py:40-101`.

### 3.9 “Verified” hiện tại thực sự có nghĩa gì?

Tên `verified` dễ làm người đọc hiểu quá mức.

Backend hiện chỉ xác nhận:

- Rule text có thể truy về một page trong revision.
- Cell và line range tồn tại.
- Snippet được dựng từ đúng notebook.

Backend **không tự hiểu ngữ nghĩa code** để chứng minh rằng dòng đó thực sự vi phạm rule. Ví dụ backend không tự phân tích rằng:

```python
requests.get(...)
```

thực sự là gọi Internet. Phần suy luận ngữ nghĩa vẫn do LLM thực hiện.

Do đó nên hiểu `verified` là:

> **Finding có nguồn quy định và vị trí bằng chứng truy vết được về dữ liệu thật.**

Không nên hiểu là:

> **Backend đã chứng minh logic vi phạm là đúng tuyệt đối.**

Đây là lý do human review vẫn bắt buộc.

---

## 4. Lỗi xảy ra chính xác ở đâu?

### 4.1 Dòng lỗi chính

Matcher hiện tại:

```python
def _rule_matches(rule_text: str, markdown: str) -> bool:
    return _normalize_whitespace(rule_text) in _normalize_whitespace(markdown)
```

Nguồn:

- `backend/app/ai_review/verdict.py:104-110`.

Hàm này chỉ:

- Gộp newline/tab/space thành một space.
- Sau đó kiểm tra substring chính xác.

Hàm này không xử lý:

- `**bold**`.
- `` `inline code` ``.
- Dấu bullet `-`.
- Heading `###`.
- Link Markdown.
- Model ghép heading với bullet.
- Ellipsis `...`/`…`.
- Model ghép hai bullet thành một câu.

### 4.2 Chuỗi thất bại

Code thực tế tại `backend/app/ai_review/verdict.py:58-77` hoạt động như sau:

```text
Model finding
    │
    ├── Tìm page bằng source_content_slug
    │
    ├── So rule_text với Markdown
    │       │
    │       └── Không khớp → RULE_NOT_FOUND
    │
    ├── Chỉ kiểm evidence nếu rule đã khớp
    │       │
    │       └── Rule không khớp → evidence = []
    │
    ├── verified = rule_verified AND có evidence hợp lệ
    │
    └── Không còn verified violation
            │
            └── FLAGGED → INCONCLUSIVE
```

Điểm quan trọng nhất:

```python
evidence = (
    _verify_evidence(finding, notebook)
    if rule_verified and finding.evidence
    else []
)
```

Nguồn:

- `backend/app/ai_review/verdict.py:61-65`.

Nghĩa là khi rule text trượt matcher, evidence chưa được kiểm tra độc lập mà bị bỏ ngay.

### 4.3 Ví dụ thật từ Competition C

Markdown canonical:

```markdown
- **C-R1 — Không dùng định danh:** Không được dùng cột `device_id` làm đặc trưng huấn luyện hoặc suy luận.
```

LLM trả:

```text
C-R1 — Không dùng định danh: Không được dùng cột `device_id` làm đặc trưng huấn luyện hoặc suy luận.
```

Hai câu có cùng ý nghĩa và gần như cùng ký tự. Khác biệt chỉ là:

- Mất `- `.
- Mất `**`.

Nhưng matcher hiện tại coi chúng khác nhau.

Kết quả case C-01:

```text
model_verdict = FLAGGED
final verdict = INCONCLUSIVE
downgrade_codes = [NO_VERIFIED_VIOLATION, RULE_NOT_FOUND]
```

LLM đã chỉ đúng việc dùng `device_id`, nhưng finding trở thành:

```text
verified = false
evidence = []
```

### 4.4 Vì sao `EVIDENCE_INVALID = 0` không có nghĩa mọi evidence đều đúng?

Chiến dịch ghi nhận:

```text
EVIDENCE_INVALID: 0
```

Không nên diễn giải thành:

> Toàn bộ evidence của 115 findings đều hợp lệ.

Lý do: `_verify_evidence()` chỉ chạy sau khi `rule_verified=true`.

Đối với 69 findings có rule mismatch:

- Evidence không được kiểm.
- Evidence bị thay bằng danh sách rỗng.
- Hệ thống không còn dữ liệu để biết tọa độ model đưa ra có đúng hay không.

Cách diễn giải đúng:

> Trong tập findings đã vượt qua cửa rule matching và có evidence, không evidence nào bị loại vì sai cell/dòng.

Đây là một giới hạn observability quan trọng.

---

## 5. Kết quả kiểm thử E2E bằng LLM thật

### 5.1 Điều kiện kiểm thử

Nguồn fixture:

```text
/home/nkd/vku-ai-challenge-platform/ai_challenge_testcases_extended.zip
```

Không sử dụng:

- Mock provider.
- Fake response.
- Stub audit row.
- Cache giả.

Đã tạo năm competition độc lập:

| Bộ | Competition ID | Slug |
|---|---|---|
| A | `6ab25219aed190556f7f4639` | `ai-review-real-a-20260922` |
| B | `6ab2521baed190556f7f4642` | `ai-review-real-b-20260922` |
| C | `6ab2521eaed190556f7f464b` | `ai-review-real-c-20260922` |
| D | `6ab25220aed190556f7f4654` | `ai-review-real-d-20260922` |
| E | `6ab25222aed190556f7f465d` | `ai-review-real-e-20260922` |

Mỗi competition có:

- Một bộ rules tương ứng.
- Ground truth thật.
- Scoring config thật.
- Participant membership thật.
- Năm submission thật qua API.
- Job và worker thật.
- Provider call thật.

### 5.2 Kết quả raw model

| Ground truth | Model `FLAGGED` | Model `CLEAR` |
|---|---:|---:|
| 20 FAIL | 20 | 0 |
| 5 PASS | 0 | 5 |

Raw model accuracy trên fixture:

```text
25/25 = 100%
```

Lưu ý: fixture có một số comment tự mô tả vi phạm nên đây chưa phải benchmark adversarial. Con số 100% chỉ đúng cho bộ này.

### 5.3 Kết quả cuối sau verifier

| Ground truth | CLEAR | FLAGGED | INCONCLUSIVE | ERROR |
|---|---:|---:|---:|---:|
| 20 FAIL | 0 | 8 | 12 | 0 |
| 5 PASS | 5 | 0 | 0 | 0 |

Strict accuracy:

```text
13/25 = 52%
```

Đối với class vi phạm:

```text
Precision FLAGGED = 8/8  = 100%
Recall FLAGGED    = 8/20 = 40%
F1 FLAGGED        ≈ 57.1%
```

### 5.4 Các case bị downgrade dù model phát hiện đúng

| Case | Vi phạm thật | Raw model | Final |
|---|---|---|---|
| A-01 | Chỉ TODO, thiếu pipeline | FLAGGED | INCONCLUSIVE |
| B-01 | Chỉ TODO, thiếu pipeline | FLAGGED | INCONCLUSIVE |
| C-01 | Dùng `device_id` | FLAGGED | INCONCLUSIVE |
| C-02 | Random Forest 100 cây | FLAGGED | INCONCLUSIVE |
| C-03 | Gọi Internet | FLAGGED | INCONCLUSIVE |
| C-05 | `device_id` + 80 cây | FLAGGED | INCONCLUSIVE |
| D-01 | `shuffle=True` | FLAGGED | INCONCLUSIVE |
| D-02 | Dùng `future_label` | FLAGGED | INCONCLUSIVE |
| D-03 | Nạp model `.pkl` có sẵn | FLAGGED | INCONCLUSIVE |
| E-01 | Ensemble ba model | FLAGGED | INCONCLUSIVE |
| E-03 | Nộp probability thay nhãn cứng | FLAGGED | INCONCLUSIVE |
| E-05 | Ensemble + probability | FLAGGED | INCONCLUSIVE |

### 5.5 Phân tích findings

Tổng cộng:

```text
115 findings
```

| Chỉ số | Số lượng |
|---|---:|
| Rule text khớp matcher | 46/115 — 40% |
| Rule text không khớp | 69/115 — 60% |
| Findings `verified=true` | 31 |
| Findings `verified=false` | 84 |
| Finding status `VIOLATION` | 34 |
| Verified violation findings | 18 |
| Review có `RULE_NOT_FOUND` | 22/25 |
| `FLAGGED` bị downgrade | 12 |

Phân loại 69 mismatch bằng đối chiếu offline:

| Nhóm nguyên nhân | Số lượng |
|---|---:|
| Bỏ/chuẩn hóa Markdown | 48 |
| Ghép heading và bullet | 12 |
| Chèn ellipsis | 6 |
| Ghép nhiều bullet | 3 |
| Paraphrase thực sự | 0 |
| Sai slug | 0 trong campaign chuẩn |

Điều này cho thấy model không bịa rule trong 69 mismatch của campaign chuẩn. Phần lớn chỉ là khác biệt biểu diễn.

### 5.6 Chi phí và độ trễ

25 lượt hợp lệ:

| Chỉ số | Kết quả |
|---|---:|
| Tổng prompt tokens | 46,703 |
| Tổng completion tokens | 47,129 |
| Tổng token | 93,832 |
| Trung bình token/lượt | 3,753 |
| Latency trung bình | 10,589 ms |
| Median | 8,710 ms |
| Min | 4,798 ms |
| Max | 40,982 ms |

Không có lỗi terminal trong campaign chuẩn:

```text
AI_OUTPUT_TRUNCATED: 0
AI_RESPONSE_INVALID: 0
AI_PROVIDER_*: 0
```

---

## 6. Vì sao 22/25 review có `RULE_NOT_FOUND` nhưng chỉ 12 verdict bị hạ?

`RULE_NOT_FOUND` được ghi nếu bất kỳ finding nào trích rule không khớp.

Một review có thể vẫn giữ `FLAGGED` nếu:

- Có năm findings.
- Bốn finding không khớp.
- Nhưng một finding `VIOLATION` còn lại khớp rule và có evidence hợp lệ.

Khi đó:

```text
verdict = FLAGGED
downgrade_codes có thể vẫn chứa RULE_NOT_FOUND
```

Ngoài ra, `CLEAR` chỉ bị hạ khi notebook bị truncate. Vì vậy một review `CLEAR` vẫn có thể có nhiều compliant findings không khớp rule nhưng verdict vẫn là `CLEAR`.

Điều này giải thích:

- `RULE_NOT_FOUND`: 22/25 review.
- Downgrade thật: 12/25 review.

---

## 7. Phân tích riêng submission `6ab2376cdaf317b02e7a0839`

Submission này không hoàn toàn giống 12 case downgrade trong campaign chuẩn.

### 7.1 Dữ liệu thực tế

- Competition yêu cầu phân loại ảnh biển báo STOP và SPEED LIMIT.
- Notebook lại phân tích nhu cầu ngôn ngữ Đông Á và kinh tế lượng mức lương VietJobs.
- Notebook rõ ràng không liên quan bài toán cuộc thi.
- Generation 3:

  ```text
  model_verdict = INCONCLUSIVE
  final verdict = INCONCLUSIVE
  downgrade_codes = [RULE_NOT_FOUND]
  ```

### 7.2 Vì sao trường hợp này không thành `FLAGGED`?

Ở đây backend không hạ một `FLAGGED` đúng. Model tự chọn `INCONCLUSIVE`.

Model có nhận ra notebook lệch đề, nhưng:

- Finding là `UNCLEAR`.
- Evidence rỗng.
- Rule text không khớp canonical content.
- Verifier có thiết kế “không bao giờ nâng verdict”, nên không thể biến `INCONCLUSIVE` thành `FLAGGED`.

### 7.3 Context của submission này cũng bị nhiễm

Revision có ba pages:

- Hai page mô tả cuộc thi biển báo.
- Một page `dataset` lại chứa nội dung đánh giá bài VietJobs.

Prompt hiện nói toàn bộ `<COMPETITION_CONTENT>` là quy định. Vì vậy một page lạc đề cũng được đưa vào model như policy hợp lệ.

Đây là lỗi **quản trị nguồn nội dung**, khác với lỗi Markdown matcher:

```text
Lỗi 1: Model → verifier không khớp trích dẫn Markdown.
Lỗi 2: Competition content có page lạc đề nhưng vẫn được coi là policy.
Lỗi 3: Không có policy đủ rõ cho tình huống notebook hoàn toàn không liên quan.
```

### 7.4 Quyết định sản phẩm cần chốt

Nếu yêu cầu nghiệp vụ là:

> Mọi notebook hoàn toàn không liên quan cuộc thi phải luôn được gắn `FLAGGED`.

thì hệ thống cần một căn cứ policy rõ ràng. Có hai lựa chọn:

1. Mỗi competition bắt buộc có rule “Notebook phải giải đúng bài toán/cuộc thi và có pipeline liên quan”.
2. Thêm một policy toàn nền tảng về task relevance vào system contract.

Lựa chọn 2 thay đổi nguyên tắc hiện tại “chỉ competition content mới là quy định”, nên phải có quyết định sản phẩm/ADR, không nên lén thêm bằng prompt.

---

## 8. Nguyên nhân gốc theo từng lớp

### 8.1 P0 — Hợp đồng citation không phù hợp hành vi LLM

Prompt yêu cầu:

```text
rule_text: trích nguyên văn quy định trong thể lệ
```

Nhưng không định nghĩa rõ:

- Có phải giữ nguyên ký hiệu Markdown không?
- Có được bỏ bullet không?
- Có được ghép heading với nội dung không?
- Có được rút gọn không?

Trong khi verifier ngầm yêu cầu substring gần như nguyên văn của Markdown thô.

Đây là khoảng cách giữa:

```text
Điều model được dặn
và
Điều backend thực sự kiểm
```

### 8.2 P0 — Rule verification và evidence verification bị buộc chung

Rule không khớp kéo theo evidence không được kiểm.

Hậu quả:

- Không biết model có trỏ đúng cell/dòng không.
- Mất bằng chứng có thể vẫn hữu ích cho admin.
- Audit thiếu khả năng giải thích chính xác finding hỏng ở phần nào.

### 8.3 P0 — Cache không có version riêng cho verifier

Cache key hiện gồm:

- Competition ID.
- Content hash.
- Notebook SHA.
- Provider/host/model.
- `max_notebook_chars`.
- Prompt version.
- Notebook normalization version.
- Context policy version.

Code:

- `backend/app/ai_review/service.py:134-156`.

Nhưng cache key không có:

```text
VERIFIER_VERSION
```

`INCONCLUSIVE` là verdict được cache:

- `backend/app/ai_review/constants.py:28-30`.

Nếu chỉ sửa `verdict.py` mà không đổi cache key:

- Review cũ vẫn có thể được tái sử dụng.
- Kết quả sẽ trông như bản sửa không hoạt động.

Đây là bẫy triển khai quan trọng.

### 8.4 P1 — `INCONCLUSIVE` đang gộp nhiều nguyên nhân

Các tình huống hiện cùng nhãn:

- Module riêng tư không có source.
- Notebook bị thiếu nội dung cần thiết.
- Model tự không chắc chắn.
- Rule text khác Markdown formatting.
- Evidence bị loại.

Đối với người dùng, các tình huống này có ý nghĩa rất khác nhau.

### 8.5 P1 — Finding chưa xác minh vẫn hiển thị như finding bình thường

Backend lưu `verified`, nhưng frontend type không có field này:

- Backend dataclass: `backend/app/ai_review/verdict.py:28-37`.
- Frontend `AiFinding`: `frontend/src/api/aiReview.ts:131-139`.

Modal hiển thị `rule_text` và `reason`, nhưng không gắn badge “chưa đối chiếu được”:

- `frontend/src/components/AiReviewDetailModal.tsx:431-468`.

Admin có thể đọc một finding chưa xác minh như thể nó đã được xác minh.

### 8.6 P1 — Summary có thể mâu thuẫn verdict cuối

Service lưu:

```python
"verdict": final_verdict,
"model_verdict": output.verdict,
"summary": output.summary,
```

Nguồn:

- `backend/app/ai_review/service.py:325-345`.

Vì summary là câu do model viết trước downgrade, có thể xuất hiện:

```text
Verdict: INCONCLUSIVE
Summary: Notebook vi phạm C-R1 vì dùng device_id...
```

Participant hiện được bảo vệ vì chỉ nhận câu cố định theo verdict:

- `backend/app/ai_review/serializers.py:10-42`.

Nhưng Admin vẫn thấy mâu thuẫn này. UI chỉ nói chung rằng verdict đã bị hạ:

- `frontend/src/components/AiReviewDetailModal.tsx:329-335`.

### 8.7 P1 — Toàn bộ page Markdown được coi là policy

Snapshot hiện lấy mọi content có Markdown, không phân biệt phần nào là:

- Thể lệ bắt buộc.
- Mô tả bài toán.
- Dataset documentation.
- Ví dụ.
- Ghi chú lạc đề.

Code:

- `backend/app/ai_review/content_snapshot.py:149-189`.
- `backend/app/ai_review/prompt.py:15-21` tuyên bố cả block là quy định.

Điều này đúng với yêu cầu “không tạo Rule Builder”, nhưng tạo rủi ro:

- Page lạc đề trở thành policy.
- Code example trong content tăng nhiễu.
- Nội dung chỉ mô tả có thể bị hiểu thành nghĩa vụ.

Không nhất thiết phải tạo Rule Builder để sửa. Có thể vẫn dùng Content Manager duy nhất nhưng bổ sung vai trò/preview rõ ràng.

### 8.8 P2 — Vi phạm dạng “vắng mặt” khó biểu diễn

Ví dụ:

- Không có pipeline.
- Không có bước train.
- Không xuất CSV.
- Chỉ có TODO.

Evidence hiện là line range dương. Nhưng bản chất finding là “thiếu thứ bắt buộc”.

A-01 và B-01 cho thấy model nhận đúng, nhưng schema chưa diễn đạt rõ bằng chứng vắng mặt.

### 8.9 P2 — Output dài và nhiều finding không cần thiết

Model thường tạo finding cho hầu hết rules, kể cả `COMPLIANT` và `UNCLEAR`.

Hậu quả:

- Tăng completion tokens.
- Tăng latency.
- Tăng bề mặt `RULE_NOT_FOUND`.
- Tăng nguy cơ chạm output cap khi content lớn.
- Làm Admin khó tập trung vào vi phạm chính.

---

## 9. Những giả định ẩn đã bị kiểm thử bác bỏ

| Giả định | Đúng? | Bằng chứng/hệ quả |
|---|---|---|
| Model sẽ copy nguyên Markdown từng ký tự | Không | 69/115 finding lệch dù nội dung đúng |
| Collapse whitespace là đủ | Không | Bold, backtick, bullet, heading và ellipsis vẫn làm fail |
| `EVIDENCE_INVALID=0` nghĩa evidence toàn bộ hợp lệ | Không | Evidence của rule mismatch chưa từng được kiểm |
| Hạ `FLAGGED` xuống `INCONCLUSIVE` luôn vô hại | Không | Bài biến mất khỏi nhóm “Có dấu hiệu” ưu tiên |
| Sửa verifier tự động có hiệu lực với review mới | Không chắc | Cache key chưa có verifier version |
| Tất cả content Markdown đều là quy định sạch | Không | Submission VietJobs có page lạc đề trong revision |
| `verified=true` nghĩa backend đã hiểu và chứng minh vi phạm | Không | Backend chỉ kiểm provenance và tọa độ |
| Prompt-only có thể bắt LLM trích đúng tuyệt đối | Không đáng tin | LLM có xu hướng tự normalize khi trích dẫn |
| Fuzzy matching giải quyết an toàn | Không | Có thể chấp nhận rule tương tự nhưng không tồn tại |

---

## 10. Những phần đang làm tốt và phải giữ nguyên

Không nên vì một lỗi mà bỏ toàn bộ cơ chế hậu kiểm.

### 10.1 AI không ảnh hưởng scoring

AI chỉ ghi vào `ai_review.*`:

- Không sửa điểm.
- Không sửa quota.
- Không tự loại leaderboard.

Đây là bất biến đúng.

### 10.2 Queue bền và có fencing

Mongo queue có:

- Unique job theo submission.
- Atomic claim.
- Lease token.
- Generation/run ID.
- Retry có backoff.
- Recovery khi worker restart.

Chiến dịch chuẩn hoàn tất 25/25 job.

### 10.3 Snapshot bất biến

Review dùng đúng content tại thời điểm nộp, không dùng content mới.

### 10.4 Notebook không được execute

Điều này giảm đáng kể rủi ro chạy mã độc từ thí sinh.

### 10.5 Prompt-injection boundary

Notebook được coi là dữ liệu không đáng tin; delimiter giả được neutralize.

### 10.6 Structured output fail-closed

JSON sai hoặc field lạ thành `ERROR`, không tự đoán.

### 10.7 Snippet do server dựng

Model không thể bịa nội dung snippet cuối cùng.

### 10.8 Verdict monotonic

Backend chỉ hạ độ chắc chắn, không nâng kết luận. Bản sửa phải giữ nguyên bất biến này.

### 10.9 Participant projection an toàn

Participant không nhận:

- Provider.
- Model.
- Token usage.
- Technical error.
- Finding/evidence.
- Prose trực tiếp từ model.

---

## 11. Các phương án giải quyết

### 11.1 Phương án A — Chỉ sửa prompt

Ví dụ dặn model:

```text
Phải copy đúng từng ký tự, giữ nguyên Markdown, không được rút gọn.
```

**Ưu điểm**

- Thay đổi nhỏ.
- Không đổi data model.
- Có thể giảm một phần mismatch.

**Nhược điểm**

- Vẫn dựa vào hành vi không tất định của LLM.
- Không bảo đảm model giữ nguyên bold/backtick/bullet.
- Không giải quyết cache/verifier/evidence observability.

**Kết luận:** chỉ nên là biện pháp phụ, không phải giải pháp chính.

### 11.2 Phương án B — Canonicalize Markdown tất định

Backend chuyển cả source Markdown và `rule_text` về dạng canonical:

- Unicode NFC.
- Chuẩn hóa newline/whitespace.
- Bỏ marker heading/list/blockquote.
- Unwrap bold/italic/inline-code nhưng giữ chữ bên trong.
- Link chuyển thành label.
- Giữ số, tên rule, tên cột và nội dung có nghĩa.

Sau đó chấp nhận nếu:

```text
raw exact match
HOẶC
canonical exact match
```

**Ưu điểm**

- Deterministic.
- Dễ unit test.
- Giải quyết trực tiếp nhóm 48/69 mismatch Markdown.
- Không cần tin model hơn.

**Nhược điểm**

- Không giải quyết hoàn toàn heading+bullet, ellipsis và merge nhiều bullet.
- Canonicalizer phải rất cẩn thận để không bỏ mất khác biệt có nghĩa.
- Cần versioning và cache invalidation.

**Kết luận:** hotfix tốt và an toàn nhất.

### 11.3 Phương án C — Fuzzy matching

Ví dụ dùng similarity score hoặc edit distance.

**Ưu điểm**

- Có thể nhận paraphrase và khác dấu câu.
- Cài đặt có vẻ nhanh.

**Nhược điểm**

- Rule “tương tự” không có nghĩa rule “tồn tại”.
- Có thể cho một policy do model bịa vượt qua verifier.
- Khó giải thích ngưỡng.
- Tiếng Việt, số, mã rule và phủ định làm similarity dễ sai.

**Kết luận:** không dùng làm cổng để giữ `FLAGGED`. Nếu dùng, chỉ dùng làm tín hiệu chẩn đoán cho Admin.

### 11.4 Phương án D — Stable `rule_ref`/anchor do backend sinh

Backend tự chia content thành các block có thể tham chiếu:

```text
heading path + list item/paragraph + page slug
```

Mỗi block nhận ID tất định, ví dụ:

```text
rules-c#5d8f0c7a
```

Prompt gửi:

```text
[RULE rules-c#5d8f0c7a]
C-R1 — Không dùng định danh: ...
```

Model trả:

```json
{
  "rule_ref": "rules-c#5d8f0c7a",
  "status": "VIOLATION",
  "evidence": [...]
}
```

Backend:

- Kiểm tra ID có trong đúng revision.
- Tự lấy canonical rule text.
- Không dùng `rule_text` do model làm nguồn sự thật.

**Ưu điểm**

- Provenance mạnh nhất.
- Không phụ thuộc LLM copy Markdown.
- Chống rule bịa tốt hơn.
- Audit và diff revision rõ.
- Đo được rule nào thường gây finding.

**Nhược điểm**

- Thay schema prompt/output/revision.
- Cần thiết kế rule-unit segmentation.
- Cần migration tương thích audit row cũ.

**Kết luận:** kiến trúc dài hạn nên chọn.

### 11.5 Phương án E — Bỏ verifier và tin raw model

**Ưu điểm**

- Bộ test hiện tại sẽ đạt 25/25.

**Nhược điểm**

- Model có thể bịa rule.
- Model có thể bịa cell/dòng.
- Prompt injection có thể trở thành kết luận trực tiếp.
- Phá ADR-036 và hàng rào an toàn quan trọng nhất.

**Kết luận:** không chấp nhận.

### 11.6 Ma trận đánh đổi

| Phương án | Độ phức tạp | Sửa lỗi Markdown | Chống rule bịa | Audit dài hạn | Rủi ro |
|---|---:|---:|---:|---:|---:|
| A. Prompt-only | Thấp | Thấp–TB | Không cải thiện | Không | Trung bình |
| B. Canonicalization | Trung bình | Cao | Giữ được nếu exact canonical | Trung bình | Thấp–TB |
| C. Fuzzy matching | Trung bình | Cao | Yếu đi | Thấp | Cao |
| D. Stable rule refs | Cao | Rất cao | Tốt nhất | Tốt nhất | Trung bình |
| E. Tin raw model | Thấp | 100% theo fixture | Rất kém | Kém | Rất cao |
| **Hybrid B → D** | Trung bình–cao | **Rất cao** | **Tốt** | **Tốt** | **Thấp có kiểm soát** |

---

## 12. Khuyến nghị kiến trúc

### 12.1 Lựa chọn chính

**Chọn hybrid:**

```text
Hotfix canonicalization tất định
             ↓
Stable rule refs do backend sinh
```

Không chọn fuzzy làm cổng xác minh.

### 12.2 Vì sao đây là lựa chọn tốt nhất?

- Giải quyết nhanh nhóm lỗi lớn nhất.
- Không phá an toàn fail-closed.
- Không tạo Rule Builder riêng.
- Không bắt Admin nhập lại thể lệ.
- Giảm phụ thuộc vào khả năng copy chính xác của LLM.
- Tăng khả năng audit và giải thích.
- Có thể rollout theo giai đoạn, không cần rewrite hệ thống.

### 12.3 Hợp đồng output đề xuất dài hạn

```json
{
  "verdict": "FLAGGED",
  "summary": "Phát hiện dấu hiệu dùng device_id.",
  "participant_summary": "Bỏ device_id khỏi đặc trưng.",
  "findings": [
    {
      "rule_ref": "rules-c#5d8f0c7a",
      "checkability": "CHECKABLE_FROM_NOTEBOOK",
      "status": "VIOLATION",
      "reason": "features chứa device_id và được dùng ở fit/predict.",
      "evidence": [
        {
          "kind": "CODE_RANGE",
          "cell": 2,
          "start_line": 5,
          "end_line": 9
        }
      ]
    }
  ]
}
```

`rule_text`, `source_content_title` và `source_content_slug` trong audit row nên do backend điền từ revision, không tin model.

---

## 13. Hướng triển khai đề xuất

> Đây là hướng dẫn triển khai, chưa phải thay đổi đã được thực hiện.

### Giai đoạn 0 — Khóa baseline và thêm khả năng quan sát

1. Giữ bộ 25 case làm regression corpus.
2. Lưu bảng expected mapping rõ ràng.
3. Bổ sung metric:
   - Raw model verdict.
   - Final verdict.
   - Số finding theo verification state.
   - Downgrade reason theo finding.
4. Tách trạng thái finding:

   ```text
   rule_resolved
   evidence_location_valid
   traceable
   ```

5. Frontend hiển thị badge:

   ```text
   Đã đối chiếu nguồn
   Chưa đối chiếu được quy định
   Sai vị trí bằng chứng
   ```

### Giai đoạn 1 — Hotfix matcher

#### Backend

Nên sửa tập trung tại:

- `backend/app/ai_review/verdict.py`.
- Có thể thêm module nhỏ `backend/app/ai_review/rule_text.py` nếu canonicalizer đủ lớn để cần test độc lập.

Yêu cầu canonicalizer:

1. Deterministic.
2. Unicode NFC.
3. Không dùng model hoặc dịch vụ ngoài.
4. Không dùng fuzzy score để xác minh.
5. Áp dụng đối xứng cho source và quote.
6. Giữ nguyên nội dung chữ, số, phủ định và identifier.
7. Có test cho mọi phép biến đổi.

Pseudo-flow:

```python
raw_match = exact_after_whitespace(rule_text, markdown)
canonical_match = exact_after_whitespace(
    canonicalize(rule_text),
    canonicalize(markdown),
)
rule_verified = raw_match or canonical_match
```

#### Tách evidence verification

Thay vì:

```text
rule sai → không kiểm evidence → evidence=[]
```

nên:

```text
luôn kiểm tọa độ evidence
rule_resolved = true/false
evidence_location_valid = true/false
traceable = rule_resolved AND evidence_location_valid
```

Finding chỉ được giữ `FLAGGED` khi `traceable=true`, nên bất biến an toàn không đổi.

Nhưng audit vẫn biết:

- Rule sai, evidence đúng vị trí.
- Rule đúng, evidence sai vị trí.
- Cả hai sai.

#### Bổ sung mã lỗi rõ hơn

Ví dụ:

```text
RULE_PAGE_NOT_FOUND
RULE_TEXT_NOT_FOUND
RULE_CANONICAL_MATCH
EVIDENCE_LOCATION_INVALID
NO_TRACEABLE_VIOLATION
```

Mã nên gắn theo finding thay vì chỉ là set toàn review.

### Giai đoạn 2 — Versioning và cache

Thêm hằng số rõ nghĩa:

```python
VERIFIER_VERSION = "verifier-v2"
```

Đưa vào `cache_key` tại:

- `backend/app/ai_review/service.py:134-156`.

Lý do không nên chỉ sửa logic mà giữ cache key:

- `INCONCLUSIVE` cũ là cacheable.
- Review mới có thể reuse kết quả cũ.

Nếu chưa thêm version mới ngay, tối thiểu phải bump một version hiện hữu và ghi ADR giải thích. Tuy nhiên thêm `VERIFIER_VERSION` là giải pháp minh bạch hơn.

Sau deploy:

- Chạy lại bằng manual review có `bypass_cache=true`.
- Không overwrite audit cũ.
- So sánh generation trước/sau.

### Giai đoạn 3 — Stable rule refs

#### Capture revision

Tại `content_snapshot.py`:

1. Parse Markdown thành block.
2. Gắn heading context cho paragraph/list item.
3. Canonicalize block.
4. Tạo ID từ:

   ```text
   page slug + heading path + canonical block text
   ```

5. Lưu anchors vào revision.

Không yêu cầu Admin nhập rule lần hai.

#### Prompt

`prompt.py` gửi mỗi block cùng ID.

Model trả `rule_ref`, không cần copy nguyên Markdown để chứng minh provenance.

#### Schema

`models.py` thêm `rule_ref`; có thể giữ `rule_text` trong một giai đoạn tương thích nhưng không dùng làm nguồn sự thật.

#### Verifier

1. `rule_ref` phải tồn tại trong đúng revision.
2. Backend lấy canonical text/title/slug.
3. Evidence phải resolve.
4. Chỉ violation traceable mới giữ `FLAGGED`.

### Giai đoạn 4 — Sửa UX Admin

Tại:

- `frontend/src/api/aiReview.ts`.
- `frontend/src/components/AiReviewDetailModal.tsx`.

Cần hiển thị:

```text
Model đề xuất: Có dấu hiệu
Kết luận sau hậu kiểm: Chưa đủ căn cứ
Nguyên nhân: Không đối chiếu được trích dẫn quy định
```

Mỗi finding cần badge verification riêng.

Không nên hiển thị rule chưa xác minh như rule canonical.

Khi verdict bị downgrade, summary hiển thị nên tách:

- “Nhận định ban đầu của AI”.
- “Kết quả hậu kiểm”.

Participant projection nên giữ nguyên câu cố định và an toàn.

### Giai đoạn 5 — Content governance

Không tạo Rule Builder mới.

Trong Content Manager hiện tại, cân nhắc:

1. Preview “Nội dung AI sẽ nhận”.
2. Cảnh báo page bất thường/lạc đề.
3. Cho Admin chọn vai trò của page trong cùng content system:

   ```text
   POLICY
   CONTEXT
   EXCLUDED_FROM_AI
   ```

4. Hoặc cho phép đánh dấu block normative trong chính Markdown metadata.

Đây là quyết định sản phẩm vì requirement hiện tại nói AI dùng toàn bộ content.

### Giai đoạn 6 — Vi phạm dạng vắng mặt

Bổ sung evidence kind:

```text
CODE_RANGE
MISSING_REQUIRED_STEP
NOTEBOOK_GLOBAL
```

Ví dụ:

```json
{
  "kind": "MISSING_REQUIRED_STEP",
  "required_step": "TRAIN_MODEL",
  "supporting_cells": [1, 2]
}
```

Không nên giả vờ rằng một line range đơn lẻ “chứng minh” toàn bộ sự vắng mặt.

---

## 14. Kế hoạch kiểm thử sau sửa

### 14.1 Unit tests bắt buộc cho rule matching

Thêm vào `backend/tests/test_ai_review_verdict.py`:

- [ ] Raw exact quote vẫn match.
- [ ] Whitespace/newline khác vẫn match.
- [ ] Bỏ `**bold**` vẫn match canonical.
- [ ] Bỏ `_italic_` vẫn match canonical.
- [ ] Bỏ backtick vẫn match canonical.
- [ ] Bỏ bullet marker vẫn match canonical.
- [ ] Bỏ heading marker vẫn match canonical.
- [ ] Link Markdown → label vẫn match đúng.
- [ ] Unicode NFC/NFD không tạo mismatch.
- [ ] Khác số giới hạn không được match.
- [ ] Mất từ phủ định “không” không được match.
- [ ] Rule bịa vẫn không match.
- [ ] Chuỗi cực ngắn không được dùng để xác minh rule.
- [ ] Sai slug có mã chẩn đoán riêng.
- [ ] Evidence vẫn được validate khi rule không resolve.
- [ ] Finding chỉ traceable khi cả rule và evidence hợp lệ.
- [ ] `INCONCLUSIVE` không bao giờ được nâng thành `FLAGGED`.

### 14.2 Cache tests

- [ ] Đổi `VERIFIER_VERSION` làm cache miss.
- [ ] Cùng verifier version và cùng input vẫn cache hit.
- [ ] Review cũ không được reuse sau thay đổi verifier.
- [ ] Manual rerun `bypass_cache=true` luôn gọi provider.

### 14.3 Schema/rule-ref tests

- [ ] Rule ref tồn tại được resolve.
- [ ] Rule ref không tồn tại bị từ chối/hạ cấp.
- [ ] Rule ref của page khác không được gắn nhầm.
- [ ] Anchor giữ ổn định khi chỉ đổi whitespace/formatting được phép.
- [ ] Anchor đổi khi nội dung nghĩa vụ thay đổi.
- [ ] Duplicate text ở hai page vẫn phân biệt được.

### 14.4 E2E thật

Chạy lại đúng 25 case bằng provider thật.

Tiêu chí regression trên bộ hiện tại:

```text
20/20 FAIL → FLAGGED
5/5 PASS → CLEAR
0 ERROR
0 false positive
0 downgrade chỉ vì Markdown formatting
```

Đồng thời kiểm:

- SHA 25/25.
- Không truncate.
- Participant projection không lộ kỹ thuật.
- Admin thấy verification state.
- Cache version đúng.

### 14.5 Bộ test adversarial cần bổ sung

Bộ hiện tại còn dễ. Cần thêm:

- [ ] Vi phạm không có comment tự thú.
- [ ] Prompt injection trong Markdown cell.
- [ ] Import alias.
- [ ] Wrapper function che lời gọi mạng.
- [ ] Dynamic import.
- [ ] Rule gần giống nhưng khác phủ định.
- [ ] Hai rule chỉ khác con số giới hạn.
- [ ] Notebook dài gần trần.
- [ ] Module ngoài không có source.
- [ ] Task hoàn toàn không liên quan.
- [ ] Content có code example không phải hành vi participant.
- [ ] Content có một page lạc đề.
- [ ] Rule nằm trong table/blockquote/link.
- [ ] Vi phạm dạng missing step.

---

## 15. Chỉ số thành công

### 15.1 Chỉ số bắt buộc

- [ ] `FLAGGED` recall trên 20 fixture vi phạm: 100% sau full fix.
- [ ] Precision `FLAGGED` trên fixture hiện tại: 100%.
- [ ] PASS → `FLAGGED`: 0.
- [ ] FAIL → `CLEAR`: 0.
- [ ] Downgrade do formatting-only: 0.
- [ ] Mọi final `FLAGGED` có ít nhất một finding traceable.
- [ ] Mọi finding chưa traceable được gắn nhãn rõ trong Admin UI.
- [ ] Cache cũ không được reuse sau đổi verifier.
- [ ] Participant không nhận raw model prose hoặc technical details.

### 15.2 Chỉ số vận hành

Theo dõi theo thời gian:

```text
raw_model_flagged_count
final_flagged_count
flagged_downgraded_count
downgrade_by_reason
rule_resolution_rate
evidence_location_valid_rate
provider_error_rate
response_invalid_rate
output_truncated_rate
tokens_per_review
latency_per_review
human_accept/reject_after_ai_verdict
```

Đặc biệt cần dashboard funnel:

```text
Model FLAGGED
    ↓
Rule resolved
    ↓
Evidence location valid
    ↓
Traceable violation
    ↓
Final FLAGGED
```

### 15.3 Không dùng một mình accuracy

Accuracy 25/25 của raw model không đủ để chứng minh hệ thống tốt vì:

- Fixture chưa adversarial.
- Một số notebook tự mô tả vi phạm trong comment.
- Backend chưa chứng minh ngữ nghĩa.
- Dữ liệu thật đa dạng hơn.

Cần theo dõi riêng:

- Recall vi phạm.
- False positive.
- Downgrade rate.
- Human overturn rate.
- Tỷ lệ finding truy vết được.

---

## 16. Review triggers — khi nào phải xem lại thiết kế?

Cần review lại nếu xảy ra một trong các điều kiện:

1. `RULE_TEXT_NOT_FOUND` tăng sau đổi model/provider.
2. `FLAGGED` downgrade vượt ngưỡng vận hành đã chốt.
3. Admin thường xuyên bác bỏ finding đã traceable.
4. Participant khiếu nại về finding không liên quan rule.
5. Content snapshot chứa page không nên gửi provider.
6. Token/completion tăng mạnh sau thêm rule refs.
7. Anchor thay đổi dù chỉ sửa format vô nghĩa.
8. Anchor không đổi khi nghĩa vụ thật sự thay đổi.
9. Provider đổi cách structured output.
10. Có incident prompt injection.
11. Notebook/task mismatch vẫn thành `INCONCLUSIVE` sau khi đã có policy rõ.
12. Cache trả lại verdict của logic verifier cũ.

---

## 17. Những việc không nên làm

### 17.1 Không bỏ verifier

Raw model đúng trong fixture không có nghĩa luôn đúng ngoài thực tế.

### 17.2 Không đổi mọi `INCONCLUSIVE` thành `FLAGGED`

Một số `INCONCLUSIVE` thật sự hợp lý, ví dụ module riêng tư không có source.

### 17.3 Không chỉ viết prompt “hãy nghiêm khắc hơn”

Điều này không sửa mismatch deterministic và có thể tăng false positive.

### 17.4 Không dùng fuzzy similarity làm cổng duy nhất

Nó làm yếu kiểm soát chống rule bịa.

### 17.5 Không sửa verifier mà quên cache version

Kết quả cũ có thể tiếp tục được reuse.

### 17.6 Không xóa lịch sử review cũ

Nên giữ audit trail và tạo generation mới để so sánh trước/sau.

### 17.7 Không cho AI tự loại submission

Human review phải tiếp tục là quyết định cuối cùng.

### 17.8 Không gọi mọi finding `verified` là “đã chứng minh vi phạm”

Backend mới chỉ xác minh nguồn và tọa độ, chưa chứng minh semantics.

---

## 18. Quyết định sản phẩm còn mở

Các câu hỏi sau cần Product Owner/BTC chốt trước khi triển khai phần tương ứng:

### 18.1 Notebook hoàn toàn không liên quan có phải rule toàn nền tảng không?

- Nếu có: thêm platform policy rõ ràng và ghi ADR.
- Nếu không: mỗi competition phải tự viết rule completeness/relevance.

### 18.2 AI được nhận những page nào?

Hiện tại là toàn bộ page có Markdown.

Cần quyết định:

- Giữ nguyên toàn bộ.
- Chỉ page public.
- Có role `POLICY/CONTEXT/EXCLUDED_FROM_AI` trong Content Manager.

### 18.3 `INCONCLUSIVE` kỹ thuật và nghiệp vụ có tách nhãn không?

Đề xuất Admin thấy hai nhóm:

```text
INCONCLUSIVE_CONTENT
INCONCLUSIVE_VERIFICATION
```

Participant vẫn có thể nhận một câu trung lập duy nhất.

### 18.4 Có chấp nhận anchor tự sinh là không tạo Rule Builder không?

Đề xuất: có, vì anchor chỉ là index kỹ thuật dẫn xuất từ Markdown; Admin không nhập lại rule.

---

## 19. Thứ tự ưu tiên đề xuất

### P0 — Cần làm trước

1. Canonicalize Markdown deterministic.
2. Tách rule resolution và evidence validation.
3. Thêm verifier version vào cache key.
4. Regression tests cho formatting và rule bịa.
5. Chạy lại 25 case bằng provider thật.

### P1 — Làm ngay sau P0

1. Per-finding verification state.
2. Admin UI phân biệt raw model và final verdict.
3. Summary trung lập sau downgrade.
4. Mã chẩn đoán riêng cho missing page/wrong slug.
5. Giảm output findings không cần thiết.

### P2 — Kiến trúc bền vững

1. Stable rule refs/anchors.
2. Rule identity do backend quản lý.
3. Content preview/governance.
4. Evidence kind cho missing steps.
5. Dashboard chất lượng.

### P3 — Nâng độ tin cậy ngoài fixture

1. Adversarial benchmark.
2. Human-overturn analysis.
3. Provider/model comparison.
4. Theo dõi drift theo prompt/verifier/model version.

---

## 20. Tiêu chí hoàn thành bản sửa

Bản sửa chỉ nên được coi là hoàn thành khi đáp ứng đồng thời:

- [ ] Unit tests mới pass.
- [ ] Toàn bộ test backend hiện có pass.
- [ ] 25/25 E2E thật hoàn tất không lỗi.
- [ ] 20/20 vi phạm trong fixture giữ `FLAGGED`.
- [ ] 5/5 case hợp lệ giữ `CLEAR`.
- [ ] Rule bịa vẫn không thể tạo final `FLAGGED`.
- [ ] Evidence sai cell/dòng vẫn bị loại.
- [ ] `INCONCLUSIVE` không bị tự nâng.
- [ ] Cache cũ không được reuse.
- [ ] Participant projection không thay đổi mức an toàn.
- [ ] Admin nhìn được finding nào chưa đối chiếu.
- [ ] Có bằng chứng từ provider thật, không chỉ unit test.
- [ ] Có báo cáo before/after cùng corpus và cùng expected results.

---

## 21. Kết luận cuối cùng

Hệ thống AI Review hiện tại không hỏng ở toàn bộ kiến trúc. Các phần submission, scoring, MinIO, snapshot, queue, worker, provider, structured output, audit và participant redaction đều hoạt động đúng trong chiến dịch thật.

Khuyết tật nghiêm trọng nằm ở **ranh giới giữa output của model và verifier**:

```text
Model trích đúng nghĩa
→ tự bỏ ký hiệu Markdown
→ backend không tìm thấy substring exact
→ evidence không được kiểm và bị xóa
→ không còn verified violation
→ FLAGGED bị hạ thành INCONCLUSIVE
```

Kết quả là:

- Model phát hiện 20/20 vi phạm.
- Sản phẩm cuối chỉ hiện “Có dấu hiệu” cho 8/20.
- 12 bài vi phạm bị chuyển thành “Chưa đủ căn cứ”.

Hướng sửa đúng không phải là tin model hoàn toàn, mà là làm hợp đồng xác minh rõ và tất định hơn:

```text
Canonicalization an toàn ngay bây giờ
+
Stable rule references về dài hạn
+
Evidence observability theo từng finding
+
Cache version đúng
+
Human review tiếp tục quyết định cuối
```

Với submission notebook VietJobs, còn có một vấn đề riêng: model tự chọn `INCONCLUSIVE` và revision chứa page lạc đề. Muốn mọi notebook không liên quan luôn thành `FLAGGED`, sản phẩm phải có một policy task-relevance rõ ràng và đảm bảo content snapshot không bị nhiễm.

**Kết luận ngắn nhất:**

> Hệ thống hiện phát hiện tốt hơn những gì nhãn cuối đang thể hiện; verifier đang làm mất nhiều tín hiệu đúng do so khớp Markdown quá cứng. Cần sửa hợp đồng rule identity, không nên bỏ hàng rào hậu kiểm.

---

## 22. Phụ lục — Tài liệu và bằng chứng

### 22.1 Code chính

- `backend/app/ai_review/prompt.py`
- `backend/app/ai_review/models.py`
- `backend/app/ai_review/notebook.py`
- `backend/app/ai_review/content_snapshot.py`
- `backend/app/ai_review/verdict.py`
- `backend/app/ai_review/service.py`
- `backend/app/ai_review/queue.py`
- `backend/app/ai_review/serializers.py`
- `backend/app/submissions/router.py`
- `frontend/src/api/aiReview.ts`
- `frontend/src/components/AiReviewDetailModal.tsx`
- `frontend/src/components/SubmissionReviewModal.tsx`

### 22.2 Tests hiện có

- `backend/tests/test_ai_review_verdict.py`
- Các test liên quan `backend/tests/test_ai_review_*.py`

Test hiện đã phủ:

- Rule vắng.
- Evidence sai cell/dòng.
- Rebuild snippet.
- CLEAR mâu thuẫn VIOLATION.
- Notebook truncate.
- Không nâng INCONCLUSIVE.
- Whitespace collapse.

Test còn thiếu chính là nhóm Markdown formatting đã gây lỗi thật.

### 22.3 ADR

- `docs/DECISIONS.md:444-461` — Human review là trục độc lập.
- `docs/DECISIONS.md:463-487` — AI review architecture và verifier.
- `docs/DECISIONS.md:518-530` — Output token/truncation.
- `docs/DECISIONS.md:532-544` — Participant summary qua human gate.

### 22.4 Evidence của chiến dịch

Các file tạm thời tại thời điểm lập báo cáo:

```text
/tmp/ai-review-e2e-real-20260922-isolated/competitions.tsv
/tmp/ai-review-e2e-real-20260922-isolated/submissions.tsv
/tmp/ai-review-e2e-real-20260922-isolated/results.json
/tmp/ai-review-e2e-real-20260922-isolated/results.ndjson
```

Các file dưới `/tmp` không phải kho lưu trữ bền vững. Nếu cần giữ làm hồ sơ lâu dài, phải chuyển sang vị trí artifact/report được quản lý sau khi rà soát dữ liệu nhạy cảm.

### 22.5 Trạng thái thực hiện

Trạng thái **tại thời điểm viết báo cáo** (giữ nguyên, không sửa lại lịch sử):

- Báo cáo đã được viết dựa trên code và campaign thật.
- Chưa sửa code.
- Chưa thay schema.
- Chưa chạy lại provider sau bất kỳ bản sửa nào.
- Dữ liệu test trong MongoDB/MinIO chưa bị xóa.

**Cập nhật 2026-09-22 (sau báo cáo).** Bản sửa đề xuất ở §19 đã được triển khai thành
**ADR-045 - Hybrid B+D** (`docs/DECISIONS.md`), gồm: canonical hóa tất định
(`backend/app/ai_review/rule_text.py`), phân đoạn revision và `rule_ref` ổn định
(`backend/app/ai_review/rule_refs.py`), hợp đồng model v5 (`rule_ref` bắt buộc, `rule_quote` chỉ
là khoá tra cứu), hai đường resolve có thứ tự, kiểm bằng chứng độc lập với resolve rule, và bốn
hằng version mới tham gia `cache_key`/audit row. **Không** thay schema Mongo, **không** migration,
**không** rewrite revision: chỉ mục quy định được dẫn xuất lúc worker đọc revision. Các con số
trong báo cáo này vẫn là số **before**; số **after** chỉ có sau khi chạy lại 25 notebook qua
provider thật và sẽ nằm ở `docs/AI_REVIEW_HYBRID_BD_E2E_2026-09-22.md`. Dữ liệu test trong
MongoDB/MinIO vẫn chưa bị xóa.
