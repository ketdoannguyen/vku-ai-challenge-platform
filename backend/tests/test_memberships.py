"""Membership/join: policy theo join mode, isolation, idempotency và admin management."""

import asyncio
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.competitions.service import COMPETITIONS_COLLECTION
from app.memberships.service import MEMBERSHIPS_COLLECTION
from app.submissions.service import SUBMISSIONS_COLLECTION
from tests.helpers import publish_competition


def _login(client, email="admin@vku.vn", password="adminmatkhau1"):
    response = client.post("/api/auth/login", json={"identifier": email, "password": password})
    assert response.status_code == 200


def _login_participant(client):
    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")


def _create_competition(
    client,
    slug="open-cup",
    join_mode="open",
    publish=True,
    start_at="2026-10-01T00:00:00Z",
    end_at="2026-11-01T00:00:00Z",
):
    _login(client)
    response = client.post(
        "/api/admin/competitions",
        json={
            "slug": slug,
            "name": slug,
            "start_at": _iso(start_at),
            "end_at": _iso(end_at),
            "join_mode": join_mode,
        },
    )
    assert response.status_code == 201
    competition = response.json()
    if publish:
        assert publish_competition(client, competition["id"]).status_code == 200
    return competition


def _iso(value) -> str:
    return value.isoformat() if isinstance(value, datetime) else value


def _past_window() -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    return now - timedelta(days=2), now - timedelta(days=1)


def _future_window() -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    return now + timedelta(days=1), now + timedelta(days=2)


def _set_end_at(client, competition_id, value: datetime):
    """Dời end_at trực tiếp trong Mongo - mô phỏng cuộc thi trôi qua hạn mà không cần chờ."""

    async def update():
        await client.app.state.mongo.db[COMPETITIONS_COLLECTION].update_one(
            {"_id": ObjectId(competition_id)}, {"$set": {"end_at": value}}
        )

    asyncio.run(update())


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
    published = publish_competition(client, competition["id"])
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


def test_join_window_opens_at_publish_and_closes_at_end_at(client):
    """Join không phụ thuộc start_at: đăng ký sớm hợp lệ, chỉ chặn sau end_at."""
    start_at, end_at = _future_window()
    _create_competition(client, "early-cup", start_at=start_at, end_at=end_at)
    past_start, past_end = _past_window()
    _create_competition(client, "late-cup", start_at=past_start, end_at=past_end)

    _login_participant(client)
    early = client.post("/api/competitions/early-cup/join", json={})
    assert early.status_code == 200
    assert early.json()["joined_now"] is True

    late = client.post("/api/competitions/late-cup/join", json={})
    assert late.status_code == 422
    assert late.json()["error"]["code"] == "JOIN_DEADLINE_PASSED"
    assert _membership_count(client) == 1


def test_existing_member_is_idempotent_after_deadline_and_after_close(client):
    competition = _create_competition(client)
    _login_participant(client)
    assert client.post("/api/competitions/open-cup/join", json={}).status_code == 200

    _login(client)
    _set_end_at(client, competition["id"], _past_window()[1])
    _login_participant(client)
    after_deadline = client.post("/api/competitions/open-cup/join", json={})
    assert after_deadline.status_code == 200
    assert after_deadline.json()["joined_now"] is False

    _login(client)
    assert client.post(f"/api/admin/competitions/{competition['id']}/close").status_code == 200
    _login_participant(client)
    after_close = client.post("/api/competitions/open-cup/join", json={})
    assert after_close.status_code == 200
    assert after_close.json()["joined_now"] is False

    _login(client)
    account_id = client.get(
        f"/api/admin/competitions/{competition['id']}/members"
    ).json()["members"][0]["account_id"]
    client.patch(
        f"/api/admin/competitions/{competition['id']}/members/{account_id}",
        json={"active": False},
    )
    _login_participant(client)
    inactive = client.post("/api/competitions/open-cup/join", json={})
    assert inactive.status_code == 403
    assert inactive.json()["error"]["code"] == "MEMBERSHIP_INACTIVE"


def test_closed_and_deadline_beat_join_policy_for_non_member(client):
    past_start, past_end = _past_window()
    closed = _create_competition(client, "closed-late", start_at=past_start, end_at=past_end)
    coded = _create_competition(
        client, "code-late", "code", publish=False, start_at=past_start, end_at=past_end
    )
    _login(client)
    assert client.put(
        f"/api/admin/competitions/{coded['id']}/join-code", json={"join_code": "secret-2026"}
    ).status_code == 200
    assert publish_competition(client, coded["id"]).status_code == 200
    assert client.post(f"/api/admin/competitions/{closed['id']}/close").status_code == 200

    _login_participant(client)
    # closed thắng deadline: không phải "hết hạn tham gia" mà là "đã kết thúc".
    closed_response = client.post("/api/competitions/closed-late/join", json={})
    assert closed_response.status_code == 422
    assert closed_response.json()["error"]["code"] == "JOIN_CLOSED"

    # deadline thắng validation mã: mã sai cũng không lộ thông tin khi đã hết hạn.
    late_code = client.post("/api/competitions/code-late/join", json={"join_code": "wrong"})
    assert late_code.status_code == 422
    assert late_code.json()["error"]["code"] == "JOIN_DEADLINE_PASSED"
    assert _membership_count(client) == 0


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


def _account_id(client, email: str) -> str:
    async def find():
        account = await client.app.state.mongo.db["accounts"].find_one({"email": email})
        return str(account["_id"])

    return asyncio.run(find())


def _insert_completed_submission(client, competition_id: str, account_id: str, score: float = 0.8):
    submission_id = ObjectId()
    now = datetime.now(timezone.utc)

    async def insert():
        await client.app.state.mongo.db[SUBMISSIONS_COLLECTION].insert_one(
            {
                "_id": submission_id,
                "competition_id": ObjectId(competition_id),
                "account_id": ObjectId(account_id),
                "file_path": "submissions/answers.csv",
                "original_filename": "answers.csv",
                "status": "completed",
                "metrics": {"f1": score, "precision": score, "recall": score},
                "primary_score": score,
                "created_at": now,
            }
        )

    asyncio.run(insert())
    return submission_id


def _insert_pending_submission(client, competition_id: str, account_id: str) -> list[str]:
    """Bài nộp dở (status != completed) có artifact trên object storage."""
    submission_id = ObjectId()
    prefix = f"competitions/{competition_id}/accounts/{account_id}/submissions/{submission_id}"
    keys = [f"{prefix}/prediction.csv", f"{prefix}/notebook.ipynb"]

    async def insert():
        await client.app.state.mongo.db[SUBMISSIONS_COLLECTION].insert_one(
            {
                "_id": submission_id,
                "competition_id": ObjectId(competition_id),
                "account_id": ObjectId(account_id),
                "status": "failed",
                "artifacts": {
                    "prediction": {"object_key": keys[0], "original_filename": "a.csv"},
                    "notebook": {"object_key": keys[1], "original_filename": "n.ipynb"},
                },
                "created_at": datetime.now(timezone.utc),
            }
        )

    asyncio.run(insert())
    return keys


def _submission_count(client, competition_id: str) -> int:
    async def count():
        return await client.app.state.mongo.db[SUBMISSIONS_COLLECTION].count_documents(
            {"competition_id": ObjectId(competition_id)}
        )

    return asyncio.run(count())


def test_participant_leave_keeps_history_and_requires_admin_to_return(client):
    competition = _create_competition(client)
    _login_participant(client)
    assert client.post("/api/competitions/open-cup/join", json={}).status_code == 200
    _insert_completed_submission(client, competition["id"], _account_id(client, "thi.sinh@vku.vn"))

    left = client.post("/api/competitions/open-cup/leave")
    assert left.status_code == 200
    assert left.json()["left_now"] is True
    assert left.json()["membership"]["active"] is False
    assert left.json()["membership"]["joined_at"] is not None

    again = client.post("/api/competitions/open-cup/leave")
    assert again.status_code == 200
    assert again.json()["left_now"] is False

    # Rời cuộc thi là soft deactivate: membership còn nguyên, chỉ đổi trạng thái.
    assert _membership_count(client) == 1
    assert client.get("/api/competitions/open-cup").json()["membership"]["active"] is False

    # Lịch sử được bảo toàn: kết quả và thứ hạng vẫn còn sau khi rời.
    leaderboard = client.get(f"/api/competitions/{competition['id']}/leaderboard").json()
    assert [row["display_name"] for row in leaderboard["entries"]] == ["Thí Sinh"]

    # Tự vào lại bị chặn - phải nhờ Ban Tổ chức kích hoạt.
    blocked = client.post("/api/competitions/open-cup/join", json={})
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "MEMBERSHIP_INACTIVE"

    _login(client)
    before = client.get(f"/api/admin/competitions/{competition['id']}/members").json()
    reactivated = client.post(
        f"/api/admin/competitions/{competition['id']}/members",
        json={"email": "thi.sinh@vku.vn"},
    )
    assert reactivated.json()["reactivated"] is True
    # Kích hoạt lại không được reset joined_at - đó là mốc tham gia gốc.
    assert reactivated.json()["member"]["joined_at"][:23] == before["members"][0]["joined_at"][:23]


def test_leave_requires_login_and_existing_membership(client):
    competition = _create_competition(client)
    _create_competition(client, "draft-cup", publish=False)
    # _create_competition đăng nhập sẵn bằng admin; xoá phiên để thử đúng khách ẩn danh.
    client.cookies.clear()
    assert client.post("/api/competitions/open-cup/leave").status_code == 401

    _login_participant(client)
    assert client.post("/api/competitions/unknown/leave").status_code == 404
    assert client.post("/api/competitions/draft-cup/leave").status_code == 404
    missing = client.post("/api/competitions/open-cup/leave")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "NOT_FOUND"

    assert client.post("/api/competitions/open-cup/join", json={}).status_code == 200
    _login(client)
    assert client.post(f"/api/admin/competitions/{competition['id']}/close").status_code == 200
    _login_participant(client)
    # Quyền rút lui không phụ thuộc trạng thái cuộc thi.
    assert client.post("/api/competitions/open-cup/leave").status_code == 200


def test_admin_hard_delete_member_only_without_completed_submission(client):
    competition = _create_competition(client, "invite-cup", "invite_only")
    _login(client)
    added = client.post(
        f"/api/admin/competitions/{competition['id']}/members",
        json={"email": "thi.sinh@vku.vn"},
    )
    account_id = added.json()["member"]["account_id"]

    deleted = client.delete(f"/api/admin/competitions/{competition['id']}/members/{account_id}")
    assert deleted.status_code == 200
    assert client.get(f"/api/admin/competitions/{competition['id']}/members").json()["total"] == 0

    client.post(
        f"/api/admin/competitions/{competition['id']}/members",
        json={"email": "thi.sinh@vku.vn"},
    )
    _insert_completed_submission(client, competition["id"], account_id)
    blocked = client.delete(f"/api/admin/competitions/{competition['id']}/members/{account_id}")
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "MEMBER_HAS_SUBMISSIONS"
    # Không xoá gì cả: membership và bài nộp vẫn nguyên để BTC chỉ vô hiệu hóa.
    assert client.get(f"/api/admin/competitions/{competition['id']}/members").json()["total"] == 1
    assert _submission_count(client, competition["id"]) == 1

    missing = client.delete(f"/api/admin/competitions/{competition['id']}/members/{ObjectId()}")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "NOT_FOUND"


def test_admin_hard_delete_member_removes_pending_submission_artifacts(
    client, fake_artifact_storage
):
    """Xoá cứng thành viên chỉ được đụng bài chưa hoàn thành - và phải dọn cả object trên MinIO."""
    competition = _create_competition(client, "invite-cup", "invite_only")
    _login(client)
    account_id = client.post(
        f"/api/admin/competitions/{competition['id']}/members",
        json={"email": "thi.sinh@vku.vn"},
    ).json()["member"]["account_id"]
    keys = _insert_pending_submission(client, competition["id"], account_id)
    fake_artifact_storage.objects.update({key: b"data" for key in keys})

    deleted = client.delete(f"/api/admin/competitions/{competition['id']}/members/{account_id}")
    assert deleted.status_code == 200
    assert fake_artifact_storage.objects == {}
    assert _submission_count(client, competition["id"]) == 0


def test_member_counts_split_active_and_inactive(client):
    competition = _create_competition(client, "invite-cup", "invite_only")
    _login(client)
    added = client.post(
        f"/api/admin/competitions/{competition['id']}/members",
        json={"email": "thi.sinh@vku.vn"},
    )
    account_id = added.json()["member"]["account_id"]

    listed = client.get(f"/api/admin/competitions/{competition['id']}/members").json()
    assert listed["total"] == 1
    assert listed["active_total"] == 1

    client.patch(
        f"/api/admin/competitions/{competition['id']}/members/{account_id}",
        json={"active": False},
    )

    def admin_row():
        return next(
            item
            for item in client.get("/api/admin/competitions").json()["competitions"]
            if item["id"] == competition["id"]
        )

    # member_count giờ đếm thành viên đang hoạt động; người bị vô hiệu hóa tách riêng.
    row = admin_row()
    assert row["member_count"] == 0
    assert row["inactive_member_count"] == 1

    after = client.get(f"/api/admin/competitions/{competition['id']}/members").json()
    assert after["total"] == 1
    assert after["active_total"] == 0

    # Membership cũ thiếu field `active` vẫn phải được tính là đang hoạt động.
    async def insert_legacy():
        await client.app.state.mongo.db[MEMBERSHIPS_COLLECTION].insert_one(
            {
                "competition_id": ObjectId(competition["id"]),
                "account_id": ObjectId(),
                "joined_at": datetime.now(timezone.utc),
            }
        )

    asyncio.run(insert_legacy())
    legacy_row = admin_row()
    assert legacy_row["member_count"] == 1
    assert legacy_row["inactive_member_count"] == 1
