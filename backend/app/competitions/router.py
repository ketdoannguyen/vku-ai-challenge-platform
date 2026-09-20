"""Participant competition API: list published/closed, detail by slug. Draft luôn ẩn.

Đọc công khai (ADR-014): khách chưa đăng nhập vẫn xem được, chỉ là không có membership
nên `membership.active` luôn false. Draft vẫn ẩn với mọi đối tượng.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Request

from app.auth.dependencies import OptionalAccount
from app.competitions import service
from app.core.errors import api_error
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
    return {
        "competitions": [
            {
                **service.public_competition(competition, memberships.get(competition["_id"])),
                "submission_count": submission_counts[competition["_id"]],
            }
            for competition in competitions
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
