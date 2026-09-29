# Kế hoạch bổ sung bộ chấm Python tùy chỉnh cho VKU AI Challenge

**Phiên bản tài liệu:** 1.0  
**Ngày lập:** 29/09/2026  
**Repository:** [ketdoannguyen/vku-ai-challenge-platform](https://github.com/ketdoannguyen/vku-ai-challenge-platform)  
**Mã nguồn đã đối chiếu:** nhánh `main`, commit `a3190418499e4c705717efb7bd69d2e5a1451195`, ngày 23/09/2026.  
**Trạng thái:** Kế hoạch triển khai. Chưa thay đổi mã nguồn ứng dụng, chưa triển khai tính năng lên hệ thống.

## Mục đích tài liệu

Tài liệu mô tả việc chuyển luồng chấm điểm của các cuộc thi mới sang sử dụng code Python do admin cung cấp. Hệ thống kiểm tra định dạng dữ liệu, chạy hàm `evaluate`, xác minh kết quả và hiển thị các metric theo cấu hình. Công thức tính điểm nằm trong code admin.

Kế hoạch chỉ rõ hiện trạng đã kiểm tra trong repository, thiết kế đề xuất, hợp đồng dữ liệu/API, các file cần thay đổi, thứ tự thực hiện và tiêu chí nghiệm thu. Các cấu trúc và endpoint được ghi là “đề xuất” chưa tồn tại trong mã nguồn tại thời điểm lập tài liệu.

## Mục lục

1. [Phương án đã chốt](#1-phương-án-đã-chốt)
2. [Hiện trạng mã nguồn và khoảng thiếu](#2-hiện-trạng-mã-nguồn-và-khoảng-thiếu)
3. [Phạm vi triển khai](#3-phạm-vi-triển-khai)
4. [Luồng thao tác của admin](#4-luồng-thao-tác-của-admin)
5. [Hợp đồng dữ liệu CSV](#5-hợp-đồng-dữ-liệu-csv)
6. [Hợp đồng hàm evaluate và kết quả](#6-hợp-đồng-hàm-evaluate-và-kết-quả)
7. [Thiết kế dữ liệu lưu trữ](#7-thiết-kế-dữ-liệu-lưu-trữ)
8. [Hợp đồng API đề xuất](#8-hợp-đồng-api-đề-xuất)
9. [Luồng xử lý backend](#9-luồng-xử-lý-backend)
10. [Môi trường thực thi bộ chấm](#10-môi-trường-thực-thi-bộ-chấm)
11. [Thay đổi backend theo file](#11-thay-đổi-backend-theo-file)
12. [Thay đổi frontend theo file](#12-thay-đổi-frontend-theo-file)
13. [Leaderboard và xuất Excel](#13-leaderboard-và-xuất-excel)
14. [Tương thích dữ liệu cũ và clone cuộc thi](#14-tương-thích-dữ-liệu-cũ-và-clone-cuộc-thi)
15. [Bộ kiểm thử và tiêu chí nghiệm thu](#15-bộ-kiểm-thử-và-tiêu-chí-nghiệm-thu)
16. [Các bước triển khai](#16-các-bước-triển-khai)
17. [Triển khai vận hành và giới hạn thiết kế](#17-triển-khai-vận-hành-và-giới-hạn-thiết-kế)
18. [Phụ lục code và dữ liệu minh họa](#18-phụ-lục-code-và-dữ-liệu-minh-họa)
19. [Nguồn đối chiếu](#19-nguồn-đối-chiếu)

---

## 1. Phương án đã chốt

### 1.1. Nguyên tắc sản phẩm

1. Public và private được admin tạo thành **hai cuộc thi độc lập**.
2. Trong mỗi cuộc thi, khu vực **Chấm điểm / setup ground truth** chứa toàn bộ cấu hình dữ liệu và bộ chấm.
3. Admin cung cấp bộ chấm bằng một trong hai cách:
   - Tải lên tệp Python `.py`.
   - Dán code vào trình soạn thảo.
4. Bộ chấm phải cung cấp hàm `evaluate(ground_truth_path, submission_path)`.
5. Hàm trả về một dictionary phẳng có dạng `dict[str, number]`.
6. Admin khai báo tên hiển thị của các metric và chọn đúng một metric chính.
7. Các khóa metric khai báo phải khớp chính xác các khóa hàm trả về.
8. Mọi công thức, tỷ trọng, cách tính từng task và quy tắc chọn lớp đánh giá đều nằm trong code admin.
9. Cuộc thi mới chỉ được publish khi bộ chấm, dữ liệu và hợp đồng kết quả đã được xác minh hợp lệ.
10. Backend dùng metric chính để chọn bài tốt nhất và xếp hạng; frontend hiển thị từ cấu hình metric.

### 1.2. Phân chia trách nhiệm

| Thành phần | Trách nhiệm |
|---|---|
| Admin | Viết code, thiết lập CSV, tải đáp án, đặt tên metric, chọn metric chính, chạy thử và đối chiếu tính đúng của công thức |
| Backend | Xác thực quyền, kiểm tra CSV, đối chiếu ID, điều phối thực thi, kiểm tra dictionary, lưu kết quả, áp dụng quota và xếp hạng |
| Runner | Thực thi đúng source Python được giao trong môi trường giới hạn và trả kết quả có cấu trúc |
| Frontend | Hiển thị cấu hình, hỗ trợ nhập code, chạy thử, hiển thị metric và lỗi theo dữ liệu API |
| Code `evaluate` | Đọc dữ liệu và thực hiện toàn bộ phép tính điểm |

### 1.3. Ví dụ kết quả cần hỗ trợ

**Bài toán một task:**

```json
{
  "precision": 0.91,
  "recall": 0.88,
  "f1": 0.8947486033519553
}
```

**Bài toán hai task:**

```json
{
  "f1_task1": 0.82,
  "f1_task2": 0.73,
  "f1_final": 78.4
}
```

**Một công thức khác trong tương lai:**

```json
{
  "error_rate": 0.12,
  "custom_score": 87.5
}
```

Các ví dụ trên dùng cùng một luồng ứng dụng. Tên khóa không làm backend lựa chọn một công thức nội bộ.

---

## 2. Hiện trạng mã nguồn và khoảng thiếu

### 2.1. Những phần đã có và có thể tái sử dụng

- FastAPI, MongoDB và hệ thống phân quyền admin/thí sinh.
- Lifecycle cuộc thi: `draft → published → closed`, có thao tác reopen và clone.
- Upload ground truth riêng tư.
- Đọc CSV UTF-8/UTF-8 BOM.
- Kiểm tra cột bắt buộc, giá trị rỗng, ID trùng, thiếu/thừa ID.
- Căn dự đoán theo ID trong bộ chấm hiện tại.
- Nộp CSV kèm notebook `.ipynb`; kiểm tra notebook và lưu artifact.
- Giữ quota bằng thao tác nguyên tử; bài không lưu thành công được hoàn lượt đã giữ.
- Lưu `metrics` và `primary_score` trên submission.
- Chọn bài tốt nhất, loại bài bị admin từ chối khỏi xếp hạng.
- Trang lịch sử, leaderboard, bảng admin và xuất Excel.
- Kiểm tra notebook bằng AI là luồng độc lập với điểm số.

### 2.2. Các giới hạn đã xác nhận

| Vị trí | Hành vi hiện tại | Hệ quả |
|---|---|---|
| `backend/app/scoring/service.py`, `ScoringConfig` | Một `id_column`, một `prediction_column`, một `label_column`, một `average` | Chưa mô tả được CSV nhiều cột dự đoán |
| Cùng file, `PRIMARY_METRICS` | Chỉ có `f1`, `precision`, `recall` | Chưa chấp nhận metric tùy chỉnh |
| Cùng file, `score_submission()` | Gọi trực tiếp các hàm sklearn | Công thức nằm trong backend |
| Cùng file, `validate_config()` | Chặn `higher_is_better=False` | Chưa xếp hạng chỉ số càng thấp càng tốt |
| Cùng file, `load_ground_truth()` và kiểm tra prediction | Suy tập nhãn từ ground truth đang dùng | Nhãn hợp lệ nhưng không xuất hiện trong tập đáp án có thể bị từ chối |
| Cùng file, `_read_required_rows()` | Chỉ yêu cầu các cột cần thiết; có thể nhận cột phụ | Khác với hướng dẫn frontend đang yêu cầu đúng hai cột |
| `backend/app/scoring/readiness.py` | Kiểm tra config và ground truth | Chưa có điều kiện code, runtime, chạy thử và output contract |
| `backend/app/scoring/admin_router.py`, `_is_locked()` | Khóa khi closed hoặc đã có bài completed | Published nhưng chưa có điểm vẫn có thể sửa cấu hình chấm |
| `backend/app/competitions/service.py` | Model và validator metric giới hạn ba tên | Cần đổi cả luồng tạo/sửa và serializer cuộc thi |
| `backend/app/leaderboard/service.py` | Luôn sort `primary_score` giảm dần | Chưa hỗ trợ metric nhỏ hơn là tốt hơn |
| `backend/app/submissions/admin_router.py`, `_build_workbook()` | Cột Excel F1/Precision/Recall cố định | Không xuất được bảng metric tùy chỉnh |
| `frontend/src/api/results.ts` | `Metrics` có ba thuộc tính cố định | Các trang bị ràng buộc vào ba metric |
| `frontend/src/components/AdminCompetitionManagement.tsx` | Chọn metric ngay khi tạo cuộc thi, dropdown ba giá trị | Cần chuyển việc chọn metric sang setup bộ chấm |
| `frontend/src/pages/MySubmissionsPage.tsx` | Tìm điểm lớn nhất trong trang lịch sử hiện tại | Cần xử lý chiều xếp hạng và ý nghĩa “bài tốt nhất” rõ ràng |
| `backend/app/competitions/admin_router.py`, `clone_competition()` | Clone cấu hình chung; chưa copy bộ chấm | Chưa thuận tiện tạo public/private với cùng evaluator |

### 2.3. Điểm cần hiểu chính xác

Code hiện tại **đã cho đổi tên cột**, nhưng mới hỗ trợ một cặp cột nhãn–dự đoán. Thay đổi cần thiết là mở rộng hợp đồng CSV và nhận code chấm tùy chỉnh.

Trường `metrics` phía backend vốn là dictionary nên có thể tái sử dụng. Phần ràng buộc lớn nằm ở bộ tính điểm, validator, metadata API và các màn hình frontend.

Đánh giá này dựa trên đọc mã nguồn và các test hiện có; không phải báo cáo chạy thử tính năng mới.

---

## 3. Phạm vi triển khai

### 3.1. Trong phạm vi

- Cấu hình schema CSV nhiều cột.
- Nhập code bằng `.py` hoặc dán code.
- Chạy thử evaluator với ground truth của cuộc thi.
- Khai báo metric động, chọn metric chính và chiều xếp hạng.
- Điều kiện publish bắt buộc có evaluator hợp lệ.
- Chấm submission bằng evaluator.
- Hiển thị metric động trên tất cả màn hình liên quan.
- Xuất Excel đồng nhất với leaderboard.
- Lưu phiên bản bộ chấm để truy vết.
- Clone bộ cấu hình sang cuộc thi nháp khác.
- Tương thích kết quả cuộc thi cũ.

### 3.2. Ngoài phạm vi của đợt này

- Một cuộc thi chứa nhiều giai đoạn public/private.
- Giao diện cấu hình số task, tỷ trọng 60/40 hoặc trình xây công thức.
- Cài package tùy ý từ nội dung code admin.
- Chạy notebook của sinh viên để huấn luyện hoặc tái lập mô hình.
- Tự động sửa công thức admin khi kết quả khác dự kiến.
- Tự chấm lại toàn bộ lịch sử sau khi thay code.
- Bảng tổng hợp nhiều challenge hoặc phép chuẩn hóa phụ thuộc điểm tất cả đội.

### 3.3. Quy ước tương thích

Tính năng mới áp dụng cho cuộc thi mới và các bản nháp chuyển sang chế độ Python evaluator. Cuộc thi đã có kết quả theo bộ chấm cũ tiếp tục đọc kết quả cũ đúng nghĩa; không tự đổi điểm lịch sử.

---

## 4. Luồng thao tác của admin

### 4.1. Vị trí giao diện

Giữ tab **Chấm điểm** trong trang quản trị chi tiết cuộc thi. Bố trí theo thứ tự:

1. Định dạng dữ liệu.
2. Ground truth.
3. Bộ chấm Python.
4. Kết quả và metric.
5. Trạng thái sẵn sàng publish.

Tên và thông báo trên UI dùng ngôn ngữ dễ hiểu. Các hash, đường dẫn lưu trữ và thông tin vận hành không cần xuất hiện trong luồng sử dụng thông thường.

### 4.2. Khai báo định dạng dữ liệu

Admin khai báo cột của từng tệp. Ví dụ NLP:

| Vai trò | Cột ground truth | Cột submission | Kiểu | Giá trị hợp lệ |
|---|---|---|---|---|
| ID | `id` | `id` | integer | Không rỗng, duy nhất |
| Tín nhiệm | `label` | `predict_label` | integer | 0, 1 |
| Thể loại | `type` | `predict_type` | integer | 0, 1, 2, 3, 4, 5 |

Có thể khai báo ID khác tên giữa hai tệp, ví dụ `sample_id` ở đáp án và `id` ở submission.

Bảng mapping hỗ trợ admin nhìn rõ hai phía. Hợp đồng dưới backend vẫn là schema từng tệp và cặp cột ID; các phép tính sử dụng cột nào do source Python quyết định.

### 4.3. Tải ground truth

- Chọn CSV.
- Kiểm tra schema, ID và giới hạn dung lượng.
- Hiển thị metadata hợp lệ.
- Nếu thay đáp án, thông báo rằng bộ chấm cần chạy thử lại.

### 4.4. Nhập bộ chấm

Các trường:

| Trường | Ý nghĩa |
|---|---|
| Tên bộ chấm | Tên quản lý do admin đặt, ví dụ “NLP 2026 — điểm tổng” |
| Tải tệp Python | Đọc nội dung UTF-8 từ `.py` và đưa vào cùng trình soạn thảo |
| Source code | Toàn bộ module Python có hàm `evaluate` |
| Lưu bộ chấm | Lưu bản nháp sau kiểm tra kích thước, cú pháp và hợp đồng hàm |
| Chạy thử | Thực thi source đã lưu với ground truth và CSV mẫu |

Tải file và dán code cùng tạo ra một source duy nhất. Nếu admin tải file rồi sửa trong editor, source đã lưu từ editor là bản được sử dụng.

### 4.5. Chạy thử và nhận diện metric

1. Admin tải một submission mẫu có đầy đủ ID tương ứng ground truth.
2. Backend kiểm tra CSV và chạy evaluator.
3. UI hiển thị dictionary trả về cùng thời gian thực thi.
4. Các khóa metric được điền vào bảng cấu hình.
5. Admin đặt tên hiển thị, thứ tự, số thập phân và chọn metric chính.
6. Khi lưu, backend kiểm tra bảng metric khớp các khóa đã chạy thử.

Khóa metric được nhận diện từ kết quả chạy thật, không suy đoán bằng regex từ source code.

Nếu muốn đổi tên khóa, admin sửa code và chạy thử lại. Tên hiển thị trên UI được chỉnh riêng.

### 4.6. Publish

UI hiển thị trạng thái từng điều kiện:

- Định dạng dữ liệu hợp lệ.
- Ground truth hợp lệ.
- Đã lưu code.
- Đã chạy thử thành công.
- Metric khớp output.
- Đã chọn metric chính và chiều xếp hạng.

Nút Publish chỉ khả dụng khi các điều kiện đã đạt. Backend vẫn kiểm tra lại khi nhận request publish, kể cả client gửi request trực tiếp.

### 4.7. Phân biệt chạy được và tính đúng

Chạy thử thành công chứng minh code thực thi được và đáp ứng hợp đồng đầu vào/đầu ra. Việc đó không tự chứng minh công thức đúng với thể lệ.

Admin cần đối chiếu ít nhất một bộ dữ liệu nhỏ có kết quả tính tay hoặc kết quả tham chiếu đáng tin cậy trước khi công bố. Bộ dữ liệu minh họa ở phụ lục phục vụ cách kiểm tra này.

---

## 5. Hợp đồng dữ liệu CSV

### 5.1. Schema từng tệp

Mỗi schema gồm:

- `id_column`: tên cột định danh.
- `columns`: danh sách cột khai báo.
- `allow_extra_columns`: có cho phép cột phụ hay không.

Mỗi cột gồm:

| Thuộc tính | Kiểu | Ý nghĩa |
|---|---|---|
| `name` | string | Tên cột, phân biệt chữ hoa/thường |
| `type` | `string / integer / number` | Kiểu dữ liệu dùng để kiểm tra |
| `nullable` | boolean | Có cho phép ô rỗng hay không |
| `allowed_values` | array hoặc null | Tập giá trị được phép; bỏ trống nghĩa là không giới hạn theo enum |

Tất cả cột trong danh sách đều phải có trong header. `nullable` chỉ điều khiển ô dữ liệu, không biến cột thành tùy chọn. Tên cột trong schema phải duy nhất. `allowed_values` không khai báo hoặc bằng `null` nghĩa là không kiểm tra enum; mảng rỗng là cấu hình không hợp lệ.

### 5.2. Mặc định đề xuất

- Ground truth cho phép cột phụ.
- Submission không cho phép cột phụ.
- ID bắt buộc không rỗng, duy nhất.
- Tập ID phải khớp hoàn toàn.
- Schema hai phía phải dùng cùng kiểu ID: `string` hoặc `integer`; không dùng số thực làm ID.
- Dữ liệu mẫu sinh ra từ schema phải phù hợp kiểu và enum đã khai báo.

### 5.3. Quy tắc đọc và kiểm tra

1. Chấp nhận UTF-8 và UTF-8 BOM.
2. CSV phân cách bằng dấu phẩy.
3. Không chấp nhận header trùng, thiếu, rỗng hoặc có khoảng trắng thừa.
4. Tên cột phải khớp chính xác cấu hình.
5. Không chấp nhận dòng có số trường không phù hợp.
6. Kiểm tra giá trị rỗng theo từng cột.
7. Kiểm tra kiểu và enum theo schema.
8. Kiểm tra trùng, thiếu và thừa ID.
9. Dùng trần dung lượng hiện có cho CSV và giới hạn số dòng hiện có, sau đó đo lại với runner khi triển khai.
10. Tập giá trị hợp lệ phải lấy từ cấu hình admin; không tự thu hẹp theo các lớp xuất hiện trong đáp án.

### 5.4. ID và chuẩn bị file cho evaluator

- Với ID kiểu `string`, giữ nguyên nội dung định danh: `001` khác `1`. Không tự ép thành số.
- Với ID kiểu `integer`, dùng biểu diễn số nguyên chuẩn; không chấp nhận các dạng mơ hồ như `1.0` hoặc `001`. Nếu số 0 đầu có ý nghĩa, admin chọn kiểu string.
- Giá trị ID có khoảng trắng thừa ở đầu/cuối bị từ chối để tránh khớp ngoài ý muốn.
- Không so sánh bằng số dòng hoặc vị trí dòng đơn thuần.
- Sau khi kiểm tra, tạo bản sao submission được sắp theo thứ tự ID của ground truth.
- Không đổi tên cột; không bỏ cột phụ nếu schema đã cho phép.
- CSV gốc sinh viên nộp vẫn được lưu làm artifact gốc.
- Quy tắc chuẩn bị dữ liệu phải có phiên bản vì thay đổi quy tắc này có thể ảnh hưởng evaluator.

Backend không tự loại lớp 0, chọn positive label, tính trung bình macro hoặc gộp task trong bước này.

### 5.5. Lỗi CSV nên dễ sửa

Ví dụ thông báo:

- “Thiếu cột bắt buộc: predict_type.”
- “Cột predict_label tại dòng 18 phải là số nguyên.”
- “Cột predict_type tại dòng 18 có giá trị ngoài danh sách cho phép.”
- “Tập ID không khớp: thiếu 2, thừa 1.”
- “Cột id chứa ID trùng lặp.”

Thông báo chỉ nêu lỗi ở dữ liệu sinh viên hoặc số lượng chênh lệch; không trả nhãn đáp án hay danh sách bản ghi ground truth riêng tư.

---

## 6. Hợp đồng hàm evaluate và kết quả

### 6.1. Chữ ký hàm

```python
def evaluate(
    ground_truth_path: str,
    submission_path: str,
) -> dict[str, float]:
    ...
```

Quy ước:

- Hàm đồng bộ thông thường.
- Nhận đúng hai đối số vị trí.
- Hai đường dẫn do runner cung cấp.
- Admin có thể định nghĩa helper function và import thư viện được cài sẵn.
- Source có thể chứa code ở cấp module; tất cả code đó chỉ thực thi trong sandbox của lượt chấm.
- Kiểm tra cú pháp hoặc AST không được xem là biện pháp cô lập thực thi.

### 6.2. Dictionary đầu ra

Kết quả phải thỏa mãn:

- Là dictionary phẳng, không rỗng.
- Khóa là string.
- Giá trị là `int` hoặc `float` của Python, không phải boolean.
- Giá trị phải hữu hạn.
- Không chấp nhận `None`, `NaN`, `Infinity`, mảng, DataFrame, tuple hoặc dictionary lồng nhau.
- Giá trị NumPy scalar nên được admin chuyển rõ bằng `float(...)` hoặc `int(...)` trước khi trả về.

**Không tự giới hạn metric trong [0,1].** Một evaluator có thể trả điểm 0–100, sai số, số âm hoặc thang đo khác tùy công thức.

### 6.3. Quy tắc khóa metric

Đề xuất khóa theo mẫu:

```text
[A-Za-z][A-Za-z0-9_]{0,63}
```

Quy tắc này cho phép `f1_task1`, `F1_Final`, `custom_score` nhưng tránh dấu chấm, ký tự `$` và các ký tự gây nhập nhằng với đường dẫn field MongoDB.

Khóa phân biệt chữ hoa/thường. Không tự chuyển `F1` thành `f1`.

### 6.4. Khớp output contract

Điều kiện:

```text
set(result.keys()) == {metric["key"] for metric in output_contract["metrics"]}
```

Thứ tự dictionary trả về không quyết định thứ tự cột UI. Thứ tự cột lấy từ danh sách `output_contract.metrics` đã lưu. Trong phần mô tả frontend, `metric_definitions` là tên gọi của chính danh sách này, không phải một nguồn cấu hình thứ hai.

Mỗi key trong danh sách khai báo phải duy nhất; label hiển thị phải có nội dung. Không dùng tên hiển thị làm khóa tra kết quả.

Thừa hoặc thiếu khóa đều là lỗi. Không tự bỏ metric thừa và không thay metric thiếu bằng 0.

### 6.5. Chọn điểm chính

```text
primary_score = metrics[primary_metric]
```

Metric chính phải là một khóa hợp lệ trong output contract. Hệ thống không tự tính thêm điểm tổng.

Chiều xếp hạng là thông tin riêng:

- `higher_is_better = true`: điểm lớn hơn đứng trước.
- `higher_is_better = false`: điểm nhỏ hơn đứng trước.

### 6.6. Tính lặp lại

Code chấm nên cho cùng kết quả với cùng code, input và runtime. Code không nên phụ thuộc thời gian hiện tại, ngẫu nhiên không cố định hoặc dữ liệu bên ngoài.

Lượt chạy thử kiểm tra khả năng thực thi và output; không thể chứng minh toàn bộ tính xác định của một chương trình Python. Dấu vết phiên bản và fixture tham chiếu giúp kiểm tra khi có khiếu nại.

---

## 7. Thiết kế dữ liệu lưu trữ

### 7.1. Nguyên tắc

- Dùng `scoring_config.version = 2` để nhận diện cấu hình Python.
- Tập trung schema, evaluator metadata và output contract tại một cấu hình.
- Source và ground truth là file riêng tư có hash.
- Metadata và trạng thái xác minh lưu trong MongoDB.
- Public API chỉ trả phần cần cho thí sinh.
- Không duy trì hai nguồn cấu hình metric chính có thể chỉnh độc lập.

### 7.2. Ví dụ cấu hình đã hoàn thiện

JSON sau là **mô hình lưu trữ đề xuất**; các giá trị dạng `<...>` là placeholder minh họa.

```json
{
  "version": 2,
  "revision": 7,
  "input_schema": {
    "ground_truth": {
      "id_column": "id",
      "allow_extra_columns": true,
      "columns": [
        {"name": "id", "type": "integer", "nullable": false},
        {"name": "label", "type": "integer", "nullable": false, "allowed_values": [0, 1]},
        {"name": "type", "type": "integer", "nullable": false, "allowed_values": [0, 1, 2, 3, 4, 5]}
      ]
    },
    "submission": {
      "id_column": "id",
      "allow_extra_columns": false,
      "columns": [
        {"name": "id", "type": "integer", "nullable": false},
        {"name": "predict_label", "type": "integer", "nullable": false, "allowed_values": [0, 1]},
        {"name": "predict_type", "type": "integer", "nullable": false, "allowed_values": [0, 1, 2, 3, 4, 5]}
      ]
    },
    "id_matching": "exact",
    "row_alignment": "ground_truth_order",
    "preprocessing_version": 1
  },
  "evaluator": {
    "name": "NLP Challenge 2026",
    "entrypoint": "evaluate",
    "source_path": "<private-path>",
    "source_sha256": "<sha256>",
    "runtime_id": "<pinned-runtime-id>"
  },
  "output_contract": {
    "metrics": [
      {"key": "f1_task1", "label": "F1 tín nhiệm", "decimals": 4},
      {"key": "f1_task2", "label": "F1 thể loại", "decimals": 4},
      {"key": "f1_final", "label": "Điểm tổng NLP", "decimals": 2}
    ],
    "primary_metric": "f1_final",
    "higher_is_better": true
  },
  "verification": {
    "state": "passed",
    "execution_fingerprint": "<sha256>",
    "config_fingerprint": "<sha256>",
    "observed_keys": ["f1_task1", "f1_task2", "f1_final"],
    "tested_submission_sha256": "<sha256>",
    "tested_at": "<UTC timestamp>",
    "tested_by": "<admin-id>"
  },
  "locked_at": null
}
```

### 7.3. Ground truth metadata

Bổ sung hash và phiên bản vào metadata hiện tại:

```json
{
  "path": "<private-path>",
  "sha256": "<sha256>",
  "row_count": 1000,
  "columns": ["id", "label", "type"],
  "uploaded_at": "<UTC timestamp>"
}
```

Path do server tạo và kiểm tra, không nhận một đường dẫn filesystem tùy ý từ admin.

### 7.4. Cấu hình nháp có thể chưa hoàn thiện

Khi admin đang thiết lập:

- `evaluator` có thể chưa có.
- `output_contract` có thể chưa có.
- `primary_metric` chưa chọn có thể là null.
- `ready` phải false.

Lưu nháp và đủ điều kiện publish là hai mức kiểm tra khác nhau. Không ép admin khai báo tất cả thông tin ngay từ màn hình tạo cuộc thi.

### 7.5. Phiên bản và dấu xác minh

**Execution fingerprint** bao gồm:

- Hash source.
- Hash ground truth.
- Schema đầu vào đã chuẩn hóa.
- Phiên bản chuẩn bị CSV.
- Runtime ID và phiên bản giao thức runner.

**Config fingerprint** bổ sung output contract và chiều xếp hạng.

Một lượt chạy thử thành công ghi nhận execution fingerprint và tập khóa đã quan sát. Khi admin đặt tên metric/chọn metric chính, backend chỉ xác nhận cấu hình nếu fingerprint thực thi vẫn khớp và tập khóa khai báo khớp kết quả đã chạy.

Thay code, ground truth, schema hoặc runtime làm lượt chạy thử mất hiệu lực. Chỉnh metadata hiển thị trong bản nháp có thể xác minh lại bằng kiểm tra tĩnh khi kết quả thực thi vẫn còn hiệu lực.

### 7.6. Submission

Tiếp tục dùng hai field cũ:

```json
{
  "metrics": {
    "f1_task1": 0.82,
    "f1_task2": 0.73,
    "f1_final": 78.4
  },
  "primary_score": 78.4,
  "scoring_ref": {
    "version": 2,
    "revision": 7,
    "config_fingerprint": "<sha256>",
    "source_sha256": "<sha256>",
    "ground_truth_sha256": "<sha256>",
    "runtime_id": "<pinned-runtime-id>"
  }
}
```

Các hash và đường dẫn nội bộ không cần trả cho thí sinh. Lưu thêm hash của CSV gốc để đối chiếu file đã chấm nếu cần.

### 7.7. Ghi file và MongoDB nhất quán

MongoDB hiện dùng mô hình không yêu cầu transaction nhiều document. Với source/ground truth:

1. Ghi file mới theo phiên bản/hash, không ghi đè file đang được tham chiếu.
2. Xác minh file đã ghi đầy đủ.
3. Cập nhật con trỏ cấu hình bằng điều kiện `expected_revision` và trạng thái draft.
4. Nếu có xung đột, trả 409; không ghi đè thay đổi của admin khác.
5. File không được tham chiếu có thể được dọn sau.

Publish cũng phải cập nhật có điều kiện theo revision đã xác minh để tránh tình huống vừa kiểm tra xong thì cấu hình bị request khác thay đổi.

---

## 8. Hợp đồng API đề xuất

### 8.1. Tận dụng endpoint hiện có

| Endpoint | Thay đổi |
|---|---|
| `GET /api/admin/competitions/{id}/scoring` | Trả cấu hình nháp/đã khóa, source dành cho admin, metadata ground truth, trạng thái xác minh và lý do chưa sẵn sàng |
| `PUT /api/admin/competitions/{id}/scoring` | Nhận cấu hình v2 và `expected_revision`; lưu source, schema, output contract; cho phép trạng thái nháp chưa hoàn thiện |
| `PUT /api/admin/competitions/{id}/ground-truth` | Upload CSV theo schema v2, tính hash, tăng revision và vô hiệu hóa kết quả xác minh cũ |
| `POST /api/admin/competitions/{id}/scoring/test` | Endpoint mới: nhận submission mẫu, chạy evaluator, trả metric và cập nhật kết quả chạy thử |
| `POST /api/admin/competitions/{id}/publish` | Áp dụng readiness mới và khóa revision |
| `POST /api/admin/competitions/{id}/clone` | Copy source/schema/output contract sang draft mới; không copy ground truth hoặc dấu xác minh |
| `POST /api/competitions/{id}/submissions` | Giữ multipart CSV + notebook; kết quả `metrics` trở thành dictionary động |
| Các endpoint history, leaderboard, admin và export | Bổ sung metadata metric theo đúng phạm vi, dùng chung output contract |

### 8.2. Nhập file .py

Không bắt buộc tạo một API upload Python riêng.

Phương án đơn giản:

1. Frontend đọc file `.py` dưới dạng UTF-8.
2. Đưa nội dung vào editor.
3. Gửi `source_code` qua `PUT /scoring` giống code dán.
4. Backend kiểm tra giới hạn kích thước, cú pháp và lưu source.

Backend vẫn phải kiểm tra dữ liệu độc lập; không dựa vào phần mở rộng file ở frontend để kết luận code hợp lệ.

### 8.3. Request lưu cấu hình

Request dùng các nhóm giống cấu hình lưu trữ nhưng:

- Nhận `evaluator.source_code` thay vì `source_path`.
- Nhận `expected_revision`.
- Không nhận client tự khai `verification.passed`, hash, `locked_at` hoặc runtime tùy ý.
- Các field quản lý phiên bản và xác minh do backend tạo.

Với upload ground truth và chạy thử, gửi `expected_revision` trong multipart form cùng file. Backend phải đối chiếu revision trước khi xử lý và trước khi ghi kết quả; không dùng bản nháp mới hơn để hoàn tất một request bắt đầu từ bản cũ.

### 8.4. Response trạng thái admin

Ví dụ:

```json
{
  "ready": false,
  "locked": false,
  "revision": 4,
  "not_ready_reason": {
    "code": "SCORING_TEST_REQUIRED",
    "message": "Cần chạy thử bộ chấm với cấu hình hiện tại."
  },
  "checks": {
    "schema": "passed",
    "ground_truth": "passed",
    "evaluator": "passed",
    "test": "required",
    "output_contract": "pending"
  }
}
```

Giữ `not_ready_reason` để các banner hiện có dễ thích ứng; `checks` giúp UI trình bày từng điều kiện.

### 8.5. Response chạy thử

Lượt thử kỹ thuật thành công có thể trả:

```json
{
  "status": "passed",
  "execution_fingerprint": "<sha256>",
  "metrics": {
    "f1_task1": 0.82,
    "f1_task2": 0.73,
    "f1_final": 78.4
  },
  "observed_keys": ["f1_task1", "f1_task2", "f1_final"],
  "duration_ms": 412,
  "output_contract_matches": true
}
```

`duration_ms` ở đây chỉ là ví dụ, không phải số đo thực tế.

Nếu chưa khai báo output contract, lượt chạy vẫn có thể trả các khóa để admin thiết lập và `output_contract_matches` là `null`; cuộc thi chưa sẵn sàng publish cho đến khi lưu output contract hợp lệ. Nếu đã có contract nhưng key khác output mới, trả `output_contract_matches=false`, cho admin xem khóa thực tế để cập nhật và giữ `ready=false`.

Kết quả từ một lượt thử đang chạy phải được kiểm tra revision/fingerprint trước khi ghi vào trạng thái hiện tại. Nếu admin đã sửa code trong lúc thử, kết quả cũ không được đánh dấu cấu hình mới là hợp lệ.

### 8.6. Public response

Chỉ trả:

- Schema submission cần cho thí sinh.
- Giới hạn dung lượng.
- Tên bộ chấm nếu cần hiển thị.
- Danh sách metric: key, label, decimals.
- Metric chính và chiều xếp hạng.
- Trạng thái sẵn sàng phù hợp quyền truy cập.

Không trả source Python, ground truth rows, đường dẫn lưu trữ hoặc output chạy thử của admin.

### 8.7. Tính nhất quán của metadata metric

- Trong một cuộc thi: trả metadata một lần ở response cấp cuộc thi hoặc cấp danh sách.
- Bảng admin toàn hệ thống: gắn metadata với từng cuộc thi trong response, để bài của hai cuộc thi có bộ metric khác nhau vẫn hiển thị đúng.
- Frontend sử dụng dữ liệu từ API, không xây thêm bảng tên metric cố định.

---

## 9. Luồng xử lý backend

### 9.1. Lưu bản nháp

1. Xác thực admin.
2. Kiểm tra cuộc thi được phép sửa bộ chấm.
3. Kiểm tra `expected_revision`.
4. Kiểm tra schema và metadata đã khai báo.
5. Kiểm tra source bằng parse/compile cú pháp mà không thực thi trong API.
6. Lưu file source riêng tư nếu thay đổi.
7. Tính lại fingerprint.
8. Giữ hoặc vô hiệu hóa kết quả chạy thử theo fingerprint.
9. Lưu cấu hình bằng cập nhật có điều kiện.
10. Trả trạng thái readiness thống nhất.

### 9.2. Chạy thử

1. Đọc một snapshot cấu hình nháp.
2. Kiểm tra schema, ground truth và source đã đủ.
3. Kiểm tra CSV mẫu như CSV sinh viên.
4. Chuẩn bị hai tệp cho evaluator.
5. Gửi tới runner.
6. Kiểm tra dictionary đầu ra.
7. So sánh output contract nếu đã có.
8. Ghi nhận kết quả thử cho đúng fingerprint.
9. Trả metric hoặc chẩn đoán dành cho admin.

Lượt thử không tạo submission, không cấp số bài, không giữ quota và không kích hoạt AI review notebook.

### 9.3. Publish

Readiness phải kiểm tra:

- Các điều kiện hiện có như mã tham gia.
- Cấu hình v2 hoàn thiện.
- Ground truth và source tồn tại, đọc được, khớp hash.
- Runtime cần dùng có khả năng phục vụ.
- Lượt chạy thử hợp lệ cho fingerprint hiện tại.
- Output contract khớp tập khóa đã xác minh.
- Có đúng một metric chính và chiều xếp hạng hợp lệ.

Sau đó chuyển trạng thái bằng một cập nhật có điều kiện theo status và revision. Lưu revision được khóa.

Không chạy lại toàn bộ evaluator mỗi lần GET trang admin. Chạy code chỉ xảy ra khi admin yêu cầu chạy thử hoặc khi chấm submission; publish xác minh bằng chứng hiện tại và khả năng vận hành runner.

### 9.4. Nhận submission

Giữ thứ tự quan trọng của luồng hiện có:

1. Xác thực tài khoản, membership, trạng thái và thời hạn cuộc thi.
2. Kiểm tra quota sớm.
3. Đọc bộ chấm đã khóa và kiểm tra tính sẵn sàng.
4. Đọc giới hạn CSV và notebook.
5. Kiểm tra notebook theo cơ chế hiện tại.
6. Kiểm tra CSV và đối chiếu ID.
7. Chuẩn bị tệp và gọi runner.
8. Kiểm tra dictionary đúng output contract.
9. Lấy `primary_score` theo metric chính.
10. Giữ quota bằng thao tác nguyên tử hiện có.
11. Cấp số submission, lưu artifact và document.
12. Ghi metadata phiên bản bộ chấm.
13. Khởi tạo hậu kiểm AI theo luồng hiện có.
14. Trả metric động và quota còn lại.

Nếu file lưu thất bại sau khi giữ quota, tiếp tục dùng cơ chế hoàn lượt/cleanup hiện có.

Giới hạn đồng thời ở runner phải áp dụng chung cho các API worker; không chỉ dùng biến đếm cục bộ của một process.

### 9.5. Phân loại lỗi

| Mã đề xuất | Tình huống | Người nhận thông tin chi tiết | Trừ lượt |
|---|---|---|---|
| `SUBMISSION_SCHEMA_INVALID` | Thiếu/thừa cột, header lỗi | Thí sinh | Không |
| `SUBMISSION_VALUE_INVALID` | Sai kiểu/giá trị/rỗng | Thí sinh | Không |
| `SUBMISSION_DUPLICATE_IDS` | ID trùng | Thí sinh | Không |
| `SUBMISSION_ID_MISMATCH` | Thiếu/thừa ID | Thí sinh, thông tin giới hạn | Không |
| `EVALUATOR_REQUIRED` | Chưa có code | Admin | Không |
| `EVALUATOR_INVALID` | Sai cú pháp/chữ ký hàm | Admin | Không |
| `SCORING_TEST_REQUIRED` | Chưa thử hoặc kết quả thử hết hiệu lực | Admin | Không |
| `EVALUATOR_OUTPUT_MISMATCH` | Output không đúng hợp đồng | Admin | Không |
| `EVALUATOR_TIMEOUT` | Chạy quá thời gian | Admin | Không |
| `EVALUATOR_FAILED` | Lỗi thực thi | Admin | Không |
| `EVALUATOR_UNAVAILABLE` | Runner không sẵn sàng/quá tải | Admin, thí sinh nhận thông báo chung | Không |
| `SCORING_REVISION_CONFLICT` | Bản nháp bị sửa đồng thời | Admin | Không |

Trong luồng sinh viên, lỗi của bộ chấm là lỗi hệ thống chấm, không được trình bày như sinh viên nộp sai nhãn. Không trả traceback hoặc log có thể chứa đáp án.

---

## 10. Môi trường thực thi bộ chấm

### 10.1. Lựa chọn kiến trúc

Đề xuất có runner tách khỏi FastAPI. Runner điều phối các sandbox riêng cho từng lượt chấm.

| Thành phần | Dữ liệu/quyền cần có |
|---|---|
| FastAPI | Quyền tài khoản, MongoDB, lưu artifact, lấy cấu hình và giao việc |
| Runner điều phối | Nhận công việc qua kênh nội bộ, quản lý giới hạn đồng thời và sandbox |
| Sandbox của evaluator | Source, hai CSV và vùng ghi kết quả tạm của đúng lượt chấm |

Sandbox thực thi code cần:

- Không có network.
- Không có credential MongoDB/MinIO.
- Không có Docker socket hoặc quyền điều khiển host.
- Chỉ đọc source và input.
- Vùng tạm có giới hạn.
- Giới hạn CPU, RAM, thời gian và số process.
- Kết thúc toàn bộ môi trường của lượt chấm khi timeout.
- Dọn file tạm sau khi xong.

Một subprocess có timeout/rlimit đơn thuần chưa tạo được ranh giới filesystem và network cần thiết. Khi hiện thực, nên dùng sandbox theo cơ chế container/OS phù hợp với hạ tầng Docker hiện có; runner điều phối và sandbox chạy code là hai vai trò khác nhau.

### 10.2. Giao thức kết quả

- Wrapper gọi `evaluate` và serialize dictionary thành JSON.
- Dùng kênh kết quả riêng với stdout/stderr.
- `print()` trong code admin không được làm hỏng việc đọc kết quả.
- Không dùng pickle để truyền kết quả từ sandbox vào API.
- Giới hạn kích thước kết quả và log.
- Log chi tiết chỉ dành cho admin/vận hành và phải tránh ghi đáp án vào log chung.

### 10.3. Thư viện

Cung cấp môi trường Python cố định, có thể gồm:

- Python standard library.
- NumPy.
- Pandas.
- Scikit-learn.

Source không tự cài thêm dependency hoặc tải tài nguyên qua Internet. Khi cần thư viện mới, cập nhật runtime và chạy thử lại evaluator.

Trong repo hiện tại, backend đã khai báo scikit-learn nhưng chưa khai báo pandas. Dependency cho evaluator nên thuộc runtime runner; phiên bản thực tế cần được khóa khi triển khai.

### 10.4. Các giá trị vận hành ban đầu đề xuất

Các giá trị dưới đây là điểm khởi đầu để đo kiểm, không phải thông số đã được benchmark:

| Tham số | Đề xuất ban đầu |
|---|---:|
| Kích thước source tối đa | 256 KiB |
| Số metric tối đa | 20 |
| Độ dài key metric | 64 ký tự |
| Số chữ số thập phân trên UI | 0–8 |
| Thời gian tối đa một lượt | 30 giây |
| RAM tối đa mỗi sandbox | 1 GiB |
| CPU tối đa mỗi sandbox | 1 CPU |
| Số lượt chấm đồng thời | 2, điều chỉnh theo VPS |
| Kết quả JSON tối đa | 64 KiB |

Số liệu cuối cùng phải được kiểm tra với CSV gần giới hạn dung lượng và số lượt nộp đồng thời dự kiến.

---

## 11. Thay đổi backend theo file

Các link ở mục này trỏ tới đúng snapshot đã đọc.

| File | Hàm/khối cần chú ý | Thay đổi |
|---|---|---|
| [scoring/service.py](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/app/scoring/service.py) | `ScoringConfig`, `GroundTruth`, `validate_config`, `load_ground_truth`, `score_submission`, `config_from_competition` | Thêm mô hình v2 và luồng điều phối; tách tính sklearn cố định thành adapter legacy |
| [scoring/admin_router.py](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/app/scoring/admin_router.py) | `configure_scoring`, `upload_ground_truth`, `_scoring_view`, `_is_locked` | Lưu code/schema/output contract; endpoint test; revision và lock theo publish |
| [scoring/readiness.py](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/app/scoring/readiness.py) | `check_readiness`, `blocked_reason` | Gate mới dùng chung cho UI và lifecycle |
| [scoring/storage.py](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/app/scoring/storage.py) | Đường dẫn và đọc ground truth | Thêm source file, hash, đọc phiên bản bất biến |
| [competitions/service.py](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/app/competitions/service.py) | `METRICS`, create/update model, serializer, `_submission_config` | Bỏ enum cố định khỏi đường v2; projection metric động; schema nhiều cột; bản nháp cho phép chưa có metric |
| [competitions/admin_router.py](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/app/competitions/admin_router.py) | `_publish_blocked_reason`, `publish_competition`, `reopen_competition`, `clone_competition` | Gate code bắt buộc; publish theo revision; reopen không bỏ qua tính toàn vẹn bộ chấm v2; clone cấu hình |
| [submissions/router.py](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/app/submissions/router.py) | `submit_submission`, `_ready_config`, `_read_ground_truth` | Dispatch evaluator, validate output, lưu scoring_ref; giữ hành vi quota/artifact |
| [submissions/service.py](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/app/submissions/service.py) | Sort constants, `sort_spec`, serializers, list history | Metric allowlist theo cuộc thi, metadata động và summary bài tốt nhất nếu cần |
| [leaderboard/service.py](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/app/leaderboard/service.py) | `ranked_entries`, response serializers | Nhận hợp đồng xếp hạng, hỗ trợ cả hai chiều; metadata metric |
| [submissions/admin_router.py](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/app/submissions/admin_router.py) | Query validator, global/scoped list, `export_results`, `_build_workbook` | Sort theo metric động khi đã chọn cuộc thi; Excel cột động |
| [core/config.py](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/app/core/config.py) | Settings | Các giới hạn/kênh kết nối runner, không đặt công thức ở env |
| [main.py](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/app/main.py) | Khởi tạo dịch vụ và router | Đăng ký client runner và endpoint mới nếu tách router |
| [backend/Dockerfile](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/Dockerfile), [pyproject.toml](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/pyproject.toml) | Runtime/dependency | Giữ API nhẹ; bổ sung client cần thiết; dependency evaluator đặt trong runtime riêng |
| [docker-compose.yml](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/docker-compose.yml), [docker-compose.prod.yml](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/docker-compose.prod.yml) | Services, healthcheck, tài nguyên | Bổ sung runner, giới hạn và kết nối nội bộ |
| [starter_notebook.py](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/backend/app/competitions/starter_notebook.py) và notebook mẫu | Tài nguyên hướng dẫn | Kiểm tra nội dung mẫu để không hướng dẫn xuất cố định hai cột cho cuộc thi v2 |

### 11.1. Các module mới đề xuất

| Module | Trách nhiệm |
|---|---|
| `backend/app/scoring/models.py` | Model cấu hình v2, input schema, metric definition, verification |
| `backend/app/scoring/csv_validation.py` | Parse, kiểm tra schema/ID, tạo bản sao dữ liệu đã căn dòng |
| `backend/app/scoring/evaluator_client.py` | Gửi job tới runner, timeout, ánh xạ lỗi |
| `backend/app/scoring/output_validation.py` | Kiểm tra dictionary, số hữu hạn, key set, lấy primary score |
| `backend/app/scoring/revisions.py` | Fingerprint, cập nhật có điều kiện, verification và lock |
| `backend/app/scoring/contracts.py` | Projection output contract thống nhất cho v1/v2 |
| `evaluator-runner/` | Wrapper, môi trường chạy và cơ chế sandbox; tên thư mục là đề xuất |

Không dồn code đọc CSV, chạy Python, lưu file và tạo response vào một router.

---

## 12. Thay đổi frontend theo file

### 12.1. Kiểu dữ liệu

Chuyển `Metrics` sang:

```typescript
type Metrics = Record<string, number>;

interface MetricDefinition {
  key: string;
  label: string;
  decimals: number;
}

interface ResultContract {
  metrics: MetricDefinition[];
  primary_metric: string | null;
  higher_is_better: boolean;
}
```

Bản nháp có thể chưa chọn metric chính. Frontend phải hiển thị “Chưa cấu hình” thay vì gọi `toUpperCase()` trên null hoặc ép về F1.

### 12.2. Bản đồ sửa frontend

| File | Thay đổi |
|---|---|
| [api/competitions.ts](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/api/competitions.ts) | Schema động, result contract, primary metric động; thay cách dùng `METRIC_LABEL` |
| [api/results.ts](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/api/results.ts) | `Record<string, number>`, metadata metric, kiểu sort động có kiểm soát |
| [AdminCompetitionDetailPage.tsx](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/pages/AdminCompetitionDetailPage.tsx) | Thay ScoringPanel; trạng thái readiness; bảng kết quả động |
| [AdminCompetitionManagement.tsx](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/components/AdminCompetitionManagement.tsx) | Chuyển chọn metric chính sang setup bộ chấm; bỏ dropdown ba metric khỏi luồng tạo mới v2 |
| [SubmissionPage.tsx](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/pages/SubmissionPage.tsx) | Cột yêu cầu động, thẻ metric động, tên metric chính đúng cấu hình |
| [MySubmissionsPage.tsx](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/pages/MySubmissionsPage.tsx) | Bảng metric động; chọn bài tốt nhất theo chiều; xử lý phân trang rõ ràng |
| [LeaderboardPage.tsx](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/pages/LeaderboardPage.tsx) | Cột động, mô tả metric chính và chiều xếp hạng |
| [AdminSubmissionsPanel.tsx](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/components/AdminSubmissionsPanel.tsx) | Bỏ `METRIC_FIELDS` cố định; metadata theo cuộc thi; sort theo metric khi có phạm vi hợp lệ |
| [submissionRequirements.ts](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/lib/submissionRequirements.ts) | Sinh header và ví dụ từ schema; đồng bộ mã lỗi thật |
| [CompetitionGuidePage.tsx](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/pages/CompetitionGuidePage.tsx) | Hướng dẫn theo schema; CSV mẫu tải được; bỏ quy định cố định hai cột |
| [CompetitionContentPanel.tsx](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/pages/CompetitionContentPanel.tsx) | Danh sách cột và nhãn metric động |
| [CompetitionDetailPage.tsx](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/pages/CompetitionDetailPage.tsx) | Chỉ số chính từ result contract |
| [DashboardPage.tsx](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/pages/DashboardPage.tsx) | Tên metric chính động trong thẻ cuộc thi |
| [AdminCompetitionsPage.tsx](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/pages/AdminCompetitionsPage.tsx) | Tên metric động và trạng thái chưa cấu hình |
| [index.css](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/frontend/src/index.css) | Bố cục editor/schema/metric table, responsive khi nhiều metric |

### 12.3. Tách component hợp lý

`AdminCompetitionDetailPage.tsx` hiện rất dài. Đề xuất đưa phần mới vào thư mục riêng, ví dụ:

- `ScoringSetupPanel`: điều phối dữ liệu và trạng thái.
- `CsvSchemaEditor`: khai báo cột.
- `GroundTruthUpload`: upload và metadata.
- `EvaluatorEditor`: tên bộ chấm, upload/dán source.
- `EvaluatorTestPanel`: CSV mẫu, kết quả và lỗi chạy thử.
- `MetricDefinitionEditor`: tên hiển thị, thứ tự, số thập phân, primary metric.
- `ScoringReadinessSummary`: điều kiện publish.

Dùng key ổn định cho các dòng cột/metric; không dùng chỉ số mảng làm định danh khi có thêm/xóa/sắp xếp.

### 12.4. Màn hình kết quả

- Render theo `metric_definitions`.
- Đánh dấu metric chính.
- Thứ tự cột theo cấu hình.
- Không lặp metric chính thành hai cột số giống nhau nếu đã hiển thị trong bảng metric; có thể dùng một thẻ tóm tắt riêng.
- Số âm hoặc điểm >1 vẫn hiển thị bình thường.
- Giá trị thiếu trong record cũ hiển thị “—”, không tự coi là 0.
- Có bảng cuộn ngang hoặc phần chi tiết khi nhiều metric.
- Hiển thị định dạng theo `decimals`; không làm tròn dữ liệu trước khi xếp hạng.

### 12.5. Bài tốt nhất trong lịch sử

Hiện frontend chỉ chọn điểm lớn nhất trong trang đang xem. Đề xuất backend trả summary bài tốt nhất trên toàn bộ lịch sử hợp lệ của đội, theo đúng chiều xếp hạng.

Nếu chưa bổ sung summary ở đợt đầu, UI phải ghi rõ “tốt nhất trong trang này”; không trình bày một phép giảm trên trang hiện tại như kết quả tốt nhất toàn cuộc thi.

---

## 13. Leaderboard và xuất Excel

### 13.1. Xếp hạng

1. Chỉ lấy submission completed và không bị admin từ chối.
2. Chọn bài tốt nhất của mỗi account theo metric chính và chiều xếp hạng.
3. Khi bằng điểm, dùng thời điểm đạt điểm sớm hơn.
4. Dùng account ID/submission ID làm khóa cuối để kết quả ổn định.
5. Cùng một hàm ranking phục vụ participant, admin và export.

`primary_score` luôn lấy trực tiếp từ output evaluator. Không tự nhân 100, chuẩn hóa hoặc đổi dấu để hiển thị.

### 13.2. Sort bảng admin

- Khi đã chọn một cuộc thi: cho sort theo các khóa metric trong contract của cuộc thi đó.
- Khi xem nhiều cuộc thi: ưu tiên sort thời gian, tên đội, tên cuộc thi; điểm từ các công thức/thang đo khác nhau không mặc nhiên so sánh có ý nghĩa.
- Nếu giữ sort điểm chính toàn cục như hiện tại, mô tả rõ đó chỉ là sắp số; không dùng để công bố xếp hạng liên cuộc thi.
- Backend không nội suy trực tiếp chuỗi sort chưa xác minh vào query MongoDB.

### 13.3. Excel

- Cột metric lấy từ contract.
- Header dùng tên hiển thị; giữ key trong sheet thông tin hoặc chú giải nếu cần phân biệt.
- Dùng cùng dữ liệu ranking với UI.
- Ghi số gốc và định dạng số, không biến metric thành chuỗi đã làm tròn.
- Dùng `get_column_letter` cho độ rộng cột động, thay cách `chr(64 + index)` hiện tại.
- Giữ cơ chế xử lý text bắt đầu bằng `=`, `+`, `-`, `@` để tránh Excel hiểu tên đội là công thức.
- Nên có sheet thông tin: tên cuộc thi, bộ chấm, revision, metric chính, chiều xếp hạng, thời điểm xuất.
- Không xuất source, ground truth hoặc đường dẫn nội bộ.

---

## 14. Tương thích dữ liệu cũ và clone cuộc thi

### 14.1. Cuộc thi cũ

Phương án triển khai từng bước:

- Cấu hình thiếu `version` được nhận diện là v1.
- V1 tiếp tục đi qua bộ chấm cũ nếu cuộc thi đang hoạt động theo cấu hình cũ.
- Result contract của v1 được adapter mô tả thành ba metric F1/Precision/Recall cho UI mới.
- `metrics` và `primary_score` cũ không bị chấm lại hoặc đổi thang.
- Cuộc thi mới dùng v2.
- Bản nháp v1 muốn publish theo luồng mới phải bổ sung evaluator v2 và chạy thử.
- Không cung cấp cách tạo mới v1 để bỏ qua điều kiện bắt buộc có code.
- Với cuộc thi v1 đã publish từ trước, ghi rõ ngoại lệ tương thích trong tài liệu vận hành; không áp dụng một đợt chuyển đổi giữa giờ thi.

### 14.2. Khóa sau publish

V2 khóa:

- Source code.
- Ground truth.
- Input schema và quy tắc chuẩn bị dữ liệu.
- Danh sách key metric.
- Primary metric và chiều xếp hạng.
- Runtime tham chiếu của bộ chấm.

Đề xuất khóa cả metadata trình bày trong đợt đầu để giảm trường hợp lịch sử đổi cách giải thích sau công bố. Nếu cần cho sửa nhãn hiển thị sau này, phải tách rõ thay đổi trình bày khỏi thay đổi điểm.

### 14.3. Clone từ public sang private

Clone v2 nên copy:

- Source Python.
- Tên bộ chấm.
- Schema hai CSV.
- Output contract.
- Các cấu hình chung phù hợp hành vi clone hiện tại.

Clone không mang theo:

- Ground truth.
- Bằng chứng chạy thử.
- Trạng thái locked/published.
- Submission, membership hoặc kết quả.

Bản sao là draft. Admin tải ground truth private, đặt thời gian/hạn mức và chạy thử rồi publish.

Với nguồn clone là v1, bản sao mới chuyển thành draft cần thiết lập evaluator; có thể cung cấp mẫu code tương đương để hỗ trợ admin, nhưng vẫn phải xác minh trước publish.

### 14.4. Rollout không làm vỡ frontend/backend

Trình tự:

1. Backend đọc được v1/v2 và trả metadata bổ sung.
2. Frontend dùng metadata động, có adapter dự phòng cho response cũ.
3. Kiểm tra cuộc thi v1 trên staging.
4. Bật tạo mới v2 sau khi runner đã sẵn sàng.
5. Khóa việc tạo mới/publish mới qua đường v1 theo chính sách đã thống nhất.

Rollback cần lưu ý: sau khi đã tạo cuộc thi v2, không hạ về bản backend không đọc được v2. Khi có lỗi, tắt mở cuộc thi mới hoặc dừng nhận bài v2 có thông báo phù hợp, giữ phiên bản backend còn đọc được dữ liệu đã tạo.

---

## 15. Bộ kiểm thử và tiêu chí nghiệm thu

### 15.1. Ma trận kiểm thử

| ID | Tình huống | Kết quả mong đợi |
|---|---|---|
| CSV-01 | Submission đúng ba cột NLP | Qua kiểm tra |
| CSV-02 | Thiếu `predict_type` | Từ chối trước khi chạy evaluator |
| CSV-03 | Thừa cột khi policy strict | Từ chối rõ tên cột |
| CSV-04 | Header trùng/khác hoa thường | Từ chối |
| CSV-05 | ID thiếu/thừa/trùng | Từ chối, không trừ lượt |
| CSV-06 | Dòng submission đảo thứ tự | Điểm giống bản cùng thứ tự |
| CSV-07 | ID hai tệp khác tên nhưng mapping đúng | Qua kiểm tra và căn dòng đúng |
| CSV-08 | ID string `001` và `1` | Được phân biệt |
| CSV-09 | Nhãn hợp lệ trong enum nhưng vắng ở ground truth | Được chấp nhận, evaluator tự tính ảnh hưởng |
| CSV-10 | Sai kiểu, rỗng không cho phép, số không hữu hạn | Từ chối |
| EVAL-01 | Source dán và file upload có cùng nội dung | Hành vi và hash source nhất quán |
| EVAL-02 | Thiếu evaluate hoặc sai chữ ký | Không cho xác minh/publish |
| EVAL-03 | Code một task trả ba metric | Lưu đúng dictionary |
| EVAL-04 | Code hai task trả điểm tổng | Backend nhận nguyên giá trị, không tính lại |
| EVAL-05 | Công thức trả `custom_score` | Hoạt động không cần thêm enum backend |
| EVAL-06 | Output thừa/thiếu key | Không lưu điểm, không trừ lượt |
| EVAL-07 | Output bool/None/NaN/Infinity/nested object | Bị từ chối |
| EVAL-08 | Code raise exception | Admin có chẩn đoán, thí sinh nhận lỗi hệ thống phù hợp |
| EVAL-09 | Vòng lặp vô hạn | Timeout và kết thúc sandbox |
| EVAL-10 | Code print ra stdout | Không phá kết quả JSON |
| READY-01 | Có ground truth nhưng thiếu code | Publish bị chặn |
| READY-02 | Có code nhưng chưa chạy thử | Publish bị chặn |
| READY-03 | Chạy thử xong đổi source/GT/schema/runtime | Verification mất hiệu lực |
| READY-04 | Thiếu primary metric hoặc key không tồn tại | Publish bị chặn |
| READY-05 | Lượt thử cũ trả về sau khi admin sửa code | Không xác minh nhầm bản mới |
| READY-06 | Hai admin sửa/publish đồng thời | Xung đột revision được phát hiện |
| READY-07 | Sửa bộ chấm sau publish | Bị khóa |
| RANK-01 | Metric càng cao càng tốt | Sort giảm dần |
| RANK-02 | Metric càng thấp càng tốt | Sort tăng dần và chọn đúng best submission |
| RANK-03 | Hai điểm hiển thị làm tròn giống nhau | Xếp theo số gốc |
| RANK-04 | Điểm thật bằng nhau | Áp dụng tie-break hiện có |
| RANK-05 | Admin từ chối bài tốt nhất | Chọn bài hợp lệ kế tiếp |
| UI-01 | Một task và hai task | Số cột/thẻ đúng contract |
| UI-02 | Đổi label hiển thị trong draft | UI/Excel dùng đúng label, key giữ nguyên |
| UI-03 | Draft chưa có primary metric | Hiển thị trạng thái chưa cấu hình, không lỗi render |
| UI-04 | Bảng admin trộn hai cuộc thi khác metric | Mỗi bài dùng đúng metadata |
| UI-05 | Nhiều metric và màn hình nhỏ | Có bố cục cuộn/chi tiết, không mất cột |
| EXPORT-01 | Export cuộc thi v2 | Điểm và thứ hạng trùng UI |
| EXPORT-02 | Tên đội có ký tự công thức Excel | Được xử lý như text |
| FLOW-01 | Runner lỗi | Không tiêu quota, không có completed submission giả |
| FLOW-02 | MinIO/DB lỗi sau giữ quota | Hoàn quota và cleanup theo luồng hiện có |
| FLOW-03 | Nhiều request vượt quota | Chốt nguyên tử vẫn ngăn vượt giới hạn |
| FLOW-04 | Clone public thành private | Có code/schema, thiếu GT/test và chưa publish |
| LEGACY-01 | Đọc kết quả v1 | Điểm và nhãn metric cũ đúng |
| LEGACY-02 | Hậu kiểm AI hoạt động | Không tự sửa metrics/primary_score |
| ISOLATION-01 | Code thử đọc secret/file ngoài input | Sandbox ngăn truy cập |
| ISOLATION-02 | Code thử truy cập mạng | Sandbox ngăn truy cập |
| ISOLATION-03 | Hai lượt chạy đồng thời | Không đọc/ghi file tạm của nhau |

### 15.2. Các test hiện có cần cập nhật

- `backend/tests/test_scoring.py`
- `backend/tests/test_scoring_admin.py`
- `backend/tests/test_submissions.py`
- `backend/tests/test_results.py`
- `backend/tests/test_admin_submissions.py`
- `backend/tests/test_competitions_admin.py`
- `backend/tests/test_competitions_public.py`
- `backend/tests/test_ai_review_scoring_isolation.py`
- Các test frontend của trang admin, submission, guide, history và leaderboard.
- Test của schema generator/hướng dẫn CSV.

Thêm test cho runner, output validation và verification theo fingerprint.

### 15.3. Kiểm thử công thức tham chiếu

Các phép tính điểm mẫu phải được đối chiếu với fixture có kết quả mong đợi, không viết test chỉ gọi lại cùng một hàm tính của implementation để suy ra expected.

Test “dict đúng shape” và test “công thức ra đúng số” giải quyết hai vấn đề khác nhau.

### 15.4. Nghiệm thu toàn luồng

Thực hiện trên staging:

1. Tạo cuộc thi mới.
2. Cấu hình CSV một task, nạp code, chạy thử, chọn metric chính, publish.
3. Nộp CSV + notebook và kiểm tra history/leaderboard/export.
4. Lặp lại với bài NLP hai task.
5. Thay bằng script có metric tên mới để chứng minh nền tảng không phụ thuộc F1.
6. Kiểm tra một metric càng thấp càng tốt.
7. Clone thành cuộc thi thứ hai với ground truth khác.
8. Kiểm tra cuộc thi v1 hiện có.
9. Kiểm tra timeout, output sai và lỗi lưu trữ không làm mất lượt.
10. Kiểm tra tải đồng thời phù hợp quy mô dự kiến.

---

## 16. Các bước triển khai

### Bước 1. Chốt hợp đồng và tài liệu kỹ thuật

**Đầu việc**

- Chốt schema CSV và quy tắc căn ID.
- Chốt chữ ký evaluate.
- Chốt dict phẳng, key hợp lệ, số hữu hạn, primary và chiều xếp hạng.
- Chốt mô hình v1/v2, revision và fingerprint.
- Bổ sung ADR, API contract, data model và test matrix.

**Nghiệm thu**

Có example request/response nhất quán cho một task, hai task và metric tùy chỉnh.

### Bước 2. Nền backend và lưu cấu hình

**Đầu việc**

- Model v2.
- CSV validator.
- Output validator.
- Private source storage và hash.
- Optimistic revision.
- Adapter đọc dữ liệu cũ.

**Nghiệm thu**

Lưu được bản nháp từng bước, báo lỗi cấu hình chính xác, không làm hỏng v1.

### Bước 3. Runner và chạy thử

**Đầu việc**

- Wrapper evaluate.
- Sandbox và giới hạn tài nguyên.
- Giao thức kết quả/log.
- Client backend.
- Endpoint test và verification.

**Nghiệm thu**

Chạy script mẫu thành công; timeout/output sai được xử lý; sandbox vượt qua test giới hạn truy cập.

### Bước 4. Publish và chấm bài thật

**Đầu việc**

- Readiness mới.
- Publish/reopen theo revision.
- Khóa bộ chấm.
- Gắn evaluator vào submit flow.
- Lưu scoring_ref.
- Giữ quota/artifact/AI review đúng hành vi hiện tại.

**Nghiệm thu**

Thiếu code hoặc test bị chặn publish; bài hợp lệ chấm đúng output; lỗi hệ thống không tiêu lượt.

### Bước 5. Giao diện setup

**Đầu việc**

- Các component cấu hình CSV, source, test và metric.
- Di chuyển chọn metric chính khỏi form tạo cuộc thi mới.
- Banner readiness.
- Hướng dẫn và CSV mẫu sinh theo schema.

**Nghiệm thu**

Admin hoàn thành toàn bộ setup một task/hai task qua UI.

### Bước 6. Kết quả, ranking và export

**Đầu việc**

- Metrics động trên mọi trang.
- Chiều xếp hạng.
- Best submission summary.
- Global admin metadata.
- Excel động.

**Nghiệm thu**

UI/API/Excel cùng metric, cùng số và cùng thứ hạng.

### Bước 7. Clone, migration và vận hành

**Đầu việc**

- Clone bộ cấu hình.
- Backward compatibility.
- Compose/runtime config.
- Hướng dẫn backup/khôi phục source và ground truth.
- Kịch bản staging và rollback.

**Nghiệm thu**

Tạo được public/private độc lập từ cùng source; dữ liệu cũ còn đọc đúng; không mất khả năng truy vết bộ chấm.

### Cách chia pull request đề xuất

1. Hợp đồng dữ liệu, model và validator.
2. Runner, test endpoint và readiness.
3. Submission, ranking và export.
4. UI setup và UI kết quả.
5. Clone, docs, migration và kiểm thử toàn luồng.

Các PR phụ thuộc nhau phải ghi rõ; chỉ bật luồng tạo mới v2 khi backend, runner và frontend đã tương thích.

---

## 17. Triển khai vận hành và giới hạn thiết kế

### 17.1. Kiểm tra trước triển khai

- Kiểm tra nhánh triển khai có thay đổi so với commit đã phân tích.
- Chạy typecheck/build frontend và các test liên quan.
- Chạy test backend, runner và kiểm thử toàn luồng.
- Kiểm tra healthcheck, giới hạn đồng thời và xử lý timeout.
- Backup MongoDB, ground truth và source evaluator.
- Giữ runtime cần cho các cuộc thi đã khóa.

### 17.2. Theo dõi vận hành

Ghi nhận tối thiểu:

- Submission/job ID.
- Competition ID.
- Phiên bản bộ chấm.
- Thời gian chấm.
- Kết quả thành công/timeout/output lỗi.
- Số lượt đang chạy/chờ.

Không ghi nội dung ground truth hoặc toàn bộ source vào log vận hành chung.

### 17.3. Giới hạn của hàm hai tham số

`evaluate(ground_truth_path, submission_path)` giải quyết được các công thức dựa trên hai file và hằng số trong code, chẳng hạn:

- Precision, Recall, F1.
- F1 từng task.
- Điểm tổng theo tỷ trọng.
- Hàm phạt hoặc công thức tùy chỉnh theo từng bản ghi.
- Chuẩn hóa theo baseline/đích cố định được đặt trong code.

Hàm này không tự biết `S_max` hoặc `S_min` của tất cả đội đang thi. Công thức chuẩn hóa động trong file thể lệ cần thêm dữ liệu toàn bảng xếp hạng. Nếu triển khai yêu cầu đó về sau, phải mở rộng context hoặc thêm công đoạn tổng hợp; không giấu quyền truy vấn DB vào evaluator.

### 17.4. Các mặc định cần xác nhận khi bắt đầu hiện thực

Thiết kế trong tài liệu đã chọn mặc định để người triển khai có thể bắt đầu. Những điểm dưới đây là thông số vận hành/sản phẩm đề xuất, không phải kết luận có sẵn từ code:

| Điểm | Mặc định đề xuất |
|---|---|
| Hình thức input evaluate | Hai đường dẫn CSV đã kiểm tra và căn ID |
| Submission cột phụ | Từ chối mặc định |
| Ground truth cột phụ | Cho phép mặc định |
| Bộ chấm sau publish | Khóa toàn bộ contract và source |
| Key metric | Theo regex ở mục 6.3 |
| Giới hạn runtime | Theo mục 10.4, điều chỉnh sau đo kiểm |
| Tên file submission | Hiển thị tên gợi ý; chỉ áp dụng ràng buộc tên chính xác nếu thể lệ đã thống nhất |
| Code NLP loại lớp 0 | Do code admin quyết định, không thành quy tắc toàn nền tảng |

### 17.5. Hoàn thành khi nào

Tính năng được xem là hoàn thành khi admin có thể:

- Tạo một cuộc thi mới.
- Cấu hình CSV với số cột dự đoán tùy bài toán.
- Cung cấp code bằng file hoặc dán.
- Chạy thử, thấy output, đặt nhãn metric và chọn metric chính.
- Publish sau khi các điều kiện hợp lệ.
- Nhận bài của sinh viên và xem cùng kết quả trên submission/history/leaderboard/Excel.
- Thay bài toán bằng một script có tên metric khác trong một cuộc thi mới mà không sửa code tính điểm của nền tảng.
- Clone cấu hình cho cuộc thi khác, tải ground truth mới và xác minh lại.

---

## 18. Phụ lục code và dữ liệu minh họa

Các đoạn code dưới đây minh họa source admin có thể đưa vào hệ thống. Đây không phải mã được gắn cứng vào backend.

### 18.1. Ví dụ một task

Giả định:

- Ground truth: `id,label`.
- Submission: `id,prediction`.
- Nhãn: `0` và `1`.
- Metric chính: `f1`.
- Chiều: càng cao càng tốt.

```python
import pandas as pd
from sklearn.metrics import f1_score, precision_score, recall_score


def evaluate(ground_truth_path, submission_path):
    truth = pd.read_csv(ground_truth_path, dtype=str, keep_default_na=False)
    submission = pd.read_csv(submission_path, dtype=str, keep_default_na=False)

    # Ghép theo ID rõ ràng để code vẫn dễ kiểm tra độc lập.
    aligned = submission.set_index("id").loc[truth["id"]]
    y_true = truth["label"].to_numpy()
    y_pred = aligned["prediction"].to_numpy()

    metric_args = {
        "average": "binary",
        "pos_label": "1",
        "zero_division": 0,
    }

    return {
        "precision": float(precision_score(y_true, y_pred, **metric_args)),
        "recall": float(recall_score(y_true, y_pred, **metric_args)),
        "f1": float(f1_score(y_true, y_pred, **metric_args)),
    }
```

### 18.2. Ví dụ NLP hai task

Giả định minh họa:

- Task 1: Macro F1 trên hai lớp 0,1.
- Task 2: Macro F1 với `labels=[1,2,3,4,5]` trên toàn bộ bản ghi.
- Điểm chính: `100 × (0.6 × F1_task1 + 0.4 × F1_task2)`.

Quy tắc Task 2 ở đây loại lớp 0 khỏi phép trung bình, không loại toàn bộ dòng có nhãn thật 0. Nếu Ban Tổ chức muốn bỏ các dòng đó, admin chỉnh code và fixture kiểm thử tương ứng.

```python
import pandas as pd
from sklearn.metrics import f1_score


def evaluate(ground_truth_path, submission_path):
    truth = pd.read_csv(ground_truth_path, dtype=str, keep_default_na=False)
    submission = pd.read_csv(submission_path, dtype=str, keep_default_na=False)

    aligned = submission.set_index("id").loc[truth["id"]]

    f1_task1 = float(
        f1_score(
            truth["label"].to_numpy(),
            aligned["predict_label"].to_numpy(),
            labels=["0", "1"],
            average="macro",
            zero_division=0,
        )
    )

    f1_task2 = float(
        f1_score(
            truth["type"].to_numpy(),
            aligned["predict_type"].to_numpy(),
            labels=["1", "2", "3", "4", "5"],
            average="macro",
            zero_division=0,
        )
    )

    final_score = 100.0 * (0.6 * f1_task1 + 0.4 * f1_task2)

    return {
        "f1_task1": f1_task1,
        "f1_task2": f1_task2,
        "f1_final": float(final_score),
    }
```

Output contract cho ví dụ:

| key | label | decimals | primary |
|---|---|---:|---|
| `f1_task1` | F1 tín nhiệm | 4 | Không |
| `f1_task2` | F1 thể loại | 4 | Không |
| `f1_final` | Điểm tổng NLP | 2 | Có |

### 18.3. Fixture nhỏ để kiểm tra

Ground truth:

```csv
id,label,type
0,0,0
1,0,1
2,1,2
3,1,3
4,0,4
5,1,5
```

Submission hoàn hảo:

```csv
id,predict_label,predict_type
0,0,0
1,0,1
2,1,2
3,1,3
4,0,4
5,1,5
```

Các kết quả tham chiếu cho code ở mục 18.2:

| Trường hợp | F1 Task 1 | F1 Task 2 | Điểm tổng |
|---|---:|---:|---:|
| Dự đoán hoàn hảo | 1 | 1 | 100 |
| Giữ Task 1 đúng; đổi predict_type của id=1 từ 1 thành 5 | 1 | 11/15 | 89.33333333333333 |
| Giữ các dòng khác đúng; đổi predict_type của id=0 từ 0 thành 3 | 1 | 14/15 | 97.33333333333333 |

Trường hợp thứ ba giúp xác nhận ý nghĩa “loại lớp 0”: dự đoán 0 thành 3 vẫn tạo FP cho lớp 3 trong cách tính đã chọn. Nếu bỏ toàn bộ dòng truth=0 trước khi chấm, kết quả trường hợp đó sẽ khác.

### 18.4. Một vài điểm trong tài liệu thi cần thống nhất

Các điểm này thuộc nội dung thể lệ/code admin, không phải logic cố định của nền tảng:

1. PDF NLP ghi trường hợp `type=1`, `predict_type=5` là “1 TP”; ví dụ này sai so với định nghĩa phân loại.
2. Công thức cuối trong PDF thiếu ngoặc bao quanh tổng có trọng số. Nếu chủ đích là tỷ trọng 60/40 trên thang 100, phải viết rõ `100 × (0.6 × Task1 + 0.4 × Task2)`.
3. PDF ghi `nlp_submission.csv`, phần khác nhắc `public_nlp.csv/private_nlp.csv`, còn thể lệ chung ghi `submission.csv`. Cần thống nhất tên hướng dẫn trước khi bật kiểm tra tên file.
4. Tài liệu Word có dòng tiêu đề còn ghi năm 2025 trong file mang tên 2026.
5. Ý nghĩa loại lớp 0 của Task 2 phải được ghi tường minh trong thể lệ và code.

---

## 19. Nguồn đối chiếu

### 19.1. Mã nguồn

Snapshot:

- Repository: [ketdoannguyen/vku-ai-challenge-platform](https://github.com/ketdoannguyen/vku-ai-challenge-platform).
- Commit: [a3190418499e4c705717efb7bd69d2e5a1451195](https://github.com/ketdoannguyen/vku-ai-challenge-platform/commit/a3190418499e4c705717efb7bd69d2e5a1451195).

Tài liệu repo đã đối chiếu:

- [API_CONTRACT.md](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/docs/API_CONTRACT.md).
- [DATA_MODEL.md](https://github.com/ketdoannguyen/vku-ai-challenge-platform/blob/a3190418499e4c705717efb7bd69d2e5a1451195/docs/DATA_MODEL.md).
- Các module scoring, competitions, submissions, leaderboard và các trang frontend được liệt kê tại mục 11–12.
- Các test về scoring, publish, submission, kết quả và sự độc lập của AI review.

### 19.2. Tài liệu người dùng cung cấp

- `OLPMTTN_NLP_Challenge(1).pdf`:
  - Trang 4: cấu trúc submission.
  - Trang 5–6: đánh giá độc lập từng task, Macro F1 và công thức tổng.
- `VKU_The_le_Vong_chung_ket_AI_Challenge_2026(1).docx`:
  - Mục II: nộp CSV + notebook và hạn mức public/private.
  - Mục III: chuẩn hóa điểm theo kết quả các đội.

### 19.3. Chỉ dẫn cho người triển khai

Trước khi bắt đầu sửa code, đối chiếu HEAD hiện tại với snapshot nêu trên. Nếu repo đã đổi, cập nhật bản đồ file/hàm tương ứng nhưng giữ các yêu cầu sản phẩm ở mục 1.

Phạm vi của bản kế hoạch này là **Python evaluator do admin cung cấp, CSV schema tùy chỉnh, metric động và publish gate có xác minh**. Mọi thay đổi ngoài phạm vi phải được nêu riêng, không tự thêm các tầng task, trọng số hoặc giai đoạn vào UI.
