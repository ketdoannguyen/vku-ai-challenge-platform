"""Participant competition content and approved image assets."""

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.auth.dependencies import CurrentAccount
from app.competitions.service import find_competition_by_slug
from app.content import service, storage
from app.core.config import get_settings
from app.core.errors import api_error
from app.memberships.service import get_membership

router = APIRouter(prefix="/api/competitions")


@router.get("/{slug}/contents")
async def list_visible_contents(
    slug: str, request: Request, account: CurrentAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _visible_competition(db, slug)
    membership = await get_membership(db, competition["_id"], account["_id"])
    is_member = bool(membership and membership.get("active", True))
    contents = await service.list_contents(db, competition["_id"])
    visible = [
        item
        for item in contents
        if item["visibility"] == "public" or is_member
    ]
    return {"contents": [service.public_content(item) for item in visible]}


@router.get("/{slug}/contents/{content_slug}")
async def get_visible_content(
    slug: str, content_slug: str, request: Request, account: CurrentAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _visible_competition(db, slug)
    content = await db[service.CONTENTS_COLLECTION].find_one(
        {"competition_id": competition["_id"], "slug": content_slug}
    )
    if content is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy nội dung.")
    membership = await get_membership(db, competition["_id"], account["_id"])
    if content["visibility"] == "members" and not (
        membership and membership.get("active", True)
    ):
        raise api_error(404, "NOT_FOUND", "Không tìm thấy nội dung.")
    markdown = _read_markdown(content)
    return service.public_content(content, markdown)


@router.get("/{slug}/assets/{name}")
async def get_asset(
    slug: str, name: str, request: Request, account: CurrentAccount
) -> Response:
    db = request.app.state.mongo.db
    competition = await _visible_competition(db, slug)
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
            "Cache-Control": "private, max-age=300",
        },
    )


async def _visible_competition(db, slug: str) -> dict:
    competition = await find_competition_by_slug(db, slug)
    if competition is None or competition["status"] == "draft":
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    return competition


def _read_markdown(content: dict) -> str:
    try:
        path = storage.ensure_within(
            Path(get_settings().data_dir), Path(content["markdown_path"])
        )
        return storage.read_bytes(path).decode("utf-8")
    except (ValueError, OSError, UnicodeDecodeError):
        raise api_error(404, "CONTENT_FILE_MISSING", "File Markdown không tồn tại.")
