"""Bảng xếp hạng tổng hợp: phép cộng có trọng số, cổng nguồn hai nhánh và trạng thái chờ.

Bài nộp và membership ghi thẳng Mongo (kèm `_touch` bỏ cache BXH) như `test_normalization_ranking`;
luồng chấm thật không chạy ở đây.
"""

from datetime import datetime, timedelta, timezone

import pytest
from bson import ObjectId

from app.competitions.service import COMPETITIONS_COLLECTION
from app.memberships.service import MEMBERSHIPS_COLLECTION
from app.submissions.service import SUBMISSIONS_COLLECTION
from tests.helpers import login, login_participant, ready_competition
from tests.test_competition_tracks import create_dual_ok, dual_body, publish_dual_v1
from tests.test_normalization_ranking import (
    HIDDEN_PRIMARY_NORM_CONTRACT,
    LOSS_CONTRACT,
    _create_account,
    _participant,
    _ready_v2,
    _run,
    _submission,
    _touch,
)

BASE = datetime(2026, 9, 15, 8, tzinfo=timezone.utc)


def _source(competition: dict, weight: float) -> dict:
    return {"competition_id": competition["id"], "weight": weight}


def _create_aggregate(client, name: str, sources: list[dict], **extra) -> dict:
    login(client)
    response = client.post("/api/admin/aggregates", json={"name": name, "sources": sources, **extra})
    assert response.status_code == 201, response.text
    return response.json()


def _publish(client, slug: str) -> dict:
    login(client)
    response = client.post(f"/api/admin/aggregates/{slug}/publish")
    assert response.status_code == 200, response.text
    return response.json()


def _board(client, slug: str, **params) -> dict:
    login_participant(client)
    response = client.get(f"/api/aggregates/{slug}/leaderboard", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _draft_competition(client, slug: str) -> dict:
    now = datetime.now(timezone.utc)
    login(client)
    response = client.post(
        "/api/admin/competitions",
        json={
            "slug": slug,
            "name": slug,
            "start_at": (now - timedelta(days=1)).isoformat(),
            "end_at": (now + timedelta(days=1)).isoformat(),
            "primary_metric": "f1",
            "quota_per_day": 5,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _join(client, competition: dict, account_id) -> None:
    """Membership ghi thẳng Mongo - cuộc thi dual dời lịch chặn join qua API."""
    _run(
        client.app.state.mongo.db[MEMBERSHIPS_COLLECTION].insert_one(
            {
                "competition_id": ObjectId(competition["id"]),
                "account_id": account_id,
                "active": True,
                "joined_at": BASE,
                "updated_at": BASE,
            }
        )
    )


def test_weighted_totals_ties_and_missing_zero(client):
    """Ví dụ khoá: An 84 = 0.6×80 + 0.4×90; thiếu kết quả đóng góp 0 với mẫu số giữ nguyên."""
    a = ready_competition(client, slug="agg-cv", normalization={"enabled": True, "baseline": 0.5})
    b = ready_competition(client, slug="agg-nlp", normalization={"enabled": True, "baseline": 0.5})
    participant = _participant(client)
    binh = _create_account(client, "Bình", "agg-binh@vku.vn")
    chi = _create_account(client, "Chi", "agg-chi@vku.vn")
    dinh = _create_account(client, "Đỉnh", "agg-dinh@vku.vn")
    for competition, entries in (
        (a, [(participant["_id"], 0.9), (binh, 0.9), (chi, 0.9), (dinh, 1.0), (chi, 0.7)]),
        (b, [(participant["_id"], 0.95), (chi, 0.5), (dinh, 1.0)]),
    ):
        for position, (account_id, score) in enumerate(entries):
            _submission(client, competition, account_id, score, BASE + timedelta(minutes=position))
        _touch(competition)

    # Điểm chuẩn hóa: reference của A là 1.0 nên 0.9 → 80; của B là 1.0 nên 0.95 → 90, 0.5 → 0.
    created = _create_aggregate(
        client,
        "Tổng hợp mùa thu",
        [_source(a, 0.6), _source(b, 0.4)],
    )
    assert created["slug"] == "tong-hop-mua-thu"
    assert created["published"] is False
    _publish(client, created["slug"])

    board = _board(client, created["slug"])
    assert board["status"] == "ready"
    assert board["view"] == "public"
    assert board["has_private"] is False
    assert board["total"] == 4

    entries = board["entries"]
    assert [entry["rank"] for entry in entries] == [1, 2, 3, 3]
    dinh_entry, an, binh_entry, chi_entry = entries
    assert "account_id" not in dinh_entry

    assert dinh_entry["total_score"] == 100.0
    assert an["display_name"] == "Thí Sinh"
    assert an["total_score"] == pytest.approx(84.0, abs=1e-9)
    # 0.95 − 0.5 không biểu diễn chính xác trong số thực nhị phân nên norm ra ~90 chứ không đúng 90.
    assert [component["score"] for component in an["components"]] == pytest.approx(
        [80.0, 90.0], abs=1e-9
    )
    assert [component["competition_id"] for component in an["components"]] == [a["id"], b["id"]]
    # Chi có hai bài ở A nhưng chỉ bài đại diện (điểm cao nhất) được ghép.
    assert binh_entry["total_score"] == pytest.approx(48.0, abs=1e-9)
    # Thiếu kết quả là `null` (không có bài), khác hẳn bài 0 điểm của Chi.
    assert binh_entry["components"][0]["score"] == pytest.approx(80.0, abs=1e-9)
    assert binh_entry["components"][1]["score"] is None
    assert [component["score"] for component in chi_entry["components"]] == pytest.approx(
        [80.0, 0.0], abs=1e-9
    )
    # Bình và Chi hòa tuyệt đối: thiếu bài hay bài 0 điểm cùng đóng góp 0.
    assert binh_entry["total_score"] == chi_entry["total_score"]

    sources = board["sources"]
    assert [source["weight"] for source in sources] == [0.6, 0.4]
    assert [source["score_kind"] for source in sources] == ["normalized", "normalized"]
    assert [source["metric_label"] for source in sources] == ["Norm", "Norm"]
    assert all(source["ready"] and source["reason"] is None for source in sources)
    assert board["updated_at"].endswith("Z")

    assert an["is_current_user"] is True
    assert board["me"]["rank"] == 2
    assert board["me"]["total_score"] == pytest.approx(84.0, abs=1e-9)
    assert board["me"]["is_current_user"] is True


def test_exact_ties_rank_1_2_2_4(client):
    a = ready_competition(client, slug="agg-tie-a")
    b = ready_competition(client, slug="agg-tie-b")
    participant = _participant(client)
    q = _create_account(client, "Q", "agg-tie-q@vku.vn")
    r = _create_account(client, "R", "agg-tie-r@vku.vn")
    s = _create_account(client, "S", "agg-tie-s@vku.vn")
    for account_id, score_a, score_b in (
        (participant["_id"], 1.0, 1.0),
        (q, 0.6, 0.4),
        (r, 0.6, 0.4),
        (s, 0.9, 0.0),
    ):
        _submission(client, a, account_id, score_a, BASE)
        _submission(client, b, account_id, score_b, BASE)
    _touch(a)
    _touch(b)

    created = _create_aggregate(client, "Bảng hòa", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])
    board = _board(client, created["slug"])
    assert [entry["rank"] for entry in board["entries"]] == [1, 2, 2, 4]
    assert [entry["total_score"] for entry in board["entries"]] == [1.0, 0.5, 0.5, 0.45]
    # Hai lượt đọc liên tiếp giữ nguyên cả thứ tự dòng trong nhóm hòa.
    assert _board(client, created["slug"])["entries"] == board["entries"]


def test_equal_after_rounding_still_ranks_apart(client):
    """Hai tổng chỉ chênh nhau ở phần bị làm tròn khi hiển thị không phải là hòa."""
    a = ready_competition(client, slug="agg-round-a")
    b = ready_competition(client, slug="agg-round-b")
    participant = _participant(client)
    rival = _create_account(client, "Đối thủ", "agg-round-rival@vku.vn")
    for account_id, score_a in ((participant["_id"], 0.601), (rival, 0.6)):
        _submission(client, a, account_id, score_a, BASE)
        _submission(client, b, account_id, 0.4, BASE)
    _touch(a)
    _touch(b)

    created = _create_aggregate(client, "Bảng lệch nhỏ", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])
    first, second = _board(client, created["slug"])["entries"]
    assert round(first["total_score"], 2) == round(second["total_score"], 2) == 0.5
    assert first["total_score"] > second["total_score"]
    assert [first["rank"], second["rank"]] == [1, 2]


def test_raw_source_keeps_scale_and_sign(client):
    """Nguồn không chuẩn hóa đóng góp nguyên điểm gốc: 0.8 vẫn là 0.8, điểm âm vẫn âm."""
    a = ready_competition(client, slug="agg-raw-a")
    b = ready_competition(client, slug="agg-raw-b")
    participant = _participant(client)
    rival = _create_account(client, "Đối thủ", "agg-raw-rival@vku.vn")
    loser = _create_account(client, "Điểm âm", "agg-raw-loser@vku.vn")
    _submission(client, a, participant["_id"], 0.8, BASE)
    _submission(client, b, rival, 0.0, BASE)
    _submission(client, a, loser, -0.5, BASE)
    _touch(a)
    _touch(b)

    created = _create_aggregate(client, "Bảng thô", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])
    board = _board(client, created["slug"])
    assert [source["score_kind"] for source in board["sources"]] == ["primary", "primary"]
    assert board["sources"][0]["metric_label"] == "F1"

    entries = {entry["display_name"]: entry for entry in board["entries"]}
    assert entries["Thí Sinh"]["components"][0]["score"] == 0.8
    assert entries["Thí Sinh"]["total_score"] == 0.4
    assert entries["Điểm âm"]["components"][0]["score"] == -0.5
    assert entries["Điểm âm"]["total_score"] == -0.25
    assert entries["Đối thủ"]["total_score"] == 0.0
    # Điểm âm xếp sau cả người thiếu bài (đóng góp 0) - hệ quả đã biết của thang gốc.
    assert [entry["display_name"] for entry in board["entries"]] == ["Thí Sinh", "Đối thủ", "Điểm âm"]


def test_lower_is_better_source_contributes_live_norm(client, fake_runner):
    fake_runner.metrics = {"loss": 0.8}
    loss = _ready_v2(client, "agg-loss", baseline=0.9, output_contract=LOSS_CONTRACT)
    other = ready_competition(client, slug="agg-loss-other")
    participant = _participant(client)
    best = _create_account(client, "Nhẹ nhất", "agg-loss-best@vku.vn")
    _submission(client, loss, participant["_id"], 0.7, BASE, metrics={"loss": 0.7})
    _submission(client, loss, best, 0.5, BASE + timedelta(minutes=1), metrics={"loss": 0.5})
    _submission(client, other, participant["_id"], 0.5, BASE)
    _touch(loss)
    _touch(other)

    created = _create_aggregate(client, "Bảng loss", [_source(loss, 0.6), _source(other, 0.4)])
    _publish(client, created["slug"])
    board = _board(client, created["slug"])
    assert board["sources"][0]["score_kind"] == "normalized"
    entries = {entry["display_name"]: entry for entry in board["entries"]}
    assert entries["Nhẹ nhất"]["components"][0]["score"] == 100.0
    assert entries["Thí Sinh"]["components"][0]["score"] == pytest.approx(50.0, abs=1e-9)
    assert entries["Thí Sinh"]["total_score"] == pytest.approx(30.2, abs=1e-9)
    assert entries["Nhẹ nhất"]["total_score"] == 60.0
    assert [entry["display_name"] for entry in board["entries"]] == ["Nhẹ nhất", "Thí Sinh"]


def test_ready_empty_board_is_not_waiting(client):
    a = ready_competition(client, slug="agg-empty-a")
    b = ready_competition(client, slug="agg-empty-b")
    created = _create_aggregate(client, "Bảng trống", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])
    board = _board(client, created["slug"])
    assert board["status"] == "ready"
    assert board["entries"] == []
    assert board["total"] == 0
    assert board["me"] is None
    assert board["has_more"] is False
    assert all(source["ready"] for source in board["sources"])


def test_draft_source_waits_the_whole_view(client):
    ready = ready_competition(client, slug="agg-draft-ready")
    draft = _draft_competition(client, "agg-draft-source")
    participant = _participant(client)
    _submission(client, ready, participant["_id"], 0.9, BASE)
    _touch(ready)
    created = _create_aggregate(
        client, "Bảng chờ nháp", [_source(ready, 0.5), _source(draft, 0.5)]
    )
    _publish(client, created["slug"])

    board = _board(client, created["slug"])
    assert board["status"] == "waiting"
    assert board["entries"] == []
    assert board["total"] is None
    assert board["me"] is None
    assert board["has_more"] is False
    sources = board["sources"]
    assert sources[0]["ready"] is True
    assert sources[1]["ready"] is False
    # Nguồn nháp bị chặn ngay ở bước nháp, dù `leaderboard_visible` của nó mặc định bật.
    assert sources[1]["reason"] == "source_draft"
    assert sources[1]["name"] == "agg-draft-source"
    assert sources[1]["slug"] == "agg-draft-source"
    # Nguồn đang chờ không lộ nhãn metric qua chính lời giải thích chờ.
    assert sources[1]["score_kind"] is None
    assert sources[1]["metric_label"] is None

    # Nguồn còn nháp chặn cả đường xem trước của admin.
    login(client)
    preview = client.get(f"/api/admin/aggregates/{created['slug']}/leaderboard")
    assert preview.status_code == 200
    assert preview.json()["status"] == "waiting"


def test_hidden_source_leaderboard_waits(client):
    hidden = ready_competition(client, slug="agg-hidden")
    other = ready_competition(client, slug="agg-hidden-other")
    login(client)
    patched = client.patch(
        f"/api/admin/competitions/{hidden['id']}", json={"leaderboard_visible": False}
    )
    assert patched.status_code == 200, patched.text
    created = _create_aggregate(
        client, "Bảng ẩn BXH", [_source(hidden, 0.5), _source(other, 0.5)]
    )
    _publish(client, created["slug"])

    board = _board(client, created["slug"])
    assert board["status"] == "waiting"
    assert board["sources"][0]["reason"] == "leaderboard_hidden"
    assert board["sources"][1]["ready"] is True
    assert board["entries"] == [] and board["total"] is None and board["me"] is None


def test_hidden_metric_waits_without_leaking_label(client, fake_runner):
    fake_runner.metrics = {"accuracy": 0.9, "n_items": 4.0}
    hidden = _ready_v2(
        client, "agg-metric", baseline=0.5, output_contract=HIDDEN_PRIMARY_NORM_CONTRACT
    )
    other = ready_competition(client, slug="agg-metric-other")
    created = _create_aggregate(
        client,
        "Bảng ẩn metric",
        [_source(hidden, 0.5), _source(other, 0.5)],
    )
    _publish(client, created["slug"])

    board = _board(client, created["slug"])
    assert board["status"] == "waiting"
    # Metric chính bị ẩn với thí sinh làm bảng chờ, và lời giải thích không lộ nhãn metric.
    assert board["sources"][0]["reason"] == "source_metric_hidden"
    assert board["sources"][0]["metric_label"] is None
    assert board["entries"] == [] and board["total"] is None


def test_broken_norm_config_waits_with_source_invalid(client):
    a = ready_competition(client, slug="agg-broken", normalization={"enabled": True, "baseline": 0.5})
    b = ready_competition(client, slug="agg-broken-b")
    created = _create_aggregate(client, "Bảng norm hỏng", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])
    _run(
        client.app.state.mongo.db[COMPETITIONS_COLLECTION].update_one(
            {"_id": ObjectId(a["id"])}, {"$set": {"normalization.baseline": None}}
        )
    )

    board = _board(client, created["slug"])
    assert board["status"] == "waiting"
    assert board["sources"][0]["reason"] == "source_invalid"
    assert board["entries"] == [] and board["total"] is None


def test_unusable_representative_score_waits_not_zero(client):
    a = ready_competition(client, slug="agg-corrupt")
    b = ready_competition(client, slug="agg-corrupt-b")
    participant = _participant(client)
    broken = _create_account(client, "Bài hỏng", "agg-corrupt-broken@vku.vn")
    _submission(client, a, participant["_id"], 0.9, BASE)
    _submission(client, a, broken, None, BASE + timedelta(minutes=1))
    _submission(client, b, participant["_id"], 0.4, BASE)
    _touch(a)
    _touch(b)

    created = _create_aggregate(client, "Bảng bài hỏng", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])
    board = _board(client, created["slug"])
    assert board["status"] == "waiting"
    assert board["sources"][0]["reason"] == "source_invalid"
    # Điểm hỏng không bị coi là chưa nộp (0) và nguồn còn lại cũng không bị quy lỗi.
    assert board["sources"][1]["ready"] is True
    assert board["entries"] == [] and board["total"] is None and board["me"] is None


def test_deleted_source_waits_with_source_missing(client):
    a = ready_competition(client, slug="agg-missing")
    b = ready_competition(client, slug="agg-missing-b")
    participant = _participant(client)
    _submission(client, b, participant["_id"], 0.9, BASE)
    _touch(b)
    created = _create_aggregate(client, "Bảng mất nguồn", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])
    # Xoá thẳng document nguồn, bỏ qua chốt xoá của API - mô phỏng đúng khe hở đã biết.
    _run(client.app.state.mongo.db[COMPETITIONS_COLLECTION].delete_one({"_id": ObjectId(a["id"])}))

    board = _board(client, created["slug"])
    assert board["status"] == "waiting"
    assert board["sources"][0]["reason"] == "source_missing"
    assert board["sources"][0]["name"] is None
    assert board["sources"][0]["slug"] is None
    assert board["entries"] == [] and board["total"] is None and board["me"] is None

    listing = client.get("/api/aggregates")
    assert listing.status_code == 200
    assert [item["slug"] for item in listing.json()["aggregates"]] == [created["slug"]]


def test_private_unpublished_waits_only_the_private_view(client):
    login(client)
    dual = create_dual_ok(client, dual_body(slug="agg-dual"))
    publish_dual_v1(client, dual["id"], slug="agg-dual")
    other = ready_competition(client, slug="agg-dual-other")
    participant = _participant(client)
    _submission(client, other, participant["_id"], 0.9, BASE)
    _touch(other)

    created = _create_aggregate(client, "Bảng hai nhánh", [_source(dual, 0.5), _source(other, 0.5)])
    _publish(client, created["slug"])

    public = _board(client, created["slug"], view="public")
    assert public["status"] == "ready"
    assert public["has_private"] is True
    assert public["total"] == 1

    private = _board(client, created["slug"], view="private")
    assert private["status"] == "waiting"
    assert private["view"] == "private"
    assert private["sources"][0]["reason"] == "private_unpublished"
    # Nguồn còn lại đã sẵn sàng nhưng bảng chờ thì không lộ gì của nó.
    assert private["sources"][1]["ready"] is True
    assert private["entries"] == [] and private["total"] is None and private["me"] is None


def test_locked_public_track_waits_its_own_view(client):
    login(client)
    dual = create_dual_ok(
        client, dual_body(slug="agg-locked", public_hours=(1, 3), private_hours=(-1, 1))
    )
    publish_dual_v1(client, dual["id"], slug="agg-locked", join=False)
    participant = _participant(client)
    _join(client, dual, participant["_id"])
    other = ready_competition(client, slug="agg-locked-other")
    _submission(client, other, participant["_id"], 0.9, BASE)
    _touch(other)

    login(client)
    detail = client.get(f"/api/admin/competitions/{dual['id']}").json()
    released = client.post(
        f"/api/admin/competitions/{dual['id']}/tracks/private/publish-results",
        json={"expected_revision": detail["control_revision"]},
    )
    assert released.status_code == 200, released.text

    created = _create_aggregate(
        client, "Bảng khóa nhánh", [_source(dual, 0.5), _source(other, 0.5)]
    )
    _publish(client, created["slug"])

    public = _board(client, created["slug"], view="public")
    assert public["status"] == "waiting"
    assert public["sources"][0]["reason"] == "track_not_open"
    assert public["entries"] == [] and public["total"] is None

    private = _board(client, created["slug"], view="private")
    assert private["status"] == "ready"
    assert private["total"] == 1


def test_single_sources_share_one_board_across_views(client):
    a = ready_competition(client, slug="agg-single-a")
    b = ready_competition(client, slug="agg-single-b")
    participant = _participant(client)
    _submission(client, a, participant["_id"], 0.9, BASE)
    _touch(a)

    created = _create_aggregate(client, "Bảng đơn", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])

    public = _board(client, created["slug"])
    private = _board(client, created["slug"], view="private")
    assert public["has_private"] is False
    assert public["status"] == private["status"] == "ready"
    assert public["total"] == private["total"] == 1
    assert private["view"] == "private"
    assert public["entries"] == private["entries"]


def test_invalid_view_is_rejected(client):
    a = ready_competition(client, slug="agg-view-a")
    b = ready_competition(client, slug="agg-view-b")
    created = _create_aggregate(client, "Bảng view sai", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])

    login_participant(client)
    response = client.get(
        f"/api/aggregates/{created['slug']}/leaderboard", params={"view": "nội-bộ"}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_VIEW"


def test_board_merges_every_account_and_paginates_with_global_rank(client):
    a = ready_competition(client, slug="agg-page-a")
    b = ready_competition(client, slug="agg-page-b")
    participant = _participant(client)
    _submission(client, b, participant["_id"], 0.4, BASE)
    rivals = [ObjectId() for _ in range(201)]
    _run(
        client.app.state.mongo.db[SUBMISSIONS_COLLECTION].insert_many(
            [
                {
                    "_id": ObjectId(),
                    "competition_id": ObjectId(a["id"]),
                    "account_id": account_id,
                    "status": "completed",
                    "created_at": BASE,
                    "metrics": {"f1": 1.0 - index * 0.001},
                    "primary_score": 1.0 - index * 0.001,
                }
                for index, account_id in enumerate(rivals)
            ]
        )
    )
    _touch(a)
    _touch(b)

    created = _create_aggregate(client, "Bảng nhiều dòng", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])

    first = _board(client, created["slug"], limit=50)
    assert first["total"] == 202
    assert first["has_more"] is True
    assert len(first["entries"]) == 50
    assert first["entries"][0]["rank"] == 1
    assert all(entry["display_name"] == "Tài khoản đã xóa" for entry in first["entries"])
    # Hợp đủ mọi tài khoản của hai nguồn; `me` đọc trên toàn bảng kể cả khi ngoài trang đang xem.
    assert first["me"]["rank"] == 202
    assert first["me"]["total_score"] == pytest.approx(0.2, abs=1e-9)

    last = _board(client, created["slug"], offset=200, limit=50)
    assert [entry["rank"] for entry in last["entries"]] == [201, 202]
    assert last["has_more"] is False
