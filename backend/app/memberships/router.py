"""Participant join endpoint. Policy được enforce hoàn toàn ở backend."""

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.auth.dependencies import CurrentAccount
from app.auth.passwords import verify_password
from app.competitions.service import find_competition_by_slug
from app.core.errors import api_error
from app.memberships import service

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
    if competition["status"] == "closed":
        raise api_error(422, "JOIN_CLOSED", "Cuộc thi đã kết thúc, không thể tham gia mới.")

    membership = await service.get_membership(db, competition["_id"], account["_id"])
    if membership is not None:
        if not membership.get("active", True):
            raise api_error(
                403,
                "MEMBERSHIP_INACTIVE",
                "Membership đã bị vô hiệu hóa. Vui lòng liên hệ Ban Tổ chức.",
            )
        return {
            "competition_id": str(competition["_id"]),
            "membership": service.public_membership(membership),
            "joined_now": False,
        }

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
    return {
        "competition_id": str(competition["_id"]),
        "membership": service.public_membership(membership),
        "joined_now": joined_now,
    }
