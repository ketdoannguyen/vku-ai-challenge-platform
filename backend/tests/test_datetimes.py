"""Helpers datetime dùng chung: Mongo trả naive, Pydantic trả aware, so sánh phải qua as_utc."""

from datetime import datetime, timedelta, timezone

from app.core.datetimes import as_utc, iso_z, utc_day_bounds

PLUS_SEVEN = timezone(timedelta(hours=7))


def test_as_utc_treats_naive_as_utc():
    assert as_utc(datetime(2026, 10, 1, 12, 30)) == datetime(2026, 10, 1, 12, 30, tzinfo=timezone.utc)


def test_as_utc_normalizes_aware_to_utc():
    aware = datetime(2026, 10, 1, 19, 30, tzinfo=PLUS_SEVEN)
    assert as_utc(aware) == datetime(2026, 10, 1, 12, 30, tzinfo=timezone.utc)


def test_naive_and_aware_same_instant_compare_equal():
    """Đây là regression gốc: so naive với aware trực tiếp sẽ TypeError ở Python."""
    naive = datetime(2026, 10, 1, 12, 30)
    aware = datetime(2026, 10, 1, 19, 30, tzinfo=PLUS_SEVEN)
    assert as_utc(naive) == as_utc(aware)


def test_utc_day_bounds_covers_now_and_stops_at_next_midnight():
    now = datetime(2026, 10, 1, 23, 59, 59, 999999, tzinfo=timezone.utc)
    start, end = utc_day_bounds(now)
    assert start == datetime(2026, 10, 1, tzinfo=timezone.utc)
    assert end == datetime(2026, 10, 2, tzinfo=timezone.utc)
    assert start <= now < end


def test_utc_day_bounds_normalizes_naive_input():
    start, end = utc_day_bounds(datetime(2026, 10, 1, 5, 0))
    assert start == datetime(2026, 10, 1, tzinfo=timezone.utc)
    assert end == datetime(2026, 10, 2, tzinfo=timezone.utc)


def test_iso_z_always_utc_with_z_suffix():
    assert iso_z(datetime(2026, 10, 1, 19, 30, tzinfo=PLUS_SEVEN)) == "2026-10-01T12:30:00Z"
    assert iso_z(datetime(2026, 10, 1, 12, 30)) == "2026-10-01T12:30:00Z"
