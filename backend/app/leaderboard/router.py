"""Participant leaderboard API with backend visibility enforcement."""

from fastapi import APIRouter, Query, Request

from app.auth.dependencies import CurrentAccount
from app.core.errors import api_error
from app.leaderboard import service
from app.submissions.router import _competition_or_404

router = APIRouter(prefix="/api/competitions")


@router.get("/{competition_id}/leaderboard")
async def leaderboard(
    competition_id: str,
    request: Request,
    account: CurrentAccount,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    if not competition.get("leaderboard_visible", False):
        raise api_error(
            403,
            "LEADERBOARD_HIDDEN",
            "Bảng xếp hạng hiện chưa được công bố.",
        )
    entries = await service.ranked_entries(db, competition["_id"])
    return service.leaderboard_response(
        competition,
        entries,
        current_account_id=account["_id"],
        limit=limit,
        offset=offset,
    )
