"""Competition membership persistence and public representations."""

from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.core.datetimes import iso_z

MEMBERSHIPS_COLLECTION = "competition_memberships"


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    collection = db[MEMBERSHIPS_COLLECTION]
    await collection.create_index(
        [("competition_id", 1), ("account_id", 1)],
        unique=True,
    )
    await collection.create_index("account_id")


async def get_membership(db, competition_id, account_id) -> dict | None:
    return await db[MEMBERSHIPS_COLLECTION].find_one(
        {"competition_id": competition_id, "account_id": account_id}
    )


async def memberships_by_competition(db, competition_ids: list, account_id) -> dict:
    if not competition_ids:
        return {}
    cursor = db[MEMBERSHIPS_COLLECTION].find(
        {"competition_id": {"$in": competition_ids}, "account_id": account_id}
    )
    return {membership["competition_id"]: membership async for membership in cursor}


async def ensure_membership(db, competition_id, account_id) -> tuple[dict, bool]:
    """Create once; duplicate requests return the existing membership."""
    existing = await get_membership(db, competition_id, account_id)
    if existing is not None:
        return existing, False

    now = datetime.now(timezone.utc)
    document = {
        "competition_id": competition_id,
        "account_id": account_id,
        "active": True,
        "joined_at": now,
        "updated_at": now,
    }
    try:
        result = await db[MEMBERSHIPS_COLLECTION].insert_one(document)
        document["_id"] = result.inserted_id
        return document, True
    except DuplicateKeyError:
        return await get_membership(db, competition_id, account_id), False


async def set_membership_active(db, membership: dict, active: bool) -> dict:
    await db[MEMBERSHIPS_COLLECTION].update_one(
        {"_id": membership["_id"]},
        {"$set": {"active": active, "updated_at": datetime.now(timezone.utc)}},
    )
    return await db[MEMBERSHIPS_COLLECTION].find_one({"_id": membership["_id"]})


def public_membership(membership: dict | None) -> dict:
    if membership is None:
        return {"active": False, "joined_at": None}
    return {
        "active": membership.get("active", True),
        "joined_at": iso_z(membership["joined_at"]),
    }


def member_view(membership: dict, account: dict) -> dict:
    return {
        "account_id": str(account["_id"]),
        "email": account["email"],
        "name": account["name"],
        "role": account["role"],
        "active": membership.get("active", True),
        "joined_at": iso_z(membership["joined_at"]),
    }
