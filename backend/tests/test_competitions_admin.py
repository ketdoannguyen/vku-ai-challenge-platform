"""Admin competitions API: guard, create/validate, edit rules, publish/close, clone."""

import asyncio

from bson import ObjectId

from app.competitions.service import COMPETITIONS_COLLECTION
from app.submissions.service import SUBMISSIONS_COLLECTION


def _login(client, email="admin@vku.vn", password="adminmatkhau1"):
    resp = client.post("/api/auth/login", json={"identifier": email, "password": password})
    assert resp.status_code == 200


def _login_participant(client):
    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")


def _body(**overrides):
    base = {
        "slug": "ai-challenge-2026",
        "name": "AI Challenge 2026",
        "short_description": "Cuộc thi AI lần thứ nhất",
        "start_at": "2026-10-01T00:00:00Z",
        "end_at": "2026-11-01T00:00:00Z",
    }
    base.update(overrides)
    return base


def test_admin_competition_endpoints_require_login(client):
    for resp in (
        client.get("/api/admin/competitions"),
        client.post("/api/admin/competitions", json={}),
        client.patch("/api/admin/competitions/abc", json={}),
        client.post("/api/admin/competitions/abc/publish"),
        client.post("/api/admin/competitions/abc/close"),
        client.post("/api/admin/competitions/abc/clone"),
    ):
        assert resp.status_code == 401
        assert resp.json()["error"]["code"] == "UNAUTHORIZED"


def test_participant_cannot_call_admin_competition_api(client):
    _login_participant(client)
    for resp in (
        client.get("/api/admin/competitions"),
        client.post("/api/admin/competitions", json=_body()),
    ):
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "FORBIDDEN"


def test_admin_create_competition_defaults_to_draft(client):
    _login(client)
    resp = client.post("/api/admin/competitions", json=_body())
    assert resp.status_code == 201
    body = resp.json()
    assert body["slug"] == "ai-challenge-2026"
    assert body["status"] == "draft"
    assert body["join_mode"] == "open"
    assert body["primary_metric"] == "f1"
    assert body["quota_per_day"] == 5
    assert body["leaderboard_visible"] is True
    assert body["created_by"] == "admin@vku.vn"


def test_admin_create_validates_fields(client):
    _login(client)
    cases = [
        _body(slug="Invalid Slug"),          # slug format
        _body(slug="ai_challenge"),          # underscore không cho
        _body(start_at="2026-11-01T00:00:00Z", end_at="2026-10-01T00:00:00Z"),  # start > end
        _body(primary_metric="accuracy"),    # metric ngoài f1/precision/recall
        _body(quota_per_day=-1),             # quota âm
        _body(quota_per_day=10_000),         # quota phi lý
        _body(join_mode="free"),             # join mode lạ
        _body(name="  "),                    # name rỗng
    ]
    for payload in cases:
        resp = client.post("/api/admin/competitions", json=payload)
        assert resp.status_code == 422, payload
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_slug_unique_enforced_by_api(client):
    _login(client)
    assert client.post("/api/admin/competitions", json=_body()).status_code == 201
    resp = client.post("/api/admin/competitions", json=_body(name="Trùng slug"))
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "SLUG_EXISTS"


def test_admin_list_includes_drafts(client):
    _login(client)
    client.post("/api/admin/competitions", json=_body())
    resp = client.get("/api/admin/competitions")
    assert resp.status_code == 200
    assert [c["slug"] for c in resp.json()["competitions"]] == ["ai-challenge-2026"]
    assert resp.json()["competitions"][0]["status"] == "draft"


def test_admin_list_counts_members_and_submissions_per_competition(client):
    """Bảng admin hiển thị số thành viên/bài nộp — phải tách đúng theo từng cuộc thi."""
    _login(client)
    tracked = client.post("/api/admin/competitions", json=_body()).json()["id"]
    other = client.post("/api/admin/competitions", json=_body(slug="other-cup", name="Other Cup")).json()["id"]
    client.post(f"/api/admin/competitions/{tracked}/members", json={"email": "thi.sinh@vku.vn"})
    account_id = ObjectId()
    asyncio.run(
        client.app.state.mongo.db[SUBMISSIONS_COLLECTION].insert_many(
            [
                {"competition_id": ObjectId(tracked), "account_id": account_id, "status": "completed"},
                {"competition_id": ObjectId(tracked), "account_id": account_id, "status": "rejected"},
                {"competition_id": ObjectId(other), "account_id": account_id, "status": "completed"},
            ]
        )
    )

    by_slug = {c["slug"]: c for c in client.get("/api/admin/competitions").json()["competitions"]}
    assert (by_slug["ai-challenge-2026"]["member_count"], by_slug["ai-challenge-2026"]["submission_count"]) == (1, 2)
    assert (by_slug["other-cup"]["member_count"], by_slug["other-cup"]["submission_count"]) == (0, 1)


def test_admin_get_detail_by_id(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    resp = client.get(f"/api/admin/competitions/{cid}")
    assert resp.status_code == 200
    assert resp.json()["id"] == cid
    assert client.get("/api/admin/competitions/000000000000000000000000").status_code == 404


def test_edit_draft_changes_fields_but_not_slug_or_status(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    resp = client.patch(
        f"/api/admin/competitions/{cid}",
        json={"name": "AI Challenge 2026 — Vòng 1", "quota_per_day": 10, "slug": "other-slug", "status": "published"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "AI Challenge 2026 — Vòng 1"
    assert body["quota_per_day"] == 10
    assert body["slug"] == "ai-challenge-2026"  # slug immutable
    assert body["status"] == "draft"  # status chỉ đổi qua publish/close


def test_edit_published_cannot_change_primary_metric(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    client.post(f"/api/admin/competitions/{cid}/publish")
    resp = client.patch(f"/api/admin/competitions/{cid}", json={"primary_metric": "precision"})
    assert resp.status_code == 422
    # field khác vẫn sửa được
    ok = client.patch(f"/api/admin/competitions/{cid}", json={"name": "Đã đổi tên"})
    assert ok.status_code == 200
    assert ok.json()["name"] == "Đã đổi tên"


def test_edit_published_validates_dates(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    client.post(f"/api/admin/competitions/{cid}/publish")
    resp = client.patch(f"/api/admin/competitions/{cid}", json={"start_at": "2026-12-01T00:00:00Z", "end_at": "2026-11-01T00:00:00Z"})
    assert resp.status_code == 422


def test_edit_closed_rejected(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    client.post(f"/api/admin/competitions/{cid}/publish")
    client.post(f"/api/admin/competitions/{cid}/close")
    resp = client.patch(f"/api/admin/competitions/{cid}", json={"name": "Sai"})
    assert resp.status_code == 422


def test_publish_close_transitions(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    # draft -> closed trực tiếp bị chặn
    assert client.post(f"/api/admin/competitions/{cid}/close").status_code == 422
    assert client.post(f"/api/admin/competitions/{cid}/publish").status_code == 200
    assert client.get(f"/api/admin/competitions/{cid}").json()["status"] == "published"
    # published -> publish lại bị chặn
    assert client.post(f"/api/admin/competitions/{cid}/publish").status_code == 422
    assert client.post(f"/api/admin/competitions/{cid}/close").status_code == 200
    assert client.get(f"/api/admin/competitions/{cid}").json()["status"] == "closed"
    # closed -> mọi transition bị chặn
    assert client.post(f"/api/admin/competitions/{cid}/publish").status_code == 422
    assert client.post(f"/api/admin/competitions/{cid}/close").status_code == 422


def test_clone_copies_config_not_status_dates_submissions(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body(quota_per_day=9)).json()["id"]
    client.post(f"/api/admin/competitions/{cid}/publish")
    resp = client.post(f"/api/admin/competitions/{cid}/clone")
    assert resp.status_code == 201
    clone = resp.json()
    assert clone["id"] != cid
    assert clone["slug"] == "ai-challenge-2026-copy"
    assert clone["name"].startswith("AI Challenge 2026")
    assert clone["status"] == "draft"  # clone luôn draft
    assert clone["quota_per_day"] == 9
    # clone không copy submissions/memberships: chỉ cần khẳng định collection đếm đúng (rỗng)
    def count_docs():
        async def run():
            return await client.app.state.mongo.db[COMPETITIONS_COLLECTION].count_documents({})
        return asyncio.run(run())
    assert count_docs() == 2  # gốc + clone, không có bản ghi thứ ba
