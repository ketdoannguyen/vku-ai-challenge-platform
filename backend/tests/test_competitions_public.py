"""Participant competition API: visibility, detail by slug, draft ẩn."""

import pytest


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
            assert client.post(f"/api/admin/competitions/{cid}/publish").status_code == 200
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
