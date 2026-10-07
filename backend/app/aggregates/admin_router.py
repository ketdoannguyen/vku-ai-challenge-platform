"""Admin API cho bảng xếp hạng tổng hợp: CRUD cấu hình, công bố/ẩn và xem trước bản đã lưu.

Không có preview cấu hình chưa lưu và không sửa slug/published qua PATCH; công bố xong vẫn sửa
được cấu hình và thay đổi áp dụng ngay cho lượt đọc kế tiếp.
"""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Query, Request
from pymongo.errors import DuplicateKeyError

from app.aggregates import service
from app.auth.dependencies import AdminAccount
from app.core.errors import api_error

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/aggregates")

_SLUG_TAKEN_MESSAGE = "Slug này đã có bảng tổng hợp khác dùng."


async def _get_aggregate_or_404(db, slug: str) -> dict:
    aggregate = await service.find_aggregate(db, slug)
    if aggregate is None:
        raise api_error(404, "AGGREGATE_NOT_FOUND", "Không tìm thấy bảng tổng hợp.")
    return aggregate


async def _detail(db, aggregate: dict) -> dict:
    documents = await service.load_source_documents(db, aggregate.get("sources") or [])
    return service.admin_detail(aggregate, documents)


@router.get("")
async def list_aggregates(request: Request, admin: AdminAccount) -> dict:
    db = request.app.state.mongo.db
    aggregates = [
        aggregate
        async for aggregate in db[service.AGGREGATES_COLLECTION]
        .find()
        .sort([("name", 1), ("_id", 1)])
    ]
    documents = await service.load_source_documents(
        db, [source for aggregate in aggregates for source in aggregate.get("sources") or []]
    )
    return {"aggregates": [service.admin_detail(aggregate, documents) for aggregate in aggregates]}


@router.post("", status_code=201)
async def create_aggregate(
    body: service.AggregateCreate, request: Request, admin: AdminAccount
) -> dict:
    db = request.app.state.mongo.db
    try:
        name, sources, visibility = await service.validated_config(
            db, name=body.name, sources=body.sources, visibility=body.visibility
        )
        slug = service.clean_slug(name)
    except service.AggregateError as exc:
        raise api_error(422, exc.code, exc.message)
    if await service.find_aggregate(db, slug) is not None:
        raise api_error(409, "AGGREGATE_SLUG_TAKEN", _SLUG_TAKEN_MESSAGE)
    try:
        aggregate = await service.insert_aggregate(
            db,
            name=name,
            sources=sources,
            visibility=visibility,
            created_by=admin["email"],
        )
    except DuplicateKeyError:
        # Hai request cùng tên có thể cùng vượt bước kiểm tra trên; `_id` unique là chốt cuối.
        raise api_error(409, "AGGREGATE_SLUG_TAKEN", _SLUG_TAKEN_MESSAGE)
    logger.info("Admin %s created aggregate slug=%s", admin["email"], aggregate["_id"])
    return await _detail(db, aggregate)


@router.get("/{slug}")
async def get_aggregate(slug: str, request: Request, admin: AdminAccount) -> dict:
    db = request.app.state.mongo.db
    return await _detail(db, await _get_aggregate_or_404(db, slug))


@router.patch("/{slug}")
async def edit_aggregate(
    slug: str, body: service.AggregateUpdate, request: Request, admin: AdminAccount
) -> dict:
    db = request.app.state.mongo.db
    aggregate = await _get_aggregate_or_404(db, slug)
    # slug/published không nhận từ body - model không có field đó nên bị bỏ qua an toàn.
    try:
        merged = service.merged_config(aggregate, body)
        name, sources, visibility = await service.validated_config(
            db, name=merged["name"], sources=merged["sources"], visibility=merged["visibility"]
        )
    except service.AggregateError as exc:
        raise api_error(422, exc.code, exc.message)
    updates: dict = {}
    if name != aggregate["name"]:
        updates["name"] = name
    if sources != aggregate["sources"]:
        updates["sources"] = sources
    if visibility != aggregate.get("visibility", service.VISIBILITY_DEFAULT):
        updates["visibility"] = visibility
    if not updates:
        return await _detail(db, aggregate)
    updates["updated_at"] = datetime.now(timezone.utc)
    await db[service.AGGREGATES_COLLECTION].update_one({"_id": slug}, {"$set": updates})
    logger.info("Admin %s edited aggregate %s fields=%s", admin["email"], slug, sorted(updates))
    return await _detail(db, await _get_aggregate_or_404(db, slug))


@router.post("/{slug}/publish")
async def publish_aggregate(slug: str, request: Request, admin: AdminAccount) -> dict:
    """Công bố bảng: kiểm lại cấu hình đầy đủ, nhưng nguồn còn nháp/chưa công bố vẫn cho qua."""
    db = request.app.state.mongo.db
    aggregate = await _get_aggregate_or_404(db, slug)
    if aggregate.get("published", False):
        # Lặp lại cùng trạng thái không đổi mốc cập nhật.
        return await _detail(db, aggregate)
    try:
        await service.validated_config(
            db,
            name=aggregate["name"],
            sources=service.stored_as_requests(aggregate.get("sources") or []),
            visibility=aggregate.get("visibility", service.VISIBILITY_DEFAULT),
        )
    except service.AggregateError as exc:
        raise api_error(422, exc.code, exc.message)
    await db[service.AGGREGATES_COLLECTION].update_one(
        {"_id": slug},
        {"$set": {"published": True, "updated_at": datetime.now(timezone.utc)}},
    )
    logger.info("Admin %s published aggregate %s", admin["email"], slug)
    return await _detail(db, await _get_aggregate_or_404(db, slug))


@router.post("/{slug}/unpublish")
async def unpublish_aggregate(slug: str, request: Request, admin: AdminAccount) -> dict:
    """Ẩn bảng: không kiểm cấu hình hay nguồn để admin luôn có đường che bảng lỗi."""
    db = request.app.state.mongo.db
    aggregate = await _get_aggregate_or_404(db, slug)
    if not aggregate.get("published", False):
        return await _detail(db, aggregate)
    await db[service.AGGREGATES_COLLECTION].update_one(
        {"_id": slug},
        {"$set": {"published": False, "updated_at": datetime.now(timezone.utc)}},
    )
    logger.info("Admin %s unpublished aggregate %s", admin["email"], slug)
    return await _detail(db, await _get_aggregate_or_404(db, slug))


@router.get("/{slug}/leaderboard")
async def preview_aggregate_leaderboard(
    slug: str,
    request: Request,
    admin: AdminAccount,
    view: str = Query(service.VIEW_PUBLIC),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    """Xem trước bản đã lưu; cổng nguồn (kể cả Private nhánh chưa mở) vẫn áp dụng đầy đủ."""
    db = request.app.state.mongo.db
    aggregate = await _get_aggregate_or_404(db, slug)
    try:
        return await service.leaderboard_view(
            db, aggregate, view=view, limit=limit, offset=offset, account=admin
        )
    except service.AggregateError as exc:
        raise api_error(422, exc.code, exc.message)


@router.delete("/{slug}")
async def delete_aggregate(
    slug: str,
    request: Request,
    admin: AdminAccount,
    confirm_slug: str = Query(...),
) -> dict:
    """Xoá bảng đã ẩn; `confirm_slug` buộc admin gõ đúng slug - thao tác này không hoàn tác được."""
    db = request.app.state.mongo.db
    aggregate = await _get_aggregate_or_404(db, slug)
    if aggregate.get("published", False):
        raise api_error(
            409, "AGGREGATE_NOT_DELETABLE", "Bảng đang công bố phải ẩn trước khi xoá."
        )
    if confirm_slug != slug:
        raise api_error(
            422, "CONFIRM_SLUG_MISMATCH", "Slug xác nhận không khớp với bảng cần xoá."
        )
    await db[service.AGGREGATES_COLLECTION].delete_one({"_id": slug})
    logger.info("Admin %s deleted aggregate %s", admin["email"], slug)
    return {"deleted": True, "slug": slug}
