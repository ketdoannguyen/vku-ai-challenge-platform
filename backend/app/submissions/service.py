"""Submission persistence and safe result representations."""

from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase

SUBMISSIONS_COLLECTION = "submissions"
_PUBLIC_ERROR_MESSAGES = {
    "SCORING_FAILED": "Không thể chấm điểm bài nộp.",
    "SUBMISSION_REJECTED": "Bài nộp không hợp lệ.",
}


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    collection = db[SUBMISSIONS_COLLECTION]
    await collection.create_index(
        [
            ("competition_id", 1),
            ("account_id", 1),
            ("created_at", -1),
            ("_id", -1),
        ]
    )
    await collection.create_index([("competition_id", 1), ("primary_score", -1)])
    await collection.create_index(
        [
            ("competition_id", 1),
            ("status", 1),
            ("primary_score", -1),
            ("created_at", 1),
            ("account_id", 1),
            ("_id", 1),
        ]
    )
    await collection.create_index(
        [
            ("competition_id", 1),
            ("status", 1),
            ("created_at", -1),
            ("_id", -1),
        ]
    )
    await collection.create_index(
        [("competition_id", 1), ("created_at", -1), ("_id", -1)]
    )


async def has_completed_submission(db, competition_id) -> bool:
    return (
        await db[SUBMISSIONS_COLLECTION].count_documents(
            {"competition_id": competition_id, "status": "completed"}, limit=1
        )
        > 0
    )


async def completed_today_count(db, competition_id, account_id, now: datetime) -> int:
    now = _as_utc(now)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + timedelta(days=1)
    return await db[SUBMISSIONS_COLLECTION].count_documents(
        {
            "competition_id": competition_id,
            "account_id": account_id,
            "status": "completed",
            "created_at": {"$gte": day_start, "$lt": day_end},
        }
    )


def public_submission(submission: dict, quota_remaining: int) -> dict:
    return {
        "id": str(submission["_id"]),
        "competition_id": str(submission["competition_id"]),
        "status": submission["status"],
        "metrics": submission["metrics"],
        "primary_score": submission["primary_score"],
        "created_at": _as_utc(submission["created_at"]).isoformat().replace("+00:00", "Z"),
        "quota_remaining": quota_remaining,
    }


def submission_history_item(submission: dict) -> dict:
    """Return participant-safe history data without account or storage details."""
    item = {
        "id": str(submission["_id"]),
        "competition_id": str(submission["competition_id"]),
        "filename": submission.get("original_filename", "submission.csv"),
        "status": submission["status"],
        "metrics": submission.get("metrics"),
        "primary_score": submission.get("primary_score"),
        "created_at": iso_datetime(submission["created_at"]),
    }
    if submission.get("error_code") or submission.get("error_message"):
        error_code = submission.get("error_code")
        if error_code not in _PUBLIC_ERROR_MESSAGES:
            error_code = "SUBMISSION_FAILED"
        item["error"] = {
            "code": error_code,
            "message": _PUBLIC_ERROR_MESSAGES.get(
                error_code, "Không thể xử lý bài nộp."
            ),
        }
    return item


async def list_account_submissions(
    db, competition_id, account_id, *, limit: int, offset: int
) -> tuple[list[dict], int]:
    query = {"competition_id": competition_id, "account_id": account_id}
    collection = db[SUBMISSIONS_COLLECTION]
    total = await collection.count_documents(query)
    cursor = collection.find(query).sort([("created_at", -1), ("_id", -1)]).skip(offset).limit(limit)
    return [submission_history_item(item) async for item in cursor], total


def iso_datetime(value: datetime) -> str:
    return _as_utc(value).isoformat().replace("+00:00", "Z")


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)
