"""Kiểm tra dictionary đầu ra của code chấm và lấy điểm chính.

Cùng một phép kiểm tra dùng cho cả lượt chạy thử của admin lẫn lượt chấm bài thật: nếu hai đường
này lệch nhau thì một cấu hình qua được bước chạy thử vẫn có thể làm hỏng cả cuộc thi.
"""

import math

from app.scoring.errors import ScoringValidationError
from app.scoring.models import METRIC_KEY_RE, OutputContract

OUTPUT_MISMATCH = "EVALUATOR_OUTPUT_MISMATCH"


def validate_metrics(payload: object) -> dict[str, float]:
    """Chuẩn hoá dictionary trả về; từ chối `bool` và mọi thứ không phải số hữu hạn.

    Phần lớn kiểu NumPy (`np.int64`, `np.float32`, `ndarray`) cùng NaN/Inf đã chết sớm hơn, ở bước
    chuyển JSON của `entrypoint.py`; riêng `np.float64` tới được đây và qua, vì từ NumPy 2 nó là lớp
    con của `float`. Cứ trả `float(...)`/`int(...)` để kiểu dữ liệu không phụ thuộc lượt chấm chạy ở
    tiến trình nào.
    """
    if not isinstance(payload, dict) or not payload:
        raise ScoringValidationError(
            OUTPUT_MISMATCH, "Bộ chấm phải trả về một dictionary không rỗng."
        )
    metrics: dict[str, float] = {}
    for key, value in payload.items():
        if not isinstance(key, str) or not METRIC_KEY_RE.fullmatch(key):
            raise ScoringValidationError(
                OUTPUT_MISMATCH,
                f"Khóa metric '{key}' không hợp lệ: chỉ gồm chữ, số và dấu gạch dưới, bắt đầu bằng chữ.",
            )
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ScoringValidationError(
                OUTPUT_MISMATCH, f"Metric '{key}' phải là số (int hoặc float)."
            )
        number = float(value)
        if not math.isfinite(number):
            raise ScoringValidationError(
                OUTPUT_MISMATCH, f"Metric '{key}' phải là số hữu hạn."
            )
        metrics[key] = number
    return metrics


def check_contract(metrics: dict[str, float], contract: OutputContract) -> None:
    """So khớp tập khóa trả về với output contract đã lưu.

    Thừa hay thiếu đều là lỗi: không tự bỏ metric thừa và không thay metric thiếu bằng 0.
    """
    declared = {metric.key for metric in contract.metrics}
    observed = set(metrics)
    missing = sorted(declared - observed)
    extra = sorted(observed - declared)
    if missing or extra:
        parts = []
        if missing:
            parts.append(f"thiếu {', '.join(missing)}")
        if extra:
            parts.append(f"thừa {', '.join(extra)}")
        raise ScoringValidationError(
            OUTPUT_MISMATCH, f"Kết quả chấm không khớp cấu hình metric ({'; '.join(parts)})."
        )


def primary_score(metrics: dict[str, float], contract: OutputContract) -> float:
    """Điểm chính luôn lấy trực tiếp từ kết quả evaluator, không tính lại và không đổi thang."""
    if contract.primary_metric is None:
        raise ScoringValidationError(
            "SCORING_TEST_REQUIRED", "Cần chọn metric chính trước khi chấm điểm."
        )
    return metrics[contract.primary_metric]
