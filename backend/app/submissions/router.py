"""Participant CSV upload, validation, synchronous scoring and persistence."""

import logging
from datetime import datetime, timezone
from pathlib import Path

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, File, Query, Request, UploadFile

from app.auth.dependencies import CurrentAccount
from app.competitions import service as competitions_service
from app.content import storage
from app.core.config import get_settings
from app.core.datetimes import as_utc
from app.core.errors import api_error
from app.memberships.service import get_membership
from app.scoring import service as scoring_service
from app.scoring import storage as scoring_storage
from app.submissions import service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/competitions")


@router.post("/{competition_id}/submissions", status_code=201)
async def submit_csv(
    competition_id: str,
    request: Request,
    account: CurrentAccount,
    file: UploadFile = File(...),
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
    data = await _read_limited(file)
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
    relative_path = Path(
        "submissions",
        str(competition["_id"]),
        str(account["_id"]),
        f"{submission_id}.csv",
    )
    path = storage.ensure_within(Path(get_settings().data_dir), relative_path)
    try:
        storage.write_atomic(path, data)
    except OSError:
        logger.exception("Cannot write submission competition=%s account=%s", competition["_id"], account["_id"])
        raise api_error(500, "FILE_WRITE_FAILED", "Không thể lưu bài nộp.")

    document = {
        "_id": submission_id,
        "competition_id": competition["_id"],
        "account_id": account["_id"],
        "file_path": relative_path.as_posix(),
        "original_filename": _safe_original_filename(file.filename),
        "status": "completed",
        "metrics": result.metrics,
        "primary_score": result.primary_score,
        "created_at": now,
    }
    try:
        await db[service.SUBMISSIONS_COLLECTION].insert_one(document)
    except Exception:
        path.unlink(missing_ok=True)
        logger.exception("Cannot persist submission competition=%s account=%s", competition["_id"], account["_id"])
        raise api_error(500, "SUBMISSION_SAVE_FAILED", "Không thể lưu kết quả bài nộp.")
    logger.info(
        "Submission completed competition=%s account=%s submission=%s",
        competition["_id"],
        account["_id"],
        submission_id,
    )
    return service.public_submission(document, max(quota - completed_today - 1, 0))


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


async def _read_limited(file: UploadFile) -> bytes:
    limit_mb = get_settings().max_upload_mb
    data = await file.read(limit_mb * 1024 * 1024 + 1)
    if len(data) > limit_mb * 1024 * 1024:
        raise api_error(413, "FILE_TOO_LARGE", f"File vượt quá giới hạn {limit_mb} MiB.")
    return data


def _safe_original_filename(filename: str | None) -> str:
    safe_name = Path((filename or "submission.csv").replace("\\", "/")).name
    return safe_name[:255] or "submission.csv"
