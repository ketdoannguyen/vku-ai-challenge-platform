"""Participant submission upload (CSV + notebook), validation, scoring and persistence."""

import hashlib
import logging
from datetime import datetime, timezone
from pathlib import Path

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, File, HTTPException, Query, Request, Response, UploadFile

from app.accounts import service as accounts_service
from app.ai_review import service as ai_service
from app.ai_review import settings as ai_settings
from app.auth.dependencies import CurrentAccount
from app.competitions import service as competitions_service
from app.core.config import get_settings
from app.core.datetimes import as_utc
from app.core.errors import api_error
from app.memberships.service import get_membership
from app.scoring import contracts, evaluator_client, models
from app.scoring import service as scoring_service
from app.scoring.errors import EvaluatorError, ScoringValidationError
from app.scoring_attempts import service as attempts_service
from app.scoring_attempts import store as attempts_store
from app.submission_artifacts import storage as artifact_storage
from app.submission_artifacts import validation as artifact_validation
from app.submission_artifacts.naming import (
    NOTEBOOK_ARTIFACT,
    PREDICTION_ARTIFACT,
    ARTIFACT_MEDIA_TYPES,
    safe_original_filename,
)
from app.submissions import artifacts as artifacts_reader
from app.submissions import scoring as scoring_flow
from app.submissions import service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/competitions")

# Một lần nhấn Nút của thí sinh là một `Idempotency-Key`; gửi lại cùng key nhận đúng lượt cũ.
IDEMPOTENCY_HEADER = "Idempotency-Key"
MAX_IDEMPOTENCY_KEY = 128


@router.post("/{competition_id}/submissions", status_code=201)
async def submit_submission(
    competition_id: str,
    request: Request,
    response: Response,
    account: CurrentAccount,
    file: UploadFile = File(...),
    notebook: UploadFile = File(...),
) -> dict:
    """Nhận bài nộp: bộ chấm cố định (v1) chấm ngay trong request, bộ chấm Python (v2) vào hàng đợi."""
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

    if isinstance(config, models.ScoringConfigV2):
        return await _submit_queued(
            db,
            request,
            response,
            competition=competition,
            account=account,
            membership=membership,
            config=config,
            data=data,
            notebook_data=notebook_data,
            csv_filename=file.filename,
            notebook_filename=notebook.filename,
            now=now,
        )
    return await _submit_scored(
        db,
        competition=competition,
        account=account,
        membership=membership,
        config=config,
        data=data,
        notebook_data=notebook_data,
        csv_filename=file.filename,
        notebook_filename=notebook.filename,
        quota=quota,
        now=now,
    )


async def _submit_scored(
    db,
    *,
    competition: dict,
    account: dict,
    membership: dict,
    config,
    data: bytes,
    notebook_data: bytes,
    csv_filename: str | None,
    notebook_filename: str | None,
    quota: int,
    now: datetime,
) -> dict:
    """Đường v1: chấm ngay trong request rồi ghi bài nộp, trả về kết quả luôn."""
    settings = get_settings()
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
                "original_filename": safe_original_filename(csv_filename, "submission.csv"),
                "size_bytes": len(data),
            },
            NOTEBOOK_ARTIFACT: {
                "object_key": notebook_key,
                "original_filename": safe_original_filename(
                    notebook_filename, "notebook.ipynb"
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
        snapshot, projection = await ai_service.plan_submission_state(
            db, competition, settings=settings, now=now
        )
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
    await ai_service.wake_worker(db, document, settings=settings, now=now)
    logger.info(
        "Submission completed competition=%s account=%s submission=%s submission_no=%s",
        competition["_id"],
        account["_id"],
        submission_id,
        submission_no,
    )
    return service.public_submission(
        document,
        max(quota - quota_used, 0),
        ai_visible=ai_settings.participant_visible(competition),
        contract=contracts.participant_contract(competition),
    )


async def _submit_queued(
    db,
    request: Request,
    response: Response,
    *,
    competition: dict,
    account: dict,
    membership: dict,
    config: models.ScoringConfigV2,
    data: bytes,
    notebook_data: bytes,
    csv_filename: str | None,
    notebook_filename: str | None,
    now: datetime,
) -> dict:
    """Đường v2: đưa lượt vào hàng đợi rồi trả 202 ngay.

    Client gửi `Idempotency-Key` cho mỗi lần nhấn Nút: gửi lại cùng key (mất mạng, bấm lần hai)
    nhận đúng lượt cũ chứ không tạo lượt mới và không tiêu thêm quota. Kết quả đến sau, client theo
    dõi bằng `attempt_id`.
    """
    if config.output_contract is None:
        # Bản nháp chưa khai báo metric: không có gì để đối chiếu, vào hàng đợi cũng chỉ để hỏng.
        raise scoring_flow.scoring_not_ready()
    key = (request.headers.get(IDEMPOTENCY_HEADER) or "").strip()
    if not key or len(key) > MAX_IDEMPOTENCY_KEY:
        raise api_error(
            400,
            "IDEMPOTENCY_KEY_REQUIRED",
            f"Thiếu header {IDEMPOTENCY_HEADER} cho lần nộp này.",
        )
    try:
        scoring_flow.validate_submission_csv(competition, config, data)
    except ScoringValidationError as exc:
        logger.info(
            "Submission rejected competition=%s account=%s code=%s",
            competition["_id"],
            account["_id"],
            exc.code,
        )
        raise api_error(422, exc.code, exc.message)
    try:
        attempt = await attempts_service.admit(
            db,
            competition=competition,
            account=account,
            membership=membership,
            data=data,
            notebook_data=notebook_data,
            csv_filename=csv_filename,
            notebook_filename=notebook_filename,
            idempotency_key=key,
            received_at=getattr(request.state, "received_at", now),
            now=now,
        )
    except artifact_storage.ArtifactStorageUnavailable:
        # Lượt đã được đóng và hoàn quota bên trong; ở đây chỉ còn dịch thành lời cho thí sinh.
        raise _storage_unavailable()
    response.status_code = 202
    return await attempts_service.attempt_payload(
        db, attempt, competition=competition, account=account, now=now
    )


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
        contract=contracts.participant_contract(competition),
    )
    return {"submissions": submissions, "total": total, "limit": limit, "offset": offset}


@router.get("/{competition_id}/submissions/attempts")
async def my_active_attempts(
    competition_id: str, request: Request, account: CurrentAccount
) -> dict:
    """Các lượt chưa kết thúc của chính mình.

    Trang nộp bài gọi endpoint này lúc mở lại: đóng tab hay mất mạng giữa chừng thì lượt vẫn còn,
    thí sinh thấy lại đúng lượt đang chờ thay vì phải nộp lần nữa.
    """
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    now = datetime.now(timezone.utc)
    attempts = await attempts_store.list_active(db, competition["_id"], account["_id"])
    return {
        "attempts": [
            await attempts_service.attempt_payload(
                db, attempt, competition=competition, account=account, now=now
            )
            for attempt in attempts
        ]
    }


@router.get("/{competition_id}/submissions/attempts/{attempt_id}")
async def my_attempt_status(
    competition_id: str, attempt_id: str, request: Request, account: CurrentAccount
) -> dict:
    """Trạng thái một lượt chấm: hàng đợi, đang chạy, kết quả hoặc lý do không thành công."""
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    attempt = await _own_attempt_or_404(db, competition, account, attempt_id)
    return await attempts_service.attempt_payload(
        db, attempt, competition=competition, account=account, now=datetime.now(timezone.utc)
    )


async def _own_attempt_or_404(db, competition: dict, account: dict, attempt_id: str) -> dict:
    try:
        oid = ObjectId(attempt_id)
    except InvalidId:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy lượt chấm.")
    attempt = await attempts_store.get(db, oid)
    if (
        attempt is None
        or attempt["competition_id"] != competition["_id"]
        or attempt["account_id"] != account["_id"]
    ):
        raise api_error(404, "NOT_FOUND", "Không tìm thấy lượt chấm.")
    return attempt


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
        raise scoring_flow.scoring_not_ready()
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
        raise scoring_flow.scoring_not_ready()
    return config


async def _score_or_fail(
    competition: dict, config, data: bytes, *, account: dict
) -> scoring_flow.Scored:
    """Chấm bài nộp, dịch mọi lỗi sang HTTP.

    Lỗi thuộc về file của thí sinh giữ mã riêng để em biết đường sửa; lỗi của cấu hình chấm và của
    bộ chấm là chuyện nội bộ - thí sinh chỉ nhận một câu chung, chi tiết đi vào log.
    """
    try:
        if isinstance(config, models.ScoringConfigV2):
            return await scoring_flow.score_v2(competition, config, data)
        return scoring_flow.score_v1(competition, config, data)
    except ScoringValidationError as exc:
        if exc.code not in scoring_flow.STUDENT_ERROR_CODES:
            logger.error(
                "Scoring unusable competition=%s code=%s message=%s",
                competition["_id"],
                exc.code,
                exc.message,
            )
            raise scoring_flow.scoring_not_ready()
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


async def _read_limited(file: UploadFile, limit_mb: int) -> bytes:
    limit = limit_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise api_error(413, "FILE_TOO_LARGE", f"File vượt quá giới hạn {limit_mb} MiB.")
    return data
