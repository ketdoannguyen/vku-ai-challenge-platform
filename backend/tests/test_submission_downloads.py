"""Phase C: tải artifact của submission - quyền participant/admin, submission legacy và lỗi storage."""

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

from bson import ObjectId

from app.core.config import get_settings
from app.core.database import MongoContext
from app.submissions.service import SUBMISSIONS_COLLECTION
from tests.helpers import (
    VALID_NOTEBOOK,
    account_id_by_email,
    login,
    login_participant,
    ready_competition,
    submit,
    submission_documents,
)

PREDICTION = b"id,prediction\n1,1\n2,0\n3,1\n4,0\n"
SECOND_PARTICIPANT = ("doi.hai@vku.vn", "matkhaudoihai1")


def _submit_one(client, competition_id: str) -> dict:
    response = submit(client, competition_id, PREDICTION)
    assert response.status_code == 201
    return submission_documents(client)[0]


def _seed_legacy(client, competition_id: str, relative_path: str, **overrides) -> dict:
    """Record cũ chỉ có CSV dưới DATA_DIR - dựng thẳng trong DB vì luồng API đã bỏ kiểu lưu này."""
    document = {
        "competition_id": ObjectId(competition_id),
        "account_id": account_id_by_email(client, "thi.sinh@vku.vn"),
        "file_path": relative_path,
        "original_filename": "bai-cu.csv",
        "status": "completed",
        "metrics": None,
        "primary_score": 0.1,
        "created_at": datetime.now(timezone.utc) - timedelta(days=3),
    }
    document.update(overrides)
    asyncio.run(client.app.state.mongo.db[SUBMISSIONS_COLLECTION].insert_one(document))
    return document


def _create_second_participant(client) -> None:
    login(client)
    created = client.post(
        "/api/admin/accounts",
        json={
            "email": SECOND_PARTICIPANT[0],
            "name": "Đội Hai",
            "password": SECOND_PARTICIPANT[1],
            "role": "participant",
        },
    )
    assert created.status_code == 201
    login(client, *SECOND_PARTICIPANT)


def test_owner_downloads_both_artifacts_with_safe_headers(client):
    competition = ready_competition(client)
    submission = _submit_one(client, competition["id"])

    prediction = client.get(
        f"/api/competitions/{competition['id']}/submissions/{submission['_id']}/prediction"
    )
    assert prediction.status_code == 200
    assert prediction.content == PREDICTION
    assert prediction.headers["content-type"] == "text/csv; charset=utf-8"
    assert prediction.headers["x-content-type-options"] == "nosniff"
    assert prediction.headers["cache-control"] == "private, no-store"
    assert prediction.headers["content-length"] == str(len(PREDICTION))
    disposition = prediction.headers["content-disposition"]
    assert 'filename="submission-cup-Thi-Sinh-submission-0001-prediction.csv"' in disposition
    assert "filename*=UTF-8''submission-cup_Th%C3%AD-Sinh_submission-0001_prediction.csv" in disposition

    notebook = client.get(
        f"/api/competitions/{competition['id']}/submissions/{submission['_id']}/notebook"
    )
    assert notebook.status_code == 200
    assert notebook.content == VALID_NOTEBOOK
    assert notebook.headers["content-type"] == "application/x-ipynb+json"
    assert "_submission-0001_notebook.ipynb" in notebook.headers["content-disposition"]


def test_download_requires_auth_and_ownership(client):
    competition = ready_competition(client)
    submission = _submit_one(client, competition["id"])
    url = f"/api/competitions/{competition['id']}/submissions/{submission['_id']}/prediction"

    assert client.post("/api/auth/logout").status_code == 200
    assert client.get(url).status_code == 401

    # Đội khác không được tải bài của mình; trả 404 để không lộ sự tồn tại của bài nộp.
    _create_second_participant(client)
    assert client.post(f"/api/competitions/submission-cup/join", json={}).status_code == 200
    foreign = client.get(url)
    assert foreign.status_code == 404
    assert foreign.json()["error"]["code"] == "NOT_FOUND"

    # Chính chủ vẫn tải được sau khi bị vô hiệu hóa membership: bài của mình là dữ liệu của mình.
    login(client)
    account = client.get("/api/admin/accounts", params={"q": "thi.sinh@vku.vn"}).json()[
        "accounts"
    ][0]
    assert (
        client.patch(
            f"/api/admin/competitions/{competition['id']}/members/{account['id']}",
            json={"active": False},
        ).status_code
        == 200
    )
    login_participant(client)
    assert client.get(url).status_code == 200


def test_admin_downloads_any_team_artifact_but_participant_cannot(client):
    competition = ready_competition(client)
    submission = _submit_one(client, competition["id"])
    admin_url = f"/api/admin/submissions/{submission['_id']}/prediction"

    denied = client.get(admin_url)
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "FORBIDDEN"

    login(client)
    assert client.get(admin_url).content == PREDICTION
    notebook = client.get(f"/api/admin/submissions/{submission['_id']}/notebook")
    assert notebook.status_code == 200
    assert notebook.content == VALID_NOTEBOOK

    assert client.get("/api/admin/submissions/khong-phai-objectid/prediction").status_code == 404
    assert client.get(f"/api/admin/submissions/{ObjectId()}/prediction").status_code == 404


def test_legacy_submission_is_still_downloadable(client, isolated_data_dir):
    competition = ready_competition(client)
    legacy_dir = isolated_data_dir / "submissions"
    legacy_dir.mkdir(parents=True)
    (legacy_dir / "bai-cu.csv").write_bytes(b"id,prediction\n1,1\n2,0\n3,0\n4,0\n")
    document = _seed_legacy(client, competition["id"], "submissions/bai-cu.csv")

    url = f"/api/competitions/{competition['id']}/submissions/{document['_id']}"
    prediction = client.get(f"{url}/prediction")
    assert prediction.status_code == 200
    assert prediction.content.startswith(b"id,prediction")
    # Không có submission_no thì tên tải dùng 8 ký tự cuối của ObjectId.
    assert f"_submission-{str(document['_id'])[-8:]}_prediction.csv" in prediction.headers[
        "content-disposition"
    ]
    assert prediction.headers["content-disposition"].startswith('attachment; filename="')

    # Legacy chỉ có CSV: notebook trả 404 chứ không phải lỗi hệ thống.
    assert client.get(f"{url}/notebook").status_code == 404

    # Metadata cho UI biết tệp nào tải được và tải bằng tên gì.
    history = client.get(f"/api/competitions/{competition['id']}/submissions/me").json()
    artifacts = history["submissions"][0]["artifacts"]
    assert artifacts["prediction"] == {
        "filename": "bai-cu.csv",
        "size_bytes": None,
        "available": True,
    }
    assert artifacts["notebook"] is None


def test_legacy_submission_with_missing_or_escaping_path_is_not_found(client, isolated_data_dir):
    competition = ready_competition(client)
    outside = isolated_data_dir.parent / "ngoai-data-dir.csv"
    outside.write_bytes(b"id,prediction\n1,1\n2,0\n3,0\n4,0\n")

    missing = _seed_legacy(client, competition["id"], "submissions/khong-ton-tai.csv")
    escaping = _seed_legacy(client, competition["id"], "../ngoai-data-dir.csv")

    for document in (missing, escaping):
        response = client.get(
            f"/api/competitions/{competition['id']}/submissions/{document['_id']}/prediction"
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "ARTIFACT_NOT_FOUND"


def test_missing_object_maps_to_artifact_not_found(client, fake_artifact_storage):
    competition = ready_competition(client)
    submission = _submit_one(client, competition["id"])
    fake_artifact_storage.objects.clear()

    response = client.get(
        f"/api/competitions/{competition['id']}/submissions/{submission['_id']}/prediction"
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "ARTIFACT_NOT_FOUND"


def test_storage_outage_returns_503_for_upload_and_download(client, fake_artifact_storage):
    competition = ready_competition(client)
    submission = _submit_one(client, competition["id"])
    fake_artifact_storage.unavailable = True

    download = client.get(
        f"/api/competitions/{competition['id']}/submissions/{submission['_id']}/prediction"
    )
    assert download.status_code == 503
    assert download.json()["error"]["code"] == "ARTIFACT_STORAGE_UNAVAILABLE"

    upload = submit(client, competition["id"], PREDICTION)
    assert upload.status_code == 503
    assert upload.json()["error"]["code"] == "ARTIFACT_STORAGE_UNAVAILABLE"
    # Không có record nào được ghi khi storage hỏng.
    assert len(submission_documents(client)) == 1


def test_storage_outage_does_not_break_health(client, fake_artifact_storage, monkeypatch):
    """Health là oracle rollback của auto-deploy nên không được phụ thuộc MinIO."""
    monkeypatch.setattr(MongoContext, "ping", AsyncMock(return_value=True))
    fake_artifact_storage.unavailable = True

    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "mongo": "reachable"}


def test_download_rejects_submission_of_another_competition(client):
    first = ready_competition(client, slug="cup-mot")
    submission = _submit_one(client, first["id"])
    second = ready_competition(client, slug="cup-hai")

    response = client.get(
        f"/api/competitions/{second['id']}/submissions/{submission['_id']}/prediction"
    )
    assert response.status_code == 404


def test_download_uses_stored_oversized_limit_from_settings(client, monkeypatch, fake_artifact_storage):
    competition = ready_competition(client)
    submission = _submit_one(client, competition["id"])
    monkeypatch.setenv("MAX_UPLOAD_MB", "1")
    get_settings.cache_clear()
    # Ghi đè đúng object mà document trỏ tới - test này soi trần bytes lúc đọc, không quan tâm hình dạng key.
    fake_artifact_storage.objects[submission["artifacts"]["prediction"]["object_key"]] = (
        b"x" * (1024 * 1024 + 1)
    )

    response = client.get(
        f"/api/competitions/{competition['id']}/submissions/{submission['_id']}/prediction"
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "ARTIFACT_STORAGE_UNAVAILABLE"


def test_download_route_does_not_leak_account_ids(client):
    """Account ID của đội khác không được xuất hiện ở bất kỳ đâu trong lịch sử của mình."""
    competition = ready_competition(client)
    _submit_one(client, competition["id"])
    _create_second_participant(client)
    assert client.post("/api/competitions/submission-cup/join", json={}).status_code == 200
    other = submit(client, competition["id"], PREDICTION)
    assert other.status_code == 201

    login_participant(client)
    history = client.get(f"/api/competitions/{competition['id']}/submissions/me").json()
    other_account_id = str(account_id_by_email(client, SECOND_PARTICIPANT[0]))
    assert other_account_id not in str(history)
    assert all(item["artifacts"]["prediction"]["available"] for item in history["submissions"])
