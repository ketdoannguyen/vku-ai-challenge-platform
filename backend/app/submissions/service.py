"""Submission persistence and safe result representations."""

import logging
import re
from datetime import datetime
from pathlib import Path

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument

from app.accounts.service import ACCOUNTS_COLLECTION
from app.ai_review import constants as ai_constants
from app.ai_review import serializers as ai_serializers
from app.competitions.service import COMPETITIONS_COLLECTION
from app.content import storage
from app.core.config import get_settings
from app.core.datetimes import iso_z, utc_day_bounds, utc_day_key
from app.memberships.service import MEMBERSHIPS_COLLECTION
from app.scoring import contracts, normalization
from app.scoring.models import OutputContract
from app.submission_artifacts import storage as artifact_storage
from app.submission_artifacts.naming import NOTEBOOK_ARTIFACT, PREDICTION_ARTIFACT

logger = logging.getLogger(__name__)

SUBMISSIONS_COLLECTION = "submissions"
# Bộ đếm quota theo ngày nằm trên membership: `quota_day` là khoá ngày UTC, `quota_used` là số
# lượt đã dùng trong ngày đó.
QUOTA_DAY_FIELD = "quota_day"
QUOTA_USED_FIELD = "quota_used"
# Dấu "lượt nộp nào đang giữ suất này" -> khoá ngày đã giữ. Chỉ đường nộp v2 dùng: v1 hoàn lượt ngay
# trong request nên không cần nhớ gì.
QUOTA_CLAIMS_FIELD = "quota_claims"
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
SCOPED_SORT_FIELDS = ("created_at", "team", "primary_score")
SORT_FIELDS = (*SCOPED_SORT_FIELDS, "competition")
SORT_ORDERS = ("asc", "desc")
# Sort theo chỉ số đọc từ `metrics.*`; sort theo tên account/cuộc thi phải lookup mới có khoá.
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
    # Trục AI: vòng reconcile quét theo `state`, bảng admin lọc theo `verdict` và trạng thái nguồn.
    # Index thường (không partial) vì mongomock không hỗ trợ đầy đủ partial expression trên field
    # lồng nhau.
    await collection.create_index([("ai_review.state", 1), ("created_at", -1), ("_id", -1)])
    await collection.create_index([("ai_review.verdict", 1), ("created_at", -1), ("_id", -1)])
    await collection.create_index(
        [("ai_review.source_status", 1), ("created_at", -1), ("_id", -1)]
    )


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
    if value in (ai_constants.FILTER_AI_SOURCE_EXTERNAL, ai_constants.FILTER_AI_SOURCE_UNCLEAR):
        return {
            "ai_review.state": ai_constants.AI_STATE_COMPLETED,
            "ai_review.source_signal_version": ai_constants.SOURCE_SIGNAL_VERSION,
            "ai_review.source_status": (
                ai_constants.SOURCE_STATUS_EXTERNAL
                if value == ai_constants.FILTER_AI_SOURCE_EXTERNAL
                else ai_constants.SOURCE_STATUS_UNCLEAR
            ),
        }
    if value == ai_constants.FILTER_AI_SOURCE_NOT_EVALUATED:
        # Gồm cả row COMPLETED từ phiên bản cũ thiếu trạng thái nguồn mới (kể cả signals rỗng,
        # warning count = 0): thiếu dữ kiện không được hiển thị như sạch.
        return {
            "ai_review.state": ai_constants.AI_STATE_COMPLETED,
            "$or": [
                {"ai_review.source_signal_version": {"$ne": ai_constants.SOURCE_SIGNAL_VERSION}},
                {"ai_review.source_status": ai_constants.SOURCE_STATUS_NOT_EVALUATED},
            ],
        }
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


async def has_graded_submission(db, account_id) -> bool:
    """Bài đã chấm điểm của một account, không giới hạn cuộc thi.

    Xoá member thì hỏi theo từng cuộc thi, còn xoá account phải hỏi trên toàn bộ lịch sử - một bài
    `completed` ở bất kỳ cuộc thi nào cũng đủ để tài khoản đó không được xoá.
    """
    query = {"account_id": account_id, "status": "completed"}
    return await db[SUBMISSIONS_COLLECTION].count_documents(query, limit=1) > 0


async def delete_submissions_matching(db, query: dict) -> int:
    """Xoá các submission khớp `query`, kèm file local và artifact MinIO.

    Người gọi phải tự loại bài đã chấm điểm khỏi `query` - hàm này không tự chặn. Dọn file là
    best-effort: lỗi chỉ được log, vì bản ghi DB đã mất mới là điều kiện đúng của thao tác.
    """
    records = [
        record async for record in db[SUBMISSIONS_COLLECTION].find(query)
    ]
    for record in records:
        relative = record.get("file_path")
        if relative:
            try:
                storage.ensure_within(Path(get_settings().data_dir), Path(relative)).unlink(
                    missing_ok=True
                )
            except (OSError, ValueError):
                logger.warning("Cannot remove submission file %s", relative)
        for entry in (record.get("artifacts") or {}).values():
            object_key = entry.get("object_key") if isinstance(entry, dict) else None
            if object_key:
                await artifact_storage.remove_object(object_key)
    if records:
        await db[SUBMISSIONS_COLLECTION].delete_many(
            {"_id": {"$in": [record["_id"] for record in records]}}
        )
    return len(records)


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


async def my_stats_by_competition(
    db, competition_ids: list, account_id, now: datetime
) -> dict:
    """Số liệu cá nhân theo từng cuộc thi cho trang danh sách: một lượt `$facet` cho cả trang.

    `total` đếm mọi record đã lưu (bất kể `status`/`review`) - cùng định nghĩa với `total` trong
    lịch sử nộp bài; `eligible` đếm bài được tính kết quả (điều kiện xếp hạng của leaderboard) để
    biết có cần đọc bảng xếp hạng không; `today` đếm bài `completed` trong ngày UTC, cùng quy ước
    với `completed_today_count`/`quota_status` nên thẻ danh sách và quota trang chi tiết không lệch.
    """
    stats = {
        competition_id: {"total": 0, "eligible_count": 0, "today": 0}
        for competition_id in competition_ids
    }
    if not competition_ids:
        return stats
    day_start, day_end = utc_day_bounds(now)
    cursor = db[SUBMISSIONS_COLLECTION].aggregate(
        [
            {
                "$match": {
                    "competition_id": {"$in": competition_ids},
                    "account_id": account_id,
                }
            },
            {
                "$facet": {
                    "total": [{"$group": {"_id": "$competition_id", "total": {"$sum": 1}}}],
                    "eligible": [
                        {"$match": eligible_query({"status": "completed"})},
                        {"$group": {"_id": "$competition_id", "total": {"$sum": 1}}},
                    ],
                    "today": [
                        {
                            "$match": {
                                "status": "completed",
                                "created_at": {"$gte": day_start, "$lt": day_end},
                            }
                        },
                        {"$group": {"_id": "$competition_id", "total": {"$sum": 1}}},
                    ],
                }
            },
        ]
    )
    facets = (await cursor.to_list(length=1))[0]
    for row in facets["total"]:
        stats[row["_id"]]["total"] = row["total"]
    for row in facets["eligible"]:
        stats[row["_id"]]["eligible_count"] = row["total"]
    for row in facets["today"]:
        stats[row["_id"]]["today"] = row["total"]
    return stats


async def normalization_snapshot(db, competition: dict, *, raw, now: datetime) -> dict | None:
    """Ảnh chụp norm tạm tại đúng lúc bài nộp được ghi nhận; `None` khi cuộc thi không bật norm.

    Mặt bằng đọc trực tiếp từ các bài eligible - cố ý không đi qua cache BXH: cache có thể đang
    giữ bản trước một bài vừa ghi, và mẫu số cũ sẽ chốt sai điểm tạm. Raw của chính bài đang ghi
    được đưa vào mặt bằng; nếu không, bài đầu tiên vượt baseline sẽ không bao giờ đạt 50. Bản ghi
    hỏng trong DB bị loại khỏi mặt bằng theo đúng chính sách của BXH, không quy về 0.
    """
    rule = normalization.active_rule(competition)
    if rule is None:
        return None
    if not normalization.is_valid_score(raw):
        raise normalization.NormalizationError(
            "Điểm gốc không phải số hữu hạn nên không dựng được snapshot chuẩn hóa."
        )
    query = eligible_query({"competition_id": competition["_id"], "status": "completed"})
    cursor = db[SUBMISSIONS_COLLECTION].find(query, {"primary_score": 1})
    scores = [submission.get("primary_score") async for submission in cursor]
    usable = [value for value in scores if normalization.is_valid_score(value)]
    reference = normalization.reference_best([*usable, raw], rule.higher_is_better)
    return normalization.snapshot_payload(rule, raw=raw, reference=reference, calculated_at=now)


async def reserve_quota_slot(
    db, membership: dict, quota_per_day: int, now: datetime, *, attempt_id: str | None = None
) -> int | None:
    """Giữ chỗ một lượt nộp trong ngày UTC, nguyên tử; trả số lượt đã dùng sau khi giữ.

    Đếm-rồi-kiểm tra để hai request song song cùng lọt qua giới hạn (đã tái hiện: quota còn 2 mà
    6 request đồng thời đều được chấm). Bộ đếm nằm trên document membership - unique theo cặp
    cuộc thi/account - và `$inc` kèm điều kiện `quota_used < quota_per_day` là một thao tác
    nguyên tử trên một document, nên số lượt dùng không thể vượt `quota_per_day`.

    `attempt_id` đóng dấu lượt nào đang giữ suất này: đường nộp v2 giữ suất lâu hơn một request
    (chờ chấm, ghi bài, đối soát), nên phải biết hoàn cho đúng lượt và không hoàn hai lần.

    Trả `None` khi đã hết lượt. Lượt đã giữ phải trả lại bằng `release_quota_slot` nếu upload
    hoặc ghi DB thất bại.
    """
    collection = db[MEMBERSHIPS_COLLECTION]
    day_key = utc_day_key(now)
    await _seed_quota_day(db, membership, day_key, now)
    update: dict = {"$inc": {QUOTA_USED_FIELD: 1}}
    if attempt_id is not None:
        update["$set"] = {f"{QUOTA_CLAIMS_FIELD}.{attempt_id}": day_key}
    updated = await collection.find_one_and_update(
        {
            "_id": membership["_id"],
            QUOTA_DAY_FIELD: day_key,
            QUOTA_USED_FIELD: {"$lt": quota_per_day},
        },
        update,
        return_document=ReturnDocument.AFTER,
    )
    return updated[QUOTA_USED_FIELD] if updated else None


async def release_quota_slot(
    db, membership: dict, now: datetime, *, attempt_id: str | None = None
) -> None:
    """Trả lại lượt đã giữ khi bài nộp không được ghi; không bao giờ để bộ đếm âm.

    Có `attempt_id` thì chỉ trả lại khi dấu của chính lượt đó còn nguyên, và dấu bị xoá luôn trong
    chính lượt ghi này - nên gọi lặp (worker chết rồi chạy lại, reconciler quét lại) không thể trừ
    hai lần. Dấu mang khoá ngày nên một lượt của ngày cũ cũng không hoàn được vào ngày mới.
    """
    day_key = utc_day_key(now)
    query = {"_id": membership["_id"], QUOTA_USED_FIELD: {"$gt": 0}}
    update: dict = {"$inc": {QUOTA_USED_FIELD: -1}}
    if attempt_id is None:
        query[QUOTA_DAY_FIELD] = day_key
    else:
        query[f"{QUOTA_CLAIMS_FIELD}.{attempt_id}"] = day_key
        update["$unset"] = {f"{QUOTA_CLAIMS_FIELD}.{attempt_id}": ""}
    await db[MEMBERSHIPS_COLLECTION].update_one(query, update)


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
        {
            "$set": {
                QUOTA_DAY_FIELD: day_key,
                QUOTA_USED_FIELD: used,
                # Dấu của ngày cũ hết giá trị khi ngày đổi: giữ lại chỉ làm map phình ra.
                QUOTA_CLAIMS_FIELD: {},
            }
        },
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
    submission: dict,
    quota_remaining: int,
    *,
    ai_visible: bool = False,
    contract: OutputContract | None = None,
    normalization_visible: bool = False,
) -> dict:
    """`contract` là hợp đồng thí sinh; `None` (đường admin) giữ nguyên mọi metric."""
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
    if contract is not None:
        contracts.apply_metric_visibility(result, contract)
    result.update(
        _snapshot_projection(
            submission, contract=contract, normalization_visible=normalization_visible
        )
    )
    projection = ai_serializers.participant_projection(submission, ai_visible)
    if projection is not None:
        result["ai_review"] = projection
    return result


def _snapshot_projection(
    submission: dict, *, contract: OutputContract | None, normalization_visible: bool
) -> dict:
    """Snapshot norm tạm của bài nộp: chỉ xuất hiện khi có snapshot VÀ người xem được xem.

    Admin (`contract` None) nhận đủ baseline/reference/version; thí sinh chỉ nhận điểm tạm và
    thời điểm, và không nhận gì khi BXH hoặc metric nguồn đang bị ẩn.
    """
    snapshot = submission.get(normalization.SNAPSHOT_FIELD)
    if snapshot is None:
        return {}
    if contract is None:
        return {normalization.SNAPSHOT_FIELD: normalization.admin_snapshot(snapshot)}
    if not normalization_visible:
        return {}
    return {normalization.SNAPSHOT_FIELD: normalization.participant_snapshot(snapshot)}


def submission_history_item(
    submission: dict,
    *,
    ai_visible: bool = False,
    contract: OutputContract | None = None,
    normalization_visible: bool = False,
) -> dict:
    """Return participant-safe history data without account or storage details.

    `contract` là hợp đồng thí sinh; `None` (đường admin) giữ nguyên mọi metric. Snapshot norm
    tạm là dữ liệu dẫn xuất: chỉ trả theo quyền xem hiện tại, không lấy từ cờ lúc nộp.
    """
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
    if contract is not None:
        contracts.apply_metric_visibility(item, contract)
    item.update(
        _snapshot_projection(
            submission, contract=contract, normalization_visible=normalization_visible
        )
    )
    projection = ai_serializers.participant_projection(submission, ai_visible)
    if projection is not None:
        item["ai_review"] = projection
    return item


async def list_account_submissions(
    db,
    competition_id,
    account_id,
    *,
    limit: int,
    offset: int,
    ai_visible: bool = False,
    contract: OutputContract | None = None,
    normalization_visible: bool = False,
) -> tuple[list[dict], int]:
    query = {"competition_id": competition_id, "account_id": account_id}
    collection = db[SUBMISSIONS_COLLECTION]
    total = await collection.count_documents(query)
    cursor = collection.find(query).sort([("created_at", -1), ("_id", -1)]).skip(offset).limit(limit)
    return [
        submission_history_item(
            item,
            ai_visible=ai_visible,
            contract=contract,
            normalization_visible=normalization_visible,
        )
        async for item in cursor
    ], total


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


def metric_sort_fields(competition: dict) -> tuple[str, ...]:
    """Khóa metric được phép sort, lấy từ hợp đồng kết quả của chính cuộc thi đó.

    Bảng toàn cục trộn nhiều cuộc thi với thang đo khác nhau nên không sort theo khóa metric.
    """
    from app.scoring import contracts

    return tuple(metric.key for metric in contracts.result_contract(competition).metrics)


def sort_spec(
    sort: str, order: str, *, metric_fields: tuple[str, ...] = ()
) -> list[tuple[str, int]]:
    """Khóa sort luôn kết thúc bằng `_id` để tie-break ổn định giữa các trang.

    `metric_fields` là các khóa metric đã được hợp đồng của cuộc thi xác nhận - chỉ những khóa
    này mới được nội suy vào `metrics.<key>`.
    """
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
    if sort in metric_fields:
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
    db,
    query: dict,
    *,
    sort: str,
    order: str,
    limit: int,
    offset: int,
    metric_fields: tuple[str, ...] = (),
) -> list[dict]:
    """Một trang submission cho quản trị; `team`/`competition` cần lookup nên phải aggregation."""
    collection = db[SUBMISSIONS_COLLECTION]
    spec = sort_spec(sort, order, metric_fields=metric_fields)
    if sort in LOOKUP_SORT_FIELDS:
        cursor = collection.aggregate(
            [
                {"$match": query},
                *_lookup_stages(sort),
                {"$sort": dict(spec)},
                {"$skip": offset},
                {"$limit": limit},
            ]
        )
        return [document async for document in cursor]
    cursor = collection.find(query).sort(spec).skip(offset).limit(limit)
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
