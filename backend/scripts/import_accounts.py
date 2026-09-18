"""Import hàng loạt participant từ CSV - chạy: python scripts/import_accounts.py <file.csv>

Định dạng CSV (header bắt buộc): email,name,password
Mỗi dòng một account role=participant. Duplicate email trong file hoặc đã tồn tại
trong DB → in cảnh báo và bỏ qua dòng đó (không im lặng); dòng hợp lệ vẫn được tạo.
Không in password hay hash ra stdout.

Ví dụ file:
    email,name,password
    team01@vku.vn,Đội 01,matkhau-do-01
    team02@vku.vn,Đội 02,matkhau-do-02
"""

import asyncio
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app.accounts.service import AccountCreate, create_account, ensure_indexes, find_account_by_email  # noqa: E402
from app.auth.passwords import password_policy_error  # noqa: E402
from app.core.config import get_settings  # noqa: E402


async def main() -> int:
    if len(sys.argv) != 2:
        print("Cách dùng: python scripts/import_accounts.py <file.csv>", file=sys.stderr)
        return 2
    csv_path = Path(sys.argv[1])
    if not csv_path.is_file():
        print(f"Lỗi: không tìm thấy file {csv_path}", file=sys.stderr)
        return 2

    rows: list[dict] = []
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None or not {"email", "name", "password"}.issubset(set(reader.fieldnames)):
            print("Lỗi: CSV phải có header: email,name,password", file=sys.stderr)
            return 2
        rows = [row for row in reader if any((row.get(c) or "").strip() for c in ("email", "name", "password"))]

    settings = get_settings()
    client = AsyncIOMotorClient(settings.mongo_uri, serverSelectionTimeoutMS=5000)
    db = client[settings.mongo_database]
    created = skipped = 0
    seen_emails: set[str] = set()
    try:
        await ensure_indexes(db)
        for i, row in enumerate(rows, start=2):  # dòng 1 là header
            email = (row.get("email") or "").strip().lower()
            name = (row.get("name") or "").strip()
            password = (row.get("password") or "").strip()
            try:
                data = AccountCreate(email=email, name=name, password=password, role="participant")
            except ValidationError:
                print(f"Dòng {i}: BỎ QUA - email/k dữ liệu không hợp lệ ({email or 'trống'})", file=sys.stderr)
                skipped += 1
                continue
            if policy_error := password_policy_error(data.password):
                print(f"Dòng {i}: BỎ QUA - {policy_error} ({email})", file=sys.stderr)
                skipped += 1
                continue
            if email in seen_emails or await find_account_by_email(db, email) is not None:
                print(f"Dòng {i}: BỎ QUA - email đã tồn tại ({email})", file=sys.stderr)
                skipped += 1
                continue
            await create_account(db, data)
            seen_emails.add(email)
            created += 1
        print(f"Hoàn tất: tạo {created}, bỏ qua {skipped}.")
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
