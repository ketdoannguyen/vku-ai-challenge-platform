"""Participant submission upload (CSV + notebook), validation, scoring and persistence."""

import logging
from datetime import datetime, timezone
from pathlib import Path

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, File, Query, Request, Response, UploadFile
from pymongo.errors import DuplicateKeyError

from app.auth.dependencies import CurrentAccount
from app.competitions import service as competitions_service
from app.core.config import get_settings
from app.core.datetimes import as_utc
from app.core.errors import api_error
from app.memberships.service import get_membership
from app.scoring import service as scoring_service
from app.scoring import storage as scoring_storage
from app.submission_artifacts import storage as artifact_storage
from app.submission_artifacts import validation as artifact_validation
from app.submission_artifacts.naming import (
    NOTEBOOK_ARTIFACT,
    PREDICTION_ARTIFACT,
    ARTIFACT_MEDIA_TYPES,
)
from app.submissions import artifacts as artifacts_reader
from app.submissions import service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/competitions")

# Hai request đồng thời có thể cùng đọc ra một số thứ tự; unique index là chốt, đây là số lần tính lại.
_SEQUENCE_ATTEMPTS = 3


@router.post("/{competition_id}/submissions", status_code=201)
async def submit_submission(
    competition_id: str,
    request: Request,
    account: CurrentAccount,
    file: UploadFile = File(...),
    notebook: UploadFile = File(...),
) -> dict:
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    if competition["status"] != "published":
        raise api_error(422, "SUBMISSION_CLOSED", "Cuộc thi hiện không nhận bài nộp.")

    membership = await get_membership(db, competition["_id"], account["_id"])
    if membership is None:
        raise api_error(403, "MEMBERSHIP_REQUIRED", "Bạn chưa tham gia cuộc thi này.")
    if not membership.get("active", True):
        raise api_error(403, "MEMBERSHIP_INACTIVE", "Quyền tham gia cuộc thi đã bị vô hiệu hóa.")

    now = datetime.now(timezone.utc)
    if now < as_utc(competition["start_at"]):
        raise api_error(422, "SUBMISSION_NOT_OPEN", "Cuộc thi chưa mở nhận bài.")
    if now > as_utc(competition["end_at"]):
        raise api_error(422, "SUBMISSION_DEADLINE_PASSED", "Đã hết hạn nộp bài.")

    config = _ready_config(competition)
    completed_today = await service.completed_today_count(
        db, competition["_id"], account["_id"], now
    )
    quota = competition["quota_per_day"]
    if completed_today >= quota:
        raise api_error(
            429,
            "SUBMISSION_QUOTA_EXCEEDED",
            "Bạn đã dùng hết lượt nộp bài hôm nay.",
        )

    ground_truth_data = _read_ground_truth(competition)
    try:
        ground_truth = scoring_service.load_ground_truth(ground_truth_data, config)
    except scoring_service.ScoringValidationError:
        logger.error("Stored ground truth is invalid competition=%s", competition["_id"])
        raise api_error(422, "SCORING_NOT_READY", "Cuộc thi chưa sẵn sàng chấm điểm.")

    if Path(file.filename or "").suffix.lower() != ".csv":
        logger.info(
            "Submission rejected competition=%s account=%s code=INVALID_FILE_TYPE",
            competition["_id"],
            account["_id"],
        )
        raise api_error(422, "INVALID_FILE_TYPE", "Chỉ chấp nhận file submission có đuôi .csv.")
    if not artifact_validation.has_notebook_extension(notebook.filename):
        logger.info(
            "Submission rejected competition=%s account=%s code=INVALID_NOTEBOOK_TYPE",
            competition["_id"],
            account["_id"],
        )
        raise api_error(
            422, "INVALID_NOTEBOOK_TYPE", "Chỉ chấp nhận notebook có đuôi .ipynb."
        )

    settings = get_settings()
    data = await _read_limited(file, settings.max_upload_mb)
    notebook_data = await _read_limited(notebook, settings.max_notebook_mb)
    try:
        artifact_validation.validate_notebook(notebook_data)
    except artifact_validation.NotebookValidationError as exc:
        logger.info(
            "Submission rejected competition=%s account=%s code=%s",
            competition["_id"],
            account["_id"],
            exc.code,
        )
        raise api_error(422, exc.code, exc.message)

    try:
        result = scoring_service.score_submission(
            data, ground_truth, config, competition["primary_metric"]
        )
    except scoring_service.ScoringValidationError as exc:
        logger.info(
            "Submission rejected competition=%s account=%s code=%s",
            competition["_id"],
            account["_id"],
            exc.code,
        )
        raise api_error(422, exc.code, exc.message)
    except Exception:
        logger.exception(
            "Submission scoring failed competition=%s account=%s",
            competition["_id"],
            account["_id"],
        )
        raise api_error(500, "SCORING_FAILED", "Không thể chấm điểm bài nộp.")

    submission_id = ObjectId()
    prediction_key = artifact_storage.prediction_key(
        competition["_id"], account["_id"], submission_id
    )
    notebook_key = artifact_storage.notebook_key(
        competition["_id"], account["_id"], submission_id
    )
    await _upload(
        prediction_key, data, ARTIFACT_MEDIA_TYPES[PREDICTION_ARTIFACT], competition, account
    )
    try:
        await artifact_storage.put_bytes(
            notebook_key, notebook_data, ARTIFACT_MEDIA_TYPES[NOTEBOOK_ARTIFACT]
        )
    except artifact_storage.ArtifactStorageUnavailable:
        logger.exception(
            "Notebook upload failed competition=%s account=%s", competition["_id"], account["_id"]
        )
        await artifact_storage.remove_object(prediction_key)
        raise _storage_unavailable()

    document = {
        "_id": submission_id,
        "competition_id": competition["_id"],
        "account_id": account["_id"],
        "artifacts": {
            PREDICTION_ARTIFACT: {
                "object_key": prediction_key,
                "original_filename": _safe_original_filename(file.filename, "submission.csv"),
                "size_bytes": len(data),
            },
            NOTEBOOK_ARTIFACT: {
                "object_key": notebook_key,
                "original_filename": _safe_original_filename(
                    notebook.filename, "notebook.ipynb"
                ),
                "size_bytes": len(notebook_data),
            },
        },
        "status": "completed",
        "metrics": result.metrics,
        "primary_score": result.primary_score,
        "created_at": now,
    }
    await _insert_with_sequence(db, document, prediction_key, notebook_key, competition, account)
    logger.info(
        "Submission completed competition=%s account=%s submission=%s submission_no=%s",
        competition["_id"],
        account["_id"],
        submission_id,
        document["submission_no"],
    )
    return service.public_submission(document, max(quota - completed_today - 1, 0))


async def _insert_with_sequence(
    db, document: dict, prediction_key: str, notebook_key: str, competition: dict, account: dict
) -> None:
    """Insert với `submission_no` tính lại khi trùng; object đã upload không bị đụng giữa các retry."""
    collection = db[service.SUBMISSIONS_COLLECTION]
    for _ in range(_SEQUENCE_ATTEMPTS):
        document["submission_no"] = await service.next_submission_no(
            db, document["competition_id"], document["account_id"]
        )
        try:
            await collection.insert_one(document)
            return
        except DuplicateKeyError:
            # Chỉ trùng số thứ tự mới tới đây; upload giữ nguyên, tính lại rồi thử tiếp.
            continue
        except Exception:
            logger.exception(
                "Cannot persist submission competition=%s account=%s",
                competition["_id"],
                account["_id"],
            )
            await _cleanup(prediction_key, notebook_key)
            raise api_error(500, "SUBMISSION_SAVE_FAILED", "Không thể lưu kết quả bài nộp.")
    logger.error(
        "Cannot allocate submission_no after %s attempts competition=%s account=%s",
        _SEQUENCE_ATTEMPTS,
        competition["_id"],
        account["_id"],
    )
    await _cleanup(prediction_key, notebook_key)
    raise api_error(500, "SUBMISSION_SAVE_FAILED", "Không thể lưu kết quả bài nộp.")


async def _upload(key: str, data: bytes, content_type: str, competition: dict, account: dict) -> None:
    try:
        await artifact_storage.put_bytes(key, data, content_type)
    except artifact_storage.ArtifactStorageUnavailable:
        logger.exception(
            "Artifact upload failed competition=%s account=%s", competition["_id"], account["_id"]
        )
        raise _storage_unavailable()


async def _cleanup(*keys: str) -> None:
    for key in keys:
        await artifact_storage.remove_object(key)


def _storage_unavailable():
    return api_error(
        503, "ARTIFACT_STORAGE_UNAVAILABLE", "Hệ thống lưu trữ tạm thời không khả dụng."
    )


@router.get("/{competition_id}/submissions/me")
async def my_submissions(
    competition_id: str,
    request: Request,
    account: CurrentAccount,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    submissions, total = await service.list_account_submissions(
        db,
        competition["_id"],
        account["_id"],
        limit=limit,
        offset=offset,
    )
    return {"submissions": submissions, "total": total, "limit": limit, "offset": offset}


@router.get("/{competition_id}/submissions/{submission_id}/prediction")
async def download_prediction(
    competition_id: str, submission_id: str, request: Request, account: CurrentAccount
) -> Response:
    return await _download_own(request, competition_id, submission_id, account, PREDICTION_ARTIFACT)


@router.get("/{competition_id}/submissions/{submission_id}/notebook")
async def download_notebook(
    competition_id: str, submission_id: str, request: Request, account: CurrentAccount
) -> Response:
    return await _download_own(request, competition_id, submission_id, account, NOTEBOOK_ARTIFACT)


async def _download_own(
    request: Request, competition_id: str, submission_id: str, account: dict, kind: str
) -> Response:
    """Bài của chính mình tải được kể cả sau khi rời cuộc thi; bài của đội khác là 404."""
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    submission = await _own_submission_or_404(db, competition, account, submission_id)
    return await artifacts_reader.artifact_response(submission, competition, account, kind)


async def _own_submission_or_404(db, competition: dict, account: dict, submission_id: str) -> dict:
    try:
        oid = ObjectId(submission_id)
    except InvalidId:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy bài nộp.")
    submission = await db[service.SUBMISSIONS_COLLECTION].find_one(
        {
            "_id": oid,
            "competition_id": competition["_id"],
            "account_id": account["_id"],
        }
    )
    if submission is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy bài nộp.")
    return submission


async def _competition_or_404(db, competition_id: str) -> dict:
    try:
        oid = ObjectId(competition_id)
    except InvalidId:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    competition = await db[competitions_service.COMPETITIONS_COLLECTION].find_one({"_id": oid})
    if competition is None or competition["status"] == "draft":
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    return competition


def _ready_config(competition: dict) -> scoring_service.ScoringConfig:
    if not competition.get("ground_truth"):
        raise api_error(422, "SCORING_NOT_READY", "Cuộc thi chưa sẵn sàng chấm điểm.")
    try:
        config = scoring_service.config_from_competition(competition)
    except Exception:
        config = None
    if config is None:
        raise api_error(422, "SCORING_NOT_READY", "Cuộc thi chưa sẵn sàng chấm điểm.")
    return config


def _read_ground_truth(competition: dict) -> bytes:
    try:
        return scoring_storage.read_ground_truth(competition)
    except (KeyError, OSError, ValueError):
        raise api_error(422, "SCORING_NOT_READY", "Cuộc thi chưa sẵn sàng chấm điểm.")


async def _read_limited(file: UploadFile, limit_mb: int) -> bytes:
    limit = limit_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise api_error(413, "FILE_TOO_LARGE", f"File vượt quá giới hạn {limit_mb} MiB.")
    return data


def _safe_original_filename(filename: str | None, fallback: str) -> str:
    safe_name = Path((filename or fallback).replace("\\", "/")).name
    return safe_name[:255] or fallback
