"""Admin API cho cấu hình AI theo cuộc thi. Router chỉ validate/auth/map lỗi, logic nằm ở `settings`."""

import logging
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict
from pymongo import ReturnDocument

from app.ai_review import (
    constants,
    content_snapshot,
    crypto,
    provider,
    settings as config,
    url_policy,
)
from app.auth.dependencies import AdminAccount
from app.competitions.admin_router import _get_competition_or_404
from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.config import get_settings
from app.core.errors import api_error

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/competitions")


def _runtime_policy(runtime):
    """Chính sách mạng dựng từ env. Allowlist hỏng là lỗi cấu hình vận hành, không phải lỗi 500."""
    try:
        return url_policy.policy_from_settings(runtime)
    except url_policy.UrlPolicyError as exc:
        raise api_error(422, exc.code, exc.message)


@router.get("/{competition_id}/ai-review")
async def get_ai_review_settings(
    competition_id: str, request: Request, admin: AdminAccount
) -> dict:
    """Trạng thái cấu hình AI của cuộc thi - không bao giờ trả ciphertext hay plaintext của key."""
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    runtime = get_settings()
    policy = _runtime_policy(runtime)
    return {
        "config": config.public_config(competition),
        "runtime": {"encryption_available": crypto.encryption_available()},
        "content_source": await content_snapshot.content_source_view(
            db, competition["_id"], settings=runtime
        ),
    }


@router.put("/{competition_id}/ai-review")
async def update_ai_review_settings(
    competition_id: str,
    body: config.SettingsUpdate,
    request: Request,
    admin: AdminAccount,
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    runtime = get_settings()
    policy = _runtime_policy(runtime)
    try:
        update = config.build_update(
            competition,
            body,
            policy=policy,
            updated_by=admin["_id"],
            now=datetime.now(timezone.utc),
        )
    except config.SettingsError as exc:
        raise api_error(422, exc.code, exc.message)

    operations: dict = {"$set": update.set_fields}
    if update.unset_fields:
        operations["$unset"] = update.unset_fields
    await db[COMPETITIONS_COLLECTION].update_one({"_id": competition["_id"]}, operations)
    updated = await db[COMPETITIONS_COLLECTION].find_one({"_id": competition["_id"]})
    logger.info(
        "AI review config updated admin=%s competition=%s enabled=%s",
        admin["email"],
        competition["_id"],
        update.set_fields[f"{config.CONFIG_FIELD}.enabled"],
    )
    return {"config": config.public_config(updated)}


class ImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_competition_id: str


@router.post("/{competition_id}/ai-review/import")
async def import_ai_review_settings(
    competition_id: str, body: ImportRequest, request: Request, admin: AdminAccount
) -> dict:
    db = request.app.state.mongo.db
    target = await _get_competition_or_404(db, competition_id)
    source = await _get_competition_or_404(db, body.source_competition_id)
    if target["_id"] == source["_id"]:
        raise api_error(422, "AI_IMPORT_SAME_COMPETITION", "Không thể nhập cấu hình từ chính cuộc thi này.")
    try:
        snapshot = config.snapshot_config(
            source,
            updated_by=admin["_id"],
            now=datetime.now(timezone.utc),
            policy=_runtime_policy(get_settings()),
        )
    except config.SettingsError as exc:
        raise api_error(422, exc.code, exc.message)
    if snapshot is None:
        raise api_error(422, "AI_IMPORT_SOURCE_NOT_CONFIGURED", "Cuộc thi nguồn chưa có cấu hình AI.")
    updated = await db[COMPETITIONS_COLLECTION].find_one_and_update(
        {"_id": target["_id"]},
        {"$set": {config.CONFIG_FIELD: snapshot}},
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    logger.info(
        "AI review config imported admin=%s target=%s source=%s",
        admin["email"], target["_id"], source["_id"],
    )
    return {"config": config.public_config(updated)}


@router.delete("/{competition_id}/ai-review/api-key")
async def delete_ai_review_api_key(
    competition_id: str, request: Request, admin: AdminAccount
) -> dict:
    """Xóa key là thao tác riêng dùng `$unset`, để PUT không bao giờ vô tình ghi đè ciphertext."""
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    await db[COMPETITIONS_COLLECTION].update_one(
        {"_id": competition["_id"]},
        {
            "$unset": {f"{config.CONFIG_FIELD}.api_key_ciphertext": ""},
            "$set": {
                f"{config.CONFIG_FIELD}.updated_by": admin["_id"],
                f"{config.CONFIG_FIELD}.updated_at": datetime.now(timezone.utc),
            },
        },
    )
    updated = await db[COMPETITIONS_COLLECTION].find_one({"_id": competition["_id"]})
    logger.info(
        "AI review API key removed admin=%s competition=%s", admin["email"], competition["_id"]
    )
    return {"config": config.public_config(updated)}


@router.post("/{competition_id}/ai-review/test")
async def test_ai_review_connection(
    competition_id: str,
    body: config.ConnectionTest,
    request: Request,
    admin: AdminAccount,
) -> dict:
    """Thử endpoint/model bằng prompt cố định; không gửi notebook hay policy nên không cần xác nhận."""
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    runtime = get_settings()
    policy = _runtime_policy(runtime)
    stored = config.stored_config(competition)
    # Chỉ lần thử bằng chính cấu hình đã lưu mới là bằng chứng về cấu hình đó, và chỉ nó mới được ghi
    # vết (ADR-043). Thử bằng giá trị admin đang gõ trên form thì chưa có gì đã lưu để nói tới.
    records_verification = body.base_url is None and body.model is None and body.api_key is None
    try:
        endpoint = config.resolve_endpoint(stored["base_url"], body.base_url, policy)
        if endpoint is None:
            raise config.SettingsError(
                constants.AI_CONFIG_INCOMPLETE, "Chưa cấu hình Base URL."
            )
        model = (stored["model"] if body.model is None else body.model).strip()
        if not model:
            raise config.SettingsError(constants.AI_CONFIG_INCOMPLETE, "Chưa cấu hình model.")
        api_key = config.resolve_api_key(competition, body.api_key)
    except config.SettingsError as exc:
        raise api_error(422, exc.code, exc.message)

    # `trust_env=False`: proxy từ biến môi trường sẽ đổi đích thật và vòng qua network policy.
    async with httpx.AsyncClient(trust_env=False) as client:
        try:
            result = await provider.test_connection(
                client,
                endpoint=endpoint,
                policy=policy,
                api_key=api_key,
                model=model,
                settings=runtime,
            )
        except provider.ProviderError as exc:
            if records_verification:
                # Lần thử hỏng phải xoá vết cũ, nếu không chip xanh sẽ mâu thuẫn với cảnh báo lỗi.
                await db[COMPETITIONS_COLLECTION].update_one(
                    {"_id": competition["_id"]},
                    {"$unset": config.verification_clear_fields()},
                )
            # Lỗi phía provider là 502; body upstream không bao giờ được chuyển tiếp cho admin.
            raise api_error(502, exc.code, exc.message)

    if records_verification:
        await db[COMPETITIONS_COLLECTION].update_one(
            {"_id": competition["_id"]},
            {
                "$set": config.verification_fields(
                    stored, now=datetime.now(timezone.utc)
                )
            },
        )
    return result
