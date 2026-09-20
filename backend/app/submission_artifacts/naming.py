"""Token object key, tên file khi tải xuống và header `Content-Disposition` an toàn.

Tên download CHUẨN hoá theo slug cuộc thi + tên account + số thứ tự submission; tên file gốc người
dùng upload chỉ được hiển thị trong metadata, không bao giờ trở thành tên tải xuống (tránh path
confusion và header injection).
"""

import re
import unicodedata
from urllib.parse import quote

from app.core.slugs import SLUG_MAX, VIETNAMESE_ASCII_FALLBACK

PREDICTION_ARTIFACT = "prediction"
NOTEBOOK_ARTIFACT = "notebook"

ARTIFACT_FILENAMES = {
    PREDICTION_ARTIFACT: "prediction.csv",
    NOTEBOOK_ARTIFACT: "notebook.ipynb",
}
ARTIFACT_MEDIA_TYPES = {
    PREDICTION_ARTIFACT: "text/csv; charset=utf-8",
    NOTEBOOK_ARTIFACT: "application/x-ipynb+json",
}

# CR/LF và control characters: chống header injection. Slash/backslash và dấu ngoặc kép: chống path
# confusion và phá vỡ tham số `filename=` của Content-Disposition.
_FORBIDDEN = re.compile(r'[\x00-\x1f\x7f/\\"<>|?*:]')
_SEPARATORS = re.compile(r"[\s_-]+")

_TOTAL_MAX = 180
_ACCOUNT_MAX = 60
_ASCII_FALLBACK = "submission-artifact"


def short_id(value: str) -> str:
    """8 ký tự cuối của ObjectId - cùng quy ước hiển thị với lịch sử bài nộp."""
    return str(value)[-8:]


def submission_token(submission_no: int) -> str:
    """Token dùng chung cho thư mục trên MinIO và tên file tải về, để hai chỗ không thể lệch nhau."""
    return f"submission-{submission_no:04d}"


def sanitize_segment(value: str, *, fallback: str, max_length: int) -> str:
    text = _SEPARATORS.sub("-", _FORBIDDEN.sub(" ", value or "")).strip("-")
    if len(text) > max_length:
        text = text[:max_length].strip("-")
    return text or fallback


def download_filename(
    *,
    competition_slug: str,
    account_name: str,
    account_id: str,
    artifact: str,
    submission_id: str,
    submission_no: int | None,
) -> str:
    token = (
        submission_token(submission_no)
        if isinstance(submission_no, int)
        else f"submission-{short_id(submission_id)}"
    )
    head = f"{sanitize_segment(competition_slug, fallback='competition', max_length=SLUG_MAX)}_"
    tail = f"_{token}_{ARTIFACT_FILENAMES[artifact]}"
    budget = max(_TOTAL_MAX - len(head) - len(tail), 12)
    account = sanitize_segment(
        account_name,
        fallback=f"account-{short_id(account_id)}",
        max_length=min(_ACCOUNT_MAX, budget),
    )
    return f"{head}{account}{tail}"


def content_disposition(filename: str) -> str:
    """ASCII trong `filename=` cho client cũ, tên Unicode đầy đủ trong `filename*=UTF-8''`."""
    ascii_name = _ascii_filename(filename)
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename, safe="")}'


def _ascii_filename(filename: str) -> str:
    stripped = (
        unicodedata.normalize("NFKD", filename.translate(VIETNAMESE_ASCII_FALLBACK))
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    return _SEPARATORS.sub("-", _FORBIDDEN.sub("-", stripped)).strip("-") or _ASCII_FALLBACK
