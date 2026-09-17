"""FastAPI dependencies cho authorization — backend là nơi quyết định (Sprint 02 locked)."""

from typing import Annotated

from fastapi import Depends, Request

from app.core.errors import api_error


def get_current_account(request: Request) -> dict:
    account = getattr(request.state, "account", None)
    if account is None:
        raise api_error(401, "UNAUTHORIZED", "Bạn cần đăng nhập để thực hiện thao tác này.")
    return account


CurrentAccount = Annotated[dict, Depends(get_current_account)]


def get_optional_account(request: Request) -> dict | None:
    """Cho endpoint đọc công khai: có phiên thì cá nhân hoá, không có phiên vẫn trả 200."""
    return getattr(request.state, "account", None)


OptionalAccount = Annotated[dict | None, Depends(get_optional_account)]


def get_current_admin(account: CurrentAccount) -> dict:
    if account.get("role") != "admin":
        raise api_error(403, "FORBIDDEN", "Chỉ admin mới được thực hiện thao tác này.")
    return account


AdminAccount = Annotated[dict, Depends(get_current_admin)]


def set_session_cookie(response, cookie_name: str, token: str, lifetime_hours: int, secure: bool, samesite: str) -> None:
    response.set_cookie(
        cookie_name,
        token,
        max_age=lifetime_hours * 3600,
        httponly=True,
        secure=secure,
        samesite=samesite,
        path="/",
    )
