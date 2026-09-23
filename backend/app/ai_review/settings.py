"""Cấu hình AI theo từng cuộc thi: parse, default, validate, và view đã che secret.

Module này không chạm đĩa cũng không gọi mạng: nó chỉ biến một body PUT thành đúng những field được
phép ghi. Nhờ vậy "AI bật được hay không" là một câu hỏi trả lời được bằng dữ liệu, và mọi lỗi cấu
hình đều là `SettingsError` với mã ổn định thay vì một chuỗi raise rải rác trong router.
"""

import hashlib
from dataclasses import dataclass
from datetime import datetime

from bson import ObjectId
from pydantic import BaseModel, ConfigDict

from app.ai_review import constants, crypto, url_policy
from app.ai_review.url_policy import EndpointPolicy, NormalizedEndpoint
from app.core.datetimes import iso_z

CONFIG_FIELD = "ai_review_config"
# Trường của cơ chế xác nhận chuyển dữ liệu đã bỏ ở ADR-042. Vẫn `$unset` khi ghi để document cũ
# không giữ lại một trường không còn ai đọc.
LEGACY_ACK_FIELD = "transfer_acknowledgement"

# Vết xác minh (ADR-043): thời điểm gọi provider thành công kèm vân tay của cấu hình đã dùng. Vân tay
# là thứ giữ cho vết này tự hết hiệu lực - đổi base URL, model hay key thì vân tay không còn khớp và
# `verification` trả None, nên không cần ai đó nhớ `$unset` khi ghi.
VERIFIED_AT_FIELD = "verified_at"
VERIFIED_FINGERPRINT_FIELD = "verified_fingerprint"
# Đổi cách tính vân tay thì bump số này: mọi vết cũ tự hết hiệu lực thay vì khớp nhầm.
_FINGERPRINT_VERSION = 1

DEFAULTS = {
    "enabled": False,
    "auto_review": True,
    "participant_visible": True,
    "provider": constants.PROVIDER_OPENAI_COMPATIBLE,
    "base_url": "",
    "model": "",
}


class SettingsError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class SettingsUpdate(BaseModel):
    """Field vắng mặt = giữ nguyên. `api_key` rỗng = giữ key cũ; xóa key có endpoint riêng."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool | None = None
    auto_review: bool | None = None
    participant_visible: bool | None = None
    base_url: str | None = None
    model: str | None = None
    api_key: str | None = None


class ConnectionTest(BaseModel):
    """Cho phép thử cấu hình chưa lưu; field vắng mặt lấy từ config đang có."""

    model_config = ConfigDict(extra="forbid")

    base_url: str | None = None
    model: str | None = None
    api_key: str | None = None


@dataclass(frozen=True)
class ConfigUpdate:
    set_fields: dict
    unset_fields: dict


def stored_config(competition: dict) -> dict:
    """Config đã lưu với default áp cho document cũ - vẫn chứa ciphertext, chỉ dùng nội bộ."""
    return {**DEFAULTS, **(competition.get(CONFIG_FIELD) or {})}


def public_config(competition: dict) -> dict:
    """View an toàn cho admin: không bao giờ có ciphertext, chỉ có `api_key_configured`."""
    stored = stored_config(competition)
    updated_at = stored.get("updated_at")
    return {
        "enabled": stored["enabled"],
        "auto_review": stored["auto_review"],
        "participant_visible": stored["participant_visible"],
        "provider": stored["provider"],
        "base_url": stored["base_url"],
        "model": stored["model"],
        "api_key_configured": bool(stored.get("api_key_ciphertext")),
        "verified_at": _verified_at(stored),
        "updated_at": iso_z(updated_at) if updated_at else None,
    }


def verification_fingerprint(stored: dict) -> str:
    """Vân tay của đúng bộ ba quyết định gọi được provider, tính từ config đã lưu."""
    combined = "\n".join(
        (
            str(_FINGERPRINT_VERSION),
            stored.get("base_url") or "",
            stored.get("model") or "",
            stored.get("api_key_ciphertext") or "",
        )
    )
    return hashlib.sha256(combined.encode("utf-8")).hexdigest()


def verification_fields(stored: dict, *, now: datetime) -> dict:
    """`$set` cho một lần gọi provider thành công bằng chính config đang lưu."""
    return {
        f"{CONFIG_FIELD}.{VERIFIED_AT_FIELD}": now,
        f"{CONFIG_FIELD}.{VERIFIED_FINGERPRINT_FIELD}": verification_fingerprint(stored),
    }


def verification_clear_fields() -> dict:
    """`$unset` khi lần thử gần nhất hỏng: chip xanh cũ không được mâu thuẫn với cảnh báo."""
    return {
        f"{CONFIG_FIELD}.{VERIFIED_AT_FIELD}": "",
        f"{CONFIG_FIELD}.{VERIFIED_FINGERPRINT_FIELD}": "",
    }


def _verified_at(stored: dict) -> str | None:
    """Thời điểm xác minh còn hiệu lực - None khi chưa từng thử, hoặc cấu hình đã đổi kể từ đó."""
    verified_at = stored.get(VERIFIED_AT_FIELD)
    if not verified_at:
        return None
    if stored.get(VERIFIED_FINGERPRINT_FIELD) != verification_fingerprint(stored):
        return None
    return iso_z(verified_at)


def active_config(competition: dict) -> dict | None:
    """Config đang bật, hoặc None. Không kiểm readiness - worker tự kiểm trước khi gọi provider."""
    stored = stored_config(competition)
    return stored if stored["enabled"] else None


def participant_visible(competition: dict) -> bool:
    """Thí sinh có được thấy kết luận AI không; cuộc thi tắt AI thì không có gì để hiện."""
    stored = stored_config(competition)
    return bool(stored["enabled"] and stored["participant_visible"])


def resolve_target(competition: dict, *, policy: EndpointPolicy) -> tuple[dict, NormalizedEndpoint, str, str]:
    """Config đang bật kèm endpoint/model/API key đã sẵn sàng; raise `SettingsError` nếu thiếu.

    Dùng chung cho worker và cho lệnh chạy lại của admin: admin nhận lỗi cấu hình ngay lúc bấm
    nút, thay vì để worker ghi một audit row ERROR mà không nói được vì sao.
    """
    active = active_config(competition)
    if active is None:
        raise SettingsError(constants.AI_REVIEW_DISABLED, "Cuộc thi đang tắt AI review.")
    endpoint = resolve_endpoint(active["base_url"], None, policy)
    model = (active.get("model") or "").strip()
    if endpoint is None or not model:
        raise SettingsError(
            constants.AI_CONFIG_INCOMPLETE, "Cấu hình AI review chưa đầy đủ."
        )
    return active, endpoint, model, resolve_api_key(competition, None)


def build_update(
    competition: dict,
    body: SettingsUpdate,
    *,
    policy: EndpointPolicy,
    updated_by: ObjectId,
    now: datetime,
) -> ConfigUpdate:
    """Dựng `$set`/`$unset` cho `ai_review_config`; raise `SettingsError` nếu cấu hình không hợp lệ."""
    stored = stored_config(competition)
    enabled = stored["enabled"] if body.enabled is None else body.enabled
    auto_review = stored["auto_review"] if body.auto_review is None else body.auto_review
    participant_visible = (
        stored["participant_visible"]
        if body.participant_visible is None
        else body.participant_visible
    )

    endpoint = resolve_endpoint(stored["base_url"], body.base_url, policy)
    host = endpoint.host if endpoint else ""
    model = (stored["model"] if body.model is None else body.model).strip()

    unset_fields = {f"{CONFIG_FIELD}.{LEGACY_ACK_FIELD}": ""}

    ciphertext = stored.get("api_key_ciphertext")
    if body.api_key and body.api_key.strip():
        try:
            ciphertext = crypto.encrypt_secret(body.api_key.strip())
        except crypto.CryptoError as exc:
            raise SettingsError(exc.code, exc.message)

    if enabled:
        _require_ready(host=host, model=model, ciphertext=ciphertext)

    set_fields = {
        f"{CONFIG_FIELD}.enabled": enabled,
        f"{CONFIG_FIELD}.auto_review": auto_review,
        f"{CONFIG_FIELD}.participant_visible": participant_visible,
        f"{CONFIG_FIELD}.provider": constants.PROVIDER_OPENAI_COMPATIBLE,
        f"{CONFIG_FIELD}.base_url": endpoint.base_url if endpoint else "",
        f"{CONFIG_FIELD}.model": model,
        f"{CONFIG_FIELD}.updated_by": updated_by,
        f"{CONFIG_FIELD}.updated_at": now,
    }
    if ciphertext is not None:
        set_fields[f"{CONFIG_FIELD}.api_key_ciphertext"] = ciphertext
    return ConfigUpdate(set_fields=set_fields, unset_fields=unset_fields)


def resolve_endpoint(
    stored_base_url: str, override: str | None, policy: EndpointPolicy
) -> NormalizedEndpoint | None:
    """Chuẩn hoá Base URL; `None`/rỗng nghĩa là chưa cấu hình, vẫn phải parse được nếu có giá trị."""
    raw = stored_base_url if override is None else override.strip()
    if not raw:
        return None
    try:
        return url_policy.normalize_endpoint(raw, policy)
    except url_policy.UrlPolicyError as exc:
        raise SettingsError(exc.code, exc.message)


def resolve_api_key(competition: dict, override: str | None) -> str:
    """Key mới trong body, hoặc key đã lưu được giải mã; không bao giờ trả ciphertext ra ngoài."""
    if override and override.strip():
        return override.strip()
    stored = stored_config(competition)
    ciphertext = stored.get("api_key_ciphertext")
    if not ciphertext:
        raise SettingsError(constants.AI_API_KEY_MISSING, "Cuộc thi chưa có API key.")
    try:
        return crypto.decrypt_secret(ciphertext)
    except crypto.CryptoError as exc:
        raise SettingsError(exc.code, exc.message)


def _require_ready(*, host: str, model: str, ciphertext) -> None:
    if not host or not model:
        raise SettingsError(
            constants.AI_CONFIG_INCOMPLETE,
            "Bật AI cần có Base URL và model hợp lệ.",
        )
    if not ciphertext:
        raise SettingsError(constants.AI_API_KEY_MISSING, "Bật AI cần có API key.")
    if not crypto.encryption_available():
        raise SettingsError(
            constants.AI_ENCRYPTION_KEY_MISSING,
            "Máy chủ chưa có khoá mã hoá để lưu API key.",
        )
