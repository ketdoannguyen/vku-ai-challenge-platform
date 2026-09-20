"""Submission persistence and safe result representations."""

import re
from datetime import datetime

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.accounts.service import ACCOUNTS_COLLECTION
from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.datetimes import iso_z, utc_day_bounds
from app.submission_artifacts.naming import NOTEBOOK_ARTIFACT, PREDICTION_ARTIFACT

SUBMISSIONS_COLLECTION = "submissions"
_PUBLIC_ERROR_MESSAGES = {
    "SCORING_FAILED": "Không thể chấm điểm bài nộp.",
    "SUBMISSION_REJECTED": "Bài nộp không hợp lệ.",
}
# Record cũ chỉ có CSV trên đĩa; tên mặc định dùng khi metadata không có.
LEGACY_FILENAME_FALLBACK = "submission.csv"

# Allowlist sort/order của bảng quản trị: không bao giờ nội suy trực tiếp từ query vào `$sort`.
# Bảng theo một cuộc thi không có cột cuộc thi nên không nhận `competition` - sort đó vô nghĩa ở đó.
SCOPED_SORT_FIELDS = ("created_at", "team", "primary_score", "f1", "precision", "recall")
SORT_FIELDS = (*SCOPED_SORT_FIELDS, "competition")
SORT_ORDERS = ("asc", "desc")
# Sort theo chỉ số đọc từ `metrics.*`; sort theo tên account/cuộc thi phải lookup mới có khoá.
METRIC_SORT_FIELDS = ("f1", "precision", "recall")
LOOKUP_SORT_FIELDS = ("team", "competition")
DEFAULT_SORT = "created_at"
DEFAULT_ORDER = "desc"


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    collection = db[SUBMISSIONS_COLLECTION]
    # Số thứ tự submission là duy nhất theo (cuộc thi, account) một khi đã được cấp; partial index để
    # record legacy thiếu `submission_no` không tham gia ràng buộc này.
    await collection.create_index(
        [("competition_id", 1), ("account_id", 1), ("submission_no", 1)],
        unique=True,
        name="submission_no_unique",
        partialFilterExpression={"submission_no": {"$exists": True}},
    )
    # Trang quản trị submission toàn cục sắp xếp không kèm competition_id nên cần index riêng.
    await collection.create_index([("created_at", -1), ("_id", -1)])
    await collection.create_index([("primary_score", -1), ("created_at", -1), ("_id", -1)])
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


async def has_completed_submission(db, competition_id, account_id=None) -> bool:
    """Không truyền account_id là kiểm tra toàn cuộc thi (dùng cho scoring lock)."""
    query = {"competition_id": competition_id, "status": "completed"}
    if account_id is not None:
        query["account_id"] = account_id
    return await db[SUBMISSIONS_COLLECTION].count_documents(query, limit=1) > 0


async def completed_today_count(db, competition_id, account_id, now: datetime) -> int:
    day_start, day_end = utc_day_bounds(now)
    return await db[SUBMISSIONS_COLLECTION].count_documents(
        {
            "competition_id": competition_id,
            "account_id": account_id,
            "status": "completed",
            "created_at": {"$gte": day_start, "$lt": day_end},
        }
    )


async def quota_status(
    db, competition_id, account_id, quota_per_day: int, now: datetime
) -> dict:
    """Quota của một account trong ngày UTC hiện tại, kèm mốc reset để UI hiển thị giờ local."""
    used = await completed_today_count(db, competition_id, account_id, now)
    _, day_end = utc_day_bounds(now)
    return {
        "per_day": quota_per_day,
        "used_today": used,
        "remaining": max(0, quota_per_day - used),
        "resets_at": iso_z(day_end),
    }


async def next_submission_no(db, competition_id, account_id) -> int:
    """Ứng viên số thứ tự kế tiếp: lớn hơn cả bề rộng lịch sử và số lớn nhất đã cấp.

    Chốt chống trùng là unique index chứ không phải hàm này - hai request đồng thời cùng đọc ra một
    ứng viên, một request sẽ nhận DuplicateKeyError rồi tính lại.
    """
    query = {"competition_id": competition_id, "account_id": account_id}
    collection = db[SUBMISSIONS_COLLECTION]
    history = await collection.count_documents(query)
    latest = await collection.find_one(
        {**query, "submission_no": {"$exists": True}},
        {"submission_no": 1},
        sort=[("submission_no", -1)],
    )
    highest = latest["submission_no"] if latest else 0
    return max(history, highest) + 1


def artifact_metadata(submission: dict) -> dict:
    """Metadata artifact an toàn cho participant/admin - không lộ object key hay backend lưu trữ."""
    stored = submission.get("artifacts") or {}
    result: dict[str, dict | None] = {PREDICTION_ARTIFACT: None, NOTEBOOK_ARTIFACT: None}
    for kind in result:
        entry = stored.get(kind)
        if entry:
            result[kind] = {
                "filename": entry.get("original_filename") or kind,
                "size_bytes": entry.get("size_bytes"),
                "available": True,
            }
    if result[PREDICTION_ARTIFACT] is None and submission.get("file_path"):
        # Submission cũ chỉ có CSV trên đĩa; kích thước không lưu nên để null.
        result[PREDICTION_ARTIFACT] = {
            "filename": submission.get("original_filename") or LEGACY_FILENAME_FALLBACK,
            "size_bytes": None,
            "available": True,
        }
    return result


def public_submission(submission: dict, quota_remaining: int) -> dict:
    return {
        "id": str(submission["_id"]),
        "competition_id": str(submission["competition_id"]),
        "submission_no": submission.get("submission_no"),
        "status": submission["status"],
        "metrics": submission["metrics"],
        "primary_score": submission["primary_score"],
        "created_at": iso_z(submission["created_at"]),
        "artifacts": artifact_metadata(submission),
        "quota_remaining": quota_remaining,
    }


def submission_history_item(submission: dict) -> dict:
    """Return participant-safe history data without account or storage details."""
    item = {
        "id": str(submission["_id"]),
        "competition_id": str(submission["competition_id"]),
        "submission_no": submission.get("submission_no"),
        "status": submission["status"],
        "metrics": submission.get("metrics"),
        "primary_score": submission.get("primary_score"),
        "created_at": iso_z(submission["created_at"]),
        "artifacts": artifact_metadata(submission),
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


async def matching_account_ids(db, query: str) -> list[ObjectId] | None:
    """Account khớp tên/email; None nghĩa là không lọc theo account."""
    query = query.strip()
    if not query:
        return None
    pattern = re.compile(re.escape(query), re.IGNORECASE)
    cursor = db[ACCOUNTS_COLLECTION].find(
        {"$or": [{"name": pattern}, {"email": pattern}]}, {"_id": 1}
    )
    return [account["_id"] async for account in cursor]


def sort_spec(sort: str, order: str) -> list[tuple[str, int]]:
    """Khóa sort luôn kết thúc bằng `_id` để tie-break ổn định giữa các trang."""
    direction = 1 if order == "asc" else -1
    if sort == "team":
        return [
            ("_account_name", direction),
            ("_account_email", direction),
            ("created_at", direction),
            ("_id", direction),
        ]
    if sort == "competition":
        return [
            ("_competition_name", direction),
            ("_competition_slug", direction),
            ("created_at", direction),
            ("_id", direction),
        ]
    if sort in METRIC_SORT_FIELDS:
        # Record lỗi chấm điểm không có `metrics`: Mongo xếp null/missing lên đầu khi tăng dần.
        return [
            (f"metrics.{sort}", direction),
            ("created_at", direction),
            ("_id", direction),
        ]
    if sort == "primary_score":
        return [("primary_score", direction), ("created_at", direction), ("_id", direction)]
    return [("created_at", direction), ("_id", direction)]


def _lookup_stages(sort: str) -> list[dict]:
    """Tên account/cuộc thi không lưu trên submission nên phải join mới sắp xếp được."""
    if sort == "competition":
        return [
            {
                "$lookup": {
                    "from": COMPETITIONS_COLLECTION,
                    "localField": "competition_id",
                    "foreignField": "_id",
                    "as": "_competition",
                }
            },
            {
                "$addFields": {
                    "_competition_name": {
                        "$ifNull": [{"$arrayElemAt": ["$_competition.name", 0]}, ""]
                    },
                    "_competition_slug": {
                        "$ifNull": [{"$arrayElemAt": ["$_competition.slug", 0]}, ""]
                    },
                }
            },
        ]
    return [
        {
            "$lookup": {
                "from": ACCOUNTS_COLLECTION,
                "localField": "account_id",
                "foreignField": "_id",
                "as": "_account",
            }
        },
        {
            "$addFields": {
                "_account_name": {"$ifNull": [{"$arrayElemAt": ["$_account.name", 0]}, ""]},
                "_account_email": {
                    "$ifNull": [{"$arrayElemAt": ["$_account.email", 0]}, ""]
                },
            }
        },
    ]


async def list_admin_submissions(
    db, query: dict, *, sort: str, order: str, limit: int, offset: int
) -> list[dict]:
    """Một trang submission cho quản trị; `team`/`competition` cần lookup nên phải aggregation."""
    collection = db[SUBMISSIONS_COLLECTION]
    if sort in LOOKUP_SORT_FIELDS:
        cursor = collection.aggregate(
            [
                {"$match": query},
                *_lookup_stages(sort),
                {"$sort": dict(sort_spec(sort, order))},
                {"$skip": offset},
                {"$limit": limit},
            ]
        )
        return [document async for document in cursor]
    cursor = (
        collection.find(query).sort(sort_spec(sort, order)).skip(offset).limit(limit)
    )
    return [document async for document in cursor]


def _facet_count(rows: list[dict]) -> int:
    """`$count` sau `$group` không trả document nào khi tập rỗng nên phải quy về 0."""
    return rows[0]["value"] if rows else 0


async def submission_stats(db, query: dict) -> dict:
    """Bốn số tổng quan của bảng toàn cục, tính trên cùng bộ lọc đang xem chứ không phải trang.

    Một lượt `$facet` thay cho bốn truy vấn riêng; `total` ở đây cũng là `total` của phân trang
    nên route gọi hàm này không cần đếm thêm lần nữa.
    """
    cursor = db[SUBMISSIONS_COLLECTION].aggregate(
        [
            {"$match": query},
            {
                "$facet": {
                    "total": [{"$count": "value"}],
                    "competitions": [
                        {"$group": {"_id": "$competition_id"}},
                        {"$count": "value"},
                    ],
                    "teams": [
                        {"$group": {"_id": "$account_id"}},
                        {"$count": "value"},
                    ],
                    "completed": [
                        {"$match": {"status": "completed"}},
                        {"$count": "value"},
                    ],
                }
            },
        ]
    )
    facets = (await cursor.to_list(length=1))[0]
    return {
        "total": _facet_count(facets["total"]),
        "competitions": _facet_count(facets["competitions"]),
        "teams": _facet_count(facets["teams"]),
        "completed": _facet_count(facets["completed"]),
    }
