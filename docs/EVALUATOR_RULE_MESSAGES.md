# Viết lời nhắn lỗi quy tắc trong evaluator

Áp dụng chung cho **bộ chấm Python v2 của mọi cuộc thi**. Khi evaluator biết chắc bài nộp vi phạm quy tắc đã công bố, hãy chủ động `raise SubmissionRuleError` trong hàm `evaluate`. Thí sinh sẽ thấy lời nhắn ở trang nộp bài cùng mã `SUBMISSION_RULE_VIOLATION` và mã lượt; lượt `FAILED` không tính vào hạn mức nộp.

```python
def evaluate(ground_truth_path, submission_path):
    # ... đọc ground truth và submission, kiểm tra quy tắc đã công bố ...
    if invalid_prediction:
        raise SubmissionRuleError("Câu trả lời phải là đoạn chữ liên tiếp trong context.")
    return {"accuracy": 0.5}
```

`SubmissionRuleError` được runtime cung cấp sẵn **trong namespace của file evaluator**, không cần `import`. Chỉ `raise` bên trong `evaluate`; lỗi phát sinh khi nạp file evaluator không được coi là lỗi bài nộp.

## Lời nhắn nào sẽ hiện?

- Truyền **đúng một chuỗi** cho `SubmissionRuleError`, không để trống; tối đa **300 ký tự sau khi chuẩn hóa khoảng trắng**. Dấu xuống dòng/tab được gộp thành dấu cách. Sai kiểu, nhiều đối số, quá dài, rỗng hoặc chứa ký tự điều khiển khác (như NUL) → UI dùng câu chung: “CSV không đáp ứng quy tắc nộp bài của cuộc thi. Hãy đối chiếu với yêu cầu về file nộp và dữ liệu trong đề bài rồi nộp lại.”
- Chỉ dùng lời nhắn mà bạn **chủ động muốn công khai**. Không ghép giá trị đáp án bí mật, nội dung ground truth, traceback, đường dẫn máy chủ hoặc dữ liệu cá nhân vào chuỗi lỗi. Nếu muốn cho thí sinh biết số dòng/ID, cân nhắc trước liệu thông tin ấy có thuộc dữ liệu được công bố không.
- Lỗi Python bình thường như `ValueError`, `KeyError` hoặc lỗi thư viện vẫn được che thành `EVALUATOR_FAILED`; chỉ `SubmissionRuleError` cho phép lời nhắn của evaluator hiện lên UI. `InvalidClassIdError` là ngoại lệ riêng với mã lớp đã khai báo công khai — xem [hợp đồng API](API_CONTRACT.md#6-error-codes).
- Thông điệp chỉ mô tả **quy tắc nộp** (ví dụ đáp án không nằm trong đoạn văn); không đánh đồng lỗi hạ tầng, cấu hình hoặc ground truth với lỗi của thí sinh.

## Kiểm tra trước khi công bố

1. Ở cuộc thi chưa khóa cấu hình, tải lên evaluator và chạy thử **một CSV hợp lệ** để xác minh các metric và dấu xác minh chấm.
2. Chạy thử một CSV vi phạm quy tắc: kiểm tra mã `SUBMISSION_RULE_VIOLATION` và chính câu chữ đã viết; phần `detail`/traceback trong lượt chạy thử chỉ dành cho admin, không hiện ở UI thí sinh.
3. Kiểm tra trang nộp bài bằng tài khoản thí sinh trên môi trường thử nghiệm: banner phải hiện đúng thông điệp, mã lỗi, mã lượt; quota không bị trừ. Kiểm riêng lỗi Python ngoài ý muốn để chắc chắn không công khai traceback.
4. Evaluator đang dùng `raise ValueError("...")` **không tự chuyển sang lời nhắn mới**: đổi các nhánh kiểm tra bài nộp sang `SubmissionRuleError` rồi chạy thử lại. Không thay source trực tiếp của cuộc thi đã publish/đã khóa hoặc sửa bản ghi FAILED cũ.

Thay đổi ở runtime cần build **image runtime với tag mới**, cấu hình runner trỏ sang image mới, rồi chạy thử lại để xác minh `runtime_id` của các cuộc thi có liên quan. Không build đè tag đang sử dụng và không áp dụng trên production ngoài quy trình release; xem [triển khai bộ chấm](DEPLOYMENT.md).
