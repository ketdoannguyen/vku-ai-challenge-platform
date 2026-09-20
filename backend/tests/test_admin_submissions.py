"""Phase D: bảng submission toàn cục cho admin - lọc, sắp xếp, phân trang server-side."""

import asyncio
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.competitions.service import COMPETITIONS_COLLECTION
from app.submissions.service import SUBMISSIONS_COLLECTION

BASE = datetime(2026, 9, 15, 8, tzinfo=timezone.utc)
GLOBAL_URL = "/api/admin/submissions"


def _run(awaitable):
    return asyncio.run(awaitable)


def _login(client, email="admin@vku.vn", password="adminmatkhau1"):
    response = client.post("/api/auth/login", json={"identifier": email, "password": password})
    assert response.status_code == 200


def _login_participant(client):
    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")


def _account_id(client, email: str) -> ObjectId:
    return _run(client.app.state.mongo.db["accounts"].find_one({"email": email}))["_id"]


def _create_account(client, name: str, email: str) -> ObjectId:
    account_id = ObjectId()
    _run(
        client.app.state.mongo.db["accounts"].insert_one(
            {
                "_id": account_id,
                "email": email,
                "name": name,
                "password_hash": "unused-in-admin-list-tests",
                "role": "participant",
                "active": True,
                "created_at": BASE,
                "updated_at": BASE,
            }
        )
    )
    return account_id


def _create_competition(client, slug: str, name: str | None = None) -> ObjectId:
    competition_id = ObjectId()
    _run(
        client.app.state.mongo.db[COMPETITIONS_COLLECTION].insert_one(
            {
                "_id": competition_id,
                "slug": slug,
                "name": name or slug.replace("-", " ").title(),
                "status": "published",
                "primary_metric": "f1",
                "start_at": BASE - timedelta(days=1),
                "end_at": BASE + timedelta(days=1),
            }
        )
    )
    return competition_id


def _submission(
    client,
    competition_id: ObjectId,
    account_id: ObjectId,
    *,
    score: float,
    created_at: datetime,
    submission_no: int | None = None,
    status: str = "completed",
    artifacts: dict | None = None,
) -> ObjectId:
    submission_id = ObjectId()
    document = {
        "_id": submission_id,
        "competition_id": competition_id,
        "account_id": account_id,
        "original_filename": "answers.csv",
        "status": status,
        "metrics": {"f1": score, "precision": score - 0.01, "recall": score - 0.02},
        "primary_score": score,
        "created_at": created_at,
    }
    if submission_no is not None:
        document["submission_no"] = submission_no
    if artifacts is None:
        document["file_path"] = f"submissions/{competition_id}/{account_id}/{submission_id}.csv"
    else:
        document["artifacts"] = artifacts
    _run(client.app.state.mongo.db[SUBMISSIONS_COLLECTION].insert_one(document))
    return submission_id


def _list(client, **params) -> dict:
    response = client.get(GLOBAL_URL, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _seed_portfolio(client) -> dict:
    """2 cuộc thi, 2 account, 3 bài nộp đủ để thử lọc/sắp xếp/phân trang."""
    participant = _account_id(client, "thi.sinh@vku.vn")
    other = _create_account(client, "Đội Khác", "doi-khac@vku.vn")
    cup_a = _create_competition(client, "cup-a", "Cup A")
    cup_b = _create_competition(client, "cup-b", "Cup B")
    oldest = _submission(
        client, cup_a, participant, score=0.4, created_at=BASE, submission_no=1
    )
    middle = _submission(
        client, cup_a, other, score=0.9, created_at=BASE + timedelta(hours=1), submission_no=1
    )
    newest = _submission(
        client,
        cup_b,
        participant,
        score=0.7,
        created_at=BASE + timedelta(hours=2),
        status="rejected",
    )
    _login(client)
    return {
        "participant": participant,
        "other": other,
        "cup_a": cup_a,
        "cup_b": cup_b,
        "oldest": oldest,
        "middle": middle,
        "newest": newest,
    }


def test_global_list_requires_admin(client):
    anonymous = client.get(GLOBAL_URL)
    assert anonymous.status_code == 401
    assert anonymous.json()["error"]["code"] == "UNAUTHORIZED"

    _login_participant(client)
    participant = client.get(GLOBAL_URL)
    assert participant.status_code == 403
    assert participant.json()["error"]["code"] == "FORBIDDEN"


def test_global_list_spans_competitions_with_filters(client):
    seeded = _seed_portfolio(client)
    body = _list(client)
    assert body["total"] == 3
    assert body["limit"] == 50
    assert body["offset"] == 0
    assert body["sort"] == "created_at"
    assert body["order"] == "desc"
    # Mặc định mới nhất trước, có tie-break `_id` nên thứ tự ổn định.
    assert [row["id"] for row in body["submissions"]] == [
        str(seeded["newest"]),
        str(seeded["middle"]),
        str(seeded["oldest"]),
    ]

    row = body["submissions"][1]
    assert row["competition"] == {
        "id": str(seeded["cup_a"]),
        "slug": "cup-a",
        "name": "Cup A",
    }
    assert row["account"] == {
        "id": str(seeded["other"]),
        "name": "Đội Khác",
        "email": "doi-khac@vku.vn",
    }
    assert row["primary_score"] == 0.9
    assert row["submission_no"] == 1
    # Bài legacy chỉ có CSV trên đĩa: kích thước không lưu nên là null.
    assert row["artifacts"] == {
        "prediction": {"filename": "answers.csv", "size_bytes": None, "available": True},
        "notebook": None,
    }
    assert "file_path" not in row and "account_id" not in row

    by_competition = _list(client, competition_id=str(seeded["cup_b"]))
    assert [row["id"] for row in by_competition["submissions"]] == [str(seeded["newest"])]

    by_account = _list(client, q="đội khác")
    assert by_account["total"] == 1
    assert by_account["submissions"][0]["account"]["id"] == str(seeded["other"])

    by_email = _list(client, q="thi.sinh@vku.vn")
    assert by_email["total"] == 2

    by_status = _list(client, status="rejected")
    assert [row["status"] for row in by_status["submissions"]] == ["rejected"]

    combined = _list(client, competition_id=str(seeded["cup_a"]), q="Thí Sinh", status="completed")
    assert combined["total"] == 1
    assert combined["submissions"][0]["id"] == str(seeded["oldest"])


def test_global_list_reports_artifact_metadata_for_new_submissions(client):
    participant = _account_id(client, "thi.sinh@vku.vn")
    cup = _create_competition(client, "cup-artifacts")
    submission = _submission(
        client,
        cup,
        participant,
        score=1.0,
        created_at=BASE,
        submission_no=12,
        artifacts={
            "prediction": {
                "object_key": f"competitions/{cup}/accounts/{participant}/submissions/x/prediction.csv",
                "original_filename": "dự-đoán.csv",
                "size_bytes": 128,
                "content_type": "text/csv; charset=utf-8",
            },
            "notebook": {
                "object_key": f"competitions/{cup}/accounts/{participant}/submissions/x/notebook.ipynb",
                "original_filename": "lời-giải.ipynb",
                "size_bytes": 2048,
                "content_type": "application/x-ipynb+json",
            },
        },
    )
    _login(client)

    row = _list(client)["submissions"][0]
    assert row["id"] == str(submission)
    assert row["artifacts"] == {
        "prediction": {"filename": "dự-đoán.csv", "size_bytes": 128, "available": True},
        "notebook": {"filename": "lời-giải.ipynb", "size_bytes": 2048, "available": True},
    }
    # Object key và backend lưu trữ không được lộ ra API quản trị.
    assert "object_key" not in str(row)


def test_global_list_sorts_and_paginates(client):
    seeded = _seed_portfolio(client)

    by_score = _list(client, sort="primary_score", order="desc")
    assert [row["primary_score"] for row in by_score["submissions"]] == [0.9, 0.7, 0.4]

    # Sort theo tên dùng collation mặc định của Mongo (so sánh code point), nên "T" đứng trước "Đ".
    by_team = _list(client, sort="team", order="asc")
    assert [row["account"]["name"] for row in by_team["submissions"]] == [
        "Thí Sinh",
        "Thí Sinh",
        "Đội Khác",
    ]

    by_time_asc = _list(client, sort="created_at", order="asc", limit=2, offset=1)
    assert by_time_asc["total"] == 3
    assert [row["id"] for row in by_time_asc["submissions"]] == [
        str(seeded["middle"]),
        str(seeded["newest"]),
    ]
    # Trang cuối chỉ còn một dòng.
    tail = _list(client, sort="created_at", order="asc", limit=2, offset=2)
    assert [row["id"] for row in tail["submissions"]] == [str(seeded["newest"])]


def test_global_list_sorts_by_competition_name(client):
    seeded = _seed_portfolio(client)

    by_competition = _list(client, sort="competition", order="asc")
    assert [row["competition"]["name"] for row in by_competition["submissions"]] == [
        "Cup A",
        "Cup A",
        "Cup B",
    ]

    reversed_rows = _list(client, sort="competition", order="desc")
    assert [row["competition"]["name"] for row in reversed_rows["submissions"]] == [
        "Cup B",
        "Cup A",
        "Cup A",
    ]

    # Cuộc thi đã xoá vẫn sort được: tên rỗng nằm đầu khi tăng, cuối khi giảm.
    _run(client.app.state.mongo.db[COMPETITIONS_COLLECTION].delete_one({"_id": seeded["cup_a"]}))
    orphans = _list(client, sort="competition", order="asc")["submissions"]
    assert [row["competition"]["name"] for row in orphans] == [
        "Cuộc thi đã xóa",
        "Cuộc thi đã xóa",
        "Cup B",
    ]


def test_global_list_sorts_by_metrics_with_stable_pagination(client):
    participant = _account_id(client, "thi.sinh@vku.vn")
    cup = _create_competition(client, "cup-metrics", "Cup Metrics")
    low = _submission(client, cup, participant, score=0.3, created_at=BASE, submission_no=1)
    high = _submission(
        client, cup, participant, score=0.8, created_at=BASE + timedelta(hours=1), submission_no=2
    )
    failed = _submission(
        client,
        cup,
        participant,
        score=0.0,
        created_at=BASE + timedelta(hours=2),
        submission_no=3,
        status="failed",
    )
    # Record lỗi chấm điểm không có metrics: vẫn phải nằm trong kết quả sort, không làm 500.
    _run(
        client.app.state.mongo.db[SUBMISSIONS_COLLECTION].update_one(
            {"_id": failed}, {"$unset": {"metrics": "", "primary_score": ""}}
        )
    )
    _login(client)

    descending = _list(client, sort="precision", order="desc")
    assert [row["id"] for row in descending["submissions"]] == [
        str(high),
        str(low),
        str(failed),
    ]

    ascending = _list(client, sort="recall", order="asc")
    assert [row["id"] for row in ascending["submissions"]] == [
        str(failed),
        str(low),
        str(high),
    ]

    # Phân trang trên cột metric không được trùng hoặc mất dòng.
    first = _list(client, sort="f1", order="desc", limit=2, offset=0)["submissions"]
    second = _list(client, sort="f1", order="desc", limit=2, offset=2)["submissions"]
    assert [row["id"] for row in first] == [str(high), str(low)]
    assert [row["id"] for row in second] == [str(failed)]


def test_global_list_returns_stats_for_current_filter(client):
    seeded = _seed_portfolio(client)

    body = _list(client)
    assert body["stats"] == {
        "total": 3,
        "competitions": 2,
        "teams": 2,
        "completed": 2,
    }
    # `total` và `stats.total` luôn là cùng một con số.
    assert body["total"] == body["stats"]["total"]

    by_competition = _list(client, competition_id=str(seeded["cup_a"]))
    assert by_competition["stats"] == {
        "total": 2,
        "competitions": 1,
        "teams": 2,
        "completed": 2,
    }

    by_account = _list(client, q="đội khác")
    assert by_account["stats"] == {
        "total": 1,
        "competitions": 1,
        "teams": 1,
        "completed": 1,
    }

    # Lọc trạng thái rejected: không còn bài completed nào trong tập kết quả.
    rejected = _list(client, status="rejected")
    assert rejected["stats"] == {
        "total": 1,
        "competitions": 1,
        "teams": 1,
        "completed": 0,
    }

    combined = _list(client, competition_id=str(seeded["cup_a"]), q="Thí Sinh")
    assert combined["stats"] == {
        "total": 1,
        "competitions": 1,
        "teams": 1,
        "completed": 1,
    }


def test_global_list_rejects_invalid_params(client):
    _login(client)
    for params in (
        {"status": "unknown"},
        {"sort": "file_path"},
        {"sort": "metrics.f1"},
        {"sort": "competition_name"},
        {"order": "random"},
        {"competition_id": "khong-phai-objectid"},
        {"limit": 0},
        {"limit": 201},
        {"offset": -1},
    ):
        response = client.get(GLOBAL_URL, params=params)
        assert response.status_code == 422, params
        assert response.json()["error"]["code"] in {"VALIDATION_ERROR", "REQUEST_VALIDATION_ERROR"}


def test_competition_scoped_list_has_no_stats_and_rejects_competition_sort(client):
    """Bảng theo cuộc thi giữ nguyên shape: không thẻ thống kê, không sort theo cột cuộc thi."""
    from tests.helpers import ready_competition

    competition = ready_competition(client)
    _login(client)
    url = f"/api/admin/competitions/{competition['id']}/submissions"

    body = client.get(url).json()
    assert "stats" not in body
    assert body["total"] == 0

    for field in ("f1", "precision", "recall"):
        assert client.get(url, params={"sort": field}).status_code == 200
    assert client.get(url, params={"sort": "competition"}).status_code == 422


def test_global_list_survives_deleted_competition_and_account(client):
    seeded = _seed_portfolio(client)
    _run(
        client.app.state.mongo.db[COMPETITIONS_COLLECTION].delete_one(
            {"_id": seeded["cup_b"]}
        )
    )
    _run(client.app.state.mongo.db["accounts"].delete_one({"_id": seeded["other"]}))

    rows = {row["id"]: row for row in _list(client)["submissions"]}
    orphan = rows[str(seeded["newest"])]
    assert orphan["competition"]["name"] == "Cuộc thi đã xóa"
    assert orphan["competition"]["slug"] == ""
    assert rows[str(seeded["middle"])]["account"]["name"] == "Tài khoản đã xóa"
    assert rows[str(seeded["middle"])]["account"]["email"] == ""
