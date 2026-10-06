"""Số liệu cá nhân (`my_stats`) trên danh sách cuộc thi của thí sinh.

Hạng/điểm phải lấy từ đúng bảng xếp hạng (tie-break, chiều metric, metric ẩn), còn lượt hôm nay
phải khớp quota trang chi tiết. Submission được ghi thẳng vào Mongo; luồng chấm thật đã có
`test_submissions.py` và `test_scoring_v2_api.py` lo.
"""

import asyncio
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.competitions.service import COMPETITIONS_COLLECTION
from app.submissions.service import SUBMISSIONS_COLLECTION
from tests.helpers import membership_document, publish_v2_competition
from tests.test_scoring_v2_results import HIDDEN_PRIMARY_CONTRACT, HIDDEN_PRIMARY_METRICS

BASE = datetime(2026, 9, 15, 8, tzinfo=timezone.utc)


def _run(awaitable):
    return asyncio.run(awaitable)


def _today_start() -> datetime:
    """Đầu ngày UTC hiện tại - mốc ghim để test không vỡ khi chạy gần nửa đêm UTC."""
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


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


def _account(client, email: str) -> dict:
    return _run(client.app.state.mongo.db["accounts"].find_one({"email": email}))


def _create_account(client, name: str, email: str) -> ObjectId:
    account_id = ObjectId()
    _run(
        client.app.state.mongo.db["accounts"].insert_one(
            {
                "_id": account_id,
                "email": email,
                "name": name,
                "password_hash": "unused-in-my-stats-tests",
                "role": "participant",
                "active": True,
                "created_at": BASE,
                "updated_at": BASE,
            }
        )
    )
    return account_id


def _create_competition(client, slug: str, *, leaderboard_visible: bool = True) -> ObjectId:
    competition_id = ObjectId()
    now = datetime.now(timezone.utc)
    _run(
        client.app.state.mongo.db[COMPETITIONS_COLLECTION].insert_one(
            {
                "_id": competition_id,
                "slug": slug,
                "name": slug.replace("-", " ").title(),
                "status": "published",
                "primary_metric": "f1",
                "join_mode": "open",
                "quota_per_day": 5,
                "leaderboard_visible": leaderboard_visible,
                "created_by": "admin@vku.vn",
                "start_at": now - timedelta(days=1),
                "end_at": now + timedelta(days=1),
            }
        )
    )
    return competition_id


def _insert_membership(
    client, competition_id: ObjectId, account_id: ObjectId, *, active: bool = True
) -> None:
    _run(
        client.app.state.mongo.db["competition_memberships"].insert_one(
            {
                "competition_id": competition_id,
                "account_id": account_id,
                "active": active,
                "joined_at": BASE,
                "updated_at": BASE,
            }
        )
    )


def _submission(
    client,
    competition_id: ObjectId,
    account_id: ObjectId,
    score: float,
    created_at: datetime,
    *,
    review_status: str | None = None,
    status: str = "completed",
) -> ObjectId:
    """Bài `completed`; `review_status="rejected"` là bài bị admin từ chối nhưng vẫn tiêu quota.

    `status="failed"` dựng bản ghi cũ chấm hỏng: có trong lịch sử nhưng không có metrics.
    """
    submission_id = ObjectId()
    document = {
        "_id": submission_id,
        "competition_id": competition_id,
        "account_id": account_id,
        "status": status,
        "created_at": created_at,
    }
    if status == "completed":
        document["metrics"] = {"f1": score, "precision": score, "recall": score}
        document["primary_score"] = score
    if review_status is not None:
        document["review"] = {"status": review_status}
    _run(client.app.state.mongo.db[SUBMISSIONS_COLLECTION].insert_one(document))
    return submission_id


def _list_item(client, slug: str) -> dict:
    response = client.get("/api/competitions")
    assert response.status_code == 200
    items = {item["slug"]: item for item in response.json()["competitions"]}
    return items[slug]


def test_guest_and_non_member_list_has_no_my_stats(client):
    _create_competition(client, "stats-open")
    # Người đã đăng nhập nhưng chưa join không nhận key này.
    _login_participant(client)
    assert "my_stats" not in _list_item(client, "stats-open")

    client.post("/api/auth/logout")
    assert "my_stats" not in _list_item(client, "stats-open")


def test_non_member_gets_zero_count_guest_gets_no_key(client):
    """`my_submission_count` dành cho mọi account đã đăng nhập, `my_stats` vẫn chỉ cho thành viên."""
    _create_competition(client, "stats-count-open")
    _login_participant(client)
    item = _list_item(client, "stats-count-open")
    assert item["my_submission_count"] == 0
    assert "my_stats" not in item

    client.post("/api/auth/logout")
    item = _list_item(client, "stats-count-open")
    assert "my_submission_count" not in item
    assert "my_stats" not in item


def test_my_submission_count_includes_rejected_and_failed_records(client):
    participant = _account(client, "thi.sinh@vku.vn")
    competition_id = _create_competition(client, "stats-count-all")
    _insert_membership(client, competition_id, participant["_id"])
    base = _today_start() + timedelta(minutes=1)
    _submission(client, competition_id, participant["_id"], 0.6, base)
    _submission(
        client,
        competition_id,
        participant["_id"],
        0.9,
        base + timedelta(minutes=5),
        review_status="rejected",
    )
    _submission(
        client,
        competition_id,
        participant["_id"],
        0.0,
        base + timedelta(minutes=10),
        status="failed",
    )

    _login_participant(client)
    item = _list_item(client, "stats-count-all")

    # Tổng bài đã nộp tính mọi record lịch sử, cùng quy ước với `total` trong lịch sử nộp bài.
    assert item["my_submission_count"] == 3
    # Bài bị từ chối và bản ghi failed không chen vào thứ hạng; lượt hôm nay vẫn theo bài completed.
    assert item["my_stats"]["best_score"] == 0.6
    assert item["my_stats"]["used_today"] == 2


def test_my_submission_count_survives_leaving_and_closing(client):
    participant = _account(client, "thi.sinh@vku.vn")
    competition_id = _create_competition(client, "stats-count-closed")
    _insert_membership(client, competition_id, participant["_id"], active=False)
    _submission(
        client, competition_id, participant["_id"], 0.8, _today_start() + timedelta(minutes=1)
    )

    _login_admin(client)
    assert client.post(f"/api/admin/competitions/{competition_id}/close").status_code == 200
    _login_participant(client)
    item = _list_item(client, "stats-count-closed")

    # Thành viên đã rời không còn hạng/điểm nhưng lịch sử nộp bài vẫn được đếm, kể cả khi đã đóng.
    assert item["status"] == "closed"
    assert item["my_submission_count"] == 1
    assert "my_stats" not in item


def test_my_submission_count_with_history_but_no_membership(client):
    participant = _account(client, "thi.sinh@vku.vn")
    competition_id = _create_competition(client, "stats-count-no-member")
    _submission(
        client, competition_id, participant["_id"], 0.8, _today_start() + timedelta(minutes=1)
    )

    _login_participant(client)
    item = _list_item(client, "stats-count-no-member")

    assert item["my_submission_count"] == 1
    assert "my_stats" not in item


def test_my_submission_count_isolated_per_account_and_competition(client):
    participant = _account(client, "thi.sinh@vku.vn")
    other_id = _create_account(client, "Đội Khác", "stats-count-other@vku.vn")
    cup_one = _create_competition(client, "stats-count-one")
    _create_competition(client, "stats-count-two")
    base = _today_start() + timedelta(minutes=1)
    _submission(client, cup_one, participant["_id"], 0.8, base)
    _submission(client, cup_one, participant["_id"], 0.7, base + timedelta(minutes=1))
    _submission(client, cup_one, other_id, 0.9, base)

    _login_participant(client)
    assert _list_item(client, "stats-count-one")["my_submission_count"] == 2
    assert _list_item(client, "stats-count-two")["my_submission_count"] == 0


def test_active_member_without_submissions_gets_zeroed_stats(client):
    participant = _account(client, "thi.sinh@vku.vn")
    competition_id = _create_competition(client, "stats-empty")
    _insert_membership(client, competition_id, participant["_id"])

    _login_participant(client)
    assert _list_item(client, "stats-empty")["my_stats"] == {
        "rank": None,
        "rank_total": None,
        "best_score": None,
        "best_normalized_score": None,
        "used_today": 0,
    }


def test_my_stats_matches_leaderboard_and_quota(client):
    participant = _account(client, "thi.sinh@vku.vn")
    early_account_id = _create_account(client, "Đội Sớm", "stats-early@vku.vn")
    third_account_id = _create_account(client, "Đội Ba", "stats-third@vku.vn")
    competition_id = _create_competition(client, "stats-cup")
    _insert_membership(client, competition_id, participant["_id"])
    base = _today_start() + timedelta(minutes=1)

    _submission(client, competition_id, participant["_id"], 0.7, base)
    _submission(client, competition_id, participant["_id"], 0.9, base + timedelta(minutes=30))
    # Bằng điểm nhưng đạt sớm hơn nên xếp trên - thứ hạng phải theo đúng bảng xếp hạng.
    _submission(client, competition_id, early_account_id, 0.9, base)
    _submission(client, competition_id, third_account_id, 0.8, base)

    _login_participant(client)
    stats = _list_item(client, "stats-cup")["my_stats"]

    board = client.get(f"/api/competitions/{competition_id}/leaderboard").json()
    assert stats == {
        "rank": board["me"]["rank"],
        "rank_total": board["total"],
        "best_score": board["me"]["primary_score"],
        "best_normalized_score": None,  # cuộc thi không bật chuẩn hóa
        "used_today": 2,
    }
    assert stats["rank"] == 2
    assert stats["rank_total"] == 3
    assert stats["best_score"] == 0.9
    # Lượt hôm nay của thẻ danh sách phải khớp quota trang chi tiết.
    assert client.get("/api/competitions/stats-cup").json()["quota"]["used_today"] == 2


def test_rejected_submission_leaves_ranking_but_still_counts_today(client):
    participant = _account(client, "thi.sinh@vku.vn")
    competition_id = _create_competition(client, "stats-rejected")
    _insert_membership(client, competition_id, participant["_id"])
    base = _today_start() + timedelta(minutes=1)

    _submission(client, competition_id, participant["_id"], 0.6, base)
    _submission(
        client,
        competition_id,
        participant["_id"],
        0.9,
        base + timedelta(minutes=5),
        review_status="rejected",
    )

    _login_participant(client)
    stats = _list_item(client, "stats-rejected")["my_stats"]

    # Bài bị từ chối không được tính kết quả nhưng vẫn tiêu một lượt quota.
    assert stats["best_score"] == 0.6
    assert stats["used_today"] == 2


def test_yesterday_submissions_do_not_count_toward_today(client):
    participant = _account(client, "thi.sinh@vku.vn")
    competition_id = _create_competition(client, "stats-yesterday")
    _insert_membership(client, competition_id, participant["_id"])
    # Ghim vào đầu ngày UTC hôm qua để không phụ thuộc giờ chạy test.
    _submission(
        client, competition_id, participant["_id"], 0.8, _today_start() - timedelta(minutes=1)
    )

    _login_participant(client)
    stats = _list_item(client, "stats-yesterday")["my_stats"]

    assert stats["used_today"] == 0
    assert stats["best_score"] == 0.8
    assert stats["rank"] == 1


def test_hidden_leaderboard_returns_no_rank_without_reading_board(client):
    participant = _account(client, "thi.sinh@vku.vn")
    competition_id = _create_competition(client, "stats-hidden-board", leaderboard_visible=False)
    _insert_membership(client, competition_id, participant["_id"])
    _submission(client, competition_id, participant["_id"], 0.8, _today_start() + timedelta(minutes=1))

    _login_participant(client)
    stats = _list_item(client, "stats-hidden-board")["my_stats"]

    assert stats == {
        "rank": None,
        "rank_total": None,
        "best_score": None,
        "best_normalized_score": None,
        "used_today": 1,
    }
    # Bảng vẫn bị chặn ở endpoint riêng - thẻ danh sách không mở đường vòng.
    assert client.get(f"/api/competitions/{competition_id}/leaderboard").status_code == 403


def test_hidden_primary_metric_nulls_best_score_but_keeps_rank(client, fake_runner):
    fake_runner.metrics = dict(HIDDEN_PRIMARY_METRICS)
    competition = publish_v2_competition(
        client, slug="stats-an-metric", output_contract=HIDDEN_PRIMARY_CONTRACT
    )
    membership = membership_document(client, competition["id"])
    _submission(
        client,
        ObjectId(competition["id"]),
        membership["account_id"],
        0.8,
        _today_start() + timedelta(minutes=1),
    )

    stats = _list_item(client, "stats-an-metric")["my_stats"]

    assert stats["best_score"] is None
    assert stats["rank"] == 1
    assert stats["used_today"] == 1


def test_closed_competition_keeps_final_stats(client):
    participant = _account(client, "thi.sinh@vku.vn")
    competition_id = _create_competition(client, "stats-closed")
    _insert_membership(client, competition_id, participant["_id"])
    _submission(client, competition_id, participant["_id"], 0.8, _today_start() + timedelta(minutes=1))

    _login_admin(client)
    assert client.post(f"/api/admin/competitions/{competition_id}/close").status_code == 200
    _login_participant(client)
    item = _list_item(client, "stats-closed")

    assert item["status"] == "closed"
    assert item["my_stats"]["rank"] == 1
    assert item["my_stats"]["best_score"] == 0.8
    # Cuộc thi đã đóng không còn quota ở trang chi tiết nhưng thẻ vẫn giữ số liệu cuối.
    assert "quota" not in client.get("/api/competitions/stats-closed").json()
