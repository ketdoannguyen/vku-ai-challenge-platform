"""Participant competition API: list published/closed, detail by slug. Draft luôn ẩn."""

from fastapi import APIRouter, Request

from app.auth.dependencies import CurrentAccount
from app.competitions import service
from app.core.errors import api_error

router = APIRouter(prefix="/api/competitions")


@router.get("")
async def list_visible_competitions(request: Request, account: CurrentAccount) -> dict:
    from app.memberships.service import memberships_by_competition

    db = request.app.state.mongo.db
    competitions = [
        competition
        async for competition in db[service.COMPETITIONS_COLLECTION]
        .find({"status": {"$in": ["published", "closed"]}})
        .sort("name", 1)
    ]
    memberships = await memberships_by_competition(
        db, [competition["_id"] for competition in competitions], account["_id"]
    )
    return {
        "competitions": [
            service.public_competition(c, memberships.get(c["_id"])) for c in competitions
        ]
    }


@router.get("/{slug}")
async def get_competition_by_slug(slug: str, request: Request, account: CurrentAccount) -> dict:
    from app.memberships.service import get_membership

    db = request.app.state.mongo.db
    competition = await service.find_competition_by_slug(db, slug)
    if competition is None or competition["status"] == "draft":
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    membership = await get_membership(db, competition["_id"], account["_id"])
    return service.public_competition(competition, membership)
