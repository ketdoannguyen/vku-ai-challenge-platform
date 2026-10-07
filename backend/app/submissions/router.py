"""Participant submission upload (CSV + notebook), validation, scoring and persistence."""

import hashlib
import logging
from datetime import datetime, timezone
from pathlib import Path

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, File, Form, HTTPException, Query, Request, Response, UploadFile

from app.accounts import service as accounts_service
from app.ai_review import service as ai_service
from app.ai_review import settings as ai_settings
from app.auth.dependencies import CurrentAccount
from app.competitions import service as competitions_service
from app.competitions import tracks as competition_tracks
from app.competitions.access import require_read_access
from app.core.config import get_settings
from app.core.datetimes import as_utc
from app.core.errors import api_error
from app.memberships.service import get_membership
from app.leaderboard import service as leaderboard_service
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
    track: str | None = Form(None),
) -> dict:
    """Nhận bài nộp: bộ chấm cố định (v1) chấm ngay trong request, bộ chấm Python (v2) vào hàng đợi.

    Cuộc thi dual nhận thêm `track` bắt buộc: mỗi bài thuộc đúng một nhánh với lịch, quota và
    ground truth riêng; client cũ nộp thiếu track bị từ chối chứ không đoán nhánh.
    """
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    try:
        resolved_track = competition_tracks.resolve_track(competition, track)
    except competition_tracks.TrackError as exc:
        raise api_error(422, exc.code, exc.message)
    if competition["status"] != "published":
        raise api_error(422, "SUBMISSION_CLOSED", "Cuộc thi hiện không nhận bài nộp.")

    membership = await get_membership(db, competition["_id"], account["_id"])
    if membership is None:
        raise api_error(403, "MEMBERSHIP_REQUIRED", "Bạn chưa tham gia cuộc thi này.")
    if not membership.get("active", True):
        raise api_error(403, "MEMBERSHIP_INACTIVE", "Quyền tham gia cuộc thi đã bị vô hiệu hóa.")

    now = datetime.now(timezone.utc)
    if resolved_track is None:
        if now < as_utc(competition["start_at"]):
            raise api_error(422, "SUBMISSION_NOT_OPEN", "Cuộc thi chưa mở nhận bài.")
        if now > as_utc(competition["end_at"]):
            raise api_error(422, "SUBMISSION_DEADLINE_PASSED", "Đã hết hạn nộp bài.")
    else:
        window = competition_tracks.window_state(competition, resolved_track, now)
        if window == competition_tracks.WINDOW_SCHEDULED:
            raise api_error(422, "SUBMISSION_NOT_OPEN", "Nhánh này chưa mở nhận bài.")
        if window == competition_tracks.WINDOW_CLOSED:
            raise api_error(422, "SUBMISSION_DEADLINE_PASSED", "Nhánh này đã hết hạn nộp bài.")

    config = _scoring_config(competition, resolved_track)
    quota = competition_tracks.track_quota(competition, resolved_track)
    # Chặn sớm cho khỏi chấm điểm khi đã hết lượt; đây chỉ là đường nhanh vì phép đếm không nguyên
    # tử. Cổng chặn thật là `reserve_quota_slot` ngay trước khi upload.
    completed_today = await service.completed_today_count(
        db, competition["_id"], account["_id"], now, track=resolved_track
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
            track=resolved_track,
            now=now,
        )
    if resolved_track is not None:
        return await _submit_inline(
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
            track=resolved_track,
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
    document = _submission_document(
        submission_id=submission_id,
        competition=competition,
        account=account,
        submission_no=submission_no,
        prediction_key=prediction_key,
        notebook_key=notebook_key,
        data=data,
        notebook_data=notebook_data,
        csv_filename=csv_filename,
        notebook_filename=notebook_filename,
        scored=scored,
        created_at=now,
    )
    try:
        await _store_submission(
            db,
            competition=competition,
            account=account,
            data=data,
            notebook_data=notebook_data,
            document=document,
            prediction_key=prediction_key,
            notebook_key=notebook_key,
            scored=scored,
            now=now,
        )
    except Exception:
        # Bài không ghi được thì trả lại lượt đã giữ, quota không bị tiêu oan.
        await service.release_quota_slot(db, membership, now)
        raise
    await ai_service.wake_worker(db, document, settings=get_settings(), now=now)
    # Bài vừa ghi đổi mặt bằng BXH của cả cuộc thi: bỏ bản đang cache để lượt xem kế tiếp thấy ngay.
    leaderboard_service.invalidate_competition(competition["_id"])
    logger.info(
        "Submission completed competition=%s account=%s submission=%s submission_no=%s",
        competition["_id"],
        account["_id"],
        submission_id,
        submission_no,
    )
    # Chấm v1 có thể lâu: admin vừa ẩn BXH/metric giữa chừng thì response phải theo trạng thái hiện
    # tại, không lấy cờ hiển thị chụp từ đầu request.
    current = await _competition_or_404(db, competition["_id"])
    return service.public_submission(
        document,
        max(quota - quota_used, 0),
        competition=current,
        ai_visible=ai_settings.participant_visible(current),
        contract=contracts.participant_contract(current),
    )


async def _submit_inline(
    db,
    request: Request,
    response: Response,
    *,
    competition: dict,
    account: dict,
    membership: dict,
    config,
    data: bytes,
    notebook_data: bytes,
    csv_filename: str | None,
    notebook_filename: str | None,
    track: str,
    now: datetime,
) -> dict:
    """Đường dual-v1: chấm ngay trong request nhưng qua đủ intent, quota và cổng admission.

    File được chấm trước khi tiêu quota - file sai là lỗi thí sinh sửa được và không được tính
    lượt; kết quả chấm được dùng lại cho bước ghi nên không có lần chấm thứ hai. Sau admission,
    lượt là của request này: ghi bài xong mới đóng lượt, hỏng ở đâu cũng đóng lượt và hoàn suất.
    """
    scored = await _score_or_fail(competition, config, data, account=account, track=track)
    key = _idempotency_key(request)
    attempt, replayed = await attempts_service.admit_inline(
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
        track=track,
    )
    if replayed:
        return await _inline_result(
            db, response, attempt, competition=competition, account=account, now=now
        )
    settings = get_settings()
    started = await attempts_store.begin_inline(
        db, attempt, now=now, lease_seconds=settings.scoring_lease_seconds
    )
    if started is None:
        # Reconciler đã đóng lượt trước khi request kịp bắt đầu chấm: trả nguyên trạng thái lượt,
        # không chấm và không ghi bài cho một lượt đã bị hủy.
        current = await attempts_store.get(db, attempt["_id"]) or attempt
        return await _inline_result(
            db, response, current, competition=competition, account=account, now=now
        )

    account_slug = await accounts_service.ensure_account_slug(db, account)
    submission_no = await service.allocate_submission_no(db, membership)
    prediction_key = artifact_storage.prediction_key(
        competition["slug"], account_slug, submission_no
    )
    notebook_key = artifact_storage.notebook_key(
        competition["slug"], account_slug, submission_no
    )
    admission = started.get("admission") or {}
    document = _submission_document(
        submission_id=started["_id"],
        competition=competition,
        account=account,
        submission_no=submission_no,
        prediction_key=prediction_key,
        notebook_key=notebook_key,
        data=data,
        notebook_data=notebook_data,
        csv_filename=csv_filename,
        notebook_filename=notebook_filename,
        scored=scored,
        # Thời điểm thí sinh nhấn Nút, không phải lúc chấm xong - cùng mốc với suất quota đã giữ.
        created_at=started["created_at"],
    )
    document["track"] = track
    document["admitted_at"] = admission.get("admitted_at")
    document["admitted_end_at"] = admission.get("admitted_end_at")
    try:
        await _store_submission(
            db,
            competition=competition,
            account=account,
            data=data,
            notebook_data=notebook_data,
            document=document,
            prediction_key=prediction_key,
            notebook_key=notebook_key,
            scored=scored,
            now=now,
        )
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        await attempts_service.fail(
            db,
            started,
            code=detail.get("code") or "SUBMISSION_SAVE_FAILED",
            message=detail.get("message") or attempts_service.GENERIC_MESSAGE,
            now=now,
        )
        raise
    await attempts_store.complete(db, started, now=now)
    await ai_service.wake_worker(db, document, settings=settings, now=now)
    leaderboard_service.invalidate_competition(competition["_id"])
    logger.info(
        "Submission completed competition=%s account=%s submission=%s submission_no=%s track=%s",
        competition["_id"],
        account["_id"],
        started["_id"],
        submission_no,
        track,
    )
    current = await _competition_or_404(db, competition["_id"])
    return service.public_submission(
        document,
        await attempts_service.remaining_quota(db, current, account, now, track=track),
        competition=current,
        ai_visible=ai_settings.participant_visible(current),
        contract=contracts.participant_contract(current),
        now=now,
    )


async def _inline_result(
    db, response: Response, attempt: dict, *, competition: dict, account: dict, now: datetime
) -> dict:
    """Kết quả của một lượt inline đã có sẵn: bài đã ghi thì trả bài, còn lại trả trạng thái lượt.

    Dùng cho cả lần gửi lại cùng idempotency key lẫn lượt bị đối soát đóng trước khi request kịp
    chấm - hai trường hợp đều không được chấm lần hai.
    """
    if attempt["status"] == attempts_store.STATUS_COMPLETED:
        submission = await db[service.SUBMISSIONS_COLLECTION].find_one({"_id": attempt["_id"]})
        if submission is not None:
            return service.public_submission(
                submission,
                await attempts_service.remaining_quota(
                    db, competition, account, now, track=attempt.get("track")
                ),
                competition=competition,
                ai_visible=ai_settings.participant_visible(competition),
                contract=contracts.participant_contract(competition),
                now=now,
            )
    response.status_code = 202
    return await attempts_service.attempt_payload(
        db, attempt, competition=competition, account=account, now=now
    )


def _submission_document(
    *,
    submission_id,
    competition: dict,
    account: dict,
    submission_no: int,
    prediction_key: str,
    notebook_key: str,
    data: bytes,
    notebook_data: bytes,
    csv_filename: str | None,
    notebook_filename: str | None,
    scored: scoring_flow.Scored,
    created_at: datetime,
) -> dict:
    """Document bài nộp dùng chung cho cả hai đường ghi; phần riêng của dual được thêm sau."""
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
        "created_at": created_at,
    }
    if scored.scoring_ref is not None:
        # Vân tay của lượt chấm v2: đối chiếu lại được bài nộp với đúng bộ chấm đã sinh ra điểm.
        document["scoring_ref"] = scored.scoring_ref
    return document


async def _store_submission(
    db,
    *,
    competition: dict,
    account: dict,
    data: bytes,
    notebook_data: bytes,
    document: dict,
    prediction_key: str,
    notebook_key: str,
    scored: scoring_flow.Scored,
    now: datetime,
) -> None:
    """Chụp AI/norm vào document rồi đẩy hai file lên kho và ghi bài nộp.

    Document phải đủ trước lượt upload đầu tiên: ghi được file mà chưa có snapshot nghĩa là bài
    nộp không bao giờ nhận lại được ảnh chụp của đúng thời điểm nộp.
    """
    snapshot, projection = await ai_service.plan_submission_state(
        db, competition, settings=get_settings(), now=now, track=document.get("track")
    )
    if snapshot is not None:
        document["content_snapshot"] = snapshot
    if projection is not None:
        document["ai_review"] = projection
    norm_snapshot = await service.normalization_snapshot(
        db,
        competition,
        track=document.get("track"),
        raw=scored.primary_score,
        now=now,
    )
    if norm_snapshot is not None:
        document["normalization_snapshot"] = norm_snapshot
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
    track: str | None,
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
    key = _idempotency_key(request)
    try:
        scoring_flow.validate_submission_csv(competition, config, data, track=track)
    except ScoringValidationError as exc:
        logger.info(
            "Submission rejected competition=%s account=%s code=%s",
            competition["_id"],
            account["_id"],
            exc.code,
        )
        if exc.code not in scoring_flow.STUDENT_ERROR_CODES:
            raise scoring_flow.scoring_not_ready()
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
            track=track,
        )
    except artifact_storage.ArtifactStorageUnavailable:
        # Lượt đã được đóng và hoàn quota bên trong; ở đây chỉ còn dịch thành lời cho thí sinh.
        raise _storage_unavailable()
    response.status_code = 202
    return await attempts_service.attempt_payload(
        db, attempt, competition=competition, account=account, now=now
    )


def _idempotency_key(request: Request) -> str:
    """Key cho một lần nhấn Nút; bắt buộc với các đường nộp có ghi intent trước khi chấm."""
    key = (request.headers.get(IDEMPOTENCY_HEADER) or "").strip()
    if not key or len(key) > MAX_IDEMPOTENCY_KEY:
        raise api_error(
            400,
            "IDEMPOTENCY_KEY_REQUIRED",
            f"Thiếu header {IDEMPOTENCY_HEADER} cho lần nộp này.",
        )
    return key


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
    """Lịch sử nộp bài của chính mình - thành viên đang hoạt động hoặc admin."""
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    await require_read_access(db, competition, account)
    submissions, total = await service.list_account_submissions(
        db,
        competition["_id"],
        account["_id"],
        competition=competition,
        limit=limit,
        offset=offset,
        ai_visible=ai_settings.participant_visible(competition),
        contract=contracts.participant_contract(competition),
    )
    return {"submissions": submissions, "total": total, "limit": limit, "offset": offset}


@router.get("/{competition_id}/submissions/attempts")
async def my_active_attempts(
    competition_id: str,
    request: Request,
    account: CurrentAccount,
    track: str | None = Query(None),
) -> dict:
    """Các lượt chưa kết thúc của chính mình, lọc theo nhánh khi được chỉ định.

    Trang nộp bài gọi endpoint này lúc mở lại: đóng tab hay mất mạng giữa chừng thì lượt vẫn còn,
    thí sinh thấy lại đúng lượt đang chờ thay vì phải nộp lần nữa. Thành viên đang hoạt động hoặc
    admin - rời cuộc thi là mất quyền xem lượt của chính mình.
    """
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    await require_read_access(db, competition, account)
    if track is not None:
        try:
            competition_tracks.resolve_track(competition, track)
        except competition_tracks.TrackError as exc:
            raise api_error(422, exc.code, exc.message)
    now = datetime.now(timezone.utc)
    attempts = await attempts_store.list_active(
        db, competition["_id"], account["_id"], track=track
    )
    if competition_tracks.is_dual(competition):
        readable = [
            candidate
            for candidate in competition_tracks.TRACKS
            if not competition_tracks.track_locked(competition, candidate, now)
        ]
        # Lượt của nhánh chưa mở (kể cả bản ghi hỏng thiếu `track`) không hiện lại sau khi mở tab.
        attempts = [attempt for attempt in attempts if attempt.get("track") in readable]
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
    await require_read_access(db, competition, account)
    attempt = await _own_attempt_or_404(db, competition, account, attempt_id)
    now = datetime.now(timezone.utc)
    _ensure_track_open(competition, attempt, now)
    return await attempts_service.attempt_payload(
        db, attempt, competition=competition, account=account, now=now
    )


def _ensure_track_open(competition: dict, record: dict, now: datetime) -> None:
    """Chặn lượt/bài của nhánh chưa mở, kể cả với chính chủ và admin trên đường thí sinh.

    Bản ghi dual thiếu `track` là dữ liệu hỏng - fail closed: không có nhánh hợp lệ thì không có
    đường đọc. Đường admin riêng `/api/admin/*` không đi qua đây.
    """
    if not competition_tracks.is_dual(competition):
        return
    track = record.get("track")
    if track is None or competition_tracks.track_locked(competition, track, now):
        raise api_error(
            403,
            "TRACK_NOT_OPEN",
            "Nhánh này chưa mở nhận bài nộp; dữ liệu của nhánh đang tạm khóa.",
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
    """Tải bài của chính mình; bài của người khác luôn là 404 kể cả admin.

    Quyền sở hữu xét trước để không ai dùng mã 403 dò được bài của người khác; sau đó nhánh chưa
    mở chặn cả chủ bài - tệp là thứ không thể thu hồi nên cổng nằm ngay trước khi đọc storage.
    """
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    await require_read_access(db, competition, account)
    submission = await _own_submission_or_404(db, competition, account, submission_id)
    _ensure_track_open(competition, submission, datetime.now(timezone.utc))
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
    competition: dict, track: str | None = None
) -> scoring_service.ScoringConfig | models.ScoringConfigV2:
    """Cấu hình chấm đang dùng của cuộc thi: bộ chấm Python của v2, hoặc cấu hình cột cố định của v1.

    Dual chỉ sẵn sàng khi GT của đúng nhánh đang nộp đã có; GT của nhánh kia không thay thế được.
    """
    if not competition_tracks.track_ground_truth(competition, track):
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
    competition: dict, config, data: bytes, *, account: dict, track: str | None = None
) -> scoring_flow.Scored:
    """Chấm bài nộp, dịch mọi lỗi sang HTTP.

    Lỗi thuộc về file của thí sinh giữ mã riêng để em biết đường sửa; lỗi của cấu hình chấm và của
    bộ chấm nhận thông báo cố định theo mã, chi tiết chỉ đi vào log. `track` chọn đúng ground truth
    của nhánh đang chấm.
    """
    try:
        if isinstance(config, models.ScoringConfigV2):
            return await scoring_flow.score_v2(competition, config, data, track=track)
        return scoring_flow.score_v1(competition, config, data, track=track)
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
            raise api_error(503, exc.code, attempts_service.SYSTEM_ERROR_MESSAGES[exc.code])
        if exc.code in ("SUBMISSION_RULE_VIOLATION", "SUBMISSION_CLASS_ID_INVALID"):
            safe = attempts_service.public_error({
                "code": exc.code, "message": exc.message, "class_info": exc.class_info
            })
            raise api_error(422 if safe["code"].startswith("SUBMISSION_") else 500, safe["code"], safe["message"])
        code = exc.code if exc.code in attempts_service.SYSTEM_ERROR_MESSAGES else "SCORING_FAILED"
        raise api_error(500, code, attempts_service.SYSTEM_ERROR_MESSAGES[code])
    except HTTPException:
        # "Cuộc thi chưa sẵn sàng" đã được dịch sẵn ở tầng đọc file; không bọc lại thành lỗi 500.
        raise
    except Exception:
        logger.exception(
            "Submission scoring failed competition=%s account=%s",
            competition["_id"],
            account["_id"],
        )
        raise api_error(500, "SCORING_FAILED", attempts_service.SYSTEM_ERROR_MESSAGES["SCORING_FAILED"])


async def _read_limited(file: UploadFile, limit_mb: int) -> bytes:
    limit = limit_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise api_error(413, "FILE_TOO_LARGE", f"Tệp vượt quá giới hạn {limit_mb} MiB.")
    return data
