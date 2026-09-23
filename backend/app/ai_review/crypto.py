"""Mã hoá đối xứng API key của provider bằng Fernet.

Plaintext chỉ tồn tại trong bộ nhớ đúng lúc gọi provider hoặc lúc test connection; Mongo chỉ giữ
ciphertext. Master key đến từ `LLM_CONFIG_ENCRYPTION_KEY` - thiếu hay sai key KHÔNG làm API/worker
chết, chỉ làm nhánh AI không dùng được.
"""

from cryptography.fernet import Fernet, InvalidToken

from app.ai_review import constants
from app.core.config import get_settings


class CryptoError(Exception):
    """Master key thiếu/sai hoặc ciphertext không giải mã được; mã lỗi ổn định cho tầng API."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def encryption_available() -> bool:
    """True khi master key hiện tại là một Fernet key hợp lệ - dùng để tô sáng cảnh báo ở UI."""
    try:
        _fernet()
    except CryptoError:
        return False
    return True


def encrypt_secret(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_secret(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError, UnicodeDecodeError):
        # Sai master key và ciphertext hỏng là cùng một biểu hiện với người vận hành.
        raise CryptoError(
            constants.AI_ENCRYPTION_KEY_MISSING,
            "Không giải mã được API key đã lưu (master key sai hoặc đã đổi).",
        )


def _fernet() -> Fernet:
    key = get_settings().llm_config_encryption_key
    if not key:
        raise CryptoError(
            constants.AI_ENCRYPTION_KEY_MISSING,
            "Chưa cấu hình khoá mã hoá API key.",
        )
    try:
        return Fernet(key.encode("ascii"))
    except (ValueError, TypeError):
        raise CryptoError(
            constants.AI_ENCRYPTION_KEY_MISSING,
            "Khoá mã hoá API key không hợp lệ.",
        )
