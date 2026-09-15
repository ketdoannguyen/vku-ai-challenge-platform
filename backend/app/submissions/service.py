"""Submission persistence helpers shared by scoring configuration and upload."""

from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase

SUBMISSIONS_COLLECTION = "submissions"


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    collection = db[SUBMISSIONS_COLLECTION]
    await collection.create_index(
        [("competition_id", 1), ("account_id", 1), ("created_at", -1)]
    )
    await collection.create_index([("competition_id", 1), ("primary_score", -1)])


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


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)
