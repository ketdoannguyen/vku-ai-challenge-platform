"""Account service: tạo/tra cứu/cập nhật accounts. Không bao giờ trả password_hash."""

import secrets
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, EmailStr
from pymongo.errors import DuplicateKeyError

from app.auth.passwords import hash_password
from app.core.slugs import SLUG_MAX, slugify

ACCOUNTS_COLLECTION = "accounts"

# Slug bị đội khác giữ thì thêm "-" + 3 ký tự random; 5 lần là quá đủ để thoát va chạm.
_SLUG_SUFFIX_LEN = 3
_SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
_SLUG_ATTEMPTS = 5
_SLUG_FALLBACK = "team"


class AccountCreate(BaseModel):
    email: EmailStr
    name: str
    password: str
    role: str = "participant"


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[ACCOUNTS_COLLECTION].create_index("email", unique=True)
    # Slug dùng để ghép object key (ADR-033). Account cũ chưa có field này, mà unique index thường coi
    # mọi document thiếu field là cùng giá trị null nên chỉ cho đúng một account như vậy tồn tại.
    # `sparse` loại hẳn chúng khỏi index - tương đương `partialFilterExpression` ở đây vì field chỉ
    # nhận chuỗi khác rỗng, và là lựa chọn duy nhất mongomock trong test áp đúng lúc tạo index.
    await db[ACCOUNTS_COLLECTION].create_index("slug", unique=True, sparse=True)


async def ensure_account_slug(db: AsyncIOMotorDatabase, account: dict) -> str:
    """Slug bất biến của account, sinh từ `name` ở lần nộp bài đầu tiên.

    Sinh lazy vì slug chỉ phục vụ đường dẫn object, không hiển thị ở đâu; account cũ tự có slug khi
    cần nên không phải backfill. Đổi `name` về sau KHÔNG sinh lại slug - object đã ghi theo slug cũ.
    """
    if account.get("slug"):
        return account["slug"]

    # Chừa 4 ký tự cho hậu tố "-xxx" để cả slug dài nhất vẫn lọt trần SLUG_MAX.
    base = (slugify(account["name"]) or _SLUG_FALLBACK)[: SLUG_MAX - 4].strip("-") or _SLUG_FALLBACK
    collection = db[ACCOUNTS_COLLECTION]
    for attempt in range(_SLUG_ATTEMPTS):
        candidate = base if attempt == 0 else f"{base}-{_random_suffix()}"
        # Đội khác đã giữ slug này thì đổi hậu tố ngay, không để index phải ném lỗi.
        if await collection.find_one({"slug": candidate}, {"_id": 1}) is not None:
            continue
        try:
            result = await collection.update_one(
                {"_id": account["_id"], "slug": {"$exists": False}},
                {"$set": {"slug": candidate, "updated_at": datetime.now(timezone.utc)}},
            )
        except DuplicateKeyError:
            # Hai request cùng sinh slug một lúc: index là chốt, tính lại rồi thử tiếp.
            continue
        if result.modified_count:
            return candidate
        # Ghi hụt: một request khác vừa đặt slug cho chính account này.
        current = await collection.find_one({"_id": account["_id"]}, {"slug": 1})
        if current and current.get("slug"):
            return current["slug"]
    raise RuntimeError("Cannot allocate a unique account slug.")


def _random_suffix() -> str:
    return "".join(secrets.choice(_SLUG_ALPHABET) for _ in range(_SLUG_SUFFIX_LEN))


async def create_account(db: AsyncIOMotorDatabase, data: AccountCreate) -> dict:
    email = data.email.lower()
    now = datetime.now(timezone.utc)
    result = await db[ACCOUNTS_COLLECTION].insert_one(
        {
            "email": email,
            "name": data.name.strip(),
            "password_hash": hash_password(data.password),
            "role": data.role,
            "active": True,
            "created_at": now,
            "updated_at": now,
        }
    )
    return await db[ACCOUNTS_COLLECTION].find_one({"_id": result.inserted_id})


async def find_account_by_email(db: AsyncIOMotorDatabase, email: str) -> dict | None:
    return await db[ACCOUNTS_COLLECTION].find_one({"email": email.strip().lower()})


async def account_stats(db: AsyncIOMotorDatabase) -> dict[str, int]:
    """Đếm toàn hệ thống theo role/active. Tài khoản legacy thiếu `active` tính là đang hoạt động."""
    stats = {"total": 0, "admin": 0, "participant": 0, "active": 0}
    pipeline = [
        {
            "$group": {
                "_id": {"role": "$role", "active": {"$ifNull": ["$active", True]}},
                "count": {"$sum": 1},
            }
        }
    ]
    async for group in db[ACCOUNTS_COLLECTION].aggregate(pipeline):
        count = group["count"]
        stats["total"] += count
        role = group["_id"]["role"]
        if role in ("admin", "participant"):
            stats[role] += count
        if group["_id"]["active"]:
            stats["active"] += count
    return stats


def public_account(account: dict) -> dict:
    return {
        "id": str(account["_id"]),
        "email": account["email"],
        "name": account["name"],
        "role": account["role"],
        "active": account.get("active", True),
    }


async def account_audit_references(db: AsyncIOMotorDatabase, account_id) -> bool:
    """Account có nằm trong vết hậu kiểm không: người duyệt bài, hoặc người sửa cấu hình AI.

    Chỉ admin mới xuất hiện ở hai chỗ này, và cả hai đều là vết không được phép trỏ vào hư không -
    xoá account đi thì hậu kiểm mất đường truy về người đã ra quyết định.
    """
    from app.ai_review.settings import CONFIG_FIELD
    from app.competitions.service import COMPETITIONS_COLLECTION
    from app.submissions.service import REVIEW_FIELD, SUBMISSIONS_COLLECTION

    if await db[SUBMISSIONS_COLLECTION].count_documents(
        {f"{REVIEW_FIELD}.reviewed_by": account_id}, limit=1
    ):
        return True
    return (
        await db[COMPETITIONS_COLLECTION].count_documents(
            {f"{CONFIG_FIELD}.updated_by": account_id}, limit=1
        )
        > 0
    )


async def delete_account_cascade(db: AsyncIOMotorDatabase, account: dict) -> dict[str, int]:
    """Xoá account kèm toàn bộ dữ liệu con. Con trước cha sau, gọi lại được nếu lỗi giữa đường.

    Mongo standalone không có transaction: account chỉ mất ở bước cuối, nên một bước hỏng giữa
    đường vẫn còn bản ghi để lần gọi sau chạy tiếp, thay vì để lại dữ liệu con mồ côi.

    Người gọi phải chặn trước tài khoản có bài đã chấm điểm - hàm này không tự kiểm.
    """
    from app.ai_review import queue as ai_queue
    from app.ai_review import service as ai_service
    from app.auth.sessions import SESSIONS_COLLECTION
    from app.memberships.service import MEMBERSHIPS_COLLECTION
    from app.submissions import service as submissions_service

    account_id = account["_id"]
    # Job và audit row AI đứng trước submission: cả hai tham chiếu tới nó.
    jobs = await db[ai_queue.JOBS_COLLECTION].delete_many({"account_id": account_id})
    reviews = await db[ai_service.REVIEWS_COLLECTION].delete_many({"account_id": account_id})
    submissions = await submissions_service.delete_submissions_matching(
        db, {"account_id": account_id, "status": {"$ne": "completed"}}
    )
    memberships = await db[MEMBERSHIPS_COLLECTION].delete_many({"account_id": account_id})
    # Session phải đi cùng account: bỏ sót thì token cũ vẫn đăng nhập được vào tài khoản đã xoá.
    sessions = await db[SESSIONS_COLLECTION].delete_many({"account_id": account_id})
    await db[ACCOUNTS_COLLECTION].delete_one({"_id": account_id})
    return {
        "ai_review_jobs": jobs.deleted_count,
        "ai_reviews": reviews.deleted_count,
        "submissions": submissions,
        "memberships": memberships.deleted_count,
        "sessions": sessions.deleted_count,
    }
