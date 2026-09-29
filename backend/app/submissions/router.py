"""Participant submission upload (CSV + notebook), validation, scoring and persistence."""

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, File, HTTPException, Query, Request, Response, UploadFile

from app.accounts import service as accounts_service
from app.ai_review import constants as ai_constants
from app.ai_review import content_snapshot, service as ai_service
from app.ai_review import settings as ai_settings
from app.auth.dependencies import CurrentAccount
from app.competitions import service as competitions_service
from app.core.config import get_settings
from app.core.datetimes import as_utc
from app.core.errors import api_error
from app.memberships.service import get_membership
from app.scoring import csv_validation, evaluator_client, execution, models, revisions
from app.scoring import output_validation
from app.scoring import service as scoring_service
from app.scoring import storage as scoring_storage
from app.scoring.errors import EvaluatorError, ScoringValidationError
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

SCORING_NOT_READY_MESSAGE = "Cuộc thi chưa sẵn sàng chấm điểm."
# Lỗi thuộc về file thí sinh: trả mã riêng để em biết phải sửa gì. Mọi lỗi còn lại - ground truth
# hỏng, hợp đồng metric lệch, bộ chấm lỗi, runner bận - là lỗi hệ thống mà thí sinh không sửa được.
_STUDENT_ERROR_CODES = frozenset(
    {
        csv_validation.SCHEMA_INVALID,
        csv_validation.VALUE_INVALID,
        csv_validation.DUPLICATE_IDS,
        csv_validation.ID_MISMATCH,
    }
)


@dataclass(frozen=True)
class _Scored:
    metrics: dict[str, float]
    primary_score: float
    # Dấu vết của lượt chấm v2; v1 để None vì bộ chấm và công thức là cố định trong mã nguồn.
    scoring_ref: dict | None = None


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

    config = _scoring_config(competition)
    quota = competition["quota_per_day"]
    # Chặn sớm cho khỏi chấm điểm khi đã hết lượt; đây chỉ là đường nhanh vì phép đếm không nguyên
    # tử. Cổng chặn thật là `reserve_quota_slot` ngay trước khi upload.
    completed_today = await service.completed_today_count(
        db, competition["_id"], account["_id"], now
    )
    if completed_today >= quota:
        raise api_error(
            429,
            "SUBMISSION_QUOTA_EXCEEDED",
            "Bạn đã dùng hết lượt nộp bài hôm nay.",
        )

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

    scored = await _score_or_fail(competition, config, data, account=account)

    # Giữ lượt nguyên tử TRƯỚC khi cấp số và upload: phép đếm ở trên không nguyên tử nên nhiều
    # request song song cùng lọt qua, còn `$inc` có điều kiện trên một document membership thì
    # không. Giữ sau validate/score nên bài không hợp lệ không tiêu lượt.
    quota_used = await service.reserve_quota_slot(db, membership, quota, now)
    if quota_used is None:
        raise api_error(
            429,
            "SUBMISSION_QUOTA_EXCEEDED",
            "Bạn đã dùng hết lượt nộp bài hôm nay.",
        )

    # Số thứ tự phải có trước khi upload vì nó nằm trong object key (ADR-033); cấp số đặt sau
    # validate/score/quota nên bài không hợp lệ không tiêu số.
    account_slug = await accounts_service.ensure_account_slug(db, account)
    submission_no = await service.allocate_submission_no(db, membership)
    submission_id = ObjectId()
    prediction_key = artifact_storage.prediction_key(
        competition["slug"], account_slug, submission_no
    )
    notebook_key = artifact_storage.notebook_key(
        competition["slug"], account_slug, submission_no
    )
    document = {
        "_id": submission_id,
        "competition_id": competition["_id"],
        "account_id": account["_id"],
        "submission_no": submission_no,
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
                # Hash chốt ngay lúc nộp: worker đối chiếu lại bytes đã lưu với nó trước khi kiểm,
                # nên artifact bị thay ngoài luồng không bao giờ được đem ra kết luận.
                "sha256": hashlib.sha256(notebook_data).hexdigest(),
            },
        },
        "status": "completed",
        "metrics": scored.metrics,
        "primary_score": scored.primary_score,
        "created_at": now,
    }
    if scored.scoring_ref is not None:
        # Vân tay của lượt chấm v2: đối chiếu lại được bài nộp với đúng bộ chấm đã sinh ra điểm.
        document["scoring_ref"] = scored.scoring_ref
    try:
        snapshot, projection = await _ai_state(db, competition, settings, now)
        if snapshot is not None:
            document["content_snapshot"] = snapshot
        if projection is not None:
            document["ai_review"] = projection
        await _upload(
            prediction_key, data, ARTIFACT_MEDIA_TYPES[PREDICTION_ARTIFACT], competition, account
        )
        try:
            await artifact_storage.put_bytes(
                notebook_key, notebook_data, ARTIFACT_MEDIA_TYPES[NOTEBOOK_ARTIFACT]
            )
        except artifact_storage.ArtifactStorageUnavailable:
            logger.exception(
                "Notebook upload failed competition=%s account=%s",
                competition["_id"],
                account["_id"],
            )
            await _cleanup(prediction_key)
            raise _storage_unavailable()
        try:
            await db[service.SUBMISSIONS_COLLECTION].insert_one(document)
        except Exception:
            logger.exception(
                "Cannot persist submission competition=%s account=%s",
                competition["_id"],
                account["_id"],
            )
            await _cleanup(prediction_key, notebook_key)
            raise api_error(500, "SUBMISSION_SAVE_FAILED", "Không thể lưu kết quả bài nộp.")
    except Exception:
        # Bài không ghi được thì trả lại lượt đã giữ, quota không bị tiêu oan.
        await service.release_quota_slot(db, membership, now)
        raise
    if projection is not None and snapshot["state"] == ai_constants.SNAPSHOT_CAPTURED:
        await _wake_worker(db, document, settings, now)
    logger.info(
        "Submission completed competition=%s account=%s submission=%s submission_no=%s",
        competition["_id"],
        account["_id"],
        submission_id,
        submission_no,
    )
    return service.public_submission(
        document, max(quota - quota_used, 0), ai_visible=ai_settings.participant_visible(competition)
    )


async def _ai_state(db, competition: dict, settings, now: datetime) -> tuple[dict | None, dict | None]:
    """Chốt ảnh chụp policy và desired state AI cho bài nộp; không bao giờ chặn việc nộp bài.

    Không chụp được nội dung chỉ làm lượt AI kết thúc ở ERROR: bài vẫn được chấm, vẫn xếp hạng và
    vẫn qua được vòng duyệt của BTC y như khi tính năng AI không tồn tại.
    """
    stored = ai_settings.stored_config(competition)
    if not stored["enabled"]:
        return None, None
    try:
        revision = await content_snapshot.capture_revision(
            db, competition["_id"], settings=settings
        )
    except content_snapshot.SnapshotError as exc:
        logger.warning(
            "AI content snapshot failed competition=%s code=%s", competition["_id"], exc.code
        )
        snapshot = ai_service.failed_snapshot(exc.code, now=now)
    else:
        snapshot = ai_service.captured_snapshot(revision, now=now)
    if not stored["auto_review"]:
        return snapshot, None
    return snapshot, ai_service.initial_projection(
        captured=snapshot["state"] == ai_constants.SNAPSHOT_CAPTURED, now=now
    )


async def _wake_worker(db, document: dict, settings, now: datetime) -> None:
    """Đánh thức worker; hỏng ở đây không được làm hỏng một bài đã ghi thành công.

    Reconciler coi "submission đang chờ mà không có job" là lỗ hổng phải vá, nên job rơi ở đây
    vẫn được tạo ở vòng quét sau.
    """
    try:
        await ai_service.ensure_job(
            db,
            document,
            source=ai_constants.JOB_SOURCE_AUTO,
            now=now,
            max_attempts=settings.ai_review_max_attempts,
        )
    except Exception:
        logger.exception("AI review enqueue failed submission=%s", document["_id"])


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
        ai_visible=ai_settings.participant_visible(competition),
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
    """Nhận cả ObjectId lẫn slug: các endpoint anh em đều nhận slug nên ở đây không được chỉ nhận id."""
    competition = None
    try:
        oid = ObjectId(competition_id)
    except InvalidId:
        pass
    else:
        competition = await db[competitions_service.COMPETITIONS_COLLECTION].find_one(
            {"_id": oid}
        )
    if competition is None:
        competition = await competitions_service.find_competition_by_slug(db, competition_id)
    if competition is None or competition["status"] == "draft":
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    return competition


def _scoring_config(
    competition: dict,
) -> scoring_service.ScoringConfig | models.ScoringConfigV2:
    """Cấu hình chấm đang dùng của cuộc thi: bộ chấm Python của v2, hoặc cấu hình cột cố định của v1."""
    if not competition.get("ground_truth"):
        raise _scoring_not_ready()
    try:
        config_v2 = models.stored_config(competition)
    except Exception:
        config_v2 = None
    if config_v2 is not None:
        return config_v2
    try:
        config = scoring_service.config_from_competition(competition)
    except Exception:
        config = None
    if config is None:
        raise _scoring_not_ready()
    return config


async def _score_or_fail(
    competition: dict, config, data: bytes, *, account: dict
) -> _Scored:
    """Chấm bài nộp, dịch mọi lỗi sang HTTP.

    Lỗi thuộc về file của thí sinh giữ mã riêng để em biết đường sửa; lỗi của cấu hình chấm và của
    bộ chấm là chuyện nội bộ - thí sinh chỉ nhận một câu chung, chi tiết đi vào log.
    """
    try:
        if isinstance(config, models.ScoringConfigV2):
            return await _score_v2(competition, config, data)
        return _score_v1(competition, config, data)
    except ScoringValidationError as exc:
        if exc.code not in _STUDENT_ERROR_CODES:
            logger.error(
                "Scoring unusable competition=%s code=%s message=%s",
                competition["_id"],
                exc.code,
                exc.message,
            )
            raise _scoring_not_ready()
        logger.info(
            "Submission rejected competition=%s account=%s code=%s",
            competition["_id"],
            account["_id"],
            exc.code,
        )
        raise api_error(422, exc.code, exc.message)
    except EvaluatorError as exc:
        logger.error(
            "Evaluator failed competition=%s account=%s code=%s detail=%s",
            competition["_id"],
            account["_id"],
            exc.code,
            exc.detail,
        )
        if exc.code == evaluator_client.UNAVAILABLE:
            raise api_error(
                503, "EVALUATOR_UNAVAILABLE", "Hệ thống chấm đang bận, vui lòng thử lại sau."
            )
        raise api_error(500, "SCORING_FAILED", "Không thể chấm điểm bài nộp.")
    except HTTPException:
        # "Cuộc thi chưa sẵn sàng" đã được dịch sẵn ở tầng đọc file; không bọc lại thành lỗi 500.
        raise
    except Exception:
        logger.exception(
            "Submission scoring failed competition=%s account=%s",
            competition["_id"],
            account["_id"],
        )
        raise api_error(500, "SCORING_FAILED", "Không thể chấm điểm bài nộp.")


def _score_v1(
    competition: dict, config: scoring_service.ScoringConfig, data: bytes
) -> _Scored:
    """Bộ chấm cố định của v1: backend tự tính f1/precision/recall từ cột prediction."""
    ground_truth_data = _read_ground_truth(competition)
    ground_truth = scoring_service.load_ground_truth(ground_truth_data, config)
    result = scoring_service.score_submission(
        data, ground_truth, config, competition["primary_metric"]
    )
    return _Scored(metrics=result.metrics, primary_score=result.primary_score)


async def _score_v2(
    competition: dict, config: models.ScoringConfigV2, data: bytes
) -> _Scored:
    """Bộ chấm Python của admin: backend kiểm dữ liệu, gọi runner rồi đối chiếu hợp đồng metric."""
    source = _read_evaluator_source(competition, config)
    ground_truth_data = _read_ground_truth(competition)
    evaluation = await execution.evaluate(
        config,
        source=source,
        ground_truth_data=ground_truth_data,
        submission_data=data,
    )
    if config.output_contract is None:
        raise ScoringValidationError("SCORING_TEST_REQUIRED", "Cuộc thi chưa khai báo metric.")
    return _Scored(
        metrics=evaluation.metrics,
        primary_score=output_validation.primary_score(
            evaluation.metrics, config.output_contract
        ),
        scoring_ref={
            "version": 2,
            "revision": config.revision,
            "config_fingerprint": evaluation.config_fingerprint,
            "source_sha256": config.evaluator.source_sha256,
            "ground_truth_sha256": revisions.sha256_bytes(ground_truth_data),
            "submission_sha256": revisions.sha256_bytes(data),
            "runtime_id": evaluation.runtime_id,
        },
    )


def _read_evaluator_source(competition: dict, config: models.ScoringConfigV2) -> str:
    """Source đã xác minh lúc publish phải đúng là source đang chạy."""
    try:
        raw = scoring_storage.read_evaluator_source(config.evaluator)
        source = raw.decode("utf-8")
    except (KeyError, OSError, ValueError, UnicodeDecodeError):
        logger.error("Evaluator source unreadable competition=%s", competition["_id"])
        raise _scoring_not_ready()
    if revisions.sha256_bytes(raw) != config.evaluator.source_sha256:
        logger.error("Evaluator source changed competition=%s", competition["_id"])
        raise _scoring_not_ready()
    return source


def _read_ground_truth(competition: dict) -> bytes:
    """Ground truth đang dùng; khác bản đã xác minh lúc publish cũng là cuộc thi không còn sẵn sàng."""
    try:
        data = scoring_storage.read_ground_truth(competition)
    except (KeyError, OSError, ValueError):
        raise _scoring_not_ready()
    stored_sha = (competition.get("ground_truth") or {}).get("sha256")
    if stored_sha and stored_sha != revisions.sha256_bytes(data):
        logger.error("Ground truth changed competition=%s", competition["_id"])
        raise _scoring_not_ready()
    return data


def _scoring_not_ready():
    return api_error(422, "SCORING_NOT_READY", SCORING_NOT_READY_MESSAGE)


async def _read_limited(file: UploadFile, limit_mb: int) -> bytes:
    limit = limit_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise api_error(413, "FILE_TOO_LARGE", f"File vượt quá giới hạn {limit_mb} MiB.")
    return data


def _safe_original_filename(filename: str | None, fallback: str) -> str:
    safe_name = Path((filename or fallback).replace("\\", "/")).name
    return safe_name[:255] or fallback
