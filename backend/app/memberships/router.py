"""Participant join endpoint. Policy được enforce hoàn toàn ở backend."""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.auth.dependencies import CurrentAccount
from app.auth.passwords import verify_password
from app.competitions.service import find_competition_by_slug
from app.core.datetimes import as_utc
from app.core.errors import api_error
from app.memberships import service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/competitions")


class JoinBody(BaseModel):
    join_code: str | None = None


@router.post("/{slug}/join")
async def join_competition(
    slug: str, body: JoinBody, request: Request, account: CurrentAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await find_competition_by_slug(db, slug)
    if competition is None or competition["status"] == "draft":
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")

    # Membership hiện có được xử lý trước cửa sổ thời gian: người đã tham gia vẫn phải thấy
    # trạng thái của mình (idempotent) kể cả sau end_at hay sau khi cuộc thi đã đóng.
    membership = await service.get_membership(db, competition["_id"], account["_id"])
    if membership is not None:
        if not membership.get("active", True):
            raise api_error(
                403,
                "MEMBERSHIP_INACTIVE",
                "Membership đã bị vô hiệu hóa. Vui lòng liên hệ Ban Tổ chức.",
            )
        logger.info(
            "Competition join reused competition=%s account=%s",
            competition["_id"],
            account["_id"],
        )
        return {
            "competition_id": str(competition["_id"]),
            "membership": service.public_membership(membership),
            "joined_now": False,
        }

    if competition["status"] == "closed":
        raise api_error(422, "JOIN_CLOSED", "Cuộc thi đã kết thúc, không thể tham gia mới.")
    # Join mở từ lúc publish đến hết end_at. Không kiểm tra start_at: tham gia sớm để chuẩn bị
    # là hợp lệ, chỉ việc nộp bài mới phụ thuộc start_at.
    if datetime.now(timezone.utc) > as_utc(competition["end_at"]):
        raise api_error(
            422,
            "JOIN_DEADLINE_PASSED",
            "Cuộc thi đã hết thời gian tham gia.",
        )

    if competition["join_mode"] == "invite_only":
        raise api_error(
            403,
            "JOIN_INVITE_ONLY",
            "Cuộc thi này chỉ dành cho tài khoản được Ban Tổ chức mời.",
        )
    if competition["join_mode"] == "code":
        code_hash = competition.get("join_code_hash")
        if not code_hash or not body.join_code or not verify_password(code_hash, body.join_code):
            raise api_error(403, "JOIN_CODE_INVALID", "Mã tham gia không hợp lệ.")

    membership, joined_now = await service.ensure_membership(
        db, competition["_id"], account["_id"]
    )
    logger.info(
        "Competition join completed competition=%s account=%s mode=%s joined_now=%s",
        competition["_id"],
        account["_id"],
        competition["join_mode"],
        joined_now,
    )
    return {
        "competition_id": str(competition["_id"]),
        "membership": service.public_membership(membership),
        "joined_now": joined_now,
    }


@router.post("/{slug}/leave")
async def leave_competition(slug: str, request: Request, account: CurrentAccount) -> dict:
    """Rời cuộc thi = soft deactivate; bài nộp, điểm và thứ hạng đã có vẫn được giữ nguyên."""
    db = request.app.state.mongo.db
    competition = await find_competition_by_slug(db, slug)
    if competition is None or competition["status"] == "draft":
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")

    membership = await service.get_membership(db, competition["_id"], account["_id"])
    if membership is None:
        raise api_error(404, "NOT_FOUND", "Bạn chưa tham gia cuộc thi này.")

    # Gọi lại sau khi đã rời là hợp lệ: UI có thể gửi lần hai mà không cần phân biệt trạng thái.
    left_now = membership.get("active", True)
    if left_now:
        membership = await service.set_membership_active(db, membership, False)
        logger.info(
            "Competition leave competition=%s account=%s", competition["_id"], account["_id"]
        )
    return {
        "competition_id": str(competition["_id"]),
        "membership": service.public_membership(membership),
        "left_now": left_now,
    }
