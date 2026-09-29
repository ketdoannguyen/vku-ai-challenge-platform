"""Lỗi chấm điểm có mã, dùng chung cho bộ chấm v1 và v2.

Mã lỗi đi thẳng ra API (mục 9.5 của kế hoạch), nên chúng là hợp đồng chứ không phải chi tiết nội bộ.
"""


class ScoringValidationError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class EvaluatorError(Exception):
    """Lỗi khi chạy code chấm của admin; `code` quyết định thí sinh thấy gì và có mất lượt hay không."""

    def __init__(self, code: str, message: str, *, detail: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        # `detail` chỉ dành cho admin/vận hành: có thể chứa stderr của code chấm.
        self.detail = detail
