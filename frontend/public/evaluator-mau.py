"""Bộ chấm mẫu của VKU AI Challenge (pandas + scikit-learn).

Tải tệp này về, sửa theo dữ liệu thật rồi dùng "Đọc nội dung tệp .py" để nạp vào ô Source code.

Hợp đồng bắt buộc:

- Hàm vào là `evaluate(ground_truth_path, submission_path)`, nhận đường dẫn hai tệp CSV.
- `ground_truth_path`: đáp án admin đã upload, giữ nguyên thứ tự dòng.
- `submission_path`: bài nộp đã kiểm tra theo định dạng khai báo và được căn đúng thứ tự
  dòng với đáp án (khớp theo cột ID).
- Trả về dictionary các chỉ số dạng số, ví dụ {"accuracy": 0.5}. Mỗi khóa phải được khai
  báo lại ở bảng "Kết quả và metric" thì mới dùng để xếp hạng.

Tên cột dưới đây chỉ là ví dụ; đổi cho khớp định dạng dữ liệu của cuộc thi.
"""

import pandas as pd
from sklearn.metrics import accuracy_score, f1_score


def evaluate(ground_truth_path, submission_path):
    truth = pd.read_csv(ground_truth_path, encoding="utf-8-sig")
    submission = pd.read_csv(submission_path, encoding="utf-8-sig")

    # Hai tệp đã cùng thứ tự dòng nên so trực tiếp từng cặp.
    expected = truth["label"]
    predicted = submission["predict_label"]

    return {
        "accuracy": float(accuracy_score(expected, predicted)),
        "macro_f1": float(f1_score(expected, predicted, average="macro", zero_division=0)),
        "n_items": float(len(truth)),
    }
