"""Admin content metadata, Markdown file and image asset management."""

import logging
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, File, Request, UploadFile
from pymongo.errors import DuplicateKeyError

from app.auth.dependencies import AdminAccount
from app.competitions.admin_router import _get_competition_or_404
from app.content import service, storage
from app.core.config import get_settings
from app.core.errors import api_error

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/competitions")


@router.get("/{competition_id}/contents")
async def list_admin_contents(
    competition_id: str, request: Request, admin: AdminAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    contents = await service.list_contents(db, competition["_id"])
    return {"contents": [service.public_content(item) for item in contents]}


@router.post("/{competition_id}/contents", status_code=201)
async def create_content(
    competition_id: str,
    body: service.ContentCreate,
    request: Request,
    admin: AdminAccount,
) -> dict:
    _validate_content(
        title=body.title,
        slug=body.slug,
        order=body.order,
        visibility=body.visibility,
    )
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    try:
        content = await service.insert_content(db, competition["_id"], body)
    except DuplicateKeyError:
        raise api_error(409, "CONTENT_SLUG_EXISTS", "Slug này đã có nội dung khác dùng.")
    return service.public_content(content)


# Static path must precede /{content_id}.
@router.post("/{competition_id}/contents/reorder")
async def reorder_contents(
    competition_id: str,
    body: service.ReorderBody,
    request: Request,
    admin: AdminAccount,
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    ids = [item.id for item in body.items]
    if len(ids) != len(set(ids)):
        raise api_error(422, "VALIDATION_ERROR", "Danh sách reorder có ID trùng.")
    contents = []
    for item in body.items:
        service.validate_values(order=item.order)
        content = await service.get_content(db, competition["_id"], item.id)
        if content is None:
            raise api_error(422, "VALIDATION_ERROR", "Nội dung không thuộc cuộc thi này.")
        contents.append((content, item.order))
    now = datetime.now(timezone.utc)
    for content, order in contents:
        await db[service.CONTENTS_COLLECTION].update_one(
            {"_id": content["_id"]}, {"$set": {"order": order, "updated_at": now}}
        )
    refreshed = await service.list_contents(db, competition["_id"])
    return {"contents": [service.public_content(item) for item in refreshed]}


@router.get("/{competition_id}/contents/{content_id}")
async def get_admin_content(
    competition_id: str, content_id: str, request: Request, admin: AdminAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    content = await _content_or_404(db, competition["_id"], content_id)
    markdown = None
    if content.get("size_bytes") is not None:
        markdown = _read_markdown(content)
    return service.public_content(content, markdown)


@router.patch("/{competition_id}/contents/{content_id}")
async def update_content(
    competition_id: str,
    content_id: str,
    body: service.ContentUpdate,
    request: Request,
    admin: AdminAccount,
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    content = await _content_or_404(db, competition["_id"], content_id)
    updates = body.model_dump(exclude_unset=True, exclude_none=True)
    _validate_content(**updates)
    if not updates:
        return service.public_content(content)
    updates["updated_at"] = datetime.now(timezone.utc)
    try:
        await db[service.CONTENTS_COLLECTION].update_one(
            {"_id": content["_id"]}, {"$set": updates}
        )
    except DuplicateKeyError:
        raise api_error(409, "CONTENT_SLUG_EXISTS", "Slug này đã có nội dung khác dùng.")
    content = await _content_or_404(db, competition["_id"], content_id)
    return service.public_content(content)


@router.put("/{competition_id}/contents/{content_id}/file")
async def upload_markdown(
    competition_id: str,
    content_id: str,
    request: Request,
    admin: AdminAccount,
    file: UploadFile = File(...),
) -> dict:
    if Path(file.filename or "").suffix.lower() != ".md":
        raise api_error(422, "INVALID_FILE_TYPE", "Chỉ chấp nhận file Markdown có đuôi .md.")
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    content = await _content_or_404(db, competition["_id"], content_id)
    data = await _read_limited(file, get_settings().max_content_mb)
    if not data:
        raise api_error(422, "VALIDATION_ERROR", "File Markdown không được để trống.")
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        raise api_error(422, "VALIDATION_ERROR", "File Markdown phải dùng encoding UTF-8.")
    path = storage.content_file_path(
        get_settings().data_dir, str(competition["_id"]), str(content["_id"])
    )
    try:
        storage.write_atomic(path, data)
    except OSError:
        logger.exception("Cannot write Markdown content=%s", content["_id"])
        raise api_error(500, "FILE_WRITE_FAILED", "Không thể lưu file Markdown.")
    await db[service.CONTENTS_COLLECTION].update_one(
        {"_id": content["_id"]},
        {"$set": {"size_bytes": len(data), "updated_at": datetime.now(timezone.utc)}},
    )
    logger.info(
        "Markdown uploaded admin=%s competition=%s content=%s bytes=%s",
        admin["email"],
        competition["_id"],
        content["_id"],
        len(data),
    )
    return service.public_content(
        await _content_or_404(db, competition["_id"], content_id)
    )


@router.delete("/{competition_id}/contents/{content_id}")
async def delete_content(
    competition_id: str, content_id: str, request: Request, admin: AdminAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    content = await _content_or_404(db, competition["_id"], content_id)
    await db[service.CONTENTS_COLLECTION].delete_one({"_id": content["_id"]})
    path = storage.content_file_path(
        get_settings().data_dir, str(competition["_id"]), str(content["_id"])
    )
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("Orphan Markdown file after delete content=%s", content["_id"])
    logger.info(
        "Content deleted admin=%s competition=%s content=%s",
        admin["email"],
        competition["_id"],
        content["_id"],
    )
    return {"ok": True}


@router.get("/{competition_id}/assets")
async def list_assets(
    competition_id: str, request: Request, admin: AdminAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    return {"assets": _asset_list(competition)}


@router.post("/{competition_id}/assets", status_code=201)
async def upload_asset(
    competition_id: str,
    request: Request,
    admin: AdminAccount,
    file: UploadFile = File(...),
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    data = await _read_limited(file, get_settings().max_asset_mb)
    try:
        extension, content_type = storage.validate_asset(file.filename or "", data)
    except ValueError as exc:
        raise api_error(422, "INVALID_FILE_TYPE", str(exc))
    name = f"{uuid4().hex}{extension}"
    path = storage.assets_dir(get_settings().data_dir, str(competition["_id"])) / name
    try:
        storage.write_atomic(path, data)
    except OSError:
        logger.exception("Cannot write competition asset competition=%s", competition["_id"])
        raise api_error(500, "FILE_WRITE_FAILED", "Không thể lưu ảnh.")
    logger.info(
        "Asset uploaded admin=%s competition=%s asset=%s bytes=%s",
        admin["email"],
        competition["_id"],
        name,
        len(data),
    )
    return _asset_view(competition["slug"], path, content_type)


@router.delete("/{competition_id}/assets/{name}")
async def delete_asset(
    competition_id: str, name: str, request: Request, admin: AdminAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    path = _safe_asset_path(competition, name)
    if not path.is_file() or path.is_symlink():
        raise api_error(404, "NOT_FOUND", "Không tìm thấy ảnh.")
    path.unlink()
    logger.info(
        "Asset deleted admin=%s competition=%s asset=%s",
        admin["email"],
        competition["_id"],
        name,
    )
    return {"ok": True}


async def _content_or_404(db, competition_id, content_id: str) -> dict:
    content = await service.get_content(db, competition_id, content_id)
    if content is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy nội dung.")
    return content


def _validate_content(**values) -> None:
    try:
        service.validate_values(**values)
    except ValueError as exc:
        raise api_error(422, "VALIDATION_ERROR", str(exc))


async def _read_limited(file: UploadFile, limit_mb: int) -> bytes:
    limit = limit_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise api_error(413, "FILE_TOO_LARGE", f"File vượt quá giới hạn {limit_mb} MiB.")
    return data


def _read_markdown(content: dict) -> str:
    try:
        return storage.read_markdown(get_settings().data_dir, content["markdown_path"])
    except storage.ContentFileMissing:
        raise api_error(404, "CONTENT_FILE_MISSING", "File Markdown không tồn tại.")


def _asset_list(competition: dict) -> list[dict]:
    root = storage.assets_dir(get_settings().data_dir, str(competition["_id"]))
    if not root.is_dir():
        return []
    assets = []
    for path in sorted(root.iterdir(), key=lambda item: item.name):
        spec = storage.ASSET_TYPES.get(path.suffix.lower())
        if path.is_file() and not path.is_symlink() and spec:
            assets.append(_asset_view(competition["slug"], path, spec[0]))
    return assets


def _asset_view(slug: str, path: Path, content_type: str) -> dict:
    return {
        "name": path.name,
        "size_bytes": path.stat().st_size,
        "content_type": content_type,
        "url": f"/api/competitions/{slug}/assets/{path.name}",
    }


def _safe_asset_path(competition: dict, name: str) -> Path:
    root = storage.assets_dir(get_settings().data_dir, str(competition["_id"]))
    if Path(name).name != name or Path(name).suffix.lower() not in storage.ASSET_TYPES:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy ảnh.")
    try:
        return storage.ensure_within(root, root / name)
    except ValueError:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy ảnh.")
