"""Nhận bài nộp v2 vào hàng đợi và trả lời trạng thái của một lượt chấm.

Một lượt nộp v2 đi qua ba bước có thứ tự: giữ một suất quota (một document membership), chiếm một
chỗ trong hàng đợi (một document attempt), rồi cất file vào kho tạm. Hỏng ở bước nào thì bước trước
được trả lại, và lượt không bao giờ tồn tại nếu chưa có chỗ trong hàng đợi.

Lỗi thí sinh nhìn thấy được dịch ngay ở đây thành HTTP; lỗi còn lại đi ra ngoài dưới dạng exception
của tầng dữ liệu (`ArtifactStorageUnavailable`) để router quyết định mã trả về.
"""

import hashlib
import logging
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.ai_review import settings as ai_settings
from app.competitions import admission as admission_gate
from app.competitions import tracks as competition_tracks
from app.core.config import get_settings
from app.core.datetimes import iso_z
from app.core.errors import api_error
from app.memberships.service import MEMBERSHIPS_COLLECTION
from app.scoring import contracts
from app.scoring_attempts import store
from app.submission_artifacts import storage as artifact_storage
from app.submission_artifacts.naming import (
    ARTIFACT_MEDIA_TYPES,
    NOTEBOOK_ARTIFACT,
    PREDICTION_ARTIFACT,
    safe_original_filename,
)
from app.submissions import scoring as scoring_flow
from app.submissions import service as submissions_service

logger = logging.getLogger(__name__)

EXPIRED_CODE = "SUBMISSION_EXPIRED"
EXPIRED_MESSAGE = "Bài nộp quá hạn chờ chấm nên không bị tính lượt. Bạn hãy nộp lại."
# Lệnh đóng quản trị hủy lượt đã nhận nhưng chưa chấm; lượt bị hủy không bị tính vào hạn mức.
CANCELLED_CODE = "SUBMISSION_CANCELLED"
CANCELLED_MESSAGE = "Cuộc thi đã đóng nên lượt nộp này không được chấm. Lượt không bị tính."
GENERIC_MESSAGE = "Không thể chấm điểm bài nộp này."
SUBMISSION_RULE_MESSAGE = (
    "CSV không đáp ứng quy tắc nộp bài của cuộc thi. "
    "Hãy đối chiếu với yêu cầu về file nộp và dữ liệu trong đề bài rồi nộp lại."
)
QUEUE_FULL_MESSAGE = "Hàng đợi chấm điểm đang đầy. Bạn thử lại sau ít phút nhé."
# Câu chữ của những mã này là thứ thí sinh phải đọc để biết đường làm tiếp: file sai thì sửa file,
# quá hạn thì nộp lại. Mọi mã khác là lỗi hệ thống, quy về một câu chung.
SAFE_ERROR_CODES = scoring_flow.STUDENT_ERROR_CODES | {EXPIRED_CODE, CANCELLED_CODE}


def staging_prefix(competition_slug, attempt_id) -> str:
    """Kho tạm của bài chưa chấm; nằm trong prefix cuộc thi nên dọn cuộc thi là dọn luôn."""
    return f"{artifact_storage.competition_prefix(competition_slug)}staging/scoring/{attempt_id}/"


def payload_fingerprint(data: bytes, notebook_data: bytes) -> str:
    """Vân tay cặp file của một lần nhấn Nút - để phát hiện dùng lại idempotency key cho bài khác."""
    digest = hashlib.sha256()
    digest.update(data)
    digest.update(b"\x00")
    digest.update(notebook_data)
    return digest.hexdigest()


async def admit(
    db,
    *,
    competition: dict,
    account: dict,
    membership: dict,
    data: bytes,
    notebook_data: bytes,
    csv_filename: str | None,
    notebook_filename: str | None,
    idempotency_key: str,
    received_at: datetime,
    now: datetime,
    track: str | None = None,
) -> dict:
    """Nhận một lượt nộp mới vào hàng đợi, hoặc trả lại lượt cũ nếu key này đã dùng.

    Hạn 60 giây tính từ `received_at` - mốc API bắt đầu nhận request - chứ không phải từ lúc file
    đã nằm trên server: thời gian upload cũng là thời gian thí sinh phải chờ.

    Dual giữ suất quota của đúng nhánh rồi qua cổng admission trước khi file vào kho tạm: lượt
    nằm trong hàng đợi luôn có snapshot admission trong intent, nên worker không phải đoán lại
    cửa sổ theo đồng hồ hiện tại.
    """
    fingerprint = payload_fingerprint(data, notebook_data)
    existing = await store.find_by_key(db, competition["_id"], account["_id"], idempotency_key)
    if existing is not None:
        return _replayed(existing, fingerprint, track=track)

    settings = get_settings()
    attempt_id = ObjectId()
    quota_used = await submissions_service.reserve_quota_slot(
        db,
        membership,
        competition_tracks.track_quota(competition, track),
        now,
        track=track,
        attempt_id=str(attempt_id),
    )
    if quota_used is None:
        raise api_error(429, "SUBMISSION_QUOTA_EXCEEDED", "Bạn đã dùng hết lượt nộp bài hôm nay.")
    prefix = staging_prefix(competition["slug"], attempt_id)
    try:
        attempt = await store.admit(
            db,
            attempt_id=attempt_id,
            competition_id=competition["_id"],
            account_id=account["_id"],
            membership_id=membership["_id"],
            idempotency_key=idempotency_key,
            payload_sha256=fingerprint,
            staging_prefix=prefix,
            deadline_at=received_at + timedelta(seconds=settings.scoring_deadline_seconds),
            now=now,
            capacity=settings.scoring_queue_capacity,
            track=track,
        )
    except store.AttemptExists as exc:
        # Đua với chính client: hai request cùng key thì nhường lượt đã có và trả lại suất vừa giữ.
        await submissions_service.release_quota_slot(
            db, membership, now, track=track, attempt_id=str(attempt_id)
        )
        return _replayed(exc.attempt, fingerprint, track=track)
    except store.QueueFull:
        await submissions_service.release_quota_slot(
            db, membership, now, track=track, attempt_id=str(attempt_id)
        )
        raise api_error(503, "SCORING_QUEUE_FULL", QUEUE_FULL_MESSAGE)

    if track is not None:
        await _pin_admission(db, attempt, track=track)

    try:
        await _stage(
            db,
            attempt,
            prefix=prefix,
            data=data,
            notebook_data=notebook_data,
            csv_filename=csv_filename,
            notebook_filename=notebook_filename,
            now=now,
        )
    except artifact_storage.ArtifactStorageUnavailable:
        logger.exception("Không cất được bài vào kho tạm attempt=%s", attempt_id)
        await fail(
            db,
            attempt,
            code="ARTIFACT_STORAGE_UNAVAILABLE",
            message="Không cất được bài nộp.",
            now=now,
        )
        raise
    return await store.get(db, attempt_id)


def _replayed(attempt: dict, fingerprint: str, *, track: str | None) -> dict:
    """Cùng idempotency key: trả lại đúng lượt cũ, trừ khi đó là một bài nộp khác.

    Dual đối chiếu thêm nhánh vì một lần nhấn Nút không thể vừa Public vừa Private; xung đột ở
    cuộc thi dual mang mã riêng theo hợp đồng, single giữ nguyên mã cũ.
    """
    conflict = attempt.get("payload_sha256") != fingerprint or (
        track is not None and attempt.get("track") != track
    )
    if conflict:
        code = "IDEMPOTENCY_CONFLICT" if track is not None else "IDEMPOTENCY_KEY_REUSED"
        raise api_error(409, code, "Mã định danh này đã dùng cho một bài nộp khác.")
    return attempt


async def admit_inline(
    db,
    *,
    competition: dict,
    account: dict,
    membership: dict,
    data: bytes,
    notebook_data: bytes,
    csv_filename: str | None,
    notebook_filename: str | None,
    idempotency_key: str,
    received_at: datetime,
    now: datetime,
    track: str,
) -> tuple[dict, bool]:
    """Nhận một lượt dual-v1 chấm ngay trong request; trả `(lượt, replayed)`.

    Cùng thứ tự với đường queue: giữ quota, ghi intent inline, rồi qua cổng admission - lượt chỉ
    được chấm sau khi snapshot admission nằm trong intent. `replayed=True` nghĩa là key này đã có
    lượt từ trước, người gọi phải trả lại lượt cũ thay vì chấm lần hai.
    """
    fingerprint = payload_fingerprint(data, notebook_data)
    existing = await store.find_by_key(db, competition["_id"], account["_id"], idempotency_key)
    if existing is not None:
        return _replayed(existing, fingerprint, track=track), True

    settings = get_settings()
    attempt_id = ObjectId()
    quota_used = await submissions_service.reserve_quota_slot(
        db,
        membership,
        competition_tracks.track_quota(competition, track),
        now,
        track=track,
        attempt_id=str(attempt_id),
    )
    if quota_used is None:
        raise api_error(429, "SUBMISSION_QUOTA_EXCEEDED", "Bạn đã dùng hết lượt nộp bài hôm nay.")
    try:
        attempt = await store.admit_inline(
            db,
            attempt_id=attempt_id,
            competition_id=competition["_id"],
            account_id=account["_id"],
            membership_id=membership["_id"],
            idempotency_key=idempotency_key,
            payload_sha256=fingerprint,
            deadline_at=received_at + timedelta(seconds=settings.scoring_deadline_seconds),
            now=now,
            track=track,
        )
    except store.AttemptExists as exc:
        await submissions_service.release_quota_slot(
            db, membership, now, track=track, attempt_id=str(attempt_id)
        )
        return _replayed(exc.attempt, fingerprint, track=track), True
    await _pin_admission(db, attempt, track=track)
    # Đọc lại như đường queue: dict trả về phải mang snapshot admission vừa ghim, không phải bản
    # trước khi qua cổng.
    return await store.get(db, attempt_id), False


async def _pin_admission(db, attempt: dict, *, track: str) -> None:
    """Chốt admission của một lượt dual; cửa đã đóng thì lượt bị đóng ngay và quota được hoàn.

    Cổng đọc giờ tại đúng thao tác DB chứ không dùng mốc từ đầu request: upload và chờ quota nằm
    giữa hai thời điểm đó. Trượt lượt ghi snapshot nghĩa là reconciler hoặc lệnh đóng đã kết thúc
    intent trước - lượt không được chấm, và người đóng cũng đã hoàn suất.
    """
    now = datetime.now(timezone.utc)
    admission = await admission_gate.confirm(db, attempt["competition_id"], track, now=now)
    if admission is None:
        code, message = await admission_gate.closed_reason(
            db, attempt["competition_id"], track, now=now
        )
        await fail(db, attempt, code=code, message=message, now=now)
        raise api_error(422, code, message)
    if not await store.set_admission(db, attempt, admission=admission, now=now):
        current = await store.get(db, attempt["_id"]) or attempt
        error = public_error(current.get("error")) or {
            "code": "SUBMISSION_CLOSED",
            "message": "Cuộc thi hiện không nhận bài nộp.",
        }
        raise api_error(422, error["code"], error["message"])


async def _stage(
    db,
    attempt: dict,
    *,
    prefix: str,
    data: bytes,
    notebook_data: bytes,
    csv_filename: str | None,
    notebook_filename: str | None,
    now: datetime,
) -> None:
    """Cất hai file vào kho tạm rồi mới cho lượt vào hàng đợi.

    Thứ tự này là thứ giữ cho worker chỉ việc đọc: một lượt nằm trong hàng đợi luôn có đủ file.
    """
    prediction_key = f"{prefix}{artifact_storage.PREDICTION_OBJECT_NAME}"
    notebook_key = f"{prefix}{artifact_storage.NOTEBOOK_OBJECT_NAME}"
    await artifact_storage.put_bytes(
        prediction_key, data, ARTIFACT_MEDIA_TYPES[PREDICTION_ARTIFACT]
    )
    await artifact_storage.put_bytes(
        notebook_key, notebook_data, ARTIFACT_MEDIA_TYPES[NOTEBOOK_ARTIFACT]
    )
    await store.set_artifacts(
        db,
        attempt,
        artifacts={
            PREDICTION_ARTIFACT: {
                "staging_key": prediction_key,
                "original_filename": safe_original_filename(csv_filename, "submission.csv"),
                "size_bytes": len(data),
            },
            NOTEBOOK_ARTIFACT: {
                "staging_key": notebook_key,
                "original_filename": safe_original_filename(notebook_filename, "notebook.ipynb"),
                "size_bytes": len(notebook_data),
                # Hash chốt ngay lúc nộp: worker đối chiếu lại bytes đã lưu với nó trước khi kiểm,
                # nên artifact bị thay ngoài luồng không bao giờ được đem ra kết luận.
                "sha256": hashlib.sha256(notebook_data).hexdigest(),
            },
        },
        now=now,
    )
    await store.mark_queued(db, attempt, now=now)


async def expire(db, attempt: dict, *, now: datetime) -> bool:
    """Đóng lượt quá hạn 60 giây: lượt không thành công không bao giờ bị tính."""
    return await _close(
        db, attempt, expired=True, code=EXPIRED_CODE, message=EXPIRED_MESSAGE, now=now
    )


async def fail(db, attempt: dict, *, code: str, message: str, now: datetime) -> bool:
    """Đóng một lượt thất bại: hỏng lúc nhận file hay lúc chấm đều đi qua đây."""
    return await _close(db, attempt, expired=False, code=code, message=message, now=now)


async def _close(
    db, attempt: dict, *, expired: bool, code: str, message: str, now: datetime
) -> bool:
    """Đóng lượt không thành công, dọn kho tạm và hoàn quota.

    Trả về False khi lượt đã thuộc về nơi khác (mất lease, hoặc đã bị đối soát đóng trước): người
    đóng được lượt mới là người dọn file và hoàn suất, nên không có chuyện hoàn hai lần hay dọn nhầm
    file mà worker khác đang đọc.
    """
    error = {"code": code, "message": message}
    closed = (
        await store.expire(db, attempt, error=error, now=now)
        if expired
        else await store.fail(db, attempt, error=error, now=now)
    )
    if not closed:
        return False
    await _drop_staging(attempt)
    await refund(db, attempt, now=now)
    return True


async def _drop_staging(attempt: dict) -> None:
    """Bỏ file tạm của lượt không thành công: kho tạm chỉ giữ bài đang chờ hoặc đang chấm."""
    prefix = attempt.get("staging_prefix")
    if prefix:
        await artifact_storage.remove_prefix(prefix)


async def refund(db, attempt: dict, *, now: datetime) -> None:
    """Hoàn suất quota của một lượt đã đóng; gọi lặp không trừ hai lần nhờ dấu trên membership."""
    if not attempt.get("quota_charged"):
        return
    membership = await db[MEMBERSHIPS_COLLECTION].find_one({"_id": attempt["membership_id"]})
    if membership is None:
        return
    await submissions_service.release_quota_slot(
        db, membership, now, track=attempt.get("track"), attempt_id=str(attempt["_id"])
    )
    await store.clear_quota_claim(db, attempt, now=now)


async def attempt_payload(
    db, attempt: dict, *, competition: dict, account: dict, now: datetime
) -> dict:
    """Trạng thái một lượt dưới dạng thí sinh nhìn thấy.

    `_id` của lượt cũng là `_id` của submission khi lượt đó thành công, nên phần kết quả chỉ cần
    một lượt đọc theo đúng định danh đó.
    """
    payload = {
        "attempt_id": str(attempt["_id"]),
        "status": attempt["status"],
        "created_at": iso_z(attempt["created_at"]),
        "deadline_at": iso_z(attempt["deadline_at"]),
        "queue_position": None,
        "error": public_error(attempt.get("error")),
        "submission": None,
    }
    if attempt.get("track") is not None:
        # Nhánh của lượt: biên nhận phải nói đúng nhánh đang chờ, single không có khóa này.
        payload["track"] = attempt["track"]
    if (
        attempt["status"] in store.HOLDING_SLOT_STATUSES
        and attempt.get("execution_kind") != store.EXECUTION_INLINE
    ):
        # Lượt inline chấm ngay trong request nên không có vị trí nào trong hàng đợi để báo.
        payload["queue_position"] = await store.queue_position(db, attempt)
    if attempt["status"] == store.STATUS_COMPLETED:
        submission = await db[submissions_service.SUBMISSIONS_COLLECTION].find_one(
            {"_id": attempt["_id"]}
        )
        if submission is not None:
            payload["submission"] = submissions_service.public_submission(
                submission,
                await remaining_quota(db, competition, account, now, track=attempt.get("track")),
                competition=competition,
                ai_visible=ai_settings.participant_visible(competition),
                contract=contracts.participant_contract(competition),
            )
    return payload


def public_error(error: dict | None) -> dict | None:
    """Lý do một lượt không thành công, ở dạng thí sinh hiểu được.

    Lỗi file của thí sinh và lượt quá hạn giữ nguyên câu chữ; lỗi còn lại - cấu hình chấm hỏng,
    runner bận - quy về một câu chung, còn chi tiết nằm trong log.
    """
    if not error:
        return None
    code = error.get("code") or "SUBMISSION_FAILED"
    if code == "SUBMISSION_RULE_VIOLATION":
        return {"code": code, "message": SUBMISSION_RULE_MESSAGE}
    if code in SAFE_ERROR_CODES:
        return {"code": code, "message": error.get("message") or GENERIC_MESSAGE}
    return {"code": code, "message": GENERIC_MESSAGE}


async def remaining_quota(
    db, competition: dict, account: dict, now: datetime, *, track: str | None = None
) -> int:
    """Lượt còn lại trong ngày UTC của đúng nhánh, đếm theo bài đã chấm xong.

    Cùng nguồn với mọi chỗ hiển thị khác, nên số trên thẻ nhánh và số trong receipt không lệch.
    """
    used = await submissions_service.completed_today_count(
        db, competition["_id"], account["_id"], now, track=track
    )
    return max(competition_tracks.track_quota(competition, track) - used, 0)
