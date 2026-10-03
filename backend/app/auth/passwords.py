"""Argon2id password hashing - locked behavior (ADR-004, Sprint 02)."""

import threading

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from starlette.concurrency import run_in_threadpool

_hasher = PasswordHasher()  # defaults: argon2id, thời gian/bộ nhớ chuẩn OWASP

# Argon2 tốn ~64 MiB và vài chục ms mỗi lượt. Endpoint tự đăng ký là công khai, nên hash phải chạy
# ngoài event loop (nếu không mọi request khác bị chặn) và phải có trần đồng thời (nếu không một đợt
# spam làm cạn RAM). 4 slot ≈ 256 MiB đỉnh - nằm trong headroom của VM production (ADR-049).
_hash_slots = threading.BoundedSemaphore(4)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


async def hash_password_async(password: str) -> str:
    """Hash cho đường công khai: chạy trong threadpool của Starlette, trần 4 lượt đồng thời."""

    def _guarded() -> str:
        with _hash_slots:
            return _hasher.hash(password)

    return await run_in_threadpool(_guarded)


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
    if len(password) < 6:
        return "Mật khẩu phải có ít nhất 6 ký tự."
    if password.strip() != password:
        return "Mật khẩu không được bắt đầu/kết thúc bằng khoảng trắng."
    return None
