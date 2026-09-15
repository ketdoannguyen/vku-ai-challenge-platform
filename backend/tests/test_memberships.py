"""Membership/join: policy theo join mode, isolation, idempotency và admin management."""

import asyncio

from app.memberships.service import MEMBERSHIPS_COLLECTION


def _login(client, email="admin@vku.vn", password="adminmatkhau1"):
    response = client.post("/api/auth/login", json={"identifier": email, "password": password})
    assert response.status_code == 200


def _login_participant(client):
    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")


def _create_competition(client, slug="open-cup", join_mode="open", publish=True):
    _login(client)
    response = client.post(
        "/api/admin/competitions",
        json={
            "slug": slug,
            "name": slug,
            "start_at": "2026-10-01T00:00:00Z",
            "end_at": "2026-11-01T00:00:00Z",
            "join_mode": join_mode,
        },
    )
    assert response.status_code == 201
    competition = response.json()
    if publish:
        response = client.post(f"/api/admin/competitions/{competition['id']}/publish")
        assert response.status_code == 200
    return competition


def _membership_count(client):
    async def count():
        return await client.app.state.mongo.db[MEMBERSHIPS_COLLECTION].count_documents({})

    return asyncio.run(count())


def test_join_requires_login(client):
    response = client.post("/api/competitions/unknown/join", json={})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"


def test_open_join_is_idempotent_and_appears_in_competition(client):
    competition = _create_competition(client)
    _login_participant(client)

    first = client.post("/api/competitions/open-cup/join", json={})
    second = client.post("/api/competitions/open-cup/join", json={})

    assert first.status_code == 200
    assert first.json()["joined_now"] is True
    assert first.json()["membership"]["active"] is True
    assert second.status_code == 200
    assert second.json()["joined_now"] is False
    assert _membership_count(client) == 1

    detail = client.get("/api/competitions/open-cup").json()
    assert detail["id"] == competition["id"]
    assert detail["membership"]["active"] is True
    assert detail["membership"]["joined_at"] is not None


def test_code_join_accepts_only_correct_code_and_never_exposes_it(client):
    competition = _create_competition(client, "code-cup", "code", publish=False)
    set_code = client.put(
        f"/api/admin/competitions/{competition['id']}/join-code",
        json={"join_code": "secret-2026"},
    )
    assert set_code.status_code == 200
    assert set(set_code.json()) == {"join_code_configured"}
    assert set_code.json()["join_code_configured"] is True
    published = client.post(f"/api/admin/competitions/{competition['id']}/publish")
    assert published.status_code == 200
    assert "join_code" not in published.json()
    assert "join_code_hash" not in published.json()

    _login_participant(client)
    for body in ({}, {"join_code": "wrong-code"}):
        response = client.post("/api/competitions/code-cup/join", json=body)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "JOIN_CODE_INVALID"
    assert client.post(
        "/api/competitions/code-cup/join", json={"join_code": "secret-2026"}
    ).status_code == 200


def test_code_competition_cannot_publish_without_code(client):
    competition = _create_competition(client, "code-cup", "code", publish=False)
    response = client.post(f"/api/admin/competitions/{competition['id']}/publish")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "JOIN_CODE_REQUIRED"


def test_join_code_policy(client):
    competition = _create_competition(client, "code-cup", "code", publish=False)
    for code in ("short", " leading-code", "trailing-code ", "x" * 129):
        response = client.put(
            f"/api/admin/competitions/{competition['id']}/join-code",
            json={"join_code": code},
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"


def test_invite_only_draft_and_closed_cannot_self_join(client):
    _create_competition(client, "invite-cup", "invite_only")
    _create_competition(client, "draft-cup", publish=False)
    closed = _create_competition(client, "closed-cup")
    client.post(f"/api/admin/competitions/{closed['id']}/close")
    _login_participant(client)

    invite = client.post("/api/competitions/invite-cup/join", json={})
    assert invite.status_code == 403
    assert invite.json()["error"]["code"] == "JOIN_INVITE_ONLY"
    draft = client.post("/api/competitions/draft-cup/join", json={})
    assert draft.status_code == 404
    closed_response = client.post("/api/competitions/closed-cup/join", json={})
    assert closed_response.status_code == 422
    assert closed_response.json()["error"]["code"] == "JOIN_CLOSED"


def test_memberships_are_isolated_by_competition(client):
    _create_competition(client, "cup-a")
    _create_competition(client, "cup-b")
    _login_participant(client)
    assert client.post("/api/competitions/cup-a/join", json={}).status_code == 200
    assert client.post("/api/competitions/cup-b/join", json={}).status_code == 200
    assert _membership_count(client) == 2


def test_participant_cannot_use_admin_membership_api(client):
    competition = _create_competition(client)
    _login_participant(client)
    response = client.get(f"/api/admin/competitions/{competition['id']}/members")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


def test_admin_add_list_deactivate_and_reactivate_member(client):
    competition = _create_competition(client, "invite-cup", "invite_only")
    _login(client)
    added = client.post(
        f"/api/admin/competitions/{competition['id']}/members",
        json={"email": "thi.sinh@vku.vn"},
    )
    assert added.status_code == 200
    original_joined_at = added.json()["member"]["joined_at"]
    account_id = added.json()["member"]["account_id"]

    listed = client.get(f"/api/admin/competitions/{competition['id']}/members")
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["members"][0]["email"] == "thi.sinh@vku.vn"

    disabled = client.patch(
        f"/api/admin/competitions/{competition['id']}/members/{account_id}",
        json={"active": False},
    )
    assert disabled.status_code == 200
    assert disabled.json()["member"]["active"] is False

    _login_participant(client)
    blocked = client.post("/api/competitions/invite-cup/join", json={})
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "MEMBERSHIP_INACTIVE"

    _login(client)
    reactivated = client.post(
        f"/api/admin/competitions/{competition['id']}/members",
        json={"email": "thi.sinh@vku.vn"},
    )
    assert reactivated.status_code == 200
    assert reactivated.json()["reactivated"] is True
    # Mongo stores milliseconds; reactivate must preserve the same instant to that precision.
    assert reactivated.json()["member"]["joined_at"][:23] == original_joined_at[:23]


def test_admin_can_only_add_active_participants(client):
    competition = _create_competition(client, "invite-cup", "invite_only")
    _login(client)
    self_add = client.post(
        f"/api/admin/competitions/{competition['id']}/members",
        json={"email": "admin@vku.vn"},
    )
    assert self_add.status_code == 422

    account = client.get("/api/admin/accounts", params={"q": "thi.sinh@vku.vn"}).json()["accounts"][0]
    client.patch(f"/api/admin/accounts/{account['id']}", json={"active": False})
    disabled = client.post(
        f"/api/admin/competitions/{competition['id']}/members",
        json={"email": "thi.sinh@vku.vn"},
    )
    assert disabled.status_code == 422


def test_membership_list_batch_marks_only_joined_competition(client):
    _create_competition(client, "cup-a")
    _create_competition(client, "cup-b")
    _login_participant(client)
    client.post("/api/competitions/cup-a/join", json={})

    competitions = client.get("/api/competitions").json()["competitions"]
    membership_by_slug = {item["slug"]: item["membership"] for item in competitions}
    assert membership_by_slug["cup-a"]["active"] is True
    assert membership_by_slug["cup-b"] == {"active": False, "joined_at": None}
