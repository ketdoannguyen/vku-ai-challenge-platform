"""Participant competition content and approved image assets.

Nội dung bên trong cuộc thi chỉ đọc được bởi thành viên đang hoạt động hoặc admin - mọi route
ở đây đi qua `require_read_access` TRƯỚC khi tra tài liệu/đọc file để người ngoài không nhận
thông tin về sự tồn tại của nội dung (xem `app.competitions.access`).
"""

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.auth.dependencies import OptionalAccount
from app.competitions.access import require_read_access
from app.competitions.service import find_competition_by_slug
from app.content import service, storage
from app.core.config import get_settings
from app.core.errors import api_error

router = APIRouter(prefix="/api/competitions")


@router.get("/{slug}/contents")
async def list_visible_contents(
    slug: str, request: Request, account: OptionalAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _visible_competition(db, slug)
    await require_read_access(db, competition, account)
    contents = await service.list_contents(db, competition["_id"])
    return {"contents": [service.public_content(item) for item in contents]}


@router.get("/{slug}/contents/{content_slug}")
async def get_visible_content(
    slug: str, content_slug: str, request: Request, account: OptionalAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _visible_competition(db, slug)
    await require_read_access(db, competition, account)
    content = await db[service.CONTENTS_COLLECTION].find_one(
        {"competition_id": competition["_id"], "slug": content_slug}
    )
    if content is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy nội dung.")
    markdown = _read_markdown(content)
    return service.public_content(content, markdown)


@router.get("/{slug}/assets/{name}")
async def get_asset(slug: str, name: str, request: Request, account: OptionalAccount) -> Response:
    """Ảnh trong nội dung - chỉ thành viên/admin, vẫn chặn traversal/symlink.

    Route này cũng phục vụ preview trong trình soạn nội dung của admin, nên admin đọc được ảnh
    của cuộc thi published/closed mà không cần membership; draft vẫn 404 như trước.
    """
    db = request.app.state.mongo.db
    competition = await _visible_competition(db, slug)
    await require_read_access(db, competition, account)
    extension = Path(name).suffix.lower()
    spec = storage.ASSET_TYPES.get(extension)
    if Path(name).name != name or spec is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy ảnh.")
    root = storage.assets_dir(get_settings().data_dir, str(competition["_id"]))
    try:
        path = storage.ensure_within(root, root / name)
        if path.is_symlink():
            raise ValueError
        data = storage.read_bytes(path)
    except (ValueError, OSError):
        raise api_error(404, "NOT_FOUND", "Không tìm thấy ảnh.")
    return Response(
        data,
        media_type=spec[0],
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    )


async def _visible_competition(db, slug: str) -> dict:
    competition = await find_competition_by_slug(db, slug)
    if competition is None or competition["status"] == "draft":
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    return competition


def _read_markdown(content: dict) -> str:
    try:
        return storage.read_markdown(get_settings().data_dir, content["markdown_path"])
    except storage.ContentFileMissing:
        raise api_error(404, "CONTENT_FILE_MISSING", "File Markdown không tồn tại.")
