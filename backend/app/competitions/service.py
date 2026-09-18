"""Competition service: validation, tạo/tra cứu, public representation.

Lifecycle (ADR-009): create -> draft; draft -> published; published -> closed.
Closed là terminal - không reopen ở MVP.
"""

import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.content import storage
from app.core.config import get_settings
from app.core.datetimes import as_utc, iso_z
from app.core.slugs import SLUG_MAX, is_valid_slug

logger = logging.getLogger(__name__)

COMPETITIONS_COLLECTION = "competitions"

STATUSES = ("draft", "published", "closed")
JOIN_MODES = ("open", "code", "invite_only")
METRICS = ("f1", "precision", "recall")

_SLUG_MAX = SLUG_MAX
_QUOTA_MAX = 1000

# Tài nguyên cuộc thi chỉ là link ngoài (Google Drive) - nền tảng không host dataset/binary.
RESOURCES_MAX = 10
_RESOURCE_LABEL_MAX = 120
_RESOURCE_URL_MAX = 2048
_RESOURCE_HOSTS = ("drive.google.com", "docs.google.com")

# Edit rule theo status (ADR-009): draft sửa mọi field config;
# published không đổi primary_metric (ảnh hưởng leaderboard đã có); closed read-only.
_LOCKED_WHEN_PUBLISHED = ("primary_metric",)
_EDITABLE_NEVER = ("slug", "status", "created_by")


class CompetitionResource(BaseModel):
    label: str
    url: str


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
    resources: list[CompetitionResource] = Field(default_factory=list)


class CompetitionUpdate(BaseModel):
    name: str | None = None
    short_description: str | None = None
    start_at: datetime | None = None
    end_at: datetime | None = None
    join_mode: str | None = None
    primary_metric: str | None = None
    quota_per_day: int | None = None
    leaderboard_visible: bool | None = None
    resources: list[CompetitionResource] | None = None


def normalize_resources(resources: list) -> list[dict]:
    """Chuẩn hoá + kiểm tra link tài nguyên. Raise ValueError với message tiếng Việt."""
    items = [item.model_dump() if isinstance(item, BaseModel) else dict(item) for item in resources]
    if len(items) > RESOURCES_MAX:
        raise ValueError(f"Mỗi cuộc thi tối đa {RESOURCES_MAX} tài nguyên.")
    normalized = []
    for item in items:
        label = _as_text(item.get("label"))
        url = _as_text(item.get("url"))
        if not label:
            raise ValueError("Tên tài nguyên không được để trống.")
        if len(label) > _RESOURCE_LABEL_MAX:
            raise ValueError(f"Tên tài nguyên tối đa {_RESOURCE_LABEL_MAX} ký tự.")
        normalized.append({"label": label, "url": _validate_resource_url(url)})
    return normalized


def _as_text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _validate_resource_url(url: str) -> str:
    if not url:
        raise ValueError("Link tài nguyên không được để trống.")
    if len(url) > _RESOURCE_URL_MAX:
        raise ValueError(f"Link tài nguyên tối đa {_RESOURCE_URL_MAX} ký tự.")
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError("Link tài nguyên phải bắt đầu bằng https://.")
    if parsed.username or parsed.password:
        raise ValueError("Link tài nguyên không được chứa thông tin đăng nhập.")
    host = parsed.hostname or ""
    if not any(host == allowed or host.endswith(f".{allowed}") for allowed in _RESOURCE_HOSTS):
        raise ValueError("Chỉ chấp nhận link Google Drive (drive.google.com hoặc docs.google.com).")
    return url


def public_resources(competition: dict) -> list[dict]:
    """Document cũ chưa có field resources trả [] - không cần migration Mongo."""
    return competition.get("resources") or []


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
            "resources": normalize_resources(data.resources),
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
    if as_utc(data.start_at) >= as_utc(data.end_at):
        raise ValueError("Thời gian bắt đầu phải trước thời gian kết thúc.")
    if data.join_mode not in JOIN_MODES:
        raise ValueError("Join mode phải là open, code hoặc invite_only.")
    if data.primary_metric not in METRICS:
        raise ValueError("Primary metric phải là f1, precision hoặc recall.")
    if not 0 <= data.quota_per_day <= _QUOTA_MAX:
        raise ValueError(f"Quota mỗi ngày phải từ 0 đến {_QUOTA_MAX}.")
    normalize_resources(data.resources)


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
    # Danh sách rỗng là hợp lệ và có nghĩa "xóa hết tài nguyên".
    if "resources" in updates:
        updates["resources"] = normalize_resources(updates["resources"])

    # Body là aware còn giá trị lưu trong Mongo là naive - bắt buộc chuẩn hoá trước khi so.
    start = as_utc(updates.get("start_at", competition["start_at"]))
    end = as_utc(updates.get("end_at", competition["end_at"]))
    if start >= end:
        raise ValueError("Thời gian bắt đầu phải trước thời gian kết thúc.")
    return updates


def public_competition(competition: dict, membership: dict | None = None) -> dict:
    """Representation cho guest/participant - không bao giờ lộ join_code_hash, created_by."""
    from app.memberships.service import public_membership

    return {
        **_competition_core(competition),
        "membership": public_membership(membership),
        "submission_config": _submission_config(
            competition, include_pos_label=_is_active_member(membership)
        ),
    }


def admin_competition(competition: dict) -> dict:
    """Representation cho admin: thêm created_by và luôn có đủ submission_config."""
    from app.memberships.service import public_membership

    return {
        **_competition_core(competition),
        "created_by": competition["created_by"],
        "membership": public_membership(None),
        "submission_config": _submission_config(competition, include_pos_label=True),
    }


def _competition_core(competition: dict) -> dict:
    return {
        "id": str(competition["_id"]),
        "slug": competition["slug"],
        "name": competition["name"],
        "short_description": competition.get("short_description", ""),
        "status": competition["status"],
        "start_at": iso_z(competition["start_at"]),
        "end_at": iso_z(competition["end_at"]),
        "join_mode": competition["join_mode"],
        "primary_metric": competition["primary_metric"],
        "quota_per_day": competition["quota_per_day"],
        "leaderboard_visible": competition["leaderboard_visible"],
        "join_code_configured": bool(competition.get("join_code_hash")),
        "resources": public_resources(competition),
    }


def _is_active_member(membership: dict | None) -> bool:
    return membership is not None and membership.get("active", True)


def _submission_config(competition: dict, *, include_pos_label: bool) -> dict:
    """`pos_label` là nhãn dương thật nên chỉ trả cho admin và thành viên đang hoạt động."""
    from app.core.config import get_settings
    from app.scoring.storage import ground_truth_available

    config = competition.get("scoring_config")
    payload = {
        "ready": bool(config and ground_truth_available(competition)),
        "id_column": config["id_column"] if config else None,
        "prediction_column": config["prediction_column"] if config else None,
        "average": config["average"] if config else None,
        "max_upload_mb": get_settings().max_upload_mb,
    }
    if include_pos_label:
        payload["pos_label"] = config.get("pos_label") if config else None
    return payload


async def activity_counts(db, competition_ids: list) -> dict:
    """member_count là thành viên ĐANG hoạt động; người đã rời/bị vô hiệu hóa đếm riêng."""
    from app.memberships.service import MEMBERSHIPS_COLLECTION
    from app.submissions.service import SUBMISSIONS_COLLECTION

    counts = {
        competition_id: {
            "member_count": 0,
            "inactive_member_count": 0,
            "submission_count": 0,
        }
        for competition_id in competition_ids
    }
    if not counts:
        return counts
    cursor = db[MEMBERSHIPS_COLLECTION].aggregate(
        [
            {"$match": {"competition_id": {"$in": competition_ids}}},
            {
                "$group": {
                    "_id": {
                        "competition_id": "$competition_id",
                        # Membership cũ thiếu field `active` được coi là đang hoạt động.
                        "active": {"$ifNull": ["$active", True]},
                    },
                    "total": {"$sum": 1},
                }
            },
        ]
    )
    async for row in cursor:
        field = "member_count" if row["_id"]["active"] else "inactive_member_count"
        counts[row["_id"]["competition_id"]][field] = row["total"]
    cursor = db[SUBMISSIONS_COLLECTION].aggregate(
        [
            {"$match": {"competition_id": {"$in": competition_ids}}},
            {"$group": {"_id": "$competition_id", "total": {"$sum": 1}}},
        ]
    )
    async for row in cursor:
        counts[row["_id"]]["submission_count"] = row["total"]
    return counts


async def delete_competition_cascade(db, competition: dict) -> None:
    """Xoá document con trước, competition sau cùng.

    Mongo standalone không có transaction: nếu một bước lỗi giữa đường thì cuộc thi vẫn còn
    và lệnh gọi lại chạy tiếp được, thay vì để lại dữ liệu con mồ côi không ai xoá.
    """
    from app.content.service import CONTENTS_COLLECTION
    from app.memberships.service import MEMBERSHIPS_COLLECTION
    from app.submissions.service import SUBMISSIONS_COLLECTION

    competition_id = competition["_id"]
    await db[SUBMISSIONS_COLLECTION].delete_many({"competition_id": competition_id})
    await db[MEMBERSHIPS_COLLECTION].delete_many({"competition_id": competition_id})
    await db[CONTENTS_COLLECTION].delete_many({"competition_id": competition_id})
    await db[COMPETITIONS_COLLECTION].delete_one({"_id": competition_id})


def competition_file_roots(competition_id) -> list[Path]:
    """Hai thư mục của một cuộc thi: nội dung/ảnh và bài nộp đã lưu."""
    root = Path(get_settings().data_dir)
    return [
        storage.ensure_within(root, Path("competitions", str(competition_id))),
        storage.ensure_within(root, Path("submissions", str(competition_id))),
    ]


def remove_competition_files(competition_id) -> bool:
    """Dọn file sau khi DB đã xoá xong; lỗi chỉ được log và báo partial, không phục hồi DB."""
    cleaned = True
    for path in competition_file_roots(competition_id):
        try:
            shutil.rmtree(path)
        except FileNotFoundError:
            continue
        except OSError:
            logger.warning("Cannot remove competition files at %s", path, exc_info=True)
            cleaned = False
    return cleaned
