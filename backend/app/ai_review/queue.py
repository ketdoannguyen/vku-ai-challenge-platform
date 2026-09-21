"""Hàng đợi job bền trên Mongo: enqueue, claim nguyên tử, lease có fencing token, heartbeat, retry.

Mongo standalone không có transaction, nên tính đúng đắn đến từ ba thứ: unique index trên
`submission_id`, `find_one_and_update` nguyên tử khi claim, và lease token + generation + run_id có
mặt trong MỌI filter ghi. Một worker đã mất lease không thể ghi đè document job của người khác.

Giới hạn của bảo đảm đó: nó áp cho document job, không áp cho audit row. `ai_reviews` là log chỉ
thêm và khoá duy nhất `(submission_id, generation)` mới là thứ chặn ghi trùng - một worker hết lease
vẫn có thể kịp ghi row cho generation của mình, và row đó là lịch sử hợp lệ của lượt chạy đó.
"""

import logging
import random
import secrets
from datetime import datetime, timedelta

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.ai_review import constants

logger = logging.getLogger(__name__)

JOBS_COLLECTION = "ai_review_jobs"

BACKOFF_BASE_SECONDS = 30
BACKOFF_MAX_SECONDS = 600

# Trần mặc định khi tầng gọi không truyền cấu hình xuống; giá trị thật do `settings` quyết định.
DEFAULT_MAX_ATTEMPTS = 3


async def ensure_indexes(db) -> None:
    # Unique trên `submission_id`: một bài nộp chỉ có đúng một job, nên enqueue đua nhau vẫn an toàn.
    await db[JOBS_COLLECTION].create_index("submission_id", unique=True)
    # Vòng quét của worker luôn lọc theo status rồi sắp theo run_after.
    await db[JOBS_COLLECTION].create_index([("status", 1), ("run_after", 1)])
    # Tìm job RUNNING đã hết lease để thu hồi.
    await db[JOBS_COLLECTION].create_index([("status", 1), ("lease_expires_at", 1)])


def backoff_ceiling(attempt: int) -> int:
    return min(BACKOFF_BASE_SECONDS * 2 ** max(attempt - 1, 0), BACKOFF_MAX_SECONDS)


def next_run_after(attempt: int, now: datetime) -> datetime:
    """Backoff có jitter: nửa khoảng dưới là sàn, nên job không dồn về cùng một thời điểm."""
    ceiling = backoff_ceiling(attempt)
    return now + timedelta(seconds=random.uniform(ceiling / 2, ceiling))


async def ensure_job(db, submission: dict, *, source: str, now: datetime, requested_by=None,
                     bypass_cache: bool = False,
                     max_attempts: int | None = None) -> None:
    """Tạo job cho desired state hiện tại; job cùng generation được giữ nguyên, generation cũ bị reset."""
    projection = submission.get("ai_review") or {}
    generation = projection.get("generation")
    run_id = projection.get("run_id")
    if generation is None or run_id is None:
        raise ValueError("Submission chưa có desired AI state.")

    document = {
        "submission_id": submission["_id"],
        "competition_id": submission["competition_id"],
        "account_id": submission["account_id"],
        "status": constants.JOB_QUEUED,
        "generation": generation,
        "run_id": run_id,
        "attempts": 0,
        "max_attempts": max_attempts or DEFAULT_MAX_ATTEMPTS,
        "run_after": now,
        "claimed_by": None,
        "lease_token": None,
        "lease_expires_at": None,
        "heartbeat_at": None,
        "bypass_cache": bypass_cache,
        "source": source,
        "requested_by": requested_by,
        "requested_at": now,
        "latest_review_id": None,
        "last_error": None,
        "projection_applied": False,
        "created_at": now,
        "updated_at": now,
        "started_at": None,
        "completed_at": None,
    }
    try:
        result = await db[JOBS_COLLECTION].update_one(
            {"submission_id": submission["_id"]},
            {"$setOnInsert": document},
            upsert=True,
        )
    except DuplicateKeyError:
        # Hai lượt enqueue song song: cái thua cuộc nhận ra job đã tồn tại, không phải lỗi.
        result = None
    if result is not None and result.upserted_id is not None:
        return

    existing = await db[JOBS_COLLECTION].find_one({"submission_id": submission["_id"]})
    if existing is None:
        return
    if existing.get("generation") == generation:
        # Job đã đúng generation: việc còn lại chỉ là nâng cờ bypass, để một lượt chạy tay không bị
        # reconciler (vốn giữ cờ cũ) biến thành lượt đọc cache.
        if bypass_cache and not existing.get("bypass_cache"):
            await db[JOBS_COLLECTION].update_one(
                {"_id": existing["_id"], "generation": generation},
                {
                    "$set": {
                        "bypass_cache": True,
                        "source": source,
                        "requested_by": requested_by,
                        "updated_at": now,
                    }
                },
            )
        return
    await reset_job(db, existing, submission, source=source, now=now, requested_by=requested_by,
                    bypass_cache=bypass_cache)


async def reset_job(db, job: dict, submission: dict, *, source: str, now: datetime,
                    requested_by=None, bypass_cache: bool = False) -> bool:
    """Đưa job về hàng đợi cho generation mới của submission (manual rerun hoặc reconcile).

    Ghi có CAS trên generation đã đọc: nếu một actor khác vừa reset job sang generation mới hơn thì
    lượt ghi này thua và không được phép xoá lease của nó.
    """
    projection = submission.get("ai_review") or {}
    result = await db[JOBS_COLLECTION].update_one(
        {"_id": job["_id"], "generation": job.get("generation")},
        {
            "$set": {
                "status": constants.JOB_QUEUED,
                "generation": projection.get("generation"),
                "run_id": projection.get("run_id"),
                "attempts": 0,
                "run_after": now,
                "claimed_by": None,
                "lease_token": None,
                "lease_expires_at": None,
                "heartbeat_at": None,
                "bypass_cache": bypass_cache,
                "source": source,
                "requested_by": requested_by,
                "requested_at": now,
                "latest_review_id": None,
                "last_error": None,
                "projection_applied": False,
                "started_at": None,
                "completed_at": None,
                "updated_at": now,
            }
        },
    )
    # `matched_count`: câu hỏi ở đây là "CAS có thắng không", không phải "bytes có đổi không".
    return result.matched_count == 1


async def claim_next(db, *, worker_id: str, now: datetime, lease_seconds: int) -> dict | None:
    """Chiếm một job QUEUED đã tới hạn; trả document sau khi cập nhật, hoặc None nếu hàng đợi rỗng."""
    return await db[JOBS_COLLECTION].find_one_and_update(
        {"status": constants.JOB_QUEUED, "run_after": {"$lte": now}},
        {
            "$set": {
                "status": constants.JOB_RUNNING,
                "claimed_by": worker_id,
                "lease_token": secrets.token_hex(16),
                "lease_expires_at": now + timedelta(seconds=lease_seconds),
                "heartbeat_at": now,
                "started_at": now,
                "updated_at": now,
            },
            "$inc": {"attempts": 1},
        },
        sort=[("run_after", 1), ("created_at", 1), ("_id", 1)],
        return_document=ReturnDocument.AFTER,
    )


async def heartbeat(db, job: dict, *, now: datetime, lease_seconds: int) -> bool:
    """Gia hạn lease; trả False khi fence không khớp, tức job đã thuộc worker khác.

    Đọc `matched_count` chứ không phải `modified_count`: hai nhịp trong cùng một milli-giây ghi
    đúng cùng giá trị thì Mongo báo không sửa gì, mà mất lease là chuyện khác hẳn.
    """
    result = await db[JOBS_COLLECTION].update_one(
        _fence(job),
        {
            "$set": {
                "heartbeat_at": now,
                "lease_expires_at": now + timedelta(seconds=lease_seconds),
                "updated_at": now,
            }
        },
    )
    return result.matched_count == 1


async def requeue(db, job: dict, *, now: datetime, error: dict) -> bool:
    """Trả job về QUEUED cho lần thử sau; không giữ lease và không sleep trong lúc chờ."""
    result = await db[JOBS_COLLECTION].update_one(
        _fence(job),
        {
            "$set": {
                "status": constants.JOB_QUEUED,
                "run_after": next_run_after(job["attempts"], now),
                "claimed_by": None,
                "lease_token": None,
                "lease_expires_at": None,
                "heartbeat_at": None,
                "last_error": error,
                "updated_at": now,
            }
        },
    )
    return result.modified_count == 1


async def mark_completed(db, job: dict, *, review_id, now: datetime) -> bool:
    result = await db[JOBS_COLLECTION].update_one(
        _fence(job),
        {
            "$set": {
                "status": constants.JOB_COMPLETED,
                "latest_review_id": review_id,
                "projection_applied": True,
                "claimed_by": None,
                "lease_token": None,
                "lease_expires_at": None,
                "heartbeat_at": None,
                "updated_at": now,
                "completed_at": now,
            }
        },
    )
    return result.modified_count == 1


async def force_complete(db, job: dict, *, review_id, now: datetime) -> bool:
    """Chốt một job QUEUED đã có sẵn kết quả (crash giữa bước 11-13) - không cần lease vì không ai giữ.

    Chỉ áp cho job đang QUEUED: job RUNNING nghĩa là còn một worker đang chạy, và ghi đè lên nó sẽ
    phá đúng thứ lease sinh ra để bảo vệ.
    """
    result = await db[JOBS_COLLECTION].update_one(
        {
            "_id": job["_id"],
            "generation": job["generation"],
            "run_id": job["run_id"],
            "status": constants.JOB_QUEUED,
        },
        {
            "$set": {
                "status": constants.JOB_COMPLETED,
                "latest_review_id": review_id,
                "projection_applied": True,
                "claimed_by": None,
                "lease_token": None,
                "lease_expires_at": None,
                "heartbeat_at": None,
                "updated_at": now,
                "completed_at": now,
            }
        },
    )
    return result.modified_count == 1


async def mark_failed(db, job: dict, *, now: datetime, error: dict, review_id=None) -> bool:
    result = await db[JOBS_COLLECTION].update_one(
        _fence(job),
        {
            "$set": {
                "status": constants.JOB_FAILED,
                "last_error": error,
                "latest_review_id": review_id,
                "claimed_by": None,
                "lease_token": None,
                "lease_expires_at": None,
                "heartbeat_at": None,
                "updated_at": now,
                "completed_at": now,
            }
        },
    )
    return result.modified_count == 1


async def expired_jobs(db, *, now: datetime) -> list[dict]:
    """Job RUNNING đã hết lease - chủ cũ có thể đã chết hoặc chỉ chậm; cả hai đều phải được xử lý."""
    return [
        job
        async for job in db[JOBS_COLLECTION].find(
            {
                "status": constants.JOB_RUNNING,
                "lease_expires_at": {"$lte": now},
            }
        )
    ]


def _fence(job: dict) -> dict:
    """Điều kiện ghi bắt buộc: đúng job, đúng generation/run, còn giữ lease, và đang RUNNING."""
    return {
        "_id": job["_id"],
        "generation": job["generation"],
        "run_id": job["run_id"],
        "status": constants.JOB_RUNNING,
        "lease_token": job["lease_token"],
    }
