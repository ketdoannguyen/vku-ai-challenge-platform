"""Hậu kiểm đánh giá nguồn dataset của model, không gọi mạng.

Model đọc cả notebook và trả MỘT đánh giá nguồn; backend không chứng nhận suy luận đó. Ở đây chỉ
làm phần kiểm chắc được: vị trí trích dẫn có thật trong CODE cell của đúng notebook đã gửi, snippet
dựng lại từ notebook, và dấu vết của vị trí bị loại. Quét dấu vết tài nguyên BTC trong code cell
(`find_resource_mentions`) vẫn là dữ kiện phụ - sự xuất hiện hay vắng mặt của link không quyết
định trạng thái nguồn.
"""

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse

from app.ai_review import constants
from app.ai_review.models import ModelSourceAssessment
from app.ai_review.notebook import CELL_CODE, NormalizedNotebook
from app.ai_review.verdict import _build_snippet

_URL = re.compile(r"(?:https?|s3|gs|ftp)://[^\s\"'<>()[\]{}`]+", re.IGNORECASE)
_ID = re.compile(r"^[A-Za-z0-9_-]+$")
# ID Drive thật dài 25-44 ký tự; ngưỡng 20 chặn substring trùng ngẫu nhiên khi quét ID thô.
_MIN_BARE_ID_CHARS = 20
_DRIVE = {"drive.google.com", "drive.usercontent.google.com"}
_DOCS = {"docs.google.com"}


@dataclass(frozen=True)
class ResourceMention:
    label: str
    cells: list[int]


@dataclass(frozen=True)
class SourceAssessment:
    """Kết quả hậu kiểm: đề xuất của model, trạng thái sau kiểm cấu trúc, và dấu vết đầy đủ."""

    model_status: str | None
    status: str
    reason: str
    evidence: list[dict]
    rejected_evidence: list[dict]
    validation_codes: list[str]


def drive_identity(url: str) -> tuple[str, str] | None:
    """Nhận diện các URL Drive tĩnh thường dùng; host phải khớp chính xác."""
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        return None
    parts = [part for part in parsed.path.split("/") if part]
    if host in _DOCS:
        if len(parts) > 3 and parts[1] == "u" and parts[2].isdigit():
            parts = [parts[0], *parts[3:]]
        if len(parts) >= 4 and parts[:3] == ["forms", "d", "e"]:
            kind, identifier = "file", parts[3]
        elif len(parts) >= 3 and parts[0] in {"document", "spreadsheets", "presentation", "forms"} and parts[1] == "d":
            kind, identifier = "file", parts[2]
        else:
            return None
    elif host in _DRIVE:
        if len(parts) > 2 and parts[:2] == ["drive", "u"] and parts[2].isdigit():
            parts = [parts[0], *parts[3:]]
        if len(parts) > 3 and parts[:2] == ["file", "u"] and parts[2].isdigit():
            parts = [parts[0], *parts[3:]]
        if len(parts) >= 3 and parts[:2] == ["file", "d"]:
            kind, identifier = "file", parts[2]
        elif len(parts) >= 3 and parts[:2] == ["drive", "folders"]:
            kind, identifier = "folder", parts[2]
        elif parts == ["open"] or parts == ["uc"] or parts == ["download"]:
            kind, identifier = "file", (parse_qs(parsed.query).get("id") or [""])[0]
        else:
            return None
    else:
        return None
    return (kind, identifier) if _ID.fullmatch(identifier) else None


def verify_source_assessment(
    assessment: ModelSourceAssessment | None,
    *,
    notebook: NormalizedNotebook,
    resources: list[dict],
) -> SourceAssessment:
    """Hậu kiểm theo thứ tự cố định; không suy luận thêm nguồn bằng regex.

    Thiếu đánh giá hoặc bản thể lệ không có tài nguyên BTC đối chiếu được là `NOT_EVALUATED` vì
    thiếu dữ kiện, không phải vì bài sạch. `ALIGNED`/`EXTERNAL` không còn vị trí CODE hợp lệ nào bị
    hạ xuống `UNCLEAR`; `ALIGNED` còn bị hạ khi trích dẫn bị loại một phần hoặc notebook bị cắt -
    nhận định cho cả pipeline cần bằng chứng trọn vẹn và phần đã đọc đầy đủ. `EXTERNAL` giữ nguyên
    khi còn bằng chứng hợp lệ, kèm mã cảnh báo; backend không chứng nhận suy luận của model.
    """
    if assessment is None:
        return SourceAssessment(
            None, constants.SOURCE_STATUS_NOT_EVALUATED, "", [], [],
            [constants.SOURCE_ASSESSMENT_MISSING],
        )
    official = {
        identity
        for item in resources
        if (identity := drive_identity(item["url"])) is not None
    }
    if not official:
        return SourceAssessment(
            assessment.status, constants.SOURCE_STATUS_NOT_EVALUATED, assessment.reason, [], [],
            [constants.SOURCE_RESOURCES_MISSING],
        )
    evidence, rejected = _verified_evidence(assessment, notebook)
    codes: set[str] = set()
    if rejected:
        codes.add(
            constants.SOURCE_EVIDENCE_PARTIALLY_INVALID
            if evidence
            else constants.SOURCE_EVIDENCE_INVALID
        )
    if notebook.truncated:
        codes.add(constants.SOURCE_NOTEBOOK_TRUNCATED)
    status = assessment.status
    if (
        status in {constants.SOURCE_STATUS_ALIGNED, constants.SOURCE_STATUS_EXTERNAL}
        and not evidence
    ):
        if not rejected:
            codes.add(constants.SOURCE_EVIDENCE_MISSING)
        status = constants.SOURCE_STATUS_UNCLEAR
    elif status == constants.SOURCE_STATUS_ALIGNED and (rejected or notebook.truncated):
        status = constants.SOURCE_STATUS_UNCLEAR
    return SourceAssessment(
        assessment.status, status, assessment.reason, evidence, rejected, sorted(codes)
    )


def _verified_evidence(
    assessment: ModelSourceAssessment, notebook: NormalizedNotebook
) -> tuple[list[dict], list[dict]]:
    """Giữ vị trí CODE cell hợp lệ kèm snippet dựng thật; vị trí bị loại ghi kèm mã lý do.

    Kiểm cell tồn tại trước khi đọc dòng: cell bị lược khỏi phần gửi model, cell markdown và khoảng
    dòng vượt biên là ba lỗi khác nhau, và cả ba đều được giữ làm dấu vết cho BTC đọc.
    """
    accepted: list[dict] = []
    rejected: list[dict] = []
    for item in assessment.evidence:
        cell = notebook.cell(item.cell)
        if cell is None:
            code = constants.SOURCE_EVIDENCE_CELL_NOT_FOUND
        elif cell.kind != CELL_CODE:
            code = constants.SOURCE_EVIDENCE_CELL_NOT_CODE
        elif not 1 <= item.start_line <= item.end_line <= len(cell.lines):
            code = constants.SOURCE_EVIDENCE_RANGE_INVALID
        else:
            accepted.append(
                {
                    "cell": item.cell,
                    "start_line": item.start_line,
                    "end_line": item.end_line,
                    "snippet": _build_snippet(cell.lines, item.start_line, item.end_line),
                }
            )
            continue
        rejected.append(
            {
                "cell": item.cell,
                "start_line": item.start_line,
                "end_line": item.end_line,
                "code": code,
            }
        )
    return accepted, rejected


def find_resource_mentions(notebook: NormalizedNotebook, resources: list[dict]) -> list[ResourceMention]:
    """Quét text thô của từng CODE cell để nói tài nguyên BTC xuất hiện ở cell nào.

    Chỉ CODE cell: markdown thường chép đề bài kèm link nên không tính. Khớp mọi dạng URL của cùng
    file/folder qua `drive_identity`, hoặc ID thô đủ dài (gdown). Danh sách rỗng nghĩa là đã quét và
    không cell CODE nào nhắc tới; notebook bị lược cell thì dữ kiện cũng chỉ soi phần model đã thấy.
    """
    mentions = []
    for item in resources:
        identity = drive_identity(item["url"])
        if identity is None:
            continue
        cells = [
            cell.number
            for cell in notebook.cells
            if cell.kind == CELL_CODE and _mentions_identity("\n".join(cell.lines), identity)
        ]
        if cells:
            mentions.append(ResourceMention(label=item["label"], cells=cells))
    return mentions


def _mentions_identity(text: str, identity: tuple[str, str]) -> bool:
    if any(drive_identity(url.rstrip(".,;:!?")) == identity for url in _URL.findall(text)):
        return True
    identifier = identity[1]
    return len(identifier) >= _MIN_BARE_ID_CHARS and identifier in text
