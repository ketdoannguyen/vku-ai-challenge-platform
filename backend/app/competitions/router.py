"""Participant competition API: list published/closed, detail by slug. Draft luôn ẩn."""

from fastapi import APIRouter, Request

from app.auth.dependencies import CurrentAccount
from app.competitions import service
from app.core.errors import api_error

router = APIRouter(prefix="/api/competitions")


@router.get("")
async def list_visible_competitions(request: Request, account: CurrentAccount) -> dict:
    db = request.app.state.mongo.db
    cursor = (
        db[service.COMPETITIONS_COLLECTION]
        .find({"status": {"$in": ["published", "closed"]}})
        .sort("name", 1)
    )
    competitions = [service.public_competition(c) async for c in cursor]
    return {"competitions": competitions}


@router.get("/{slug}")
async def get_competition_by_slug(slug: str, request: Request, account: CurrentAccount) -> dict:
    db = request.app.state.mongo.db
    competition = await service.find_competition_by_slug(db, slug)
    if competition is None or competition["status"] == "draft":
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    return service.public_competition(competition)
