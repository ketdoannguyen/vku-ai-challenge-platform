"""Participant competition API: visibility, detail by slug, draft ẩn."""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from bson import ObjectId

from app.competitions.service import COMPETITIONS_COLLECTION
from tests.helpers import publish_competition


@pytest.fixture()
def seeded(client):
    """Admin tạo 3 competitions: draft, published, closed; đăng nhập participant."""
    resp = client.post("/api/auth/login", json={"identifier": "admin@vku.vn", "password": "adminmatkhau1"})
    assert resp.status_code == 200
    for slug, name in (("draft-cup", "Draft Cup"), ("open-cup", "Open Cup"), ("closed-cup", "Closed Cup")):
        body = {
            "slug": slug,
            "name": name,
            "short_description": f"Mo tả {name}",
            "start_at": "2026-10-01T00:00:00Z",
            "end_at": "2026-11-01T00:00:00Z",
        }
        cid = client.post("/api/admin/competitions", json=body).json()["id"]
        if slug != "draft-cup":
            assert publish_competition(client, cid).status_code == 200
        if slug == "closed-cup":
            assert client.post(f"/api/admin/competitions/{cid}/close").status_code == 200
    resp = client.post("/api/auth/login", json={"identifier": "thi.sinh@vku.vn", "password": "thisinhmatkhau1"})
    assert resp.status_code == 200
    return client


def test_guest_list_hides_draft_and_membership(seeded):
    """Khách chưa đăng nhập đọc được danh sách (ADR-014) nhưng không thấy draft."""
    seeded.post("/api/auth/logout")
    resp = seeded.get("/api/competitions")
    assert resp.status_code == 200
    assert [c["slug"] for c in resp.json()["competitions"]] == ["closed-cup", "open-cup"]
    for competition in resp.json()["competitions"]:
        assert competition["membership"] == {"active": False, "joined_at": None}
        assert "join_code" not in competition
        assert "join_code_hash" not in competition


def test_guest_detail_by_slug_and_draft_404(seeded):
    seeded.post("/api/auth/logout")
    assert seeded.get("/api/competitions/open-cup").json()["membership"] == {
        "active": False,
        "joined_at": None,
    }
    assert seeded.get("/api/competitions/draft-cup").status_code == 404


def test_public_list_hides_draft(seeded):
    resp = seeded.get("/api/competitions")
    assert resp.status_code == 200
    slugs = [c["slug"] for c in resp.json()["competitions"]]
    assert slugs == ["closed-cup", "open-cup"]  # sort name asc
    for c in resp.json()["competitions"]:
        assert "join_code" not in c
        assert "join_code_hash" not in c


def test_public_detail_by_slug(seeded):
    resp = seeded.get("/api/competitions/open-cup")
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Open Cup"
    assert body["status"] == "published"
    assert "join_code" not in body


def test_public_detail_draft_returns_404(seeded):
    resp = seeded.get("/api/competitions/draft-cup")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_public_detail_unknown_slug_404(seeded):
    assert seeded.get("/api/competitions/khong-ton-tai").status_code == 404


def test_public_payload_never_exposes_created_by(seeded):
    """created_by là email admin - từng rò cho cả khách ẩn danh lẫn participant chưa join."""
    seeded.post("/api/auth/logout")
    guest_list = seeded.get("/api/competitions").json()["competitions"]
    assert guest_list
    for competition in guest_list:
        assert "created_by" not in competition
    assert "created_by" not in seeded.get("/api/competitions/open-cup").json()

    seeded.post("/api/auth/login", json={"identifier": "thi.sinh@vku.vn", "password": "thisinhmatkhau1"})
    assert "created_by" not in seeded.get("/api/competitions/open-cup").json()


def test_public_detail_exposes_resources_to_guest(client):
    """Khách xem tổng quan vẫn thấy link dataset - đây là cách BTC phát tài nguyên."""
    resources = [{"label": "Dataset", "url": "https://drive.google.com/drive/folders/abc"}]
    client.post("/api/auth/login", json={"identifier": "admin@vku.vn", "password": "adminmatkhau1"})
    cid = client.post(
        "/api/admin/competitions",
        json={
            "slug": "resource-cup",
            "name": "Resource Cup",
            "start_at": "2026-10-01T00:00:00Z",
            "end_at": "2026-11-01T00:00:00Z",
            "resources": resources,
        },
    ).json()["id"]
    assert publish_competition(client, cid).status_code == 200
    client.post("/api/auth/logout")

    assert client.get("/api/competitions/resource-cup").json()["resources"] == resources


def _open_competition(client, slug="quota-cup", quota_per_day=3) -> str:
    """Cuộc thi đang thật sự mở (cửa sổ quanh hiện tại) để quota đếm được bài nộp."""
    now = datetime.now(timezone.utc)
    client.post("/api/auth/login", json={"identifier": "admin@vku.vn", "password": "adminmatkhau1"})
    cid = client.post(
        "/api/admin/competitions",
        json={
            "slug": slug,
            "name": slug,
            "start_at": (now - timedelta(days=1)).isoformat(),
            "end_at": (now + timedelta(days=1)).isoformat(),
            "quota_per_day": quota_per_day,
        },
    ).json()["id"]
    assert publish_competition(client, cid).status_code == 200
    return cid


def _login_participant(client):
    client.post("/api/auth/login", json={"identifier": "thi.sinh@vku.vn", "password": "thisinhmatkhau1"})


def _submit(client, competition_id, data=b"id,prediction\n1,1\n2,0\n3,1\n4,0\n"):
    return client.post(
        f"/api/competitions/{competition_id}/submissions",
        files={"file": ("answers.csv", data, "text/csv")},
    )


def test_quota_block_only_for_active_member_on_detail(client):
    cid = _open_competition(client)
    client.post("/api/auth/logout")
    assert "quota" not in client.get("/api/competitions/quota-cup").json()
    # Guest cũng không thấy quota trong list.
    assert "quota" not in client.get("/api/competitions").json()["competitions"][0]

    _login_participant(client)
    assert "quota" not in client.get("/api/competitions/quota-cup").json()
    assert "quota" not in client.get("/api/competitions").json()["competitions"][0]

    assert client.post("/api/competitions/quota-cup/join", json={}).status_code == 200
    quota = client.get("/api/competitions/quota-cup").json()["quota"]
    assert quota["per_day"] == 3
    assert quota["used_today"] == 0
    assert quota["remaining"] == 3
    assert quota["resets_at"].endswith("Z")
    next_midnight = (datetime.now(timezone.utc) + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    assert datetime.fromisoformat(quota["resets_at"].replace("Z", "+00:00")) == next_midnight

    submitted = _submit(client, cid)
    assert submitted.status_code == 201
    assert submitted.json()["quota_remaining"] == 2
    after = client.get("/api/competitions/quota-cup").json()["quota"]
    assert after["used_today"] == 1
    assert after["remaining"] == 2
    # List vẫn không tính quota dù member đang hoạt động - tránh N+1.
    assert "quota" not in client.get("/api/competitions").json()["competitions"][0]


def test_quota_excludes_yesterday_and_absent_for_inactive_member(client):
    cid = _open_competition(client, quota_per_day=1)
    _login_participant(client)
    assert client.post("/api/competitions/quota-cup/join", json={}).status_code == 200
    assert _submit(client, cid).status_code == 201
    assert client.get("/api/competitions/quota-cup").json()["quota"]["remaining"] == 0

    async def backdate():
        await client.app.state.mongo.db["submissions"].update_many(
            {"status": "completed"},
            {"$set": {"created_at": datetime.now(timezone.utc) - timedelta(days=1)}},
        )

    asyncio.run(backdate())
    reset = client.get("/api/competitions/quota-cup").json()["quota"]
    assert reset["used_today"] == 0
    assert reset["remaining"] == 1

    client.post("/api/auth/login", json={"identifier": "admin@vku.vn", "password": "adminmatkhau1"})
    account_id = client.get(f"/api/admin/competitions/{cid}/members").json()["members"][0]["account_id"]
    assert client.patch(
        f"/api/admin/competitions/{cid}/members/{account_id}", json={"active": False}
    ).status_code == 200
    _login_participant(client)
    assert "quota" not in client.get("/api/competitions/quota-cup").json()


def test_legacy_document_without_resources_serializes_empty(client):
    """Document tạo trước khi có field resources vẫn phải trả [] - không migration Mongo."""
    now = datetime(2026, 9, 1, tzinfo=timezone.utc)

    async def insert_legacy():
        await client.app.state.mongo.db[COMPETITIONS_COLLECTION].insert_one(
            {
                "_id": ObjectId(),
                "slug": "legacy-cup",
                "name": "Legacy Cup",
                "short_description": "",
                "status": "published",
                "start_at": now,
                "end_at": now,
                "join_mode": "open",
                "join_code_hash": None,
                "primary_metric": "f1",
                "quota_per_day": 5,
                "leaderboard_visible": True,
                "created_by": "admin@vku.vn",
                "created_at": now,
                "updated_at": now,
            }
        )

    asyncio.run(insert_legacy())
    body = client.get("/api/competitions/legacy-cup").json()
    assert body["resources"] == []
    assert client.get("/api/competitions").json()["competitions"][0]["resources"] == []
