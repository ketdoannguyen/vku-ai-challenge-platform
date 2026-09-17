"""Competition service: validation, tạo/tra cứu, public representation.

Lifecycle (ADR-009): create -> draft; draft -> published; published -> closed.
Closed là terminal — không reopen ở MVP.
"""

from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel

from app.core.slugs import SLUG_MAX, is_valid_slug

COMPETITIONS_COLLECTION = "competitions"

STATUSES = ("draft", "published", "closed")
JOIN_MODES = ("open", "code", "invite_only")
METRICS = ("f1", "precision", "recall")

_SLUG_MAX = SLUG_MAX
_QUOTA_MAX = 1000

# Edit rule theo status (ADR-009): draft sửa mọi field config;
# published không đổi primary_metric (ảnh hưởng leaderboard đã có); closed read-only.
_LOCKED_WHEN_PUBLISHED = ("primary_metric",)
_EDITABLE_NEVER = ("slug", "status", "created_by")


class CompetitionCreate(BaseModel):
    slug: str
    name: str
    short_description: str = ""
    start_at: datetime
    end_at: datetime
    join_mode: str = "open"
    primary_metric: str = "f1"
    quota_per_day: int = 5
    leaderboard_visible: bool = True


class CompetitionUpdate(BaseModel):
    name: str | None = None
    short_description: str | None = None
    start_at: datetime | None = None
    end_at: datetime | None = None
    join_mode: str | None = None
    primary_metric: str | None = None
    quota_per_day: int | None = None
    leaderboard_visible: bool | None = None


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COMPETITIONS_COLLECTION].create_index("slug", unique=True)


async def find_competition_by_slug(db: AsyncIOMotorDatabase, slug: str) -> dict | None:
    return await db[COMPETITIONS_COLLECTION].find_one({"slug": slug})


async def insert_competition(db: AsyncIOMotorDatabase, data: CompetitionCreate, created_by: str) -> dict:
    now = datetime.now(timezone.utc)
    result = await db[COMPETITIONS_COLLECTION].insert_one(
        {
            "slug": data.slug,
            "name": data.name.strip(),
            "short_description": data.short_description.strip(),
            "status": "draft",
            "start_at": data.start_at,
            "end_at": data.end_at,
            "join_mode": data.join_mode,
            "join_code_hash": None,
            "primary_metric": data.primary_metric,
            "quota_per_day": data.quota_per_day,
            "leaderboard_visible": data.leaderboard_visible,
            "created_by": created_by,
            "created_at": now,
            "updated_at": now,
        }
    )
    return await db[COMPETITIONS_COLLECTION].find_one({"_id": result.inserted_id})


def validate_create(data: CompetitionCreate) -> None:
    """Raise ValueError với message tiếng Việt nếu dữ liệu tạo competition không hợp lệ."""
    if not is_valid_slug(data.slug):
        raise ValueError(f"Slug chỉ gồm a-z, 0-9 và dấu gạch ngang (tối đa {_SLUG_MAX} ký tự).")
    if not data.name.strip():
        raise ValueError("Tên cuộc thi không được để trống.")
    if data.start_at >= data.end_at:
        raise ValueError("Thời gian bắt đầu phải trước thời gian kết thúc.")
    if data.join_mode not in JOIN_MODES:
        raise ValueError("Join mode phải là open, code hoặc invite_only.")
    if data.primary_metric not in METRICS:
        raise ValueError("Primary metric phải là f1, precision hoặc recall.")
    if not 0 <= data.quota_per_day <= _QUOTA_MAX:
        raise ValueError(f"Quota mỗi ngày phải từ 0 đến {_QUOTA_MAX}.")


def validate_update(competition: dict, changes: dict) -> dict:
    """Validate + lọc field được phép sửa theo status. Trả về dict $set-ready."""
    status = competition["status"]
    if status == "closed":
        raise ValueError("Cuộc thi đã kết thúc, không thể chỉnh sửa.")
    for field in _EDITABLE_NEVER:
        if field in changes:
            raise ValueError("Không thể thay đổi slug/status/created_by.")

    updates = {k: v for k, v in changes.items() if v is not None}
    if status == "published":
        locked = [f for f in _LOCKED_WHEN_PUBLISHED if f in updates]
        if locked:
            raise ValueError("Cuộc thi đã publish, không thể đổi primary_metric.")

    if "name" in updates and not updates["name"].strip():
        raise ValueError("Tên cuộc thi không được để trống.")
    if "join_mode" in updates and updates["join_mode"] not in JOIN_MODES:
        raise ValueError("Join mode phải là open, code hoặc invite_only.")
    if "primary_metric" in updates and updates["primary_metric"] not in METRICS:
        raise ValueError("Primary metric phải là f1, precision hoặc recall.")
    if "quota_per_day" in updates and not 0 <= updates["quota_per_day"] <= _QUOTA_MAX:
        raise ValueError(f"Quota mỗi ngày phải từ 0 đến {_QUOTA_MAX}.")

    start = updates.get("start_at", competition["start_at"])
    end = updates.get("end_at", competition["end_at"])
    if start >= end:
        raise ValueError("Thời gian bắt đầu phải trước thời gian kết thúc.")
    return updates


def public_competition(competition: dict, membership: dict | None = None) -> dict:
    """Representation trả về API — không bao giờ lộ join_code_hash."""
    from app.memberships.service import public_membership

    return {
        "id": str(competition["_id"]),
        "slug": competition["slug"],
        "name": competition["name"],
        "short_description": competition.get("short_description", ""),
        "status": competition["status"],
        "start_at": _iso(competition["start_at"]),
        "end_at": _iso(competition["end_at"]),
        "join_mode": competition["join_mode"],
        "primary_metric": competition["primary_metric"],
        "quota_per_day": competition["quota_per_day"],
        "leaderboard_visible": competition["leaderboard_visible"],
        "created_by": competition["created_by"],
        "join_code_configured": bool(competition.get("join_code_hash")),
        "membership": public_membership(membership),
        "submission_config": _public_submission_config(competition),
    }


def _public_submission_config(competition: dict) -> dict:
    from app.core.config import get_settings
    from app.scoring.storage import ground_truth_available

    config = competition.get("scoring_config")
    return {
        "ready": bool(config and ground_truth_available(competition)),
        "id_column": config["id_column"] if config else None,
        "prediction_column": config["prediction_column"] if config else None,
        "average": config["average"] if config else None,
        "pos_label": config.get("pos_label") if config else None,
        "max_upload_mb": get_settings().max_upload_mb,
    }


async def activity_counts(db, competition_ids: list) -> dict:
    """member_count/submission_count cho cả trang, gộp bằng 2 aggregate thay vì N+1."""
    from app.memberships.service import MEMBERSHIPS_COLLECTION
    from app.submissions.service import SUBMISSIONS_COLLECTION

    counts = {
        competition_id: {"member_count": 0, "submission_count": 0}
        for competition_id in competition_ids
    }
    if not counts:
        return counts
    for collection_name, field in (
        (MEMBERSHIPS_COLLECTION, "member_count"),
        (SUBMISSIONS_COLLECTION, "submission_count"),
    ):
        cursor = db[collection_name].aggregate(
            [
                {"$match": {"competition_id": {"$in": competition_ids}}},
                {"$group": {"_id": "$competition_id", "total": {"$sum": 1}}},
            ]
        )
        async for row in cursor:
            counts[row["_id"]][field] = row["total"]
    return counts


def _iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
