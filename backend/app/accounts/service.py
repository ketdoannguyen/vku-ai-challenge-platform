"""Account service: tạo/tra cứu/cập nhật accounts. Không bao giờ trả password_hash."""

from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, EmailStr

from app.auth.passwords import hash_password

ACCOUNTS_COLLECTION = "accounts"


class AccountCreate(BaseModel):
    email: EmailStr
    name: str
    password: str
    role: str = "participant"


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[ACCOUNTS_COLLECTION].create_index("email", unique=True)


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


def public_account(account: dict) -> dict:
    return {
        "id": str(account["_id"]),
        "email": account["email"],
        "name": account["name"],
        "role": account["role"],
        "active": account.get("active", True),
    }
