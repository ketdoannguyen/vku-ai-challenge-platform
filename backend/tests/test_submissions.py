"""Submission upload policy, validation, scoring and persistence tests."""

import asyncio
from datetime import datetime, timedelta, timezone

import logging

import pytest
from bson import ObjectId

from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.config import get_settings
from app.submissions.service import SUBMISSIONS_COLLECTION


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


def _login(client, email="admin@vku.vn", password="adminmatkhau1"):
    response = client.post("/api/auth/login", json={"identifier": email, "password": password})
    assert response.status_code == 200


def _login_participant(client):
    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")


def _ready_competition(client, slug="submission-cup", quota=5, ground_truth=None):
    now = datetime.now(timezone.utc)
    _login(client)
    created = client.post(
        "/api/admin/competitions",
        json={
            "slug": slug,
            "name": slug,
            "start_at": (now - timedelta(days=1)).isoformat(),
            "end_at": (now + timedelta(days=1)).isoformat(),
            "primary_metric": "f1",
            "quota_per_day": quota,
        },
    )
    assert created.status_code == 201
    competition = created.json()
    cid = competition["id"]
    configured = client.put(
        f"/api/admin/competitions/{cid}/scoring",
        json={
            "id_column": "id",
            "prediction_column": "prediction",
            "label_column": "label",
            "average": "binary",
            "pos_label": "1",
            "higher_is_better": True,
        },
    )
    assert configured.status_code == 200
    truth = ground_truth or b"id,label\n1,1\n2,1\n3,0\n4,0\n"
    uploaded = client.put(
        f"/api/admin/competitions/{cid}/ground-truth",
        files={"file": ("truth.csv", truth)},
    )
    assert uploaded.status_code == 200
    assert client.post(f"/api/admin/competitions/{cid}/publish").status_code == 200
    _login_participant(client)
    assert client.post(f"/api/competitions/{slug}/join", json={}).status_code == 200
    return competition


def _submit(client, competition_id, data, filename="answers.csv"):
    return client.post(
        f"/api/competitions/{competition_id}/submissions",
        files={"file": (filename, data, "text/csv")},
    )


def _submission_documents(client, query=None):
    async def load():
        cursor = client.app.state.mongo.db[SUBMISSIONS_COLLECTION].find(query or {})
        return [document async for document in cursor]

    return asyncio.run(load())


def test_valid_submission_scores_and_persists_to_backend_generated_path(client, isolated_data_dir):
    competition = _ready_competition(client)
    response = _submit(
        client,
        competition["id"],
        b"id,prediction\n1,1\n2,0\n3,1\n4,0\n",
        "../../team-result.csv",
    )
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "completed"
    assert body["metrics"] == {"f1": 0.5, "precision": 0.5, "recall": 0.5}
    assert body["primary_score"] == 0.5
    assert body["quota_remaining"] == 4

    documents = _submission_documents(client)
    assert len(documents) == 1
    stored = documents[0]
    assert stored["original_filename"] == "team-result.csv"
    assert stored["competition_id"] == ObjectId(competition["id"])
    assert stored["status"] == "completed"
    assert stored["file_path"] == (
        f"submissions/{competition['id']}/{stored['account_id']}/{stored['_id']}.csv"
    )
    expected = isolated_data_dir / stored["file_path"]
    assert expected.read_bytes().startswith(b"id,prediction")
    assert not (isolated_data_dir / "team-result.csv").exists()


def test_reordered_submission_has_identical_score(client):
    competition = _ready_competition(client)
    first = _submit(
        client,
        competition["id"],
        b"id,prediction\n1,1\n2,0\n3,1\n4,0\n",
    )
    reordered = _submit(
        client,
        competition["id"],
        b"id,prediction\n4,0\n2,0\n1,1\n3,1\n",
    )
    assert first.status_code == reordered.status_code == 201
    assert first.json()["metrics"] == reordered.json()["metrics"]


def test_invalid_submissions_return_clear_errors_without_record_or_file(client, isolated_data_dir):
    competition = _ready_competition(client)
    cases = [
        (b"", "SUBMISSION_SCHEMA_INVALID"),
        (b"id,wrong\n1,1\n2,0\n3,0\n4,0\n", "SUBMISSION_SCHEMA_INVALID"),
        (b"id,prediction\n1,1\n1,0\n3,0\n4,0\n", "SUBMISSION_DUPLICATE_IDS"),
        (b"id,prediction\n1,1\n2,0\n3,0\n", "SUBMISSION_ID_MISMATCH"),
        (b"id,prediction\n1,1\n2,0\n3,0\n4,0\n5,1\n", "SUBMISSION_ID_MISMATCH"),
        (b"id,prediction\n1,1\n2,\n3,0\n4,0\n", "SUBMISSION_VALUE_INVALID"),
        (b"id,prediction\n1,1\n2,unknown\n3,0\n4,0\n", "SUBMISSION_VALUE_INVALID"),
    ]
    for data, code in cases:
        response = _submit(client, competition["id"], data)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == code
    assert _submission_documents(client) == []
    submission_root = isolated_data_dir / "submissions"
    assert not submission_root.exists() or list(submission_root.rglob("*.csv")) == []


def test_rejected_submission_log_contains_code_but_not_uploaded_values(client, caplog):
    competition = _ready_competition(client)
    private_value = "do-not-log-this-prediction"
    caplog.set_level(logging.INFO, logger="app.submissions.router")

    response = _submit(
        client,
        competition["id"],
        f"id,prediction\n1,1\n2,{private_value}\n3,0\n4,0\n".encode(),
    )

    assert response.status_code == 422
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "code=SUBMISSION_VALUE_INVALID" in messages
    assert private_value not in messages


def test_submission_requires_auth_and_active_membership(client):
    competition = _ready_competition(client)
    valid = b"id,prediction\n1,1\n2,1\n3,0\n4,0\n"
    assert client.post("/api/auth/logout").status_code == 200
    unauthorized = _submit(client, competition["id"], valid)
    assert unauthorized.status_code == 401

    second = _ready_competition(client, slug="no-membership")
    _login(client)
    participant = client.get(
        "/api/admin/accounts", params={"q": "thi.sinh@vku.vn"}
    ).json()["accounts"][0]
    disabled = client.patch(
        f"/api/admin/competitions/{competition['id']}/members/{participant['id']}",
        json={"active": False},
    )
    assert disabled.status_code == 200

    _login_participant(client)
    inactive = _submit(client, competition["id"], valid)
    assert inactive.status_code == 403
    assert inactive.json()["error"]["code"] == "MEMBERSHIP_INACTIVE"

    missing = _submit(client, second["id"], valid)
    assert missing.status_code == 201

    third = _ready_competition(client, slug="never-joined")
    _login(client)
    awaitable = client.app.state.mongo.db["competition_memberships"].delete_one(
        {"competition_id": ObjectId(third["id"])}
    )
    asyncio.run(awaitable)
    _login_participant(client)
    no_membership = _submit(client, third["id"], valid)
    assert no_membership.status_code == 403
    assert no_membership.json()["error"]["code"] == "MEMBERSHIP_REQUIRED"


def test_submission_enforces_status_start_and_deadline(client):
    valid = b"id,prediction\n1,1\n2,1\n3,0\n4,0\n"
    closed = _ready_competition(client, slug="closed-cup")
    _login(client)
    assert client.post(f"/api/admin/competitions/{closed['id']}/close").status_code == 200
    _login_participant(client)
    response = _submit(client, closed["id"], valid)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SUBMISSION_CLOSED"

    timed = _ready_competition(client, slug="timed-cup")

    async def set_times(start_at, end_at):
        await client.app.state.mongo.db[COMPETITIONS_COLLECTION].update_one(
            {"_id": ObjectId(timed["id"])},
            {"$set": {"start_at": start_at, "end_at": end_at}},
        )

    now = datetime.now(timezone.utc)
    asyncio.run(set_times(now + timedelta(hours=1), now + timedelta(hours=2)))
    not_open = _submit(client, timed["id"], valid)
    assert not_open.status_code == 422
    assert not_open.json()["error"]["code"] == "SUBMISSION_NOT_OPEN"

    asyncio.run(set_times(now - timedelta(hours=2), now - timedelta(hours=1)))
    expired = _submit(client, timed["id"], valid)
    assert expired.status_code == 422
    assert expired.json()["error"]["code"] == "SUBMISSION_DEADLINE_PASSED"


def test_daily_quota_counts_completed_submissions_in_utc_day(client):
    competition = _ready_competition(client, quota=1)
    valid = b"id,prediction\n1,1\n2,1\n3,0\n4,0\n"
    first = _submit(client, competition["id"], valid)
    assert first.status_code == 201
    assert first.json()["quota_remaining"] == 0
    second = _submit(client, competition["id"], valid)
    assert second.status_code == 429
    assert second.json()["error"]["code"] == "SUBMISSION_QUOTA_EXCEEDED"
    assert len(_submission_documents(client)) == 1


def test_submission_rejects_extension_and_global_size_limit(client, monkeypatch):
    competition = _ready_competition(client)
    wrong_type = _submit(client, competition["id"], b"id,prediction\n", "answers.txt")
    assert wrong_type.status_code == 422
    assert wrong_type.json()["error"]["code"] == "INVALID_FILE_TYPE"

    monkeypatch.setenv("MAX_UPLOAD_MB", "1")
    get_settings.cache_clear()
    oversized = _submit(client, competition["id"], b"x" * (1024 * 1024 + 1))
    assert oversized.status_code == 413
    assert oversized.json()["error"]["code"] == "FILE_TOO_LARGE"
    assert _submission_documents(client) == []


def test_submission_reports_scoring_not_ready_when_ground_truth_disappears(client, isolated_data_dir):
    """Publish đã gate readiness, nên 422 chỉ còn xảy ra khi ground truth hỏng sau khi publish."""
    competition = _ready_competition(client, slug="not-ready")
    (isolated_data_dir / "competitions" / competition["id"] / "private" / "ground_truth.csv").unlink()
    _login_participant(client)
    response = _submit(client, competition["id"], b"id,prediction\n1,1\n")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SCORING_NOT_READY"


def test_submission_uses_only_its_competition_ground_truth(client):
    first = _ready_competition(
        client, slug="cup-a", ground_truth=b"id,label\na,1\nb,0\n"
    )
    second = _ready_competition(
        client, slug="cup-b", ground_truth=b"id,label\nx,1\ny,0\n"
    )
    valid_for_a = b"id,prediction\na,1\nb,0\n"
    assert _submit(client, first["id"], valid_for_a).status_code == 201
    wrong_competition = _submit(client, second["id"], valid_for_a)
    assert wrong_competition.status_code == 422
    assert wrong_competition.json()["error"]["code"] == "SUBMISSION_ID_MISMATCH"
