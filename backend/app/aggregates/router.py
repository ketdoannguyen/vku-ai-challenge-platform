"""API thí sinh cho bảng xếp hạng tổng hợp.

Kiểm lần lượt: đăng nhập → tồn tại → đã công bố → chế độ membership → view hợp lệ → điều kiện
nguồn. Admin miễn điều kiện membership nhưng vẫn bị chặn bởi bước đã công bố trên API này;
bản nháp chỉ xem được qua API admin.
"""

from fastapi import APIRouter, Query, Request

from app.aggregates import service
from app.auth.dependencies import CurrentAccount
from app.core.errors import api_error

router = APIRouter(prefix="/api/aggregates")


def _sources_of(aggregates: list[dict]) -> list[dict]:
    return [source for aggregate in aggregates for source in aggregate.get("sources") or []]


@router.get("")
async def list_aggregates(request: Request, account: CurrentAccount) -> dict:
    """Danh sách bảng đã công bố mà người xem được phép xem; nháp không xuất hiện với bất kỳ ai."""
    db = request.app.state.mongo.db
    published = [
        aggregate
        async for aggregate in db[service.AGGREGATES_COLLECTION]
        .find({"published": True})
        .sort([("name", 1), ("_id", 1)])
    ]
    allowed = await service.list_visible(db, published, account)
    documents = await service.load_source_documents(db, _sources_of(allowed))
    return {"aggregates": [service.list_item(aggregate, documents) for aggregate in allowed]}


@router.get("/{slug}/leaderboard")
async def aggregate_leaderboard(
    slug: str,
    request: Request,
    account: CurrentAccount,
    view: str = Query(service.VIEW_PUBLIC),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    db = request.app.state.mongo.db
    aggregate = await service.find_aggregate(db, slug)
    if aggregate is None:
        raise api_error(404, "AGGREGATE_NOT_FOUND", "Không tìm thấy bảng tổng hợp.")
    if not aggregate.get("published", False):
        raise api_error(403, "AGGREGATE_NOT_PUBLISHED", "Bảng tổng hợp chưa được công bố.")
    if not await service.can_view(db, aggregate, account):
        raise api_error(
            403,
            "AGGREGATE_MEMBERSHIP_REQUIRED",
            "Bạn cần quyền tham gia cuộc thi nguồn để xem bảng tổng hợp này.",
        )
    try:
        return await service.leaderboard_view(
            db, aggregate, view=view, limit=limit, offset=offset, account=account
        )
    except service.AggregateError as exc:
        raise api_error(422, exc.code, exc.message)
