"""Helpers datetime dùng chung.

Mongo (motor, tz_aware=False) trả về datetime naive theo UTC còn Pydantic parse ISO
thành datetime aware. So sánh trực tiếp hai loại này sẽ TypeError, nên mọi phép so
sánh/định dạng phải đi qua các helper ở đây.
"""

from datetime import datetime, timedelta, timezone


def as_utc(value: datetime) -> datetime:
    """Coi naive là UTC (quy ước lưu trữ hiện tại), aware thì đổi về UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def utc_day_bounds(now: datetime) -> tuple[datetime, datetime]:
    """Trả [đầu ngày UTC, đầu ngày kế tiếp) chứa `now` - dùng cho quota theo ngày."""
    start = as_utc(now).replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=1)


def iso_z(value: datetime) -> str:
    """ISO 8601 UTC với hậu tố `Z` - định dạng mọi timestamp trả ra API."""
    return as_utc(value).isoformat().replace("+00:00", "Z")
