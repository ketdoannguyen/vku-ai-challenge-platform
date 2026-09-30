"""Hàng đợi chấm v2 trên Mongo: trần nhận bài, claim nguyên tử, lease có fencing.

Mongo standalone không có transaction, nên tính đúng đến từ ba thứ: unique index trên
`(cuộc thi, account, idempotency_key)` chặn hai lượt nộp cho cùng một lần nhấn Nút, unique index
trên `queue_slot` là trần hàng đợi - mỗi lượt đang chờ GIỮ một chỗ trong dải 0..capacity-1, không
đếm-rồi-kiểm - và lease token có mặt trong mọi filter ghi nên một worker đã mất lease không thể ghi
đè document của người khác.

`_id` của lượt nộp cũng là `_id` của submission khi lượt đó thành công: một định danh duy nhất cho
cả hai đầu, nên bước đối soát chỉ cần `find_one({"_id": ...})` là biết bài đã ghi hay chưa.
"""

import logging
import secrets
from datetime import datetime, timedelta

from bson import ObjectId
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

logger = logging.getLogger(__name__)

ATTEMPTS_COLLECTION = "scoring_attempts"

STATUS_STAGING = "STAGING"
STATUS_QUEUED = "QUEUED"
STATUS_RUNNING = "RUNNING"
STATUS_RESOLVING = "RESOLVING"
STATUS_COMPLETED = "COMPLETED"
STATUS_FAILED = "FAILED"
STATUS_EXPIRED = "EXPIRED"

# Còn giữ một chỗ trong hàng đợi: đang nhận file hoặc đang chờ tới lượt.
HOLDING_SLOT_STATUSES = (STATUS_STAGING, STATUS_QUEUED)
# Không thuộc về worker nào: chưa ai claim, hoặc đã trả lại cho reconciler đối soát.
UNOWNED_STATUSES = (STATUS_STAGING, STATUS_QUEUED, STATUS_RESOLVING)
# Chưa kết thúc: thí sinh còn phải theo dõi được và reconciler còn phải để mắt.
ACTIVE_STATUSES = (STATUS_STAGING, STATUS_QUEUED, STATUS_RUNNING, STATUS_RESOLVING)
TERMINAL_STATUSES = (STATUS_COMPLETED, STATUS_FAILED, STATUS_EXPIRED)


class QueueFull(Exception):
    """Hàng đợi đã đủ số lượt chờ."""


class AttemptExists(Exception):
    """Idempotency key đã có lượt nộp: trả lại lượt cũ thay vì tạo lượt thứ hai."""

    def __init__(self, attempt: dict) -> None:
        super().__init__("attempt exists")
        self.attempt = attempt


async def ensure_indexes(db) -> None:
    collection = db[ATTEMPTS_COLLECTION]
    # Một lần nhấn Nút chỉ có đúng một lượt, kể cả khi client gửi lại vì mất mạng.
    await collection.create_index(
        [("competition_id", 1), ("account_id", 1), ("idempotency_key", 1)],
        unique=True,
        name="attempt_idempotency_unique",
    )
    # Trần hàng đợi: `queue_slot` chỉ tồn tại khi lượt còn chờ, nên partial index này là thứ chặn
    # hai lượt cùng giữ một chỗ.
    await collection.create_index(
        "queue_slot",
        unique=True,
        name="attempt_queue_slot_unique",
        partialFilterExpression={"queue_slot": {"$exists": True}},
    )
    await collection.create_index(
        [("competition_id", 1), ("account_id", 1), ("created_at", -1), ("_id", -1)]
    )
    await collection.create_index([("status", 1), ("deadline_at", 1)])
    await collection.create_index([("status", 1), ("lease_expires_at", 1)])


def _fence(attempt: dict) -> dict:
    """Filter chỉ khớp khi lượt vẫn thuộc worker đang giữ lease."""
    return {"_id": attempt["_id"], "lease_token": attempt["lease_token"]}


def _claim_filter(attempt: dict) -> dict:
    """Filter để đóng một lượt: worker đang giữ thì khoá theo lease, không ai giữ thì theo trạng thái.

    Lượt không có lease (STAGING, QUEUED vừa được trả về, hoặc RESOLVING) không thuộc về worker nào,
    nên khoá theo trạng thái là đủ để không đóng nhầm một lượt vừa được claim ở nơi khác.
    """
    if attempt.get("lease_token") is None:
        return {"_id": attempt["_id"], "status": {"$in": list(UNOWNED_STATUSES)}}
    return _fence(attempt)


async def find_by_key(db, competition_id, account_id, idempotency_key: str) -> dict | None:
    return await db[ATTEMPTS_COLLECTION].find_one(
        {
            "competition_id": competition_id,
            "account_id": account_id,
            "idempotency_key": idempotency_key,
        }
    )


async def get(db, attempt_id) -> dict | None:
    return await db[ATTEMPTS_COLLECTION].find_one({"_id": attempt_id})


async def list_active(db, competition_id, account_id, *, limit: int = 10) -> list[dict]:
    """Các lượt chưa kết thúc của một account - để trang nộp bài tự khôi phục sau khi mở lại."""
    cursor = (
        db[ATTEMPTS_COLLECTION]
        .find(
            {
                "competition_id": competition_id,
                "account_id": account_id,
                "status": {"$in": list(ACTIVE_STATUSES)},
            }
        )
        .sort([("created_at", -1), ("_id", -1)])
        .limit(limit)
    )
    return [document async for document in cursor]


async def queue_position(db, attempt: dict) -> int:
    """Số thứ tự trong hàng đợi, 1 là lượt được chấm kế tiếp."""
    ahead = await db[ATTEMPTS_COLLECTION].count_documents(
        {
            "status": {"$in": list(HOLDING_SLOT_STATUSES)},
            "created_at": {"$lt": attempt["created_at"]},
        }
    )
    return ahead + 1


async def admit(
    db,
    *,
    attempt_id: ObjectId,
    competition_id,
    account_id,
    membership_id,
    idempotency_key: str,
    payload_sha256: str,
    staging_prefix: str,
    deadline_at: datetime,
    now: datetime,
    capacity: int,
) -> dict:
    """Tạo lượt nộp mới ở trạng thái STAGING và giữ một chỗ trong hàng đợi.

    Chỗ được giữ bằng chính document của lượt: thử lần lượt các số 0..capacity-1, số nào đã có người
    giữ thì nhảy sang số kế. Hết dải nghĩa là hàng đợi đầy - `QueueFull`.

    Người gọi phải giữ suất quota TRƯỚC khi gọi hàm này, nên lượt được tạo ra với `quota_charged`
    bật sẵn; chỉ `clear_quota_claim` mới tắt lại sau khi suất đã được hoàn.
    """
    base = {
        "_id": attempt_id,
        "competition_id": competition_id,
        "account_id": account_id,
        "membership_id": membership_id,
        "idempotency_key": idempotency_key,
        "payload_sha256": payload_sha256,
        "status": STATUS_STAGING,
        # Kho tạm của lượt nằm trong document để bước dọn không cần biết cuộc thi nào.
        "staging_prefix": staging_prefix,
        "deadline_at": deadline_at,
        "created_at": now,
        "updated_at": now,
        "artifacts": {},
        "result": None,
        "error": None,
        "quota_charged": True,
        "submission_no": None,
        "claimed_by": None,
        "lease_token": None,
        "lease_expires_at": None,
    }
    for slot in range(capacity):
        document = {**base, "queue_slot": slot}
        try:
            await db[ATTEMPTS_COLLECTION].insert_one(document)
        except DuplicateKeyError:
            # Có thể là trùng chỗ (thử số kế) hoặc trùng idempotency key (đua với chính client).
            existing = await find_by_key(db, competition_id, account_id, idempotency_key)
            if existing is not None:
                raise AttemptExists(existing)
            continue
        return document
    raise QueueFull()


async def mark_queued(db, attempt: dict, *, now: datetime) -> bool:
    """Chốt lượt đã nhận đủ file; chỉ lượt còn STAGING mới chuyển được."""
    result = await db[ATTEMPTS_COLLECTION].update_one(
        {"_id": attempt["_id"], "status": STATUS_STAGING},
        {"$set": {"status": STATUS_QUEUED, "updated_at": now}},
    )
    return result.modified_count == 1


async def set_artifacts(db, attempt: dict, *, artifacts: dict, now: datetime) -> bool:
    result = await db[ATTEMPTS_COLLECTION].update_one(
        {"_id": attempt["_id"], "status": STATUS_STAGING},
        {"$set": {"artifacts": artifacts, "updated_at": now}},
    )
    return result.modified_count == 1


async def clear_quota_claim(db, attempt: dict, *, now: datetime) -> None:
    """Tắt dấu giữ quota sau khi suất đã được hoàn, để reconciler không hoàn lần thứ hai."""
    await db[ATTEMPTS_COLLECTION].update_one(
        {"_id": attempt["_id"]},
        {"$set": {"quota_charged": False, "updated_at": now}},
    )


async def set_submission_no(db, attempt: dict, submission_no: int, *, now: datetime) -> dict:
    """Ghim số thứ tự submission vào lượt trước khi ghi artifact.

    Số nằm trong object key, nên phải cố định trước khi copy để một lượt ghi lại (sau lỗi mạng)
    không tạo ra bộ object thứ hai.
    """
    return await db[ATTEMPTS_COLLECTION].find_one_and_update(
        {"_id": attempt["_id"]},
        {"$set": {"submission_no": submission_no, "updated_at": now}},
        return_document=ReturnDocument.AFTER,
    )


async def store_result(db, attempt: dict, *, result: dict, now: datetime) -> bool:
    """Lưu kết quả chấm vào lượt TRƯỚC khi ghi submission.

    Có bước này thì một worker chết giữa lúc ghi vẫn để lại đủ dữ liệu cho reconciler hoàn tất lượt
    thay vì phải chấm lại (hoặc đánh mất kết quả đã tốn 30 giây CPU).
    """
    result_ = await db[ATTEMPTS_COLLECTION].update_one(
        _fence(attempt),
        {"$set": {"result": result, "updated_at": now}},
    )
    return result_.matched_count == 1


async def claim_next(db, *, worker_id: str, now: datetime, lease_seconds: int) -> dict | None:
    """Chiếm lượt chờ lâu nhất còn hạn; trả None khi hàng đợi rỗng.

    `$unset queue_slot` nằm trong chính lượt ghi này: chỗ trong hàng đợi được trả lại đúng lúc lượt
    bắt đầu chạy, và vì chỉ là một thao tác trên một document nên không có khe hở ở giữa.
    """
    return await db[ATTEMPTS_COLLECTION].find_one_and_update(
        {"status": STATUS_QUEUED, "deadline_at": {"$gt": now}},
        {
            "$set": {
                "status": STATUS_RUNNING,
                "claimed_by": worker_id,
                "lease_token": secrets.token_hex(16),
                "lease_expires_at": now + timedelta(seconds=lease_seconds),
                "started_at": now,
                "updated_at": now,
            },
            "$unset": {"queue_slot": ""},
        },
        sort=[("created_at", 1), ("_id", 1)],
        return_document=ReturnDocument.AFTER,
    )


async def _finish(
    db, filter_: dict, *, status: str, error: dict | None, now: datetime
) -> bool:
    """Đóng một lượt: trả lại chỗ hàng đợi, xoá lease, ghi lý do nếu có."""
    result = await db[ATTEMPTS_COLLECTION].update_one(
        filter_,
        {
            "$set": {
                "status": status,
                "error": error,
                "finished_at": now,
                "updated_at": now,
                "claimed_by": None,
                "lease_token": None,
                "lease_expires_at": None,
            },
            "$unset": {"queue_slot": ""},
        },
    )
    return result.matched_count == 1


async def fail(db, attempt: dict, *, error: dict, now: datetime) -> bool:
    """Đóng một lượt thất bại: hỏng lúc nhận file hay lúc chấm đều đi qua đây."""
    return await _finish(db, _claim_filter(attempt), status=STATUS_FAILED, error=error, now=now)


async def expire(db, attempt: dict, *, error: dict, now: datetime) -> bool:
    """Quá hạn 60 giây: đóng lượt dù đang chờ hay đang chấm."""
    return await _finish(db, _claim_filter(attempt), status=STATUS_EXPIRED, error=error, now=now)


async def complete(db, attempt: dict, *, now: datetime) -> bool:
    """Đóng lượt thành công; lượt đang RESOLVING cũng đi qua đây khi reconciler thấy bài đã ghi."""
    return await _finish(
        db, _claim_filter(attempt), status=STATUS_COMPLETED, error=None, now=now
    )


async def requeue(db, attempt: dict, *, now: datetime) -> bool:
    """Trả một lượt mất lease về hàng đợi khi vẫn còn kịp chấm.

    Lượt này đã tiêu chỗ hàng đợi của nó từ lúc được claim, nên không giữ chỗ mới: trần 20 chỗ là
    trần của các lượt CHỜ ĐƯỢC NHẬN, không phải của các lượt đang được chấm lại.
    """
    result = await db[ATTEMPTS_COLLECTION].update_one(
        {"_id": attempt["_id"], "lease_token": attempt["lease_token"]},
        {
            "$set": {
                "status": STATUS_QUEUED,
                "claimed_by": None,
                "lease_token": None,
                "lease_expires_at": None,
                "updated_at": now,
            }
        },
    )
    return result.matched_count == 1


async def mark_resolving(db, attempt: dict, *, error: dict, now: datetime) -> bool:
    """Kết quả ghi chưa xác định: giữ lượt lại cho reconciler, không báo thất bại vội."""
    result = await db[ATTEMPTS_COLLECTION].update_one(
        _fence(attempt),
        {
            "$set": {
                "status": STATUS_RESOLVING,
                "error": error,
                "claimed_by": None,
                "lease_token": None,
                "lease_expires_at": None,
                "updated_at": now,
            }
        },
    )
    return result.matched_count == 1


async def overdue(db, *, now: datetime, limit: int) -> list[dict]:
    """Lượt còn giữ chỗ mà đã quá hạn: không còn kịp chấm trong 60 giây nữa."""
    cursor = db[ATTEMPTS_COLLECTION].find(
        {
            "status": {"$in": list(HOLDING_SLOT_STATUSES)},
            "deadline_at": {"$lt": now},
        },
        limit=limit,
    )
    return [document async for document in cursor]


async def abandoned(db, *, now: datetime, limit: int) -> list[dict]:
    """Lượt đang chạy mà lease đã hết: worker giữ nó đã chết hoặc mất kết nối."""
    cursor = db[ATTEMPTS_COLLECTION].find(
        {"status": STATUS_RUNNING, "lease_expires_at": {"$lt": now}},
        limit=limit,
    )
    return [document async for document in cursor]


async def resolving(db, *, limit: int) -> list[dict]:
    """Lượt đang chờ đối soát kết quả ghi."""
    cursor = db[ATTEMPTS_COLLECTION].find({"status": STATUS_RESOLVING}, limit=limit)
    return [document async for document in cursor]


async def refundable(db, *, limit: int) -> list[dict]:
    """Lượt đã kết thúc thất bại nhưng quota chưa được trả lại (crash giữa hai bước)."""
    cursor = db[ATTEMPTS_COLLECTION].find(
        {
            "status": {"$in": [STATUS_FAILED, STATUS_EXPIRED]},
            "quota_charged": True,
        },
        limit=limit,
    )
    return [document async for document in cursor]
