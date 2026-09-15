"""Tạo admin đầu tiên — chạy: python scripts/create_admin.py <email> <name> <password>

Idempotent: nếu email đã tồn tại thì báo rõ và thoát lỗi (không ghi đè).
Không in password hay hash ra stdout.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.accounts.service import AccountCreate, create_account, ensure_indexes, find_account_by_email  # noqa: E402
from app.auth.passwords import password_policy_error  # noqa: E402
from app.core.config import get_settings  # noqa: E402


async def main() -> int:
    if len(sys.argv) != 4:
        print("Cách dùng: python scripts/create_admin.py <email> <name> <password>", file=sys.stderr)
        return 2
    email, name, password = sys.argv[1], sys.argv[2], sys.argv[3]

    policy_error = password_policy_error(password)
    if policy_error:
        print(f"Lỗi: {policy_error}", file=sys.stderr)
        return 2

    settings = get_settings()
    client = AsyncIOMotorClient(settings.mongo_uri, serverSelectionTimeoutMS=5000)
    db = client[settings.mongo_database]
    try:
        await ensure_indexes(db)
        if await find_account_by_email(db, email) is not None:
            print(f"Bỏ qua: email {email} đã có tài khoản. Không ghi đè.", file=sys.stderr)
            return 1
        account = await create_account(db, AccountCreate(email=email, name=name, password=password, role="admin"))
        print(f"Đã tạo admin: {account['email']}")
        return 0
    except Exception as exc:
        if "ServerSelectionTimeoutError" in type(exc).__name__ or "failed to connect" in str(exc).lower():
            print(f"Lỗi: không kết nối được MongoDB tại {settings.mongo_host}:{settings.mongo_port}.", file=sys.stderr)
            return 1
        raise
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
