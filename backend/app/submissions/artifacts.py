"""Đọc artifact của submission để tải xuống, dùng chung cho route participant và admin.

Submission mới đọc từ MinIO; record cũ chỉ có CSV dưới `DATA_DIR` vẫn phải tải được (ADR-028).
"""

import logging
from pathlib import Path

from fastapi import Response

from app.content import storage as file_storage
from app.core.config import get_settings
from app.core.errors import api_error
from app.submission_artifacts import storage
from app.submission_artifacts.naming import (
    ARTIFACT_MEDIA_TYPES,
    NOTEBOOK_ARTIFACT,
    PREDICTION_ARTIFACT,
    content_disposition,
    download_filename,
)

logger = logging.getLogger(__name__)

_DOWNLOAD_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
}


async def artifact_response(
    submission: dict, competition: dict, account: dict | None, kind: str
) -> Response:
    data = await _load(submission, kind)
    filename = download_filename(
        competition_slug=competition.get("slug", ""),
        account_name=(account or {}).get("name") or (account or {}).get("email") or "",
        account_id=str(submission["account_id"]),
        artifact=kind,
        submission_id=str(submission["_id"]),
        submission_no=submission.get("submission_no"),
    )
    return Response(
        data,
        media_type=ARTIFACT_MEDIA_TYPES[kind],
        headers={
            **_DOWNLOAD_HEADERS,
            "Content-Length": str(len(data)),
            "Content-Disposition": content_disposition(filename),
        },
    )


async def _load(submission: dict, kind: str) -> bytes:
    entry = (submission.get("artifacts") or {}).get(kind)
    if entry and entry.get("object_key"):
        try:
            return await storage.get_bytes(
                entry["object_key"], _limit_bytes(kind)
            )
        except storage.ArtifactNotFound:
            raise api_error(404, "ARTIFACT_NOT_FOUND", "Không tìm thấy tệp của bài nộp.")
        except storage.ArtifactStorageUnavailable:
            logger.warning(
                "Artifact storage unavailable submission=%s kind=%s", submission["_id"], kind
            )
            raise api_error(
                503,
                "ARTIFACT_STORAGE_UNAVAILABLE",
                "Hệ thống lưu trữ tạm thời không khả dụng. Vui lòng thử lại sau.",
            )
    if kind == PREDICTION_ARTIFACT and submission.get("file_path"):
        return _read_legacy(submission["file_path"])
    raise api_error(404, "ARTIFACT_NOT_FOUND", "Không tìm thấy tệp của bài nộp.")


def _not_found():
    return api_error(404, "ARTIFACT_NOT_FOUND", "Không tìm thấy tệp của bài nộp.")


def _read_legacy(relative_path: str) -> bytes:
    """CSV của submission cũ nằm dưới DATA_DIR: kiểm tra containment rồi đọc không theo symlink."""
    root = Path(get_settings().data_dir)
    try:
        path = file_storage.ensure_within(root, Path(relative_path))
    except ValueError:
        logger.warning("Legacy submission path escapes DATA_DIR: %s", relative_path)
        raise _not_found()
    try:
        # File cũ đã bị chặn 10 MiB lúc upload; vượt trần ở đây nghĩa là dữ liệu đã hỏng.
        if path.stat().st_size > _limit_bytes(PREDICTION_ARTIFACT):
            logger.warning("Legacy submission file exceeds the size limit: %s", relative_path)
            raise api_error(413, "ARTIFACT_TOO_LARGE", "Tệp bài nộp vượt quá giới hạn cho phép.")
        return file_storage.read_bytes(path)
    except FileNotFoundError:
        raise _not_found()
    except OSError:
        logger.warning("Cannot read legacy submission file %s", relative_path, exc_info=True)
        raise api_error(500, "ARTIFACT_READ_FAILED", "Không thể đọc tệp bài nộp.")


def _limit_bytes(kind: str) -> int:
    settings = get_settings()
    limit_mb = settings.max_notebook_mb if kind == NOTEBOOK_ARTIFACT else settings.max_upload_mb
    return limit_mb * 1024 * 1024
