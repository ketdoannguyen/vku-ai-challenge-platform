"""Admin account API: list/search, create, reset password, enable/disable, delete. Chỉ admin."""

import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
from bson import ObjectId
from bson.errors import InvalidId

from app.accounts.service import (
    ACCOUNTS_COLLECTION,
    AccountCreate,
    account_audit_references,
    account_stats,
    create_account,
    delete_account_cascade,
    find_account_by_email,
    public_account,
)
from app.auth.dependencies import AdminAccount
from app.auth.passwords import hash_password, password_policy_error
from app.core.errors import api_error
from app.submissions import service as submissions_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/accounts")

_EMAIL_SEARCH = re.compile(r"^[^@.\s][^@\s]*@[^@\s]+\.[^@\s]+$")


class AdminAccountCreate(AccountCreate):
    pass  # role tùy chọn từ body, đã mặc định participant


class ResetPasswordBody(BaseModel):
    password: str


class SetActiveBody(BaseModel):
    active: bool


def _validate_role(role: str) -> None:
    if role not in ("admin", "participant"):
        raise api_error(422, "VALIDATION_ERROR", "Vai trò phải là 'admin' hoặc 'participant'.")


def _validate_password(password: str) -> None:
    error = password_policy_error(password)
    if error:
        raise api_error(422, "VALIDATION_ERROR", error)


async def _get_account_or_404(db, account_id: str) -> dict:
    try:
        oid = ObjectId(account_id)
    except InvalidId:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy tài khoản.")
    account = await db[ACCOUNTS_COLLECTION].find_one({"_id": oid})
    if account is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy tài khoản.")
    return account


@router.get("")
async def list_accounts(request: Request, admin: AdminAccount, q: str = "", limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)) -> dict:
    db = request.app.state.mongo.db
    query = {}
    if q.strip():
        q = q.strip()
        if _EMAIL_SEARCH.match(q):
            query = {"email": q.lower()}
        else:
            query = {"$or": [{"email": {"$regex": re.escape(q), "$options": "i"}}, {"name": {"$regex": re.escape(q), "$options": "i"}}]}
    cursor = db[ACCOUNTS_COLLECTION].find(query).sort("email", 1).skip(offset).limit(limit)
    accounts = [public_account(a) async for a in cursor]
    total = await db[ACCOUNTS_COLLECTION].count_documents(query)
    # `total` là số khớp `q`; `stats` là tổng quan toàn hệ thống cho các thẻ KPI.
    return {"accounts": accounts, "total": total, "limit": limit, "offset": offset, "stats": await account_stats(db)}


@router.post("", status_code=201)
async def admin_create_account(body: AdminAccountCreate, request: Request, admin: AdminAccount) -> dict:
    _validate_role(body.role)
    _validate_password(body.password)
    db = request.app.state.mongo.db
    if await find_account_by_email(db, body.email) is not None:
        raise api_error(409, "ACCOUNT_EXISTS", "Email này đã có tài khoản.")
    account = await create_account(db, body)
    logger.info("Admin %s created account %s role=%s", admin["email"], account["email"], account["role"])
    return public_account(account)


@router.post("/{account_id}/reset-password")
async def reset_password(account_id: str, body: ResetPasswordBody, request: Request, admin: AdminAccount) -> dict:
    _validate_password(body.password)
    db = request.app.state.mongo.db
    account = await _get_account_or_404(db, account_id)
    await db[ACCOUNTS_COLLECTION].update_one(
        {"_id": account["_id"]},
        {"$set": {"password_hash": hash_password(body.password), "updated_at": datetime.now(timezone.utc)}},
    )
    logger.info("Admin %s reset password of %s", admin["email"], account["email"])
    return {"ok": True}


@router.delete("/{account_id}")
async def delete_account(
    account_id: str,
    request: Request,
    admin: AdminAccount,
    confirm_email: str = Query(...),
) -> dict:
    """Xoá tài khoản kèm dữ liệu con. Lịch sử thi đấu không bao giờ bị xoá theo.

    `confirm_email` buộc admin gõ đúng email, cùng kiểu chốt với `confirm_slug` của xoá cuộc thi -
    thao tác này không hoàn tác được. Tài khoản đã có bài được chấm điểm, hoặc đang là vết hậu
    kiểm, phải dùng Vô hiệu hoá thay vì xoá.
    """
    db = request.app.state.mongo.db
    account = await _get_account_or_404(db, account_id)
    if confirm_email.strip().lower() != account["email"]:
        raise api_error(
            422, "CONFIRM_EMAIL_MISMATCH", "Email xác nhận không khớp với tài khoản cần xoá."
        )
    if account["_id"] == admin["_id"]:
        raise api_error(422, "VALIDATION_ERROR", "Không thể tự xoá tài khoản của chính bạn.")
    if await submissions_service.has_graded_submission(db, account["_id"]):
        raise api_error(
            409,
            "ACCOUNT_HAS_SUBMISSIONS",
            "Tài khoản đã có bài nộp được chấm điểm. Hãy dùng Vô hiệu hoá thay vì xoá.",
        )
    if await account_audit_references(db, account["_id"]):
        raise api_error(
            409,
            "ACCOUNT_REFERENCED",
            "Tài khoản đang là vết hậu kiểm (người duyệt bài hoặc người sửa cấu hình AI), không thể xoá.",
        )
    removed = await delete_account_cascade(db, account)
    logger.info("Admin %s deleted account %s removed=%s", admin["email"], account["email"], removed)
    return {
        "deleted": True,
        "account_id": str(account["_id"]),
        "email": account["email"],
        "removed": removed,
    }


@router.patch("/{account_id}")
async def set_active(account_id: str, body: SetActiveBody, request: Request, admin: AdminAccount) -> dict:
    db = request.app.state.mongo.db
    account = await _get_account_or_404(db, account_id)
    if account["_id"] == admin["_id"] and not body.active:
        raise api_error(422, "VALIDATION_ERROR", "Không thể tự vô hiệu hóa tài khoản của chính bạn.")
    await db[ACCOUNTS_COLLECTION].update_one(
        {"_id": account["_id"]},
        {"$set": {"active": body.active, "updated_at": datetime.now(timezone.utc)}},
    )
    logger.info("Admin %s set active=%s for %s", admin["email"], body.active, account["email"])
    return public_account(await _get_account_or_404(db, account_id))
