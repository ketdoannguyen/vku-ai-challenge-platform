"""Submission persistence and safe result representations."""

import re
from datetime import datetime

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument

from app.accounts.service import ACCOUNTS_COLLECTION
from app.ai_review import constants as ai_constants
from app.ai_review import serializers as ai_serializers
from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.datetimes import iso_z, utc_day_bounds, utc_day_key
from app.memberships.service import MEMBERSHIPS_COLLECTION
from app.submission_artifacts.naming import NOTEBOOK_ARTIFACT, PREDICTION_ARTIFACT

SUBMISSIONS_COLLECTION = "submissions"
# Bộ đếm quota theo ngày nằm trên membership: `quota_day` là khoá ngày UTC, `quota_used` là số
# lượt đã dùng trong ngày đó.
QUOTA_DAY_FIELD = "quota_day"
QUOTA_USED_FIELD = "quota_used"
_PUBLIC_ERROR_MESSAGES = {
    "SCORING_FAILED": "Không thể chấm điểm bài nộp.",
    "SUBMISSION_REJECTED": "Bài nộp không hợp lệ.",
}
# Record cũ chỉ có CSV trên đĩa; tên mặc định dùng khi metadata không có.
LEGACY_FILENAME_FALLBACK = "submission.csv"

# Trục xét duyệt của admin, độc lập với `status` (trạng thái chấm điểm). Giữ `status="completed"`
# là điều kiện để quota, scoring lock và việc giữ artifact khi xoá member không đổi hành vi.
REVIEW_FIELD = "review"
REVIEW_STATUS_FIELD = f"{REVIEW_FIELD}.status"
REVIEW_STATUS_REJECTED = "rejected"
REVIEW_STATUS_ACCEPTED = "accepted"
REVIEW_STATUSES = (REVIEW_STATUS_ACCEPTED, REVIEW_STATUS_REJECTED)
MAX_REVIEW_NOTE_LENGTH = 1000

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
    # Trục AI: vòng reconcile quét theo `state`, bảng admin lọc theo `verdict`. Index thường (không
    # partial) vì mongomock không hỗ trợ đầy đủ partial expression trên field lồng nhau.
    await collection.create_index([("ai_review.state", 1), ("created_at", -1), ("_id", -1)])
    await collection.create_index([("ai_review.verdict", 1), ("created_at", -1), ("_id", -1)])


def eligible_query(query: dict | None = None) -> dict:
    """Thêm điều kiện "được tính kết quả": đã chấm điểm và chưa bị admin từ chối.

    `$ne` khớp cả document thiếu `review`, nên record cũ và bài chưa từng bị xét duyệt mặc nhiên
    hợp lệ - không cần migration hay backfill.
    """
    return {**(query or {}), REVIEW_STATUS_FIELD: {"$ne": REVIEW_STATUS_REJECTED}}


def review_filter(value: str) -> dict:
    """Query cho bộ lọc trạng thái duyệt của bảng admin.

    `accepted` gồm cả bài chưa từng bị từ chối lẫn bài đã được khôi phục, vì hai thứ đó hành xử
    giống nhau ở mọi đường tính kết quả.
    """
    if value == REVIEW_STATUS_REJECTED:
        return {REVIEW_STATUS_FIELD: REVIEW_STATUS_REJECTED}
    return {REVIEW_STATUS_FIELD: {"$ne": REVIEW_STATUS_REJECTED}}


def ai_review_filter(value: str) -> dict:
    """Query cho trục AI của bảng admin - hoàn toàn độc lập với `status` và `review`.

    `pending` là QUEUED/RUNNING (kể cả lượt ERROR chưa kịp có audit row), `none` là bài nộp từ
    lúc cuộc thi chưa bật AI.
    """
    if value == ai_constants.FILTER_AI_ALL:
        return {}
    if value == ai_constants.FILTER_AI_NONE:
        return {"ai_review": {"$exists": False}}
    if value == ai_constants.FILTER_AI_PENDING:
        return {"ai_review.state": {"$in": list(ai_constants.AI_PENDING_STATES)}}
    if value == ai_constants.FILTER_AI_ERROR:
        return {"ai_review.verdict": ai_constants.VERDICT_ERROR}
    return {"ai_review.verdict": value.upper()}


async def set_submission_review(
    db, submission_id, *, status: str, note: str | None, reviewed_by, now: datetime
) -> dict | None:
    """Ghi đè trọn object `review` - một thao tác nguyên tử trên một document.

    Ghi cả object thay vì `$set` từng field để note, người duyệt và thời điểm luôn thuộc về cùng
    một lần xét duyệt, không trộn metadata của hai admin thao tác song song. Lọc kèm
    `status="completed"` để record chưa chấm được điểm không bao giờ nhận được quyết định duyệt.

    Trả `None` khi không khớp; người gọi phân biệt 404 với 422 bằng một lượt đọc riêng trên nhánh
    lỗi. Đây là latest-write-wins: `reviewed_at` đổi ở mỗi lần ghi nên thao tác không idempotent.
    """
    return await db[SUBMISSIONS_COLLECTION].find_one_and_update(
        {"_id": submission_id, "status": "completed"},
        {
            "$set": {
                REVIEW_FIELD: {
                    "status": status,
                    "note": note,
                    "reviewed_by": reviewed_by,
                    "reviewed_at": now,
                }
            }
        },
        return_document=ReturnDocument.AFTER,
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


async def reserve_quota_slot(
    db, membership: dict, quota_per_day: int, now: datetime
) -> int | None:
    """Giữ chỗ một lượt nộp trong ngày UTC, nguyên tử; trả số lượt đã dùng sau khi giữ.

    Đếm-rồi-kiểm tra để hai request song song cùng lọt qua giới hạn (đã tái hiện: quota còn 2 mà
    6 request đồng thời đều được chấm). Bộ đếm nằm trên document membership - unique theo cặp
    cuộc thi/account - và `$inc` kèm điều kiện `quota_used < quota_per_day` là một thao tác
    nguyên tử trên một document, nên số lượt dùng không thể vượt `quota_per_day`.

    Trả `None` khi đã hết lượt. Lượt đã giữ phải trả lại bằng `release_quota_slot` nếu upload
    hoặc ghi DB thất bại.
    """
    collection = db[MEMBERSHIPS_COLLECTION]
    day_key = utc_day_key(now)
    await _seed_quota_day(db, membership, day_key, now)
    updated = await collection.find_one_and_update(
        {
            "_id": membership["_id"],
            QUOTA_DAY_FIELD: day_key,
            QUOTA_USED_FIELD: {"$lt": quota_per_day},
        },
        {"$inc": {QUOTA_USED_FIELD: 1}},
        return_document=ReturnDocument.AFTER,
    )
    return updated[QUOTA_USED_FIELD] if updated else None


async def release_quota_slot(db, membership: dict, now: datetime) -> None:
    """Trả lại lượt đã giữ khi bài nộp không được ghi; không bao giờ để bộ đếm âm."""
    await db[MEMBERSHIPS_COLLECTION].update_one(
        {
            "_id": membership["_id"],
            QUOTA_DAY_FIELD: utc_day_key(now),
            QUOTA_USED_FIELD: {"$gt": 0},
        },
        {"$inc": {QUOTA_USED_FIELD: -1}},
    )


async def _seed_quota_day(db, membership: dict, day_key: str, now: datetime) -> None:
    """Mở ngày mới cho bộ đếm, lấy số lượt đã dùng thật làm mốc.

    Membership tạo trước khi có bộ đếm (hoặc bài nộp trong ngày tạo bằng đường khác) vẫn được
    tính đúng: mốc seed là số bài `completed` trong ngày. Chỉ update khi document còn ở ngày cũ
    nên nhiều request đồng thời cùng seed cũng chỉ ghi một lần, cùng một giá trị.
    """
    if membership.get(QUOTA_DAY_FIELD) == day_key:
        return
    used = await completed_today_count(
        db, membership["competition_id"], membership["account_id"], now
    )
    await db[MEMBERSHIPS_COLLECTION].update_one(
        {"_id": membership["_id"], QUOTA_DAY_FIELD: {"$ne": day_key}},
        {"$set": {QUOTA_DAY_FIELD: day_key, QUOTA_USED_FIELD: used}},
    )


async def allocate_submission_no(db, membership: dict) -> int:
    """Cấp số thứ tự kế tiếp, nguyên tử, từ counter `submission_seq` trên membership (ADR-033).

    Số phải biết TRƯỚC khi upload vì nó nằm trong object key; `$inc` trên đúng document membership
    (unique theo cặp cuộc thi/account) cho hai request đồng thời hai số khác nhau nên không còn
    đường ghi đè object của nhau. Đổi lại, số nhảy cách nếu upload fail sau khi đã cấp.
    """
    collection = db[MEMBERSHIPS_COLLECTION]
    if "submission_seq" not in membership:
        await collection.update_one(
            {"_id": membership["_id"], "submission_seq": {"$exists": False}},
            {"$set": {"submission_seq": await _highest_submission_no(db, membership)}},
        )
    updated = await collection.find_one_and_update(
        {"_id": membership["_id"]},
        {"$inc": {"submission_seq": 1}},
        return_document=ReturnDocument.AFTER,
    )
    return updated["submission_seq"]


async def _highest_submission_no(db, membership: dict) -> int:
    """Số lớn nhất đã cấp cho cặp này trước khi có counter - mốc seed để không cấp lại số cũ."""
    latest = await db[SUBMISSIONS_COLLECTION].find_one(
        {
            "competition_id": membership["competition_id"],
            "account_id": membership["account_id"],
            "submission_no": {"$exists": True},
        },
        {"submission_no": 1},
        sort=[("submission_no", -1)],
    )
    return latest["submission_no"] if latest else 0


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


def public_submission(
    submission: dict, quota_remaining: int, *, ai_visible: bool = False
) -> dict:
    result = {
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
    projection = ai_serializers.participant_projection(submission, ai_visible)
    if projection is not None:
        result["ai_review"] = projection
    return result


def submission_history_item(submission: dict, *, ai_visible: bool = False) -> dict:
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
    # Participant chỉ thấy lý do khi bài đang bị từ chối; người duyệt và thời điểm là chuyện nội bộ.
    # Serializer này cũng phục vụ bảng admin nên admin ghi đè lại bằng shape đầy đủ.
    review = submission.get(REVIEW_FIELD) or {}
    if review.get("status") == REVIEW_STATUS_REJECTED:
        item[REVIEW_FIELD] = {
            "status": REVIEW_STATUS_REJECTED,
            "note": review.get("note"),
        }
    projection = ai_serializers.participant_projection(submission, ai_visible)
    if projection is not None:
        item["ai_review"] = projection
    return item


async def list_account_submissions(
    db, competition_id, account_id, *, limit: int, offset: int, ai_visible: bool = False
) -> tuple[list[dict], int]:
    query = {"competition_id": competition_id, "account_id": account_id}
    collection = db[SUBMISSIONS_COLLECTION]
    total = await collection.count_documents(query)
    cursor = collection.find(query).sort([("created_at", -1), ("_id", -1)]).skip(offset).limit(limit)
    return [submission_history_item(item, ai_visible=ai_visible) async for item in cursor], total


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
                    # "Đã chấm điểm" trên thẻ thống kê phải khớp thẻ của nó: bài bị từ chối vẫn
                    # `completed` nhưng không được tính kết quả nên không nằm trong con số này.
                    "completed": [
                        {"$match": eligible_query({"status": "completed"})},
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
