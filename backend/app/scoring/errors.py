"""Lỗi chấm điểm có mã, dùng chung cho bộ chấm v1 và v2.

Mã lỗi đi thẳng ra API (mục 9.5 của kế hoạch), nên chúng là hợp đồng chứ không phải chi tiết nội bộ.
"""


class ScoringValidationError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


CLASS_ID_INVALID = "SUBMISSION_CLASS_ID_INVALID"
MAX_RULE_MESSAGE_CHARS = 300


def valid_rule_message(value: object) -> str | None:
    """Chỉ cho lời nhắn quy tắc do evaluator chủ động viết đi ra API thí sinh."""
    if not isinstance(value, str) or any(not (char.isprintable() or char.isspace()) for char in value):
        return None
    message = " ".join(value.split())
    return message if message and len(message) <= MAX_RULE_MESSAGE_CHARS else None


def valid_class_info(value: object) -> dict | None:
    """Chỉ cho phép mã nguyên đã kiểm tra đi từ runner sang lời nhắn của thí sinh."""
    if not isinstance(value, dict) or set(value) != {"class_id", "allowed_class_ids"}:
        return None
    class_id = value["class_id"]
    allowed = value["allowed_class_ids"]
    if (
        type(class_id) is not int
        or abs(class_id) > 1_000_000_000
        or not isinstance(allowed, list)
        or not 1 <= len(allowed) <= 32
        or any(type(item) is not int or abs(item) > 1_000_000_000 for item in allowed)
        or len(set(allowed)) != len(allowed)
        or class_id in allowed
    ):
        return None
    return {"class_id": class_id, "allowed_class_ids": allowed}


class EvaluatorError(Exception):
    """Lỗi khi chạy code chấm của admin; `code` quyết định thí sinh thấy gì và có mất lượt hay không."""

    def __init__(
        self, code: str, message: str, *, detail: str | None = None, class_info: dict | None = None
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        # `detail` chỉ dành cho admin/vận hành: có thể chứa stderr của code chấm.
        self.detail = detail
        self.class_info = valid_class_info(class_info) if code == CLASS_ID_INVALID else None
