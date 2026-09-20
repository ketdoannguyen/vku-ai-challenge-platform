"""Notebook khung dùng chung cho mọi cuộc thi, tải công khai (không cần đăng nhập).

Asset nằm cạnh module này và được Dockerfile copy cùng `app/`; không có record DB, không sao chép
theo từng cuộc thi và không phụ thuộc Mongo/MinIO nên endpoint luôn trả được kể cả khi storage hỏng.
"""

from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, Response

from app.core.errors import api_error
from app.submission_artifacts.naming import (
    ARTIFACT_MEDIA_TYPES,
    NOTEBOOK_ARTIFACT,
    content_disposition,
)

router = APIRouter(prefix="/api")

STARTER_NOTEBOOK_FILENAME = "starter-notebook.ipynb"
_NOTEBOOK_PATH = Path(__file__).with_name("starter_notebook.ipynb")


@lru_cache(maxsize=1)
def _notebook_bytes() -> bytes:
    try:
        return _NOTEBOOK_PATH.read_bytes()
    except OSError:
        raise api_error(
            500,
            "STARTER_NOTEBOOK_MISSING",
            "Notebook khung chưa được cài đặt trên máy chủ.",
        )


@router.get("/starter-notebook")
async def download_starter_notebook() -> Response:
    data = _notebook_bytes()
    return Response(
        data,
        media_type=ARTIFACT_MEDIA_TYPES[NOTEBOOK_ARTIFACT],
        headers={
            "X-Content-Type-Options": "nosniff",
            # Tài nguyên công khai, không đổi theo người dùng - cache ngắn để vẫn thay được bản mới.
            "Cache-Control": "public, max-age=3600",
            "Content-Length": str(len(data)),
            "Content-Disposition": content_disposition(STARTER_NOTEBOOK_FILENAME),
        },
    )
