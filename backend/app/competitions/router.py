"""Participant competition API: list published/closed, detail by slug. Draft luôn ẩn.

Đọc công khai (ADR-014): khách chưa đăng nhập vẫn xem được, chỉ là không có membership
nên `membership.active` luôn false. Draft vẫn ẩn với mọi đối tượng.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Request

from app.accounts import service as accounts_service
from app.auth.dependencies import CurrentAccount, OptionalAccount
from app.competitions import service
from app.core.errors import api_error
from app.leaderboard import service as leaderboard_service
from app.scoring import normalization
from app.submissions import service as submissions_service

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
    competition_ids = [competition["_id"] for competition in competitions]
    # Khách không có phiên thì không cần truy vấn membership - public_membership(None) đã đủ.
    memberships = (
        await memberships_by_competition(db, competition_ids, account["_id"]) if account else {}
    )
    submission_counts = await service.submission_counts(db, competition_ids)
    # Hạng/điểm chỉ có nghĩa với thành viên đang hoạt động; tổng bài đã nộp thì mọi account đã
    # đăng nhập đều có (kể cả non-member). Một aggregation cho cả trang, không truy vấn per-card.
    active_id_set = {
        competition_id
        for competition_id, membership in memberships.items()
        if membership.get("active", True)
    }
    my_stats = (
        await submissions_service.my_stats_by_competition(
            db, competition_ids, account["_id"], datetime.now(timezone.utc)
        )
        if account
        else {}
    )
    # Account doc đã nằm sẵn trong request.state từ middleware - không tốn truy vấn cho cờ ghim.
    pinned_ids = set(account.get(accounts_service.PINNED_COMPETITIONS_FIELD) or []) if account else set()
    return {
        "competitions": [
            {
                **service.public_competition(competition, memberships.get(competition["_id"])),
                "submission_count": submission_counts[competition["_id"]],
                "pinned": competition["_id"] in pinned_ids,
                **(
                    {"my_submission_count": my_stats[competition["_id"]]["total"]}
                    if account
                    else {}
                ),
                **(
                    {
                        "my_stats": await _my_stats(
                            db, competition, account["_id"], my_stats[competition["_id"]]
                        )
                    }
                    if competition["_id"] in active_id_set
                    else {}
                ),
            }
            for competition in competitions
        ]
    }


async def _my_stats(db, competition: dict, account_id, counts: dict) -> dict:
    """Hạng/điểm tốt nhất của thành viên đang hoạt động, lấy từ đúng bảng xếp hạng.

    Không tự tính lại thứ hạng: `leaderboard_response` giữ nguyên quy tắc tie-break, chiều metric
    và lọc metric ẩn của bảng. Bảng bị ẩn thì không trả hạng/điểm và không tốn lượt đọc bảng.
    `best_score` là raw của đúng bài đại diện nên không hứa là raw tốt nhất của đội; norm hiện tại
    nằm ở `best_normalized_score`, null khi cuộc thi không bật norm hoặc người xem không được xem.
    """
    stats = {
        "rank": None,
        "rank_total": None,
        "best_score": None,
        "best_normalized_score": None,
        "used_today": counts["today"],
    }
    if not competition["leaderboard_visible"] or counts["eligible_count"] == 0:
        return stats
    try:
        board = await leaderboard_service.cached_ranked_board(db, competition)
    except normalization.NormalizationError:
        # Cấu hình norm hỏng (chỉ tới được bằng sửa tay ngoài API): thẻ vẫn phải mở được với số
        # liệu null, còn BXH của chính cuộc thi đó vẫn thất bại ồn ào thay vì xếp theo luật sai.
        return stats
    response = leaderboard_service.leaderboard_response(
        competition, board, current_account_id=account_id, limit=1
    )
    me = response["me"]
    if me is not None:
        stats["rank"] = me["rank"]
        stats["rank_total"] = response["total"]
        stats["best_score"] = me["primary_score"]
        stats["best_normalized_score"] = me.get("normalized_score")
    return stats


@router.get("/{slug}")
async def get_competition_by_slug(slug: str, request: Request, account: OptionalAccount) -> dict:
    from app.memberships.service import get_membership

    db = request.app.state.mongo.db
    competition = await service.find_competition_by_slug(db, slug)
    if competition is None or competition["status"] == "draft":
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    membership = await get_membership(db, competition["_id"], account["_id"]) if account else None
    payload = service.public_competition(competition, membership)
    # Quota chỉ tốn một count_documents nên chỉ tính khi thật sự dùng được: thành viên đang
    # hoạt động của cuộc thi đang mở. List cố ý không tính để tránh N+1.
    if (
        account
        and membership is not None
        and membership.get("active", True)
        and competition["status"] == "published"
    ):
        payload["quota"] = await submissions_service.quota_status(
            db,
            competition["_id"],
            account["_id"],
            competition["quota_per_day"],
            datetime.now(timezone.utc),
        )
    return payload


@router.put("/{slug}/pin")
async def pin_competition(slug: str, request: Request, account: CurrentAccount) -> dict:
    """Ghim cuộc thi cho account hiện tại - sở thích riêng, không đòi hỏi membership."""
    return await _set_pin(request, account, slug, pinned=True)


@router.delete("/{slug}/pin")
async def unpin_competition(slug: str, request: Request, account: CurrentAccount) -> dict:
    return await _set_pin(request, account, slug, pinned=False)


async def _set_pin(request: Request, account: dict, slug: str, *, pinned: bool) -> dict:
    """Trả trạng thái SAU thao tác (PUT luôn true, DELETE luôn false) để gọi lặp vẫn nhất quán."""
    db = request.app.state.mongo.db
    competition = await service.find_competition_by_slug(db, slug)
    if competition is None or competition["status"] == "draft":
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    await accounts_service.set_competition_pin(
        db, account["_id"], competition["_id"], pinned=pinned
    )
    return {"competition_id": str(competition["_id"]), "pinned": pinned}
