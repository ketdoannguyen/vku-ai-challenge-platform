"""Admin scoring configuration and private ground-truth management."""

import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, File, Request, UploadFile

from app.auth.dependencies import AdminAccount
from app.competitions import service as competitions_service
from app.competitions.admin_router import _get_competition_or_404
from app.content import storage
from app.core.config import get_settings
from app.core.datetimes import iso_z
from app.core.errors import api_error
from app.scoring import service, storage as scoring_storage
from app.scoring.readiness import blocked_reason, check_readiness
from app.submissions.service import has_completed_submission

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/competitions")


@router.get("/{competition_id}/scoring")
async def get_scoring_status(
    competition_id: str, request: Request, admin: AdminAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    return await _scoring_view(db, competition)


@router.put("/{competition_id}/scoring")
async def configure_scoring(
    competition_id: str,
    body: service.ScoringConfig,
    request: Request,
    admin: AdminAccount,
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    await _ensure_unlocked(db, competition)
    try:
        service.validate_config(body)
        if competition.get("ground_truth"):
            try:
                data = scoring_storage.read_ground_truth(competition)
            except (KeyError, OSError, ValueError):
                raise service.ScoringValidationError(
                    "GROUND_TRUTH_INVALID", "Ground truth hiện tại không đọc được."
                )
            service.load_ground_truth(data, body)
    except service.ScoringValidationError as exc:
        raise api_error(422, exc.code, exc.message)

    await db[competitions_service.COMPETITIONS_COLLECTION].update_one(
        {"_id": competition["_id"]},
        {
            "$set": {
                "scoring_config": body.model_dump(),
                "updated_at": datetime.now(timezone.utc),
            }
        },
    )
    logger.info("Admin %s configured scoring competition=%s", admin["email"], competition["_id"])
    updated = await db[competitions_service.COMPETITIONS_COLLECTION].find_one(
        {"_id": competition["_id"]}
    )
    return await _scoring_view(db, updated)


@router.put("/{competition_id}/ground-truth")
async def upload_ground_truth(
    competition_id: str,
    request: Request,
    admin: AdminAccount,
    file: UploadFile = File(...),
) -> dict:
    if Path(file.filename or "").suffix.lower() != ".csv":
        raise api_error(422, "INVALID_FILE_TYPE", "Chỉ chấp nhận ground truth có đuôi .csv.")
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    await _ensure_unlocked(db, competition)
    config = service.config_from_competition(competition)
    if config is None:
        raise api_error(
            422,
            "SCORING_CONFIG_REQUIRED",
            "Cần lưu cấu hình chấm điểm trước khi upload ground truth.",
        )
    data = await _read_limited(file)
    try:
        ground_truth = service.load_ground_truth(data, config)
    except service.ScoringValidationError as exc:
        raise api_error(422, exc.code, exc.message)

    try:
        path = scoring_storage.ground_truth_path(competition)
    except (KeyError, ValueError):
        raise api_error(422, "GROUND_TRUTH_INVALID", "Đường dẫn ground truth không hợp lệ.")
    try:
        storage.write_atomic(path, data)
    except OSError:
        logger.exception("Cannot write ground truth competition=%s", competition["_id"])
        raise api_error(500, "FILE_WRITE_FAILED", "Không thể lưu ground truth.")

    now = datetime.now(timezone.utc)
    metadata = {
        "path": path.relative_to(Path(get_settings().data_dir)).as_posix(),
        "row_count": ground_truth.row_count,
        "columns": list(ground_truth.columns),
        "uploaded_at": now,
    }
    await db[competitions_service.COMPETITIONS_COLLECTION].update_one(
        {"_id": competition["_id"]},
        {"$set": {"ground_truth": metadata, "updated_at": now}},
    )
    logger.info("Admin %s uploaded ground truth competition=%s", admin["email"], competition["_id"])
    updated = await db[competitions_service.COMPETITIONS_COLLECTION].find_one(
        {"_id": competition["_id"]}
    )
    return await _scoring_view(db, updated)


async def _scoring_view(db, competition: dict) -> dict:
    config = service.config_from_competition(competition)
    metadata = competition.get("ground_truth")
    # Dùng chung check_readiness với publish gate để UI và backend không lệch nhau.
    readiness = check_readiness(competition)
    return {
        "ready": readiness.ready,
        "not_ready_reason": blocked_reason(readiness),
        "locked": await _is_locked(db, competition),
        "config": config.model_dump() if config else None,
        "ground_truth": _ground_truth_metadata(metadata),
        "primary_metric": competition["primary_metric"],
        "quota_per_day": competition["quota_per_day"],
        "max_upload_mb": get_settings().max_upload_mb,
    }


async def _ensure_unlocked(db, competition: dict) -> None:
    if await _is_locked(db, competition):
        raise api_error(
            422,
            "SCORING_LOCKED",
            "Không thể đổi cấu hình hoặc ground truth sau khi cuộc thi đã đóng hoặc có điểm.",
        )


async def _is_locked(db, competition: dict) -> bool:
    return competition["status"] == "closed" or await has_completed_submission(
        db, competition["_id"]
    )


async def _read_limited(file: UploadFile) -> bytes:
    limit_mb = get_settings().max_upload_mb
    data = await file.read(limit_mb * 1024 * 1024 + 1)
    if len(data) > limit_mb * 1024 * 1024:
        raise api_error(413, "FILE_TOO_LARGE", f"File vượt quá giới hạn {limit_mb} MiB.")
    return data


def _ground_truth_metadata(metadata: dict | None) -> dict | None:
    if metadata is None:
        return None
    return {
        "row_count": metadata["row_count"],
        "columns": metadata["columns"],
        "uploaded_at": iso_z(metadata["uploaded_at"]),
    }
