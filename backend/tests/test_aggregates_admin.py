"""API admin bảng tổng hợp: validate trọn cấu hình, công bố/ẩn idempotent, xoá và chốt xoá nguồn."""

import json
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.aggregates import service as aggregates_service
from app.competitions.service import COMPETITIONS_COLLECTION
from tests.helpers import (
    login,
    login_participant,
    publish_v2_competition,
    put_scoring_v2,
    ready_competition,
)
from tests.test_aggregates import _draft_competition, _publish
from tests.test_normalization_ranking import LOSS_CONTRACT, _run


def _source(competition: dict, weight: float, **extra) -> dict:
    return {"competition_id": competition["id"], "weight": weight, **extra}


def _error(response) -> dict:
    return response.json()["error"]


def _create(client, name: str, sources: list[dict], **extra):
    login(client)
    return client.post("/api/admin/aggregates", json={"name": name, "sources": sources, **extra})


def _create_ok(client, name: str, sources: list[dict], **extra) -> dict:
    response = _create(client, name, sources, **extra)
    assert response.status_code == 201, response.text
    return response.json()


def test_create_requires_two_distinct_existing_sources(client):
    a = ready_competition(client, slug="agg-admin-a")
    b = ready_competition(client, slug="agg-admin-b")
    login(client)
    cases = (
        [_source(a, 1.0)],  # thiếu nguồn thứ hai
        [_source(a, 0.5), _source(a, 0.5)],  # trùng nguồn
        [_source(a, 0.5), {"competition_id": "không-phải-mã", "weight": 0.5}],
        [_source(a, 0.5), {"competition_id": str(ObjectId()), "weight": 0.5}],  # không tồn tại
    )
    for sources in cases:
        response = client.post(
            "/api/admin/aggregates", json={"name": "Bảng lỗi nguồn", "sources": sources}
        )
        assert response.status_code == 422, response.text
        assert _error(response)["code"] == "AGGREGATE_SOURCES_INVALID"


def test_create_rejects_bad_weights(client):
    a = ready_competition(client, slug="agg-admin-w-a")
    b = ready_competition(client, slug="agg-admin-w-b")
    login(client)
    cases = (
        [_source(a, 0.5), _source(b, 0.4)],  # tổng 0.9
        [_source(a, 0.7), _source(b, 0.4)],  # tổng 1.1
        [_source(a, 0.0), _source(b, 1.0)],  # có phần tử 0
        [_source(a, 1.2), _source(b, -0.2)],  # có phần tử vượt 1
    )
    for sources in cases:
        response = client.post(
            "/api/admin/aggregates", json={"name": "Bảng lỗi trọng số", "sources": sources}
        )
        assert response.status_code == 422, response.text
        assert _error(response)["code"] == "AGGREGATE_WEIGHT_INVALID"

    # NaN/Infinity không có trong JSON chuẩn nên phải gửi thô; json.loads phía server vẫn đọc được.
    for bad_weight in (float("nan"), float("inf")):
        body = json.dumps(
            {
                "name": "Bảng lỗi trọng số",
                "sources": [_source(a, bad_weight), _source(b, 0.5)],
            }
        )
        response = client.post(
            "/api/admin/aggregates",
            content=body.encode(),
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422, response.text
        assert _error(response)["code"] == "AGGREGATE_WEIGHT_INVALID"

    boolean = client.post(
        "/api/admin/aggregates",
        json={
            "name": "Bảng boolean",
            "sources": [
                {"competition_id": a["id"], "weight": True},
                {"competition_id": b["id"], "weight": 1.0},
            ],
        },
    )
    assert boolean.status_code == 422
    assert _error(boolean)["code"] == "VALIDATION_ERROR"

    # Dung sai kỹ thuật 1e-6: lệch trong ngưỡng vẫn nhận, không tự cân lại trọng số.
    accepted = _create_ok(client, "Bảng lệch nhỏ", [_source(a, 0.7), _source(b, 0.3000001)])
    assert [source["weight"] for source in accepted["sources"]] == [0.7, 0.3000001]


def test_create_rejects_source_without_primary_metric(client):
    ready = ready_competition(client, slug="agg-admin-metric")
    now = datetime.now(timezone.utc)
    login(client)
    created = client.post(
        "/api/admin/competitions",
        json={
            "slug": "agg-admin-no-metric",
            "name": "Chưa khai metric",
            "start_at": (now - timedelta(days=1)).isoformat(),
            "end_at": (now + timedelta(days=1)).isoformat(),
            "primary_metric": "f1",
            "quota_per_day": 5,
        },
    )
    assert created.status_code == 201, created.text
    draft = created.json()
    configured = put_scoring_v2(client, draft["id"], expected_revision=0, output_contract=None)
    assert configured.status_code == 200, configured.text

    response = client.post(
        "/api/admin/aggregates",
        json={"name": "Bảng thiếu metric", "sources": [_source(ready, 0.5), _source(draft, 0.5)]},
    )
    assert response.status_code == 422
    assert _error(response)["code"] == "AGGREGATE_UNSUPPORTED_SOURCE"
    assert "metric chính" in _error(response)["message"]


def test_create_rejects_lower_better_without_norm(client, fake_runner):
    fake_runner.metrics = {"loss": 0.8}
    loss = publish_v2_competition(client, slug="agg-admin-loss", output_contract=LOSS_CONTRACT)
    other = ready_competition(client, slug="agg-admin-loss-other")
    login(client)
    response = client.post(
        "/api/admin/aggregates",
        json={"name": "Bảng thấp-là-tốt", "sources": [_source(loss, 0.5), _source(other, 0.5)]},
    )
    assert response.status_code == 422
    assert _error(response)["code"] == "AGGREGATE_UNSUPPORTED_SOURCE"
    assert "thấp-là-tốt" in _error(response)["message"]


def test_create_generates_slug_and_rejects_duplicate(client):
    a = ready_competition(client, slug="agg-admin-dup-a")
    b = ready_competition(client, slug="agg-admin-dup-b")
    created = _create_ok(client, "Bảng Mùa Thu", [_source(a, 0.5), _source(b, 0.5)])
    assert created["slug"] == "bang-mua-thu"
    assert created["published"] is False
    assert created["created_by"] == "admin@vku.vn"
    assert created["visibility"] == "members_any"
    assert [source["name"] for source in created["sources"]] == ["agg-admin-dup-a", "agg-admin-dup-b"]

    duplicate = _create(client, "Bảng Mùa Thu", [_source(a, 0.5), _source(b, 0.5)])
    assert duplicate.status_code == 409
    assert _error(duplicate)["code"] == "AGGREGATE_SLUG_TAKEN"


def test_slug_race_is_reported_as_conflict(client, monkeypatch):
    a = ready_competition(client, slug="agg-admin-race-a")
    b = ready_competition(client, slug="agg-admin-race-b")
    _create_ok(client, "Bảng Đua", [_source(a, 0.5), _source(b, 0.5)])

    async def missing(db, slug):
        return None

    # Request khác vừa chèn cùng slug sau bước kiểm tra: unique `_id` là chốt cuối.
    monkeypatch.setattr(aggregates_service, "find_aggregate", missing)
    response = _create(client, "Bảng Đua", [_source(a, 0.5), _source(b, 0.5)])
    assert response.status_code == 409
    assert _error(response)["code"] == "AGGREGATE_SLUG_TAKEN"


def test_patch_merges_and_validates_whole_config(client):
    a = ready_competition(client, slug="agg-admin-patch-a")
    b = ready_competition(client, slug="agg-admin-patch-b")
    c = ready_competition(client, slug="agg-admin-patch-c")
    created = _create_ok(
        client,
        "Bảng Sửa",
        [_source(a, 0.5), _source(b, 0.5)],
        visibility="authenticated",
    )
    login(client)
    base = f"/api/admin/aggregates/{created['slug']}"
    # So hai lượt đọc (đều đã cắt mili-giây khi lưu), không so với response tạo còn micro-giây.
    before = client.get(base).json()["updated_at"]
    same = client.patch(base, json={"name": created["name"]})
    assert same.status_code == 200
    assert same.json()["updated_at"] == before  # no-op không đổi mốc cập nhật

    renamed = client.patch(base, json={"name": "Bảng Sửa Tên"})
    assert renamed.status_code == 200
    body = renamed.json()
    assert body["name"] == "Bảng Sửa Tên"
    assert body["slug"] == created["slug"]
    assert [source["competition_id"] for source in body["sources"]] == [a["id"], b["id"]]
    assert body["visibility"] == "authenticated"

    replaced = client.patch(base, json={"sources": [_source(b, 0.3), _source(c, 0.7)]})
    assert replaced.status_code == 200
    assert [source["competition_id"] for source in replaced.json()["sources"]] == [b["id"], c["id"]]
    assert [source["weight"] for source in replaced.json()["sources"]] == [0.3, 0.7]

    bad_sum = client.patch(base, json={"sources": [_source(b, 0.9), _source(c, 0.9)]})
    assert bad_sum.status_code == 422
    assert _error(bad_sum)["code"] == "AGGREGATE_WEIGHT_INVALID"

    null_field = client.patch(base, json={"visibility": None})
    assert null_field.status_code == 422
    assert _error(null_field)["code"] == "VALIDATION_ERROR"

    # Field ngoài model (kể cả `published`) bị bỏ qua an toàn, không đổi trạng thái công bố.
    ignored = client.patch(base, json={"published": True})
    assert ignored.status_code == 200
    assert ignored.json()["published"] is False


def test_patch_name_revalidates_the_sources(client):
    a = ready_competition(client, slug="agg-admin-reval-a", normalization={"enabled": True, "baseline": 0.5})
    b = ready_competition(client, slug="agg-admin-reval-b")
    created = _create_ok(client, "Bảng Kiểm Lại", [_source(a, 0.5), _source(b, 0.5)])
    login(client)
    _run(
        client.app.state.mongo.db[COMPETITIONS_COLLECTION].update_one(
            {"_id": ObjectId(a["id"])}, {"$set": {"normalization.baseline": None}}
        )
    )
    response = client.patch(f"/api/admin/aggregates/{created['slug']}", json={"name": "Tên Mới"})
    assert response.status_code == 422
    assert _error(response)["code"] == "AGGREGATE_UNSUPPORTED_SOURCE"
    kept = client.get(f"/api/admin/aggregates/{created['slug']}")
    assert kept.json()["name"] == "Bảng Kiểm Lại"


def test_publish_revalidates_sources(client):
    a = ready_competition(client, slug="agg-admin-pub-a")
    b = ready_competition(client, slug="agg-admin-pub-b")
    created = _create_ok(client, "Bảng Công Bố", [_source(a, 0.5), _source(b, 0.5)])
    login(client)
    _run(client.app.state.mongo.db[COMPETITIONS_COLLECTION].delete_one({"_id": ObjectId(a["id"])}))
    response = client.post(f"/api/admin/aggregates/{created['slug']}/publish")
    assert response.status_code == 422
    assert _error(response)["code"] == "AGGREGATE_SOURCES_INVALID"


def test_publish_allows_waiting_sources(client):
    ready = ready_competition(client, slug="agg-admin-wait-ready")
    draft = _draft_competition(client, "agg-admin-wait-draft")
    created = _create_ok(client, "Bảng Chờ Nguồn", [_source(ready, 0.5), _source(draft, 0.5)])
    published = _publish(client, created["slug"])
    assert published["published"] is True

    # Cấu hình hợp lệ đã công bố, nhưng view vẫn chờ nguồn nháp - hai trạng thái khác nhau.
    login_participant(client)
    board = client.get(f"/api/aggregates/{created['slug']}/leaderboard")
    assert board.status_code == 200
    assert board.json()["status"] == "waiting"


def test_publish_and_unpublish_are_idempotent(client):
    a = ready_competition(client, slug="agg-admin-idem-a")
    b = ready_competition(client, slug="agg-admin-idem-b")
    created = _create_ok(client, "Bảng Lặp", [_source(a, 0.5), _source(b, 0.5)])
    first = _publish(client, created["slug"])
    login(client)
    again = client.post(f"/api/admin/aggregates/{created['slug']}/publish")
    assert again.status_code == 200
    assert again.json()["published"] is True
    assert again.json()["updated_at"] == first["updated_at"]

    hidden = client.post(f"/api/admin/aggregates/{created['slug']}/unpublish")
    assert hidden.status_code == 200
    assert hidden.json()["published"] is False
    hidden_again = client.post(f"/api/admin/aggregates/{created['slug']}/unpublish")
    assert hidden_again.json() == hidden.json()


def test_unpublish_always_works_but_republish_needs_healthy_sources(client):
    a = ready_competition(client, slug="agg-admin-unpub-a", normalization={"enabled": True, "baseline": 0.5})
    b = ready_competition(client, slug="agg-admin-unpub-b")
    created = _create_ok(client, "Bảng Hỏng", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])
    _run(
        client.app.state.mongo.db[COMPETITIONS_COLLECTION].update_one(
            {"_id": ObjectId(a["id"])}, {"$set": {"normalization.baseline": None}}
        )
    )
    login(client)
    hidden = client.post(f"/api/admin/aggregates/{created['slug']}/unpublish")
    assert hidden.status_code == 200
    assert hidden.json()["published"] is False

    republished = client.post(f"/api/admin/aggregates/{created['slug']}/publish")
    assert republished.status_code == 422
    assert _error(republished)["code"] == "AGGREGATE_UNSUPPORTED_SOURCE"


def test_delete_requires_unpublish_and_confirm_slug(client):
    a = ready_competition(client, slug="agg-admin-del-a")
    b = ready_competition(client, slug="agg-admin-del-b")
    created = _create_ok(client, "Bảng Xoá", [_source(a, 0.5), _source(b, 0.5)])
    _publish(client, created["slug"])
    login(client)
    base = f"/api/admin/aggregates/{created['slug']}"

    blocked = client.delete(base, params={"confirm_slug": created["slug"]})
    assert blocked.status_code == 409
    assert _error(blocked)["code"] == "AGGREGATE_NOT_DELETABLE"

    client.post(f"{base}/unpublish")
    mismatch = client.delete(base, params={"confirm_slug": "sai-slug"})
    assert mismatch.status_code == 422
    assert _error(mismatch)["code"] == "CONFIRM_SLUG_MISMATCH"

    deleted = client.delete(base, params={"confirm_slug": created["slug"]})
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True, "slug": created["slug"]}

    missing = client.delete(base, params={"confirm_slug": created["slug"]})
    assert missing.status_code == 404
    assert _error(missing)["code"] == "AGGREGATE_NOT_FOUND"


def test_competition_delete_guard_covers_draft_aggregates(client):
    a = ready_competition(client, slug="agg-admin-guard-a")
    b = ready_competition(client, slug="agg-admin-guard-b")
    created = _create_ok(client, "Bảng Chặn Xoá", [_source(a, 0.5), _source(b, 0.5)])
    login(client)
    closed = client.post(f"/api/admin/competitions/{a['id']}/close")
    assert closed.status_code == 200, closed.text

    blocked = client.delete(
        f"/api/admin/competitions/{a['id']}", params={"confirm_slug": a["slug"]}
    )
    assert blocked.status_code == 409
    assert _error(blocked)["code"] == "COMPETITION_REFERENCED_BY_AGGREGATE"
    assert "Bảng Chặn Xoá" in _error(blocked)["message"]

    removed_aggregate = client.delete(
        f"/api/admin/aggregates/{created['slug']}", params={"confirm_slug": created["slug"]}
    )
    assert removed_aggregate.status_code == 200
    removed = client.delete(
        f"/api/admin/competitions/{a['id']}", params={"confirm_slug": a["slug"]}
    )
    assert removed.status_code == 200, removed.text


def test_admin_list_returns_drafts_with_source_names(client):
    a = ready_competition(client, slug="agg-admin-list-a")
    b = ready_competition(client, slug="agg-admin-list-b")
    created = _create_ok(client, "Bảng Danh Sách", [_source(a, 0.5), _source(b, 0.5)])
    login(client)
    listing = client.get("/api/admin/aggregates")
    assert listing.status_code == 200
    items = listing.json()["aggregates"]
    assert [item["slug"] for item in items] == [created["slug"]]
    item = items[0]
    assert item["published"] is False
    assert item["created_by"] == "admin@vku.vn"
    assert [source["slug"] for source in item["sources"]] == ["agg-admin-list-a", "agg-admin-list-b"]
    assert [source["name"] for source in item["sources"]] == ["agg-admin-list-a", "agg-admin-list-b"]


def test_preview_reads_the_saved_config(client):
    a = ready_competition(client, slug="agg-admin-preview-a")
    b = ready_competition(client, slug="agg-admin-preview-b")
    created = _create_ok(client, "Bảng Xem Trước", [_source(a, 0.5), _source(b, 0.5)])
    login(client)
    base = f"/api/admin/aggregates/{created['slug']}"

    # Nháp vẫn xem trước được; đổi cấu hình áp dụng ngay cho lượt đọc kế tiếp, không cần công bố.
    draft_preview = client.get(f"{base}/leaderboard")
    assert draft_preview.status_code == 200
    assert draft_preview.json()["status"] == "ready"

    client.patch(base, json={"sources": [_source(b, 0.3), _source(a, 0.7)]})
    preview = client.get(f"{base}/leaderboard")
    assert [source["competition_id"] for source in preview.json()["sources"]] == [b["id"], a["id"]]

    private_preview = client.get(f"{base}/leaderboard", params={"view": "private"})
    assert private_preview.json()["view"] == "private"
