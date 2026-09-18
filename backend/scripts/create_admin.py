"""Tạo admin đầu tiên — chạy: python scripts/create_admin.py <email> <name>

Mật khẩu KHÔNG truyền qua tham số dòng lệnh (sẽ lộ trong `ps` và shell history):
script hỏi ẩn khi có TTY, hoặc đọc một dòng từ stdin khi được pipe.

Idempotent: nếu email đã tồn tại thì báo rõ và thoát lỗi (không ghi đè).
Không in password hay hash ra stdout.

Ví dụ trên VPS production (nhập mật khẩu ở prompt ẩn):
    sudo docker compose -f docker-compose.prod.yml exec api \\
        python scripts/create_admin.py admin@vku.udn.vn "ADMIN NKD"
"""

import asyncio
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app.accounts.service import AccountCreate, create_account, ensure_indexes, find_account_by_email  # noqa: E402
from app.auth.passwords import password_policy_error  # noqa: E402
from app.core.config import get_settings  # noqa: E402


def read_password() -> str:
    """Đọc mật khẩu: prompt ẩn khi tương tác, đọc trọn một dòng khi stdin là pipe/file."""
    if sys.stdin.isatty():
        return getpass.getpass("Mật khẩu admin: ")
    return sys.stdin.readline().rstrip("\r\n")


async def main() -> int:
    if len(sys.argv) != 3:
        print("Cách dùng: python scripts/create_admin.py <email> <name>", file=sys.stderr)
        return 2
    email, name = sys.argv[1], sys.argv[2]

    password = read_password()
    policy_error = password_policy_error(password)
    if policy_error:
        print(f"Lỗi: {policy_error}", file=sys.stderr)
        return 2

    try:
        data = AccountCreate(email=email, name=name, password=password, role="admin")
    except ValidationError:
        print(f"Lỗi: email không hợp lệ: {email}", file=sys.stderr)
        return 2

    settings = get_settings()
    client = AsyncIOMotorClient(settings.mongo_uri, serverSelectionTimeoutMS=5000)
    db = client[settings.mongo_database]
    try:
        await ensure_indexes(db)
        if await find_account_by_email(db, email) is not None:
            print(f"Bỏ qua: email {email} đã có tài khoản. Không ghi đè.", file=sys.stderr)
            return 1
        account = await create_account(db, data)
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
