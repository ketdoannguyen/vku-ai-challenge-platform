"""Participant leaderboard API with backend visibility enforcement.

Chỉ thành viên đang hoạt động (hoặc admin) đọc được bảng xếp hạng; kiểm quyền trước khi tra cache
để người ngoài không nhận thông tin về bảng. Admin vẫn phải chịu luật `leaderboard_visible`.

Cuộc thi dual có hai bảng độc lập: client phải chỉ rõ nhánh, và bảng Private chưa công bố bị chặn
bằng mã riêng `PRIVATE_RESULTS_UNPUBLISHED` - khác hẳn "BXH bị ẩn" để FE nói đúng chuyện đang xảy ra.
"""

from fastapi import APIRouter, Query, Request

from app.auth.dependencies import CurrentAccount
from app.competitions import tracks as competition_tracks
from app.competitions.access import require_read_access
from app.core.errors import api_error
from app.leaderboard import service
from app.submissions.router import _competition_or_404

router = APIRouter(prefix="/api/competitions")


@router.get("/{competition_id}/leaderboard")
async def leaderboard(
    competition_id: str,
    request: Request,
    account: CurrentAccount,
    track: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    await require_read_access(db, competition, account)
    try:
        resolved_track = competition_tracks.resolve_track(competition, track)
    except competition_tracks.TrackError as exc:
        raise api_error(422, exc.code, exc.message)
    if not competition_tracks.results_visible(competition, resolved_track):
        raise api_error(
            403,
            "PRIVATE_RESULTS_UNPUBLISHED",
            "Kết quả Private chưa được công bố.",
        )
    if not competition.get("leaderboard_visible", False):
        raise api_error(
            403,
            "LEADERBOARD_HIDDEN",
            "Bảng xếp hạng hiện chưa được công bố.",
        )
    board = await service.cached_ranked_board(db, competition, track=resolved_track)
    return service.leaderboard_response(
        competition,
        board,
        track=resolved_track,
        current_account_id=account["_id"],
        limit=limit,
        offset=offset,
    )
