"""Server-side session: opaque random token, DB lưu sha256(token) (ADR-004)."""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

SESSIONS_COLLECTION = "sessions"


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[SESSIONS_COLLECTION].create_index("expires_at", expireAfterSeconds=0)
    await db[SESSIONS_COLLECTION].create_index("account_id")


async def create_session(db: AsyncIOMotorDatabase, account_id: ObjectId, lifetime_hours: int) -> str:
    token = new_session_token()
    now = datetime.now(timezone.utc)
    await db[SESSIONS_COLLECTION].insert_one(
        {
            "_id": hash_token(token),
            "account_id": account_id,
            "created_at": now,
            "expires_at": now + timedelta(hours=lifetime_hours),
        }
    )
    return token


async def resolve_session(
    db: AsyncIOMotorDatabase, token: str
) -> dict | None:
    """Trả document account nếu session còn hạn và account active, ngược lại None.

    Mongo TTL index chỉ dọn khi có write xảy ra, nên vẫn phải check expires_at ở đây.
    """
    session = await db[SESSIONS_COLLECTION].find_one({"_id": hash_token(token)})
    if session is None:
        return None
    expires_at = session["expires_at"]
    if expires_at.tzinfo is None:  # Mongo trả naive UTC
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) >= expires_at:
        await db[SESSIONS_COLLECTION].delete_one({"_id": session["_id"]})
        return None
    account = await db["accounts"].find_one({"_id": session["account_id"]})
    if account is None or not account.get("active", False):
        return None
    return account


async def delete_session(db: AsyncIOMotorDatabase, token: str) -> None:
    await db[SESSIONS_COLLECTION].delete_one({"_id": hash_token(token)})
