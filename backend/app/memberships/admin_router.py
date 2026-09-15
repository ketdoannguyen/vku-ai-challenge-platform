"""Admin membership and join-code management."""

import logging
from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, EmailStr

from app.accounts.service import ACCOUNTS_COLLECTION, find_account_by_email
from app.auth.dependencies import AdminAccount
from app.auth.passwords import hash_password
from app.competitions.admin_router import _get_competition_or_404
from app.core.errors import api_error
from app.memberships import service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/competitions")


class JoinCodeBody(BaseModel):
    join_code: str


class AddMemberBody(BaseModel):
    email: EmailStr


class SetMemberActiveBody(BaseModel):
    active: bool


@router.put("/{competition_id}/join-code")
async def set_join_code(
    competition_id: str, body: JoinCodeBody, request: Request, admin: AdminAccount
) -> dict:
    if not 8 <= len(body.join_code) <= 128 or body.join_code.strip() != body.join_code:
        raise api_error(
            422,
            "VALIDATION_ERROR",
            "Mã tham gia phải có 8-128 ký tự và không có khoảng trắng ở đầu/cuối.",
        )
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    if competition["status"] == "closed":
        raise api_error(422, "INVALID_TRANSITION", "Không thể đổi mã của cuộc thi đã kết thúc.")
    await db["competitions"].update_one(
        {"_id": competition["_id"]},
        {
            "$set": {
                "join_code_hash": hash_password(body.join_code),
                "join_code_updated_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
            }
        },
    )
    logger.info("Admin %s updated join code for %s", admin["email"], competition["slug"])
    return {"join_code_configured": True}


@router.get("/{competition_id}/members")
async def list_members(
    competition_id: str,
    request: Request,
    admin: AdminAccount,
    q: str = "",
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    memberships = [
        item
        async for item in db[service.MEMBERSHIPS_COLLECTION]
        .find({"competition_id": competition["_id"]})
        .sort([("joined_at", 1), ("_id", 1)])
    ]
    account_ids = [membership["account_id"] for membership in memberships]
    account_query = {"_id": {"$in": account_ids}}
    if q.strip():
        import re

        pattern = {"$regex": re.escape(q.strip()), "$options": "i"}
        account_query["$or"] = [{"email": pattern}, {"name": pattern}]
    accounts = {
        account["_id"]: account
        async for account in db[ACCOUNTS_COLLECTION].find(account_query)
    }
    filtered = [m for m in memberships if m["account_id"] in accounts]
    page = filtered[offset : offset + limit]
    return {
        "members": [service.member_view(m, accounts[m["account_id"]]) for m in page],
        "total": len(filtered),
        "limit": limit,
        "offset": offset,
    }


@router.post("/{competition_id}/members")
async def add_member(
    competition_id: str, body: AddMemberBody, request: Request, admin: AdminAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    account = await find_account_by_email(db, str(body.email))
    if account is None:
        raise api_error(404, "ACCOUNT_NOT_FOUND", "Không tìm thấy tài khoản.")
    if account["role"] != "participant" or not account.get("active", True):
        raise api_error(422, "VALIDATION_ERROR", "Chỉ có thể thêm tài khoản participant đang hoạt động.")

    membership = await service.get_membership(db, competition["_id"], account["_id"])
    created = membership is None
    reactivated = membership is not None and not membership.get("active", True)
    if membership is None:
        membership, _ = await service.ensure_membership(db, competition["_id"], account["_id"])
    elif reactivated:
        membership = await service.set_membership_active(db, membership, True)
    return {
        "member": service.member_view(membership, account),
        "created": created,
        "reactivated": reactivated,
    }


@router.patch("/{competition_id}/members/{account_id}")
async def set_member_active(
    competition_id: str,
    account_id: str,
    body: SetMemberActiveBody,
    request: Request,
    admin: AdminAccount,
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    try:
        oid = ObjectId(account_id)
    except InvalidId:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy membership.")
    account = await db[ACCOUNTS_COLLECTION].find_one({"_id": oid})
    membership = await service.get_membership(db, competition["_id"], oid)
    if account is None or membership is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy membership.")
    membership = await service.set_membership_active(db, membership, body.active)
    return {"member": service.member_view(membership, account)}
