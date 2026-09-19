"""Submission upload policy, validation, scoring and persistence tests."""

import asyncio
from datetime import datetime, timedelta, timezone

import logging

import pytest
from bson import ObjectId

from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.config import get_settings
from app.submission_artifacts import storage as artifact_storage
from app.submissions.service import SUBMISSIONS_COLLECTION
from tests.helpers import (
    VALID_NOTEBOOK,
    login,
    login_participant,
    notebook_bytes,
    ready_competition,
    submission_documents,
    submit,
)


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


def test_valid_submission_scores_and_stores_both_artifacts(
    client, isolated_data_dir, fake_artifact_storage
):
    competition = ready_competition(client)
    prediction = b"id,prediction\n1,1\n2,0\n3,1\n4,0\n"
    response = submit(
        client,
        competition["id"],
        prediction,
        "../../team-result.csv",
    )
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "completed"
    assert body["metrics"] == {"f1": 0.5, "precision": 0.5, "recall": 0.5}
    assert body["primary_score"] == 0.5
    assert body["quota_remaining"] == 4
    assert body["submission_no"] == 1
    assert body["artifacts"]["prediction"] == {
        "filename": "team-result.csv",
        "size_bytes": len(prediction),
        "available": True,
    }
    assert body["artifacts"]["notebook"] == {
        "filename": "solution.ipynb",
        "size_bytes": len(VALID_NOTEBOOK),
        "available": True,
    }

    documents = submission_documents(client)
    assert len(documents) == 1
    stored = documents[0]
    prefix = f"competitions/{competition['id']}/accounts/{stored['account_id']}/submissions/{stored['_id']}"
    assert stored["artifacts"]["prediction"]["object_key"] == f"{prefix}/prediction.csv"
    assert stored["artifacts"]["notebook"]["object_key"] == f"{prefix}/notebook.ipynb"
    assert stored["artifacts"]["prediction"]["original_filename"] == "team-result.csv"
    assert stored["competition_id"] == ObjectId(competition["id"])
    assert stored["status"] == "completed"
    # Không còn CSV mới nào ghi xuống DATA_DIR (ADR-028); tên upload cũng không tạo file ở gốc.
    assert fake_artifact_storage.objects[f"{prefix}/prediction.csv"] == prediction
    assert fake_artifact_storage.objects[f"{prefix}/notebook.ipynb"] == VALID_NOTEBOOK
    assert not (isolated_data_dir / "submissions").exists()
    assert not (isolated_data_dir / "team-result.csv").exists()


def test_reordered_submission_has_identical_score(client):
    competition = ready_competition(client)
    first = submit(
        client,
        competition["id"],
        b"id,prediction\n1,1\n2,0\n3,1\n4,0\n",
    )
    reordered = submit(
        client,
        competition["id"],
        b"id,prediction\n4,0\n2,0\n1,1\n3,1\n",
    )
    assert first.status_code == reordered.status_code == 201
    assert first.json()["metrics"] == reordered.json()["metrics"]


def test_invalid_submissions_return_clear_errors_without_record_or_file(
    client, isolated_data_dir, fake_artifact_storage
):
    competition = ready_competition(client)
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
        response = submit(client, competition["id"], data)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == code
    assert submission_documents(client) == []
    assert fake_artifact_storage.objects == {}
    submission_root = isolated_data_dir / "submissions"
    assert not submission_root.exists() or list(submission_root.rglob("*.csv")) == []


def test_rejected_submission_log_contains_code_but_not_uploaded_values(client, caplog):
    competition = ready_competition(client)
    private_value = "do-not-log-this-prediction"
    caplog.set_level(logging.INFO, logger="app.submissions.router")

    response = submit(
        client,
        competition["id"],
        f"id,prediction\n1,1\n2,{private_value}\n3,0\n4,0\n".encode(),
    )

    assert response.status_code == 422
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "code=SUBMISSION_VALUE_INVALID" in messages
    assert private_value not in messages


def test_submission_requires_auth_and_active_membership(client):
    competition = ready_competition(client)
    valid = b"id,prediction\n1,1\n2,1\n3,0\n4,0\n"
    assert client.post("/api/auth/logout").status_code == 200
    unauthorized = submit(client, competition["id"], valid)
    assert unauthorized.status_code == 401

    second = ready_competition(client, slug="no-membership")
    login(client)
    participant = client.get(
        "/api/admin/accounts", params={"q": "thi.sinh@vku.vn"}
    ).json()["accounts"][0]
    disabled = client.patch(
        f"/api/admin/competitions/{competition['id']}/members/{participant['id']}",
        json={"active": False},
    )
    assert disabled.status_code == 200

    login_participant(client)
    inactive = submit(client, competition["id"], valid)
    assert inactive.status_code == 403
    assert inactive.json()["error"]["code"] == "MEMBERSHIP_INACTIVE"

    missing = submit(client, second["id"], valid)
    assert missing.status_code == 201

    third = ready_competition(client, slug="never-joined")
    login(client)
    awaitable = client.app.state.mongo.db["competition_memberships"].delete_one(
        {"competition_id": ObjectId(third["id"])}
    )
    asyncio.run(awaitable)
    login_participant(client)
    no_membership = submit(client, third["id"], valid)
    assert no_membership.status_code == 403
    assert no_membership.json()["error"]["code"] == "MEMBERSHIP_REQUIRED"


def test_submission_enforces_status_start_and_deadline(client):
    valid = b"id,prediction\n1,1\n2,1\n3,0\n4,0\n"
    closed = ready_competition(client, slug="closed-cup")
    login(client)
    assert client.post(f"/api/admin/competitions/{closed['id']}/close").status_code == 200
    login_participant(client)
    response = submit(client, closed["id"], valid)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SUBMISSION_CLOSED"

    timed = ready_competition(client, slug="timed-cup")

    async def set_times(start_at, end_at):
        await client.app.state.mongo.db[COMPETITIONS_COLLECTION].update_one(
            {"_id": ObjectId(timed["id"])},
            {"$set": {"start_at": start_at, "end_at": end_at}},
        )

    now = datetime.now(timezone.utc)
    asyncio.run(set_times(now + timedelta(hours=1), now + timedelta(hours=2)))
    not_open = submit(client, timed["id"], valid)
    assert not_open.status_code == 422
    assert not_open.json()["error"]["code"] == "SUBMISSION_NOT_OPEN"

    asyncio.run(set_times(now - timedelta(hours=2), now - timedelta(hours=1)))
    expired = submit(client, timed["id"], valid)
    assert expired.status_code == 422
    assert expired.json()["error"]["code"] == "SUBMISSION_DEADLINE_PASSED"


def test_reopen_restores_submission_after_close(client):
    """Mở lại là hoàn tác việc đóng nên cuộc thi phải nhận bài trở lại, không chỉ đổi status."""
    valid = b"id,prediction\n1,1\n2,1\n3,0\n4,0\n"
    competition = ready_competition(client, slug="reopen-cup")
    cid = competition["id"]

    login(client)
    assert client.post(f"/api/admin/competitions/{cid}/close").status_code == 200
    login_participant(client)
    blocked = submit(client, cid, valid)
    assert blocked.status_code == 422
    assert blocked.json()["error"]["code"] == "SUBMISSION_CLOSED"

    login(client)
    assert client.post(f"/api/admin/competitions/{cid}/reopen").status_code == 200
    login_participant(client)
    accepted = submit(client, cid, valid)
    assert accepted.status_code == 201
    assert accepted.json()["status"] == "completed"


def test_daily_quota_counts_completed_submissions_in_utc_day(client):
    competition = ready_competition(client, quota=1)
    valid = b"id,prediction\n1,1\n2,1\n3,0\n4,0\n"
    first = submit(client, competition["id"], valid)
    assert first.status_code == 201
    assert first.json()["quota_remaining"] == 0
    second = submit(client, competition["id"], valid)
    assert second.status_code == 429
    assert second.json()["error"]["code"] == "SUBMISSION_QUOTA_EXCEEDED"
    assert len(submission_documents(client)) == 1


def test_submission_rejects_extension_and_size_limits(
    client, monkeypatch, fake_artifact_storage
):
    competition = ready_competition(client)
    valid = b"id,prediction\n1,1\n2,0\n3,0\n4,0\n"
    wrong_type = submit(client, competition["id"], b"id,prediction\n", "answers.txt")
    assert wrong_type.status_code == 422
    assert wrong_type.json()["error"]["code"] == "INVALID_FILE_TYPE"

    wrong_notebook = submit(
        client, competition["id"], valid, notebook_filename="solution.txt"
    )
    assert wrong_notebook.status_code == 422
    assert wrong_notebook.json()["error"]["code"] == "INVALID_NOTEBOOK_TYPE"

    monkeypatch.setenv("MAX_UPLOAD_MB", "1")
    get_settings.cache_clear()
    oversized = submit(client, competition["id"], b"x" * (1024 * 1024 + 1))
    assert oversized.status_code == 413
    assert oversized.json()["error"]["code"] == "FILE_TOO_LARGE"

    monkeypatch.setenv("MAX_UPLOAD_MB", "10")
    monkeypatch.setenv("MAX_NOTEBOOK_MB", "1")
    get_settings.cache_clear()
    big_notebook = submit(
        client, competition["id"], valid, notebook=b"x" * (1024 * 1024 + 1)
    )
    assert big_notebook.status_code == 413
    assert big_notebook.json()["error"]["code"] == "FILE_TOO_LARGE"
    assert submission_documents(client) == []
    assert fake_artifact_storage.objects == {}


@pytest.mark.parametrize(
    ("notebook", "code"),
    [
        (b"", "NOTEBOOK_INVALID"),
        (b"not json at all", "NOTEBOOK_INVALID"),
        (b"[1, 2, 3]", "NOTEBOOK_INVALID"),
        (b'{"nbformat": 3, "nbformat_minor": 5, "metadata": {}, "cells": []}', "NOTEBOOK_UNSUPPORTED_VERSION"),
        (b'{"nbformat": 4, "nbformat_minor": "5", "metadata": {}, "cells": []}', "NOTEBOOK_INVALID"),
        (b'{"nbformat": 4, "nbformat_minor": 5, "metadata": [], "cells": []}', "NOTEBOOK_INVALID"),
        (b'{"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": {}}', "NOTEBOOK_INVALID"),
        (b'{"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": ["x"]}', "NOTEBOOK_INVALID"),
        (
            b'{"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [{"cell_type": "sql", "source": "x"}]}',
            "NOTEBOOK_INVALID",
        ),
        (
            b'{"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [{"cell_type": "code", "source": 7}]}',
            "NOTEBOOK_INVALID",
        ),
        (b'{"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [], "x": "\x00"}', "NOTEBOOK_INVALID"),
    ],
)
def test_notebook_validation_rejects_bad_notebooks(
    client, notebook, code, fake_artifact_storage
):
    competition = ready_competition(client)
    response = submit(
        client, competition["id"], b"id,prediction\n1,1\n2,0\n3,0\n4,0\n", notebook=notebook
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == code
    assert submission_documents(client) == []
    assert fake_artifact_storage.objects == {}


def test_notebook_accepts_utf8_bom_and_crlf_sources(client, fake_artifact_storage):
    """Notebook lưu trên Windows (BOM + CRLF) vẫn phải nộp được."""
    competition = ready_competition(client)
    valid = b"id,prediction\n1,1\n2,0\n3,0\n4,0\n"
    body = notebook_bytes(
        cells=[
            {"cell_type": "markdown", "source": ["# Tiêu đề\n", "\n"]},
            {"cell_type": "raw", "source": "ghi chú"},
        ]
    )
    windows_body = (
        b"{\r\n"
        b' "cells": [{"cell_type": "code", "source": ["print(1)\\n"]}],\r\n'
        b' "metadata": {}, "nbformat": 4, "nbformat_minor": 5\r\n'
        b"}\r\n"
    )
    assert submit(client, competition["id"], valid, notebook=b"\xef\xbb\xbf" + body).status_code == 201
    assert submit(client, competition["id"], valid, notebook=windows_body).status_code == 201


def test_missing_notebook_part_is_rejected_without_side_effects(client, fake_artifact_storage):
    competition = ready_competition(client)
    response = submit(
        client,
        competition["id"],
        b"id,prediction\n1,1\n2,0\n3,0\n4,0\n",
        notebook=None,
    )
    assert response.status_code == 422
    assert submission_documents(client) == []
    assert fake_artifact_storage.objects == {}


def test_storage_failure_rolls_back_uploaded_artifacts(client, fake_artifact_storage):
    competition = ready_competition(client)
    valid = b"id,prediction\n1,1\n2,0\n3,0\n4,0\n"

    # Prediction upload lỗi: chưa có object nào và cũng không có document.
    original_put = fake_artifact_storage.put_object

    def failing_put(bucket_name, object_name, data, length=None, content_type=None):
        raise OSError("storage down")

    fake_artifact_storage.put_object = failing_put
    failed_prediction = submit(client, competition["id"], valid)
    assert failed_prediction.status_code == 503
    assert failed_prediction.json()["error"]["code"] == "ARTIFACT_STORAGE_UNAVAILABLE"
    assert fake_artifact_storage.objects == {}
    assert submission_documents(client) == []

    # Notebook upload lỗi: prediction đã lên phải được dọn lại.
    calls = {"count": 0}

    def fail_second(bucket_name, object_name, data, length=None, content_type=None):
        calls["count"] += 1
        if calls["count"] == 2:
            raise OSError("storage down")
        return original_put(bucket_name, object_name, data, length, content_type)

    fake_artifact_storage.put_object = fail_second
    failed_notebook = submit(client, competition["id"], valid)
    assert failed_notebook.status_code == 503
    assert fake_artifact_storage.objects == {}
    assert submission_documents(client) == []


def test_insert_failure_removes_both_objects(client, fake_artifact_storage, monkeypatch):
    competition = ready_competition(client)
    valid = b"id,prediction\n1,1\n2,0\n3,0\n4,0\n"

    async def failing_insert(self, document, *args, **kwargs):
        raise RuntimeError("mongo down")

    monkeypatch.setattr(
        type(client.app.state.mongo.db[SUBMISSIONS_COLLECTION]), "insert_one", failing_insert
    )
    response = submit(client, competition["id"], valid)
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "SUBMISSION_SAVE_FAILED"
    assert fake_artifact_storage.objects == {}


def test_submission_sequence_increments_and_ignores_legacy_gaps(client, fake_artifact_storage):
    competition = ready_competition(client)
    valid = b"id,prediction\n1,1\n2,0\n3,0\n4,0\n"
    first = submit(client, competition["id"], valid)
    second = submit(client, competition["id"], valid)
    assert first.json()["submission_no"] == 1
    assert second.json()["submission_no"] == 2

    # 10 record legacy không có submission_no: đẩy số kế tiếp lên total + 1 nhưng nằm ngoài ngày hiện tại
    # nên không tiêu tốn quota.
    existing = submission_documents(client)
    account_id = existing[0]["account_id"]
    asyncio.run(
        client.app.state.mongo.db[SUBMISSIONS_COLLECTION].insert_many(
            [
                {
                    "competition_id": ObjectId(competition["id"]),
                    "account_id": account_id,
                    "file_path": f"submissions/legacy/{index}.csv",
                    "original_filename": "legacy.csv",
                    "status": "completed",
                    "metrics": None,
                    "primary_score": 0.1,
                    "created_at": datetime.now(timezone.utc) - timedelta(days=30),
                }
                for index in range(10)
            ]
        )
    )
    third = submit(client, competition["id"], valid)
    assert third.status_code == 201
    assert third.json()["submission_no"] == 13


def test_submission_sequence_is_per_account_and_competition(client, fake_artifact_storage):
    first = ready_competition(client, slug="seq-a")
    valid_a = b"id,prediction\n1,1\n2,0\n3,0\n4,0\n"
    assert submit(client, first["id"], valid_a).json()["submission_no"] == 1

    second = ready_competition(client, slug="seq-b")
    assert submit(client, second["id"], valid_a).json()["submission_no"] == 1
    assert submit(client, first["id"], valid_a).json()["submission_no"] == 2


def test_concurrent_submissions_get_distinct_numbers(client, fake_artifact_storage):
    competition = ready_competition(client)
    valid = b"id,prediction\n1,1\n2,0\n3,0\n4,0\n"

    async def race():
        import httpx

        transport = httpx.ASGITransport(app=client.app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            cookies=dict(client.cookies),
        ) as async_client:
            return await asyncio.gather(
                *(
                    async_client.post(
                        f"/api/competitions/{competition['id']}/submissions",
                        files={
                            "file": ("answers.csv", valid, "text/csv"),
                            "notebook": (
                                "solution.ipynb",
                                VALID_NOTEBOOK,
                                "application/x-ipynb+json",
                            ),
                        },
                    )
                    for _ in range(4)
                )
            )

    responses = asyncio.run(race())
    assert [response.status_code for response in responses] == [201, 201, 201, 201]
    numbers = sorted(response.json()["submission_no"] for response in responses)
    assert numbers == [1, 2, 3, 4]


def test_submission_reports_scoring_not_ready_when_ground_truth_disappears(client, isolated_data_dir):
    """Publish đã gate readiness, nên 422 chỉ còn xảy ra khi ground truth hỏng sau khi publish."""
    competition = ready_competition(client, slug="not-ready")
    (isolated_data_dir / "competitions" / competition["id"] / "private" / "ground_truth.csv").unlink()
    login_participant(client)
    response = submit(client, competition["id"], b"id,prediction\n1,1\n")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SCORING_NOT_READY"


def test_submission_uses_only_its_competition_ground_truth(client):
    first = ready_competition(
        client, slug="cup-a", ground_truth=b"id,label\na,1\nb,0\n"
    )
    second = ready_competition(
        client, slug="cup-b", ground_truth=b"id,label\nx,1\ny,0\n"
    )
    valid_for_a = b"id,prediction\na,1\nb,0\n"
    assert submit(client, first["id"], valid_for_a).status_code == 201
    wrong_competition = submit(client, second["id"], valid_for_a)
    assert wrong_competition.status_code == 422
    assert wrong_competition.json()["error"]["code"] == "SUBMISSION_ID_MISMATCH"
