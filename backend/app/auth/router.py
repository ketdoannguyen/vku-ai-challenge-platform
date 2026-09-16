"""Auth API: login/logout/me. Login sai trả generic error, không tiết lộ email tồn tại."""

import logging

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from app.accounts.service import find_account_by_email, public_account
from app.auth.dependencies import set_session_cookie
from app.auth.passwords import verify_password
from app.auth.rate_limit import login_limiter
from app.auth.sessions import create_session, delete_session, resolve_session
from app.core.config import get_settings
from app.core.errors import api_error

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth")


class LoginBody(BaseModel):
    identifier: str
    password: str


def _generic_login_error():
    return api_error(401, "INVALID_CREDENTIALS", "Email hoặc mật khẩu không đúng.")


@router.post("/login")
async def login(body: LoginBody, request: Request, response: Response) -> dict:
    db = request.app.state.mongo.db
    email = body.identifier.strip().lower()
    retry_after = login_limiter.retry_after(email)
    if retry_after is not None:
        logger.warning("Login rate limited for email=%s", email)
        error = api_error(429, "RATE_LIMITED", "Đăng nhập thất bại quá nhiều lần. Vui lòng thử lại sau.")
        error.headers = {"Retry-After": str(retry_after)}
        raise error

    account = await find_account_by_email(db, email)
    if account is None or not verify_password(account.get("password_hash", ""), body.password):
        login_limiter.record_failure(email)
        logger.info("Login failed for email=%s", email)
        raise _generic_login_error()
    if not account.get("active", False):
        logger.info("Login blocked: disabled account email=%s", email)
        raise api_error(403, "ACCOUNT_DISABLED", "Tài khoản đã bị vô hiệu hóa.")

    login_limiter.reset(email)
    settings = get_settings()
    token = await create_session(db, account["_id"], settings.session_lifetime_hours)
    set_session_cookie(
        response,
        settings.session_cookie_name,
        token,
        settings.session_lifetime_hours,
        settings.cookie_secure,
        settings.cookie_samesite,
    )
    logger.info("Login ok: account=%s role=%s", account["email"], account["role"])
    return public_account(account)


@router.post("/logout")
async def logout(request: Request, response: Response) -> dict:
    settings = get_settings()
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        await delete_session(request.app.state.mongo.db, token)
    response.delete_cookie(settings.session_cookie_name, path="/")
    return {"ok": True}


@router.get("/me")
async def me(request: Request) -> dict:
    settings = get_settings()
    token = request.cookies.get(settings.session_cookie_name)
    account = await resolve_session(request.app.state.mongo.db, token) if token else None
    if account is None:
        raise api_error(401, "UNAUTHORIZED", "Bạn cần đăng nhập để thực hiện thao tác này.")
    return public_account(account)
