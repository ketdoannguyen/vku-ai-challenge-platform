"""Auth API: register/login/logout/me. Login sai trả generic error, không tiết lộ email tồn tại."""

import logging

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, EmailStr, Field

from app.accounts.service import AccountCreate, create_account, find_account_by_email, public_account
from app.auth.dependencies import set_session_cookie
from app.auth.passwords import hash_password_async, password_policy_error, verify_password
from app.auth.rate_limit import (
    _SIGNUP_GLOBAL_KEY,
    login_limiter,
    signup_email_limiter,
    signup_global_hour_limiter,
    signup_global_minute_limiter,
)
from app.auth.sessions import create_session, delete_session, resolve_session
from app.core.config import get_settings
from app.core.errors import api_error

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth")


class LoginBody(BaseModel):
    identifier: str
    password: str


# Trần độ dài chặn payload rác trước khi tới bước hash Argon2; 72 ký tự theo giới hạn thực dụng của
# bcrypt-style nhưng áp cả ở đây vì tự đăng ký là đường công khai (ADR-049).
class RegisterBody(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=72)


_REGISTER_ACCEPTED_MESSAGE = (
    "Nếu đăng ký được ghi nhận, tài khoản cần Ban Tổ chức duyệt trước khi đăng nhập. "
    "Nếu bạn đã có tài khoản, hãy đăng nhập hoặc liên hệ Ban Tổ chức."
)


def _rate_limited(retry_after: int):
    error = api_error(429, "RATE_LIMITED", "Có quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau.")
    error.headers = {"Retry-After": str(retry_after)}
    return error


@router.post("/register", status_code=202)
async def register(body: RegisterBody, request: Request) -> dict:
    """Tự đăng ký (ADR-049): tạo tài khoản participant ở trạng thái chờ admin duyệt.

    Trả cùng một response cho email mới lẫn email đã tồn tại để không biến endpoint công khai thành
    oracle dò email. Vẫn chạy đủ bước hash ở cả hai nhánh để chênh lệch thời gian không lộ điều đó;
    unique index là chốt chặn khi hai request tranh nhau (DuplicateKeyError -> cùng response).
    """
    settings = get_settings()
    if not settings.public_registration_enabled:
        raise api_error(403, "REGISTRATION_DISABLED", "Chức năng đăng ký đang tạm đóng.")

    email = str(body.email).strip().lower()
    name = body.name.strip()
    if not name:
        raise api_error(422, "VALIDATION_ERROR", "Vui lòng nhập tên hiển thị.")
    policy_error = password_policy_error(body.password)
    if policy_error:
        raise api_error(422, "VALIDATION_ERROR", policy_error)

    # Mọi lượt đủ hình dạng đều tiêu ngân sách (kể cả lượt trùng email), nếu không kẻ spam dò email
    # không bao giờ chạm trần. 429 ở đây không tiết lộ email có tồn tại hay không.
    for limiter, identifier in (
        (signup_global_minute_limiter, _SIGNUP_GLOBAL_KEY),
        (signup_global_hour_limiter, _SIGNUP_GLOBAL_KEY),
        (signup_email_limiter, email),
    ):
        retry_after = limiter.is_blocked(identifier)
        if retry_after is not None:
            logger.warning("Signup rate limited for email=%s", email)
            raise _rate_limited(retry_after)
    signup_global_minute_limiter.record_failure(_SIGNUP_GLOBAL_KEY)
    signup_global_hour_limiter.record_failure(_SIGNUP_GLOBAL_KEY)
    signup_email_limiter.record_failure(email)

    password_hash = await hash_password_async(body.password)
    db = request.app.state.mongo.db
    account = await create_account(
        db,
        AccountCreate(email=email, name=name, password=body.password, role="participant"),
        pending=True,
        password_hash=password_hash,
    )
    if account is None:
        logger.info("Signup duplicate email=%s", email)
        return {"ok": True, "pending": True, "message": _REGISTER_ACCEPTED_MESSAGE}

    logger.info("Signup pending: email=%s", email)
    return {"ok": True, "pending": True, "message": _REGISTER_ACCEPTED_MESSAGE}


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
    # Pending có `active=False` nên phải kiểm tra trước để người vừa đăng ký nhận đúng thông điệp
    # "chờ duyệt" thay vì "bị vô hiệu hóa" (ADR-049).
    if account.get("pending_approval", False):
        logger.info("Login blocked: pending account email=%s", email)
        raise api_error(403, "ACCOUNT_PENDING", "Tài khoản đang chờ Ban Tổ chức duyệt.")
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
