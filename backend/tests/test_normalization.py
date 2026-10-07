"""Điểm chuẩn hóa 0-100: công thức, cấu hình draft-only, khóa publish, clone và chống ghi chen."""

import asyncio
import json
import math
from datetime import datetime, timedelta, timezone

import pytest
from bson import ObjectId
from fastapi.testclient import TestClient

from app.competitions import admin_router as competitions_admin
from app.competitions.admin_router import _get_competition_or_404
from app.competitions.service import COMPETITIONS_COLLECTION
from app.scoring import normalization
from tests.helpers import configure_scoring


def _login(client, email="admin@vku.vn", password="adminmatkhau1"):
    resp = client.post("/api/auth/login", json={"identifier": email, "password": password})
    assert resp.status_code == 200


def _body(slug="norm-cup", **overrides):
    now = datetime.now(timezone.utc)
    base = {
        "slug": slug,
        "name": slug,
        "start_at": (now - timedelta(days=1)).isoformat(),
        "end_at": (now + timedelta(days=1)).isoformat(),
        "primary_metric": "f1",
        "quota_per_day": 5,
    }
    base.update(overrides)
    return base


def _create(client, slug="norm-cup", **overrides) -> dict:
    response = client.post("/api/admin/competitions", json=_body(slug, **overrides))
    assert response.status_code == 201, response.text
    return response.json()


def _update_document(client, competition_id: str, update: dict) -> None:
    async def run():
        await client.app.state.mongo.db[COMPETITIONS_COLLECTION].update_one(
            {"_id": ObjectId(competition_id)}, update
        )

    asyncio.run(run())


def _document(client, competition_id: str) -> dict:
    async def run():
        return await client.app.state.mongo.db[COMPETITIONS_COLLECTION].find_one(
            {"_id": ObjectId(competition_id)}
        )

    return asyncio.run(run())


class _StaleRead:
    """Giả lập lượt đọc cũ: đúng lượt thứ `stale_at` trả bản đã cũ, các lượt khác trả bản thật."""

    def __init__(self, stale: dict, *, stale_at: int = 1):
        self.stale = stale
        self.stale_at = stale_at
        self.calls = 0

    async def __call__(self, db, competition_id: str) -> dict:
        self.calls += 1
        current = await _get_competition_or_404(db, competition_id)
        return {**current, **self.stale} if self.calls == self.stale_at else current


class _StaleReadBeforeNormalization:
    """Giả lập lượt đọc cũ chưa thấy cấu hình norm: PATCH bật norm chen giữa đọc và ghi."""

    def __init__(self, *, stale_at: int = 1):
        self.stale_at = stale_at
        self.calls = 0

    async def __call__(self, db, competition_id: str) -> dict:
        self.calls += 1
        current = await _get_competition_or_404(db, competition_id)
        if self.calls == self.stale_at:
            return {key: value for key, value in current.items() if key != "normalization"}
        return current


# --- A. Công thức -------------------------------------------------------------------------------


def test_formula_higher_is_better():
    kwargs = {"baseline": 0.5, "higher_is_better": True}
    assert normalization.score(0.9, reference=0.9, **kwargs) == pytest.approx(100.0)
    assert normalization.score(0.7, reference=0.9, **kwargs) == pytest.approx(50.0, rel=1e-12)
    assert normalization.score(0.5, reference=0.9, **kwargs) == 0.0
    assert normalization.score(0.2, reference=0.9, **kwargs) == 0.0


def test_formula_lower_is_better():
    kwargs = {"baseline": 100.0, "higher_is_better": False}
    assert normalization.score(60, reference=60, **kwargs) == pytest.approx(100.0)
    assert normalization.score(80, reference=60, **kwargs) == pytest.approx(50.0)
    assert normalization.score(100, reference=60, **kwargs) == 0.0
    assert normalization.score(120, reference=60, **kwargs) == 0.0


def test_formula_without_anyone_above_baseline():
    """Không ai vượt baseline thì mọi bài 0, kể cả bài tốt nhất - không chia 0, không NaN."""
    assert normalization.score(0.4, baseline=0.5, reference=0.4, higher_is_better=True) == 0.0
    assert normalization.score(0.2, baseline=0.5, reference=0.2, higher_is_better=True) == 0.0
    assert normalization.reference_best([], higher_is_better=True) is None
    assert normalization.reference_best([0.2, 0.4], higher_is_better=True) == 0.4
    assert normalization.reference_best([0.2, 0.4], higher_is_better=False) == 0.2


def test_formula_baseline_zero_and_negative_are_valid():
    assert normalization.score(0.5, baseline=0.0, reference=1.0, higher_is_better=True) == 50.0
    # Lower-is-better với baseline âm: phải nhỏ hơn -1 mới có điểm, nên best -2 được 100 còn -1.5 được 50.
    kwargs = {"baseline": -1.0, "higher_is_better": False}
    assert normalization.score(-2.0, reference=-2.0, **kwargs) == pytest.approx(100.0)
    assert normalization.score(-1.5, reference=-2.0, **kwargs) == pytest.approx(50.0)
    # Best bằng 0 không thắng được baseline -1 (0 > -1): cả bảng 0, không chia 0.
    assert normalization.score(0.0, reference=0.0, **kwargs) == 0.0


def test_formula_does_not_round_before_ranking():
    """Làm tròn sớm có thể đổi thứ tự hoà: giá trị thô phải giữ nguyên độ chính xác."""
    first = normalization.score(1.0, baseline=0.0, reference=3.0, higher_is_better=True)
    second = normalization.score(1.0000004, baseline=0.0, reference=3.0, higher_is_better=True)
    assert first == pytest.approx(100 / 3, rel=1e-12)
    assert second > first
    assert second != first  # Nếu bị cắt 2 chữ số trước khi so, hai giá trị này bằng nhau.


def test_formula_tiny_gap_is_not_treated_as_zero():
    assert normalization.score(1e-9, baseline=0.0, reference=1.0, higher_is_better=True) > 0
    assert normalization.score(5e-301, baseline=0.0, reference=1e-300, higher_is_better=True) == pytest.approx(50.0)


def test_formula_survives_huge_finite_domain():
    """Hiệu hai số hữu hạn cực lớn tràn double: vẫn phải ra số hữu hạn, không NaN/Infinity."""
    value = normalization.score(0.0, baseline=-1e308, reference=1e308, higher_is_better=True)
    assert math.isfinite(value)
    assert value == pytest.approx(50.0)
    clamped = normalization.score(1.7e308, baseline=-1.7e308, reference=1.5e308, higher_is_better=True)
    assert math.isfinite(clamped)
    assert clamped == float(normalization.MAX_SCORE)


def test_valid_score_rule_rejects_non_numbers():
    assert normalization.is_valid_score(1) is True
    assert normalization.is_valid_score(0.5) is True
    assert normalization.is_valid_score(True) is False  # bool không phải điểm
    assert normalization.is_valid_score(float("nan")) is False
    assert normalization.is_valid_score(float("inf")) is False
    assert normalization.is_valid_score(None) is False
    assert normalization.is_valid_score("0.5") is False


# --- A. Validation cấu hình và projection -------------------------------------------------------


def test_config_payload_requires_finite_baseline():
    with pytest.raises(ValueError):
        normalization.config_payload(normalization.NormalizationRequest(enabled=True))
    with pytest.raises(ValueError):
        normalization.config_payload(normalization.NormalizationRequest(enabled=True, baseline=float("nan")))
    with pytest.raises(ValueError):
        normalization.config_payload(normalization.NormalizationRequest(enabled=True, baseline=float("inf")))
    with pytest.raises(ValueError):
        # Pydantic lax ép `true` thành 1.0 nếu không chặn trước - boolean không phải baseline.
        normalization.NormalizationRequest(enabled=True, baseline=True)
    assert normalization.config_payload(normalization.NormalizationRequest(enabled=True, baseline=0)) == {
        "enabled": True,
        "baseline": 0.0,
        "version": 1,
    }
    # Tắt chuẩn hóa luôn xoá baseline, kể cả khi request còn gửi kèm.
    assert normalization.config_payload(normalization.NormalizationRequest(enabled=False, baseline=0.6)) == {
        "enabled": False,
        "baseline": None,
        "version": 1,
    }
    assert normalization.config_payload(None) == {"enabled": False, "baseline": None, "version": 1}


def test_stored_config_handles_legacy_and_broken_records():
    legacy = {"_id": "x"}
    assert normalization.stored_config(legacy) == normalization.Config(False, None, 1)
    assert normalization.stored_config({**legacy, "normalization": {"enabled": False, "baseline": 0.6}}) == (
        normalization.Config(False, None, 1)
    )
    for broken in (
        {"normalization": "on"},
        {"normalization": {"enabled": True}},
        {"normalization": {"enabled": True, "baseline": None}},
        {"normalization": {"enabled": True, "baseline": "0.5"}},
        {"normalization": {"enabled": True, "baseline": float("nan")}},
        {"normalization": {"enabled": True, "baseline": 0.6, "version": None}},
        {"normalization": {"enabled": True, "baseline": 0.6, "version": "1"}},
    ):
        with pytest.raises(normalization.NormalizationError):
            normalization.stored_config({**legacy, **broken})


def test_config_guard_pins_observed_shape():
    # Document cũ không có field: so với dạng chuẩn hóa sẽ báo conflict giả, nên phải đòi vắng mặt.
    assert normalization.config_guard({"_id": "x"}) == {"normalization": {"$exists": False}}
    assert normalization.config_guard(
        {"normalization": {"enabled": False, "baseline": None, "version": 1}}
    ) == {
        "normalization.enabled": False,
        "normalization.baseline": None,
        "normalization.version": 1,
    }
    assert normalization.config_guard({"normalization": {"enabled": True, "baseline": 0.6}}) == {
        "normalization.enabled": True,
        "normalization.baseline": 0.6,
        "normalization.version": {"$exists": False},
    }


def test_config_view_stays_readable_when_stored_record_is_broken():
    """DTO hiển thị không được raise vì một bản ghi hỏng: hiện nguyên trạng để admin còn đường sửa."""
    assert normalization.config_view(
        {"normalization": {"enabled": True, "baseline": None, "version": 1}}
    ) == {"enabled": True, "baseline": None, "version": 1}
    # Baseline/version không đọc được vẫn trả dạng hiển thị được (baseline None, version mặc định),
    # không kéo NaN hay chuỗi lạ vào JSON của response.
    assert normalization.config_view(
        {"normalization": {"enabled": True, "baseline": float("nan"), "version": "1"}}
    ) == {"enabled": True, "baseline": None, "version": 1}
    assert normalization.config_view({"normalization": "on"}) == {
        "enabled": False,
        "baseline": None,
        "version": 1,
    }


def test_projection_helpers_shape():
    calculated_at = datetime.now(timezone.utc)
    snapshot = {
        "version": 1,
        "source_metric": "f1",
        "higher_is_better": True,
        "baseline": 0.6,
        "reference_best": 0.8,
        "score": 25.0,
        "calculated_at": calculated_at,
    }
    assert normalization.participant_snapshot(snapshot) == {
        "score": 25.0,
        "calculated_at": normalization.iso_z(calculated_at),
    }
    assert normalization.participant_snapshot(None) is None
    assert normalization.admin_snapshot(snapshot)["reference_best"] == 0.8
    rule = normalization.Rule(baseline=0.6, source_metric="f1", higher_is_better=True)
    metadata = normalization.board_metadata(rule, reference=None, calculated_at=calculated_at)
    assert metadata["max_score"] == 100
    assert metadata["decimals"] == 2
    assert metadata["reference_best"] is None
    assert metadata["calculated_at"] == normalization.iso_z(calculated_at)


# --- D. Cấu hình qua API ------------------------------------------------------------------------


def test_create_stores_canonical_configuration(client):
    _login(client)
    enabled = _create(client, normalization={"enabled": True, "baseline": 0.6})
    assert enabled["normalization"] == {"enabled": True, "baseline": 0.6, "version": 1}
    assert _document(client, enabled["id"])["normalization"] == {
        "enabled": True,
        "baseline": 0.6,
        "version": 1,
    }
    disabled = _create(client, slug="norm-off-cup")
    assert disabled["normalization"] == {"enabled": False, "baseline": None, "version": 1}


def test_create_rejects_enabled_without_baseline(client):
    _login(client)
    for baseline_case in ({"enabled": True}, {"enabled": True, "baseline": None}):
        response = client.post("/api/admin/competitions", json=_body(**{"normalization": baseline_case}))
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    # NaN/Infinity phải gửi dạng token thô (json.dumps của Python chấp nhận, JSON chuẩn thì không).
    for token in ("NaN", "Infinity", "-Infinity"):
        raw = json.dumps(_body(normalization={"enabled": True, "baseline": "__TOKEN__"})).replace(
            '"__TOKEN__"', token
        )
        response = client.post(
            "/api/admin/competitions", content=raw, headers={"content-type": "application/json"}
        )
        assert response.status_code == 422, response.text
    # Boolean bị chặn ngay ở tầng parse, không âm thầm thành 1.0.
    response = client.post(
        "/api/admin/competitions", json=_body(normalization={"enabled": True, "baseline": True})
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


def test_patch_normalization_only_in_draft(client):
    _login(client)
    competition = _create(client)
    patched = client.patch(
        f"/api/admin/competitions/{competition['id']}",
        json={"normalization": {"enabled": True, "baseline": 0.6}},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["normalization"] == {"enabled": True, "baseline": 0.6, "version": 1}

    configure_scoring(client, competition["id"])
    assert client.post(f"/api/admin/competitions/{competition['id']}/publish").status_code == 200

    refused = client.patch(
        f"/api/admin/competitions/{competition['id']}",
        json={"normalization": {"enabled": False, "baseline": None}},
    )
    assert refused.status_code == 422
    assert "chuẩn hóa" in refused.json()["error"]["message"]
    # Sửa field khác trên cuộc thi đã publish vẫn phải đi được.
    renamed = client.patch(f"/api/admin/competitions/{competition['id']}", json={"name": "Tên mới"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Tên mới"
    assert renamed.json()["normalization"]["enabled"] is True


def test_patch_rejects_explicit_null_normalization(client):
    _login(client)
    competition = _create(client)
    refused = client.patch(
        f"/api/admin/competitions/{competition['id']}", json={"normalization": None}
    )
    assert refused.status_code == 422
    assert refused.json()["error"]["code"] == "VALIDATION_ERROR"


def test_patch_and_publish_work_on_legacy_draft_without_field(client):
    """Draft cũ không có field normalization vẫn sửa và publish được - guard dùng $exists:false."""
    _login(client)
    competition = _create(client)
    _update_document(client, competition["id"], {"$unset": {"normalization": ""}})

    configure_scoring(client, competition["id"])
    enabled = client.patch(
        f"/api/admin/competitions/{competition['id']}",
        json={"normalization": {"enabled": True, "baseline": 0.5}},
    )
    assert enabled.status_code == 200, enabled.text
    published = client.post(f"/api/admin/competitions/{competition['id']}/publish")
    assert published.status_code == 200, published.text

    legacy_again = _create(client, slug="norm-legacy-cup")
    _update_document(client, legacy_again["id"], {"$unset": {"normalization": ""}})
    configure_scoring(client, legacy_again["id"])
    published_legacy = client.post(f"/api/admin/competitions/{legacy_again['id']}/publish")
    assert published_legacy.status_code == 200, published_legacy.text


def test_patch_conflicts_when_configuration_changed_mid_request(client, monkeypatch):
    """Đọc cũ nói baseline 0.5, DB đã bị đổi thành 0.9: lượt ghi phải trượt (409), không ghi đè."""
    _login(client)
    competition = _create(client, normalization={"enabled": True, "baseline": 0.6})
    _update_document(
        client,
        competition["id"],
        {"$set": {"normalization": {"enabled": True, "baseline": 0.9, "version": 1}}},
    )
    stale = _StaleRead({"normalization": {"enabled": True, "baseline": 0.6, "version": 1}})
    monkeypatch.setattr(competitions_admin, "_get_competition_or_404", stale)

    refused = client.patch(
        f"/api/admin/competitions/{competition['id']}",
        json={"normalization": {"enabled": True, "baseline": 0.7}},
    )
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "COMPETITION_CHANGED"
    assert _document(client, competition["id"])["normalization"]["baseline"] == 0.9


def test_publish_conflicts_when_normalization_changed_mid_request(client, monkeypatch):
    """Baseline đổi giữa lượt readiness và lượt ghi status thì publish bị từ chối, cuộc thi ở lại draft."""
    _login(client)
    competition = _create(client, normalization={"enabled": True, "baseline": 0.6})
    configure_scoring(client, competition["id"])
    _update_document(
        client,
        competition["id"],
        {"$set": {"normalization": {"enabled": True, "baseline": 0.9, "version": 1}}},
    )
    stale = _StaleRead({"normalization": {"enabled": True, "baseline": 0.6, "version": 1}})
    monkeypatch.setattr(competitions_admin, "_get_competition_or_404", stale)

    refused = client.post(f"/api/admin/competitions/{competition['id']}/publish")
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "SCORING_REVISION_CONFLICT"
    assert _document(client, competition["id"])["status"] == "draft"


def test_publish_conflicts_when_status_changed_mid_request(client, monkeypatch):
    """Trạng thái đổi giữa lượt đọc của _transition và lượt ghi: phải trượt, không 200 rỗng."""
    _login(client)
    competition = _create(client)
    configure_scoring(client, competition["id"])
    _update_document(client, competition["id"], {"$set": {"status": "closed"}})
    # Lượt đọc đầu (cổng publish) thấy trạng thái thật "closed"; lượt đọc trong _transition mới là bản cũ.
    stale = _StaleRead({"status": "draft"}, stale_at=2)
    monkeypatch.setattr(competitions_admin, "_get_competition_or_404", stale)

    refused = client.post(f"/api/admin/competitions/{competition['id']}/publish")
    assert refused.status_code == 422
    assert refused.json()["error"]["code"] == "INVALID_TRANSITION"
    assert _document(client, competition["id"])["status"] == "closed"


def test_publish_blocked_when_stored_configuration_is_broken(client):
    """Bản ghi hỏng (sửa tay dưới DB) phải chặn publish với lý do rõ, không publish rồi mới vỡ bảng."""
    _login(client)
    competition = _create(client, normalization={"enabled": True, "baseline": 0.6})
    configure_scoring(client, competition["id"])
    _update_document(client, competition["id"], {"$set": {"normalization.baseline": None}})

    refused = client.post(f"/api/admin/competitions/{competition['id']}/publish")
    assert refused.status_code == 422
    assert refused.json()["error"]["code"] == "NORMALIZATION_CONFIG_INVALID"


def test_broken_stored_config_does_not_break_competition_listing(client):
    """Một bản ghi norm hỏng (sửa tay dưới DB) không được làm sập danh sách/chi tiết cuộc thi."""
    _login(client)
    competition = _create(
        client, normalization={"enabled": True, "baseline": 0.6}, leaderboard_visible=True
    )
    configure_scoring(client, competition["id"])
    assert client.post(f"/api/admin/competitions/{competition['id']}/publish").status_code == 200
    _update_document(client, competition["id"], {"$set": {"normalization.baseline": None}})

    listing = client.get("/api/competitions")
    assert listing.status_code == 200, listing.text
    listed = next(item for item in listing.json()["competitions"] if item["slug"] == "norm-cup")
    assert listed["normalization"] == {"enabled": True, "baseline": None, "version": 1}

    detail = client.get("/api/competitions/norm-cup")
    assert detail.status_code == 200, detail.text
    assert detail.json()["normalization"] == {"enabled": True, "baseline": None, "version": 1}

    # BXH của chính cuộc thi đó vẫn phải thất bại ồn ào, không âm thầm xếp theo luật raw.
    with TestClient(client.app, raise_server_exceptions=False) as raw:
        raw.cookies.update(client.cookies)
        board = raw.get("/api/competitions/norm-cup/leaderboard")
    assert board.status_code == 500
    assert board.json()["error"]["code"] == "INTERNAL_ERROR"


def test_scoring_source_is_locked_once_published_with_normalization(client):
    _login(client)
    competition = _create(client, normalization={"enabled": True, "baseline": 0.6})
    configure_scoring(client, competition["id"])
    assert client.post(f"/api/admin/competitions/{competition['id']}/publish").status_code == 200

    # Nguồn của v1 là primary_metric, đã bị khóa từ trước; đường v2 không được mở lại nguồn khác.
    from tests.helpers import V2_CONTRACT, V2_SCHEMA

    changed = client.put(
        f"/api/admin/competitions/{competition['id']}/scoring",
        json={
            "version": 2,
            "expected_revision": 0,
            "input_schema": V2_SCHEMA,
            "evaluator": {"name": "Bộ chấm thử", "source_code": None},
            "output_contract": {**V2_CONTRACT, "primary_metric": "n_items"},
        },
    )
    assert changed.status_code == 422
    assert changed.json()["error"]["code"] == "SCORING_LOCKED"

    # Giữ đúng nguồn cũ (f1) và chiều cũ thì được: chuyển đời cấu hình chỉ vì kỹ thuật.
    kept = client.put(
        f"/api/admin/competitions/{competition['id']}/scoring",
        json={
            "version": 2,
            "expected_revision": 0,
            "input_schema": V2_SCHEMA,
            "evaluator": {"name": "Bộ chấm thử", "source_code": None},
            "output_contract": {
                "metrics": [{"key": "f1", "label": "F1", "decimals": 4}],
                "primary_metric": "f1",
                "higher_is_better": True,
                "visible_metrics": None,
            },
        },
    )
    assert kept.status_code == 200, kept.text


def test_scoring_save_keeps_a_source_while_draft_normalization_is_on(client):
    """Draft đang bật norm không được lưu cấu hình v2 không có metric chính, nhưng đổi nguồn thì được."""
    from tests.helpers import V2_SCHEMA

    _login(client)
    competition = _create(client, normalization={"enabled": True, "baseline": 0.6})
    dropped = client.put(
        f"/api/admin/competitions/{competition['id']}/scoring",
        json={
            "version": 2,
            "expected_revision": 0,
            "input_schema": V2_SCHEMA,
            "evaluator": {"name": "Bộ chấm thử", "source_code": None},
            "output_contract": None,
        },
    )
    assert dropped.status_code == 422
    assert dropped.json()["error"]["code"] == "SCORING_CONFIG_REQUIRED"


def test_scoring_save_conflicts_when_normalization_is_enabled_mid_request(client, monkeypatch):
    """Lượt lưu scoring đọc lúc chưa bật norm: norm bật chen giữa phải làm lượt ghi trượt (409).

    Không thì draft kẹt ở trạng thái bật norm mà không còn metric chính, và chính lượt lưu sau
    không sửa được nữa vì norm đã bật.
    """
    from app.scoring import admin_router as scoring_admin
    from tests.helpers import V2_SCHEMA

    _login(client)
    competition = _create(client)
    configure_scoring(client, competition["id"])
    patched = client.patch(
        f"/api/admin/competitions/{competition['id']}",
        json={"normalization": {"enabled": True, "baseline": 0.5}},
    )
    assert patched.status_code == 200, patched.text

    stale = _StaleReadBeforeNormalization()
    monkeypatch.setattr(scoring_admin, "_get_competition_or_404", stale)

    refused = client.put(
        f"/api/admin/competitions/{competition['id']}/scoring",
        json={
            "version": 2,
            "expected_revision": 0,
            "input_schema": V2_SCHEMA,
            "evaluator": {"name": "Bộ chấm thử", "source_code": None},
            "output_contract": None,
        },
    )
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "SCORING_REVISION_CONFLICT"
    # Cấu hình chấm vẫn là bản v1 cũ: lượt ghi không được áp cấu hình đã kiểm dưới luật cũ.
    assert _document(client, competition["id"])["scoring_config"].get("revision") is None


def test_clone_copies_normalization(client):
    _login(client)
    competition = _create(client, normalization={"enabled": True, "baseline": 0.6})
    cloned = client.post(f"/api/admin/competitions/{competition['id']}/clone")
    assert cloned.status_code == 201, cloned.text
    body = cloned.json()
    assert body["normalization"] == {"enabled": True, "baseline": 0.6, "version": 1}
    assert body["status"] == "draft"

    legacy = _create(client, slug="norm-legacy-clone")
    _update_document(client, legacy["id"], {"$unset": {"normalization": ""}})
    cloned_legacy = client.post(f"/api/admin/competitions/{legacy['id']}/clone")
    assert cloned_legacy.status_code == 201
    assert cloned_legacy.json()["normalization"] == {"enabled": False, "baseline": None, "version": 1}


def test_reopen_does_not_unlock_normalization(client):
    _login(client)
    competition = _create(client, normalization={"enabled": True, "baseline": 0.6})
    configure_scoring(client, competition["id"])
    assert client.post(f"/api/admin/competitions/{competition['id']}/publish").status_code == 200
    assert client.post(f"/api/admin/competitions/{competition['id']}/close").status_code == 200
    assert client.post(f"/api/admin/competitions/{competition['id']}/reopen").status_code == 200
    refused = client.patch(
        f"/api/admin/competitions/{competition['id']}",
        json={"normalization": {"enabled": True, "baseline": 0.9}},
    )
    assert refused.status_code == 422
    assert _document(client, competition["id"])["normalization"]["baseline"] == 0.6


def test_participant_payload_reports_normalization_configuration(client):
    """Thí sinh cần biết cuộc thi đang bật norm để không hiển thị điểm gốc như điểm xếp hạng."""
    _login(client)
    competition = _create(client, normalization={"enabled": True, "baseline": 0.6})
    configure_scoring(client, competition["id"])
    assert client.post(f"/api/admin/competitions/{competition['id']}/publish").status_code == 200
    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")
    assert client.post(f"/api/competitions/{competition['slug']}/join", json={}).status_code == 200
    detail = client.get(f"/api/competitions/{competition['slug']}")
    assert detail.status_code == 200
    assert detail.json()["normalization"] == {"enabled": True, "baseline": 0.6, "version": 1}
