"""Quyền xem bảng tổng hợp: ba chế độ, membership hoạt động/thiếu hẳn, miễn trừ admin và no-store.

Người xem thứ hai đăng nhập được thật (tạo qua `accounts.service`) để mọi lượt kiểm đi qua HTTP.
"""

from datetime import datetime, timezone

from bson import ObjectId

from app.accounts.service import AccountCreate, create_account
from app.competitions.service import COMPETITIONS_COLLECTION
from app.memberships.service import MEMBERSHIPS_COLLECTION
from tests.helpers import login, login_participant, ready_competition
from tests.test_aggregates import _create_aggregate, _publish
from tests.test_normalization_ranking import _participant, _run, _submission, _touch

BASE = datetime(2026, 9, 15, 8, tzinfo=timezone.utc)
PASSWORD = "matkhauthu1"


def _source(competition: dict, weight: float) -> dict:
    return {"competition_id": competition["id"], "weight": weight}


def _make_user(client, name: str, email: str) -> dict:
    account = _run(
        create_account(
            client.app.state.mongo.db,
            AccountCreate(email=email, name=name, password=PASSWORD, role="participant"),
        )
    )
    assert account is not None
    return {"id": account["_id"], "email": email}


def _viewer(client, user: dict) -> None:
    login(client, user["email"], PASSWORD)


def _join(client, slug: str) -> None:
    response = client.post(f"/api/competitions/{slug}/join", json={})
    assert response.status_code == 200, response.text


def _board(client, slug: str) -> dict:
    response = client.get(f"/api/aggregates/{slug}/leaderboard")
    assert response.status_code == 200, response.text
    return response.json()


def _denied(client, slug: str) -> dict:
    response = client.get(f"/api/aggregates/{slug}/leaderboard")
    assert response.status_code == 403, response.text
    return response.json()["error"]


def _listing(client) -> set[str]:
    response = client.get("/api/aggregates")
    assert response.status_code == 200, response.text
    return {item["slug"] for item in response.json()["aggregates"]}


def test_anonymous_is_rejected(client):
    a = ready_competition(client, slug="agg-access-anon-a")
    b = ready_competition(client, slug="agg-access-anon-b")
    created = _create_aggregate(client, "Bảng Ẩn Danh", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])

    client.cookies.clear()
    assert client.get("/api/aggregates").status_code == 401
    assert client.get(f"/api/aggregates/{created['slug']}/leaderboard").status_code == 401


def test_draft_board_is_invisible_on_the_participant_api(client):
    a = ready_competition(client, slug="agg-access-draft-a")
    b = ready_competition(client, slug="agg-access-draft-b")
    created = _create_aggregate(client, "Bảng Nháp", [_source(a, 0.5), _source(b, 0.5)])

    login(client)  # admin cũng bị chặn ở bước công bố trên API thí sinh
    assert _listing(client) == set()
    denied = client.get(f"/api/aggregates/{created['slug']}/leaderboard")
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "AGGREGATE_NOT_PUBLISHED"
    # Nháp chỉ xem được qua đường admin.
    assert client.get(f"/api/admin/aggregates/{created['slug']}/leaderboard").status_code == 200


def test_visibility_modes_decide_list_and_read(client):
    a = ready_competition(client, slug="agg-access-modes-a")
    b = ready_competition(client, slug="agg-access-modes-b")
    any_board = _create_aggregate(client, "Bảng Thành Viên", [_source(a, 0.5), _source(b, 0.5)])
    all_board = _create_aggregate(
        client, "Bảng Toàn Bộ", [_source(a, 0.5), _source(b, 0.5)], visibility="members_all"
    )
    open_board = _create_aggregate(
        client, "Bảng Đăng Nhập", [_source(a, 0.5), _source(b, 0.5)], visibility="authenticated"
    )
    for created in (any_board, all_board, open_board):
        _publish(client, created["slug"])

    # Participant là thành viên cả hai nguồn (ready_competition tự join): qua đủ ba chế độ.
    login_participant(client)
    assert _listing(client) == {any_board["slug"], all_board["slug"], open_board["slug"]}
    for created in (any_board, all_board, open_board):
        assert _board(client, created["slug"])["status"] == "ready"

    # Người chỉ có membership ở `b`: members_any mở, members_all kín.
    rival = _make_user(client, "Đội B", "agg-access-rival@vku.vn")
    _viewer(client, rival)
    _join(client, "agg-access-modes-b")
    assert _listing(client) == {any_board["slug"], open_board["slug"]}
    assert _board(client, any_board["slug"])["status"] == "ready"
    assert _denied(client, all_board["slug"])["code"] == "AGGREGATE_MEMBERSHIP_REQUIRED"

    # Tài khoản không có membership nào: chỉ chế độ `authenticated` là mở.
    stranger = _make_user(client, "Người Lạ", "agg-access-stranger@vku.vn")
    _viewer(client, stranger)
    assert _listing(client) == {open_board["slug"]}
    assert _board(client, open_board["slug"])["status"] == "ready"
    assert _denied(client, any_board["slug"])["code"] == "AGGREGATE_MEMBERSHIP_REQUIRED"

    # Admin miễn điều kiện membership hoàn toàn.
    login(client)
    for created in (any_board, all_board, open_board):
        assert _board(client, created["slug"])["status"] == "ready"


def test_inactive_and_legacy_memberships(client):
    a = ready_competition(client, slug="agg-access-mem-a")
    b = ready_competition(client, slug="agg-access-mem-b")
    created = _create_aggregate(
        client, "Bảng Hoạt Động", [_source(a, 0.5), _source(b, 0.5)], visibility="members_all"
    )
    _publish(client, created["slug"])
    participant = _participant(client)
    membership = _run(
        client.app.state.mongo.db[MEMBERSHIPS_COLLECTION].find_one(
            {"competition_id": ObjectId(a["id"]), "account_id": participant["_id"]}
        )
    )
    assert membership is not None
    _run(
        client.app.state.mongo.db[MEMBERSHIPS_COLLECTION].update_one(
            {"_id": membership["_id"]}, {"$set": {"active": False}}
        )
    )
    login_participant(client)
    assert _denied(client, created["slug"])["code"] == "AGGREGATE_MEMBERSHIP_REQUIRED"

    # Membership cũ thiếu hẳn field `active` được coi như đang bật.
    _run(
        client.app.state.mongo.db[MEMBERSHIPS_COLLECTION].update_one(
            {"_id": membership["_id"]}, {"$unset": {"active": ""}}
        )
    )
    assert _board(client, created["slug"])["status"] == "ready"


def test_membership_reads_stored_sources_when_one_is_missing(client):
    a = ready_competition(client, slug="agg-access-gone-a")
    b = ready_competition(client, slug="agg-access-gone-b")
    created = _create_aggregate(
        client, "Bảng Mất Nửa", [_source(a, 0.5), _source(b, 0.5)], visibility="members_all"
    )
    _publish(client, created["slug"])
    _run(client.app.state.mongo.db[COMPETITIONS_COLLECTION].delete_one({"_id": ObjectId(a["id"])}))

    # Thành viên của nguồn đã mất vẫn qua cổng (đọc trên ObjectId đã lưu), rồi mới thấy bảng chờ.
    login_participant(client)
    board = _board(client, created["slug"])
    assert board["status"] == "waiting"
    assert board["sources"][0]["reason"] == "source_missing"

    stranger = _make_user(client, "Người Lạ", "agg-access-gone@vku.vn")
    _viewer(client, stranger)
    assert _denied(client, created["slug"])["code"] == "AGGREGATE_MEMBERSHIP_REQUIRED"


def test_leaving_a_source_keeps_old_scores_on_the_board(client):
    a = ready_competition(client, slug="agg-access-leave-a")
    b = ready_competition(client, slug="agg-access-leave-b")
    participant = _participant(client)
    _submission(client, a, participant["_id"], 0.8, BASE)
    _touch(a)
    created = _create_aggregate(client, "Bảng Rời", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])
    # Vô hiệu hóa membership ở `a`: vẫn xem được nhờ `b`, và điểm cũ ở `a` vẫn nằm trên bảng.
    _run(
        client.app.state.mongo.db[MEMBERSHIPS_COLLECTION].update_one(
            {"competition_id": ObjectId(a["id"]), "account_id": participant["_id"]},
            {"$set": {"active": False}},
        )
    )
    login_participant(client)
    entries = {entry["display_name"]: entry for entry in _board(client, created["slug"])["entries"]}
    assert entries["Thí Sinh"]["components"][0]["score"] == 0.8


def test_no_store_applies_to_success_and_denied(client):
    a = ready_competition(client, slug="agg-access-cache-a")
    b = ready_competition(client, slug="agg-access-cache-b")
    created = _create_aggregate(client, "Bảng Cache", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])

    login_participant(client)
    ok = client.get(f"/api/aggregates/{created['slug']}/leaderboard")
    assert ok.status_code == 200
    assert ok.headers["cache-control"] == "private, no-store"
    assert client.get("/api/aggregates").headers["cache-control"] == "private, no-store"

    stranger = _make_user(client, "Người Lạ", "agg-access-cache@vku.vn")
    _viewer(client, stranger)
    denied = client.get(f"/api/aggregates/{created['slug']}/leaderboard")
    assert denied.status_code == 403
    assert denied.headers["cache-control"] == "private, no-store"

    login(client)
    assert client.get("/api/admin/aggregates").headers["cache-control"] == "private, no-store"
