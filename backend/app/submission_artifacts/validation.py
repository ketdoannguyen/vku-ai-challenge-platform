"""Validate notebook `.ipynb` mà KHÔNG chạy và KHÔNG render nội dung.

Dùng `json` stdlib thay vì `nbformat` để tránh dependency nặng và để chắc chắn không có đường nào
thực thi code trong notebook (ADR-028).
"""

import json
from pathlib import Path

NOTEBOOK_SUFFIX = ".ipynb"
_NBFORMAT = 4
_CELL_TYPES = frozenset({"code", "markdown", "raw"})


class NotebookValidationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def has_notebook_extension(filename: str | None) -> bool:
    return Path(filename or "").suffix.lower() == NOTEBOOK_SUFFIX


def validate_notebook(data: bytes) -> None:
    """Raise `NotebookValidationError` với code ổn định cho frontend."""
    if b"\x00" in data:
        raise NotebookValidationError(
            "NOTEBOOK_INVALID", "Notebook chứa ký tự không hợp lệ."
        )
    try:
        payload = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        raise NotebookValidationError(
            "NOTEBOOK_INVALID", "Notebook không phải JSON UTF-8 hợp lệ."
        )

    if not isinstance(payload, dict):
        raise NotebookValidationError(
            "NOTEBOOK_INVALID", "Notebook phải là một JSON object ở cấp gốc."
        )
    if payload.get("nbformat") != _NBFORMAT:
        raise NotebookValidationError(
            "NOTEBOOK_UNSUPPORTED_VERSION", "Chỉ chấp nhận notebook định dạng v4."
        )
    minor = payload.get("nbformat_minor")
    if not isinstance(minor, int) or isinstance(minor, bool):
        raise NotebookValidationError(
            "NOTEBOOK_INVALID", "Notebook thiếu `nbformat_minor` hợp lệ."
        )
    if not isinstance(payload.get("metadata"), dict):
        raise NotebookValidationError("NOTEBOOK_INVALID", "Notebook thiếu `metadata` hợp lệ.")
    cells = payload.get("cells")
    if not isinstance(cells, list):
        raise NotebookValidationError("NOTEBOOK_INVALID", "Notebook thiếu danh sách `cells`.")
    for cell in cells:
        if not isinstance(cell, dict):
            raise NotebookValidationError("NOTEBOOK_INVALID", "Mỗi cell phải là một object.")
        if cell.get("cell_type") not in _CELL_TYPES:
            raise NotebookValidationError(
                "NOTEBOOK_INVALID", "Cell có `cell_type` không hợp lệ."
            )
        source = cell.get("source")
        valid_source = isinstance(source, str) or (
            isinstance(source, list) and all(isinstance(line, str) for line in source)
        )
        if not valid_source:
            raise NotebookValidationError(
                "NOTEBOOK_INVALID", "`source` của cell phải là chuỗi hoặc danh sách chuỗi."
            )
    # Danh sách rỗng thoả vòng lặp trên một cách rỗng, nên phải chặn riêng: notebook không có
    # cell code nào thì không chứng minh được cách tạo ra kết quả.
    if not any(cell["cell_type"] == "code" for cell in cells):
        raise NotebookValidationError(
            "NOTEBOOK_INVALID", "Notebook phải có ít nhất một cell code."
        )
