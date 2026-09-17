"""Participant competition API: list published/closed, detail by slug. Draft luôn ẩn.

Đọc công khai (ADR-014): khách chưa đăng nhập vẫn xem được, chỉ là không có membership
nên `membership.active` luôn false. Draft vẫn ẩn với mọi đối tượng.
"""

from fastapi import APIRouter, Request

from app.auth.dependencies import OptionalAccount
from app.competitions import service
from app.core.errors import api_error

router = APIRouter(prefix="/api/competitions")


@router.get("")
async def list_visible_competitions(request: Request, account: OptionalAccount) -> dict:
    from app.memberships.service import memberships_by_competition

    db = request.app.state.mongo.db
    competitions = [
        competition
        async for competition in db[service.COMPETITIONS_COLLECTION]
        .find({"status": {"$in": ["published", "closed"]}})
        .sort("name", 1)
    ]
    # Khách không có phiên thì không cần truy vấn membership — public_membership(None) đã đủ.
    memberships = (
        await memberships_by_competition(db, [c["_id"] for c in competitions], account["_id"])
        if account
        else {}
    )
    return {
        "competitions": [
            service.public_competition(c, memberships.get(c["_id"])) for c in competitions
        ]
    }


@router.get("/{slug}")
async def get_competition_by_slug(slug: str, request: Request, account: OptionalAccount) -> dict:
    from app.memberships.service import get_membership

    db = request.app.state.mongo.db
    competition = await service.find_competition_by_slug(db, slug)
    if competition is None or competition["status"] == "draft":
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    membership = await get_membership(db, competition["_id"], account["_id"]) if account else None
    return service.public_competition(competition, membership)
