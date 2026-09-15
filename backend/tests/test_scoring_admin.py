"""Admin scoring configuration and private ground-truth API tests."""

import asyncio

import pytest
from bson import ObjectId

from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.config import get_settings


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


def _login(client, email="admin@vku.vn", password="adminmatkhau1"):
    response = client.post("/api/auth/login", json={"identifier": email, "password": password})
    assert response.status_code == 200


def _competition(client, slug="scoring-cup", publish=False):
    _login(client)
    response = client.post(
        "/api/admin/competitions",
        json={
            "slug": slug,
            "name": slug,
            "start_at": "2026-01-01T00:00:00Z",
            "end_at": "2027-01-01T00:00:00Z",
            "primary_metric": "f1",
            "quota_per_day": 5,
        },
    )
    assert response.status_code == 201
    competition = response.json()
    if publish:
        assert client.post(f"/api/admin/competitions/{competition['id']}/publish").status_code == 200
    return competition


def _config(**overrides):
    body = {
        "id_column": "id",
        "prediction_column": "prediction",
        "label_column": "label",
        "average": "binary",
        "pos_label": "1",
        "higher_is_better": True,
    }
    body.update(overrides)
    return body


def _put_config(client, competition_id, **overrides):
    return client.put(
        f"/api/admin/competitions/{competition_id}/scoring",
        json=_config(**overrides),
    )


def test_scoring_admin_requires_login_and_admin_role(client):
    assert client.get("/api/admin/competitions/abc/scoring").status_code == 401
    competition = _competition(client)
    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")
    response = client.get(f"/api/admin/competitions/{competition['id']}/scoring")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


def test_config_and_ground_truth_create_ready_metadata(client, isolated_data_dir):
    competition = _competition(client, publish=True)
    cid = competition["id"]
    initial = client.get(f"/api/admin/competitions/{cid}/scoring")
    assert initial.status_code == 200
    assert initial.json() == {
        "ready": False,
        "locked": False,
        "config": None,
        "ground_truth": None,
        "primary_metric": "f1",
        "quota_per_day": 5,
        "max_upload_mb": 10,
    }

    configured = _put_config(client, cid)
    assert configured.status_code == 200
    assert configured.json()["config"] == _config()
    assert configured.json()["ready"] is False

    uploaded = client.put(
        f"/api/admin/competitions/{cid}/ground-truth",
        files={"file": ("truth.csv", b"id,label,private_note\n1,1,a\n2,0,b\n")},
    )
    assert uploaded.status_code == 200
    body = uploaded.json()
    assert body["ready"] is True
    assert body["ground_truth"]["row_count"] == 2
    assert body["ground_truth"]["columns"] == ["id", "label", "private_note"]
    assert body["ground_truth"]["uploaded_at"].endswith("Z")
    assert "labels" not in body["ground_truth"]

    expected = isolated_data_dir / "competitions" / cid / "private" / "ground_truth.csv"
    assert expected.read_bytes().startswith(b"id,label")

    async def stored_competition():
        return await client.app.state.mongo.db[COMPETITIONS_COLLECTION].find_one(
            {"_id": ObjectId(cid)}
        )

    stored = asyncio.run(stored_competition())
    assert stored["scoring_config"] == _config()
    assert set(stored["scoring_config"]) == {
        "id_column",
        "prediction_column",
        "label_column",
        "average",
        "pos_label",
        "higher_is_better",
    }
    assert stored["ground_truth"]["path"] == f"competitions/{cid}/private/ground_truth.csv"

    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")
    public = client.get("/api/competitions/scoring-cup")
    assert public.status_code == 200
    assert public.json()["submission_config"] == {
        "ready": True,
        "id_column": "id",
        "prediction_column": "prediction",
        "average": "binary",
        "pos_label": "1",
        "max_upload_mb": 10,
    }
    assert client.get(f"/api/competitions/{cid}/ground-truth").status_code == 404

    expected.unlink()
    outside = isolated_data_dir / "outside.csv"
    outside.write_bytes(b"id,label\n1,0\n2,1\n")
    expected.symlink_to(outside)
    public_after_symlink = client.get("/api/competitions/scoring-cup")
    assert public_after_symlink.json()["submission_config"]["ready"] is False
    _login(client)
    admin_after_symlink = client.get(f"/api/admin/competitions/{cid}/scoring")
    assert admin_after_symlink.json()["ready"] is False
    incompatible_storage = _put_config(client, cid, prediction_column="answer")
    assert incompatible_storage.status_code == 422
    assert incompatible_storage.json()["error"]["code"] == "GROUND_TRUTH_INVALID"


def test_ground_truth_requires_valid_config_and_keeps_invalid_file_out(client, isolated_data_dir):
    competition = _competition(client)
    cid = competition["id"]
    url = f"/api/admin/competitions/{cid}/ground-truth"
    missing_config = client.put(url, files={"file": ("truth.csv", b"id,label\n1,1\n")})
    assert missing_config.status_code == 422
    assert missing_config.json()["error"]["code"] == "SCORING_CONFIG_REQUIRED"

    assert _put_config(client, cid).status_code == 200
    invalid = client.put(url, files={"file": ("truth.csv", b"id,label\n1,1\n1,0\n")})
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "GROUND_TRUTH_INVALID"
    assert not (
        isolated_data_dir / "competitions" / cid / "private" / "ground_truth.csv"
    ).exists()


def test_config_update_validates_existing_ground_truth_before_saving(client):
    competition = _competition(client)
    cid = competition["id"]
    assert _put_config(client, cid).status_code == 200
    assert client.put(
        f"/api/admin/competitions/{cid}/ground-truth",
        files={"file": ("truth.csv", b"id,label\n1,1\n2,0\n")},
    ).status_code == 200

    incompatible = _put_config(client, cid, label_column="target")
    assert incompatible.status_code == 422
    assert incompatible.json()["error"]["code"] == "GROUND_TRUTH_INVALID"
    current = client.get(f"/api/admin/competitions/{cid}/scoring").json()
    assert current["config"]["label_column"] == "label"


@pytest.mark.parametrize(
    "overrides",
    [
        {"average": "micro"},
        {"average": "binary", "pos_label": None},
        {"average": "macro", "pos_label": "1"},
        {"higher_is_better": False},
        {"prediction_column": "id"},
    ],
)
def test_scoring_config_rejects_unsupported_values(client, overrides):
    competition = _competition(client)
    response = _put_config(client, competition["id"], **overrides)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SCORING_CONFIG_INVALID"


def test_scoring_config_and_ground_truth_lock_after_completed_submission(client):
    competition = _competition(client)
    cid = competition["id"]
    assert _put_config(client, cid).status_code == 200
    ground_truth_url = f"/api/admin/competitions/{cid}/ground-truth"
    assert client.put(
        ground_truth_url,
        files={"file": ("truth.csv", b"id,label\n1,1\n2,0\n")},
    ).status_code == 200

    async def seed_completed():
        await client.app.state.mongo.db["submissions"].insert_one(
            {
                "competition_id": ObjectId(cid),
                "account_id": ObjectId(),
                "status": "completed",
            }
        )

    asyncio.run(seed_completed())
    status = client.get(f"/api/admin/competitions/{cid}/scoring")
    assert status.json()["locked"] is True
    for response in (
        _put_config(client, cid),
        client.put(
            ground_truth_url,
            files={"file": ("truth.csv", b"id,label\n1,0\n2,1\n")},
        ),
    ):
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "SCORING_LOCKED"


def test_closed_competition_scoring_is_locked_even_without_submission(client):
    competition = _competition(client, publish=True)
    cid = competition["id"]
    assert client.post(f"/api/admin/competitions/{cid}/close").status_code == 200
    response = _put_config(client, cid)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SCORING_LOCKED"
