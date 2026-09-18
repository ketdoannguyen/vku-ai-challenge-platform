"""Argon2id password hashing - locked behavior (ADR-004, Sprint 02)."""

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

_hasher = PasswordHasher()  # defaults: argon2id, thời gian/bộ nhớ chuẩn OWASP


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except VerifyMismatchError:
        return False
    except Exception:
        # hash malformed/unsupported - coi như sai, không crash luồng login
        return False


def password_policy_error(password: str) -> str | None:
    """Policy tối thiểu cho account BTC tạo; trả message lỗi hoặc None nếu hợp lệ."""
    if len(password) < 10:
        return "Mật khẩu phải có ít nhất 10 ký tự."
    if password.strip() != password:
        return "Mật khẩu không được bắt đầu/kết thúc bằng khoảng trắng."
    return None
