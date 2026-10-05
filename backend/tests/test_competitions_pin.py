"""Ghim cuộc thi theo tài khoản: PUT/DELETE idempotent và cờ `pinned` trên danh sách.

Ghim là sở thích riêng của từng account, lưu trên chính document account; không cần membership,
không lộ qua `GET /auth/me` và không cần thêm collection/index.
"""

import asyncio
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.accounts.service import ACCOUNTS_COLLECTION, set_competition_pin
from app.competitions.service import COMPETITIONS_COLLECTION


def _run(awaitable):
    return asyncio.run(awaitable)


def _login_admin(client) -> None:
    response = client.post(
        "/api/auth/login", json={"identifier": "admin@vku.vn", "password": "adminmatkhau1"}
    )
    assert response.status_code == 200


def _login_participant(client) -> None:
    response = client.post(
        "/api/auth/login", json={"identifier": "thi.sinh@vku.vn", "password": "thisinhmatkhau1"}
    )
    assert response.status_code == 200


def _competition(client, slug: str, *, status: str = "published") -> ObjectId:
    competition_id = ObjectId()
    now = datetime.now(timezone.utc)
    _run(
        client.app.state.mongo.db[COMPETITIONS_COLLECTION].insert_one(
            {
                "_id": competition_id,
                "slug": slug,
                "name": slug.replace("-", " ").title(),
                "status": status,
                "primary_metric": "f1",
                "join_mode": "open",
                "quota_per_day": 5,
                "leaderboard_visible": True,
                "created_by": "admin@vku.vn",
                "start_at": now - timedelta(days=1),
                "end_at": now + timedelta(days=1),
            }
        )
    )
    return competition_id


def _list_items(client) -> dict:
    response = client.get("/api/competitions")
    assert response.status_code == 200
    return {item["slug"]: item for item in response.json()["competitions"]}


def _pinned_ids(client, email: str):
    """Mảng ghim thô trên document account; None là account cũ chưa từng ghim."""
    account = _run(client.app.state.mongo.db[ACCOUNTS_COLLECTION].find_one({"email": email}))
    return account.get("pinned_competition_ids")


def test_guest_sees_pinned_false_and_cannot_toggle(client):
    _competition(client, "pin-guest")

    assert _list_items(client)["pin-guest"]["pinned"] is False
    assert client.put("/api/competitions/pin-guest/pin").status_code == 401
    assert client.delete("/api/competitions/pin-guest/pin").status_code == 401


def test_pin_and_unpin_round_trip(client):
    competition_id = _competition(client, "pin-round")
    _login_participant(client)

    # Account cũ chưa có field: coi như chưa ghim gì.
    assert _pinned_ids(client, "thi.sinh@vku.vn") is None
    assert _list_items(client)["pin-round"]["pinned"] is False

    pinned = client.put("/api/competitions/pin-round/pin")
    assert pinned.status_code == 200
    assert pinned.json() == {"competition_id": str(competition_id), "pinned": True}
    assert _list_items(client)["pin-round"]["pinned"] is True
    assert _pinned_ids(client, "thi.sinh@vku.vn") == [competition_id]

    unpinned = client.delete("/api/competitions/pin-round/pin")
    assert unpinned.status_code == 200
    assert unpinned.json() == {"competition_id": str(competition_id), "pinned": False}
    assert _list_items(client)["pin-round"]["pinned"] is False
    assert _pinned_ids(client, "thi.sinh@vku.vn") == []


def test_repeat_pin_and_unpin_are_idempotent(client):
    competition_id = _competition(client, "pin-repeat")
    _login_participant(client)

    for _ in range(2):
        response = client.put("/api/competitions/pin-repeat/pin")
        assert response.status_code == 200
        assert response.json() == {"competition_id": str(competition_id), "pinned": True}
    assert _pinned_ids(client, "thi.sinh@vku.vn") == [competition_id]

    for _ in range(2):
        response = client.delete("/api/competitions/pin-repeat/pin")
        assert response.status_code == 200
        assert response.json() == {"competition_id": str(competition_id), "pinned": False}
    assert _pinned_ids(client, "thi.sinh@vku.vn") == []


def test_pin_only_affects_target_competition(client):
    _competition(client, "pin-one")
    _competition(client, "pin-two")
    _login_participant(client)

    assert client.put("/api/competitions/pin-one/pin").status_code == 200
    items = _list_items(client)
    assert items["pin-one"]["pinned"] is True
    assert items["pin-two"]["pinned"] is False


def test_pins_are_private_per_account(client):
    _competition(client, "pin-private")
    _login_participant(client)
    assert client.put("/api/competitions/pin-private/pin").status_code == 200

    client.post("/api/auth/logout")
    _login_admin(client)
    assert _list_items(client)["pin-private"]["pinned"] is False


def test_non_member_can_pin_closed_competition(client):
    _competition(client, "pin-closed", status="closed")
    _login_participant(client)

    assert client.put("/api/competitions/pin-closed/pin").status_code == 200
    item = _list_items(client)["pin-closed"]
    assert item["pinned"] is True
    # Ghim không cấp quyền thành viên: vẫn không có hạng/điểm.
    assert "my_stats" not in item


def test_draft_and_unknown_slug_return_404(client):
    _competition(client, "pin-draft", status="draft")
    _login_participant(client)

    for slug in ("pin-draft", "pin-missing"):
        assert client.put(f"/api/competitions/{slug}/pin").status_code == 404
        assert client.delete(f"/api/competitions/{slug}/pin").status_code == 404
    assert "pin-draft" not in _list_items(client)


def test_concurrent_pins_do_not_duplicate_id(client):
    """Hai lượt ghim chồng nhau không nhân đôi id. Mongo giả chạy tuần tự nên test chỉ khẳng định
    idempotent của hai lượt gọi; tính nguyên tử thật đến từ `$addToSet` trong service."""
    account = _run(
        client.app.state.mongo.db[ACCOUNTS_COLLECTION].find_one({"email": "thi.sinh@vku.vn"})
    )
    competition_id = _competition(client, "pin-race")

    async def race():
        await asyncio.gather(
            set_competition_pin(
                client.app.state.mongo.db, account["_id"], competition_id, pinned=True
            ),
            set_competition_pin(
                client.app.state.mongo.db, account["_id"], competition_id, pinned=True
            ),
        )

    _run(race())
    assert _pinned_ids(client, "thi.sinh@vku.vn") == [competition_id]


def test_pins_do_not_leak_through_public_account(client):
    _competition(client, "pin-me")
    _login_participant(client)
    assert client.put("/api/competitions/pin-me/pin").status_code == 200

    body = client.get("/api/auth/me").json()
    assert "pinned_competition_ids" not in body
    assert "pins" not in body
