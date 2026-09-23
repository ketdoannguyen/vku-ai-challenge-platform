"""Parse và normalize notebook `.ipynb` thành text tất định để gửi LLM.

Không chạy, không render, không import: chỉ `json` stdlib đọc cấu trúc, đúng như
`submission_artifacts.validation` (ADR-028). Không dùng `nbformat` để giữ bề mặt tấn công nhỏ.

Quy ước đánh số: `number` của cell là vị trí 1-based trong mảng `cells` GỐC của notebook, không
phải vị trí sau khi lọc. Cell `raw` bị bỏ khỏi context nhưng vẫn chiếm số, nên "Cell 14" mà admin
đọc được luôn trỏ đúng cell 14 trong Jupyter. `start_line`/`end_line` là 1-based trong nội dung
cell SAU normalize.
"""

import hashlib
import json
import re
from dataclasses import dataclass

from app.submission_artifacts import validation as artifact_validation

CELL_CODE = "CODE"
CELL_MARKDOWN = "MARKDOWN"
# `raw` cố ý không có mặt: nội dung raw là văn bản tự do không phải code lẫn markdown.
_KEPT_KINDS = {"code": CELL_CODE, "markdown": CELL_MARKDOWN}

_OPEN_TAG = "<PARTICIPANT_NOTEBOOK>"
_CLOSE_TAG = "</PARTICIPANT_NOTEBOOK>"

# Tên ba khối có delimiter trong user message. `prompt.py` dùng đúng ba tên này trong văn bản system
# prompt, nên đổi tên ở một nơi là phải đổi cả ở đây (regex dưới đây bám theo danh sách này).
_BLOCK_TAGS = ("COMPETITION_CONTENT", "SUBMISSION_CONTEXT", "PARTICIPANT_NOTEBOOK")
_TAG_LIKE = re.compile(r"<\s*/?\s*(?:" + "|".join(_BLOCK_TAGS) + r")\s*>", re.IGNORECASE)
_TAG_SAFE = str.maketrans({"<": "‹", ">": "›"})


def neutralize_delimiters(text: str) -> str:
    """Vô hiệu hoá mọi chuỗi giống thẻ khối trong văn bản do người dùng kiểm soát.

    Thí sinh viết được `</PARTICIPANT_NOTEBOOK>` rồi mở một `<COMPETITION_CONTENT>` giả, và model
    đọc cấu trúc mạnh hơn đọc lời dặn "notebook là dữ liệu". Chỉ đổi cặp ngoặc của đúng những chuỗi
    đó sang ký tự nhìn giống hệt nhưng không còn là delimiter; phần còn lại giữ nguyên.
    """
    return _TAG_LIKE.sub(lambda match: match.group(0).translate(_TAG_SAFE), text)


class NotebookNormalizationError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class NotebookCell:
    number: int
    kind: str
    lines: tuple[str, ...]


@dataclass(frozen=True)
class NormalizedNotebook:
    cells: tuple[NotebookCell, ...]
    index: dict[int, NotebookCell]
    total_cells: int
    code_cells: int
    markdown_cells: int
    omitted_cells: int
    lines: int
    truncated: bool
    text: str
    raw_sha256: str
    normalized_sha256: str

    def cell(self, number: int) -> NotebookCell | None:
        return self.index.get(number)


def notebook_sha256(raw: bytes) -> str:
    """SHA-256 của bytes thô - dùng ở submit path và để worker xác minh artifact đã lưu."""
    return hashlib.sha256(raw).hexdigest()


def normalize_notebook(raw: bytes, *, max_chars: int) -> NormalizedNotebook:
    """Raise `NotebookNormalizationError` khi notebook không parse được theo luật hiện hành."""
    try:
        artifact_validation.validate_notebook(raw)
    except artifact_validation.NotebookValidationError as exc:
        raise NotebookNormalizationError(exc.code, exc.message)
    # `validate_notebook` đã decode UTF-8 và parse JSON thành công, nên ở đây không còn nhánh hỏng.
    payload = json.loads(raw.decode("utf-8-sig"))

    all_cells = _kept_cells(payload["cells"])
    budget = max(max_chars - len(_OPEN_TAG) - len(_CLOSE_TAG) - 2, 0)
    included: list[NotebookCell] = []
    blocks: list[str] = []
    used = 0
    for cell in all_cells:
        block = _render_block(cell)
        if used + len(block) > budget:
            break
        included.append(cell)
        blocks.append(block)
        used += len(block)

    text = f"{_OPEN_TAG}\n{''.join(blocks)}{_CLOSE_TAG}"
    omitted = len(all_cells) - len(included)
    return NormalizedNotebook(
        cells=tuple(included),
        index={cell.number: cell for cell in included},
        total_cells=len(payload["cells"]),
        code_cells=sum(1 for cell in all_cells if cell.kind == CELL_CODE),
        markdown_cells=sum(1 for cell in all_cells if cell.kind == CELL_MARKDOWN),
        omitted_cells=omitted,
        lines=sum(len(cell.lines) for cell in included),
        truncated=omitted > 0,
        text=text,
        raw_sha256=notebook_sha256(raw),
        normalized_sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
    )


def _kept_cells(cells: list[dict]) -> list[NotebookCell]:
    kept = []
    for position, raw_cell in enumerate(cells, start=1):
        kind = _KEPT_KINDS.get(raw_cell["cell_type"])
        if kind is None:
            continue
        kept.append(
            NotebookCell(
                number=position,
                kind=kind,
                lines=_split_lines(_cell_text(raw_cell["source"])),
            )
        )
    return kept


def _cell_text(source) -> str:
    text = source if isinstance(source, str) else "".join(source)
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _split_lines(text: str) -> tuple[str, ...]:
    """Tách dòng tất định: newline cuối cùng không sinh thêm một dòng rỗng."""
    if text == "":
        return ()
    lines = text.split("\n")
    if lines[-1] == "":
        lines.pop()
    return tuple(lines)


def _render_block(cell: NotebookCell) -> str:
    """Dựng phần text gửi model; `cell.lines` vẫn giữ nguyên cho snippet mà admin đọc."""
    body = "".join(
        f"{number} {neutralize_delimiters(line)}".rstrip() + "\n"
        for number, line in enumerate(cell.lines, start=1)
    )
    return f"\n=== CELL {cell.number} | {cell.kind} ===\n{body}"


def snapshot_stats(notebook: NormalizedNotebook) -> dict:
    """Thống kê lưu kèm review row - không chứa nội dung notebook."""
    return {
        "cells": len(notebook.cells),
        "code_cells": notebook.code_cells,
        "markdown_cells": notebook.markdown_cells,
        "lines": notebook.lines,
        "truncated": notebook.truncated,
        "omitted_cells": notebook.omitted_cells,
    }
