"""Sinh slug account (ADR-033): slug hoá tên đội và cấp slug duy nhất, bất biến."""

import asyncio

import pytest

from app.accounts.service import ACCOUNTS_COLLECTION, ensure_account_slug
from app.core.slugs import SLUG_MAX, is_valid_slug, slugify

PARTICIPANT_EMAIL = "thi.sinh@vku.vn"


def _account(client, email: str) -> dict:
    async def load():
        return await client.app.state.mongo.db[ACCOUNTS_COLLECTION].find_one({"email": email})

    return asyncio.run(load())


# --- slugify ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Đội A", "doi-a"),
        ("Đội Thi Sinh", "doi-thi-sinh"),
        ("Khánh Hoà - Team 01", "khanh-hoa-team-01"),
        ("VKU__CAHLLENG", "vku-cahlleng"),
        ("../../etc/passwd", "etc-passwd"),
        ('"; rm -rf /', "rm-rf"),
        ("  khoảng   trắng  ", "khoang-trang"),
        ("team", "team"),
    ],
)
def test_slugify_normalises_free_text(raw, expected):
    assert slugify(raw) == expected


@pytest.mark.parametrize("raw", ["日本語", "", "   ", "---", "!!!"])
def test_slugify_returns_empty_when_nothing_survives(raw):
    assert slugify(raw) == ""


def test_slugify_is_bounded_and_always_a_valid_slug():
    assert len(slugify("a" * 200)) == SLUG_MAX
    for raw in ("Đội A", "a" * 200, "Khánh Hoà - Team 01", "khoảng trắng"):
        assert is_valid_slug(slugify(raw)), raw


# --- ensure_account_slug ---------------------------------------------------


def test_slug_is_generated_once_and_never_regenerated(client):
    """Sinh lazy ở lần nộp đầu tiên rồi bất biến - đổi tên đội không được đổi slug."""
    account = _account(client, PARTICIPANT_EMAIL)
    assert account.get("slug") is None

    db = client.app.state.mongo.db
    slug = asyncio.run(ensure_account_slug(db, account))
    assert slug == "thi-sinh"
    assert asyncio.run(ensure_account_slug(db, account)) == slug
    # Account đã có slug: gọi lại chỉ đọc, không ghi thêm gì.
    assert _account(client, PARTICIPANT_EMAIL)["slug"] == slug

    asyncio.run(
        db[ACCOUNTS_COLLECTION].update_one({"_id": account["_id"]}, {"$set": {"name": "Đội Khác"}})
    )
    assert asyncio.run(ensure_account_slug(db, _account(client, PARTICIPANT_EMAIL))) == slug


def test_slug_appends_random_suffix_when_base_is_taken(client):
    db = client.app.state.mongo.db
    asyncio.run(
        db[ACCOUNTS_COLLECTION].insert_one(
            {"email": "khac@vku.vn", "name": "Thí Sinh", "role": "participant", "slug": "thi-sinh"}
        )
    )

    slug = asyncio.run(ensure_account_slug(db, _account(client, PARTICIPANT_EMAIL)))
    assert slug.startswith("thi-sinh-")
    assert len(slug) == len("thi-sinh-") + 3
    assert is_valid_slug(slug)


def test_slug_falls_back_for_names_without_ascii(client):
    db = client.app.state.mongo.db
    asyncio.run(
        db[ACCOUNTS_COLLECTION].insert_one({"email": "ja@vku.vn", "name": "日本語"})
    )
    account = asyncio.run(db[ACCOUNTS_COLLECTION].find_one({"email": "ja@vku.vn"}))
    assert asyncio.run(ensure_account_slug(db, account)) == "team"
