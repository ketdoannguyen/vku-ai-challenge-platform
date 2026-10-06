"""Snapshot norm tạm: ghi MỘT LẦN cùng bài nộp, gồm cả điểm gốc đang tới, và không bao giờ viết lại.

Bài nộp thật đi qua đường API (v1) hoặc hàng đợi worker (v2) để kiểm đúng chỗ ghi; các bài khác
trong cuộc thi được ghi thẳng vào Mongo để dựng mặt bằng điểm. Snapshot là dữ liệu lịch sử: BXH
tính norm hiện tại theo mặt bằng mới nhất, còn lịch sử giữ nguyên con số lúc ghi nhận.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from io import BytesIO

import pytest
from bson import ObjectId

from app.core.config import get_settings
from app.core.datetimes import as_utc, iso_z
from app.leaderboard import service as leaderboard_service
from app.scoring_attempts import worker
from app.scoring_attempts.store import ATTEMPTS_COLLECTION
from app.submissions.service import SUBMISSIONS_COLLECTION
from tests.helpers import (
    V2_SUBMISSION,
    attempt_status,
    login,
    login_participant,
    membership_document,
    publish_v2_competition,
    ready_competition,
    run_worker,
    submission_documents,
    submit,
)

BASE = datetime(2026, 9, 15, 8, tzinfo=timezone.utc)

# Dự đoán 1,0,1,0 trên bộ nhãn 1,1,0,0 của `ready_competition`: f1 = 0.5.
HALF_PREDICTION = b"id,prediction\n1,1\n2,0\n3,1\n4,0\n"
# Khớp hoàn toàn bộ nhãn: f1 = 1.0.
PERFECT_PREDICTION = b"id,prediction\n1,1\n2,1\n3,0\n4,0\n"


def _run(awaitable):
    return asyncio.run(awaitable)


def _db(client):
    return client.app.state.mongo.db


def _ready(client, slug: str, *, baseline: float) -> dict:
    return ready_competition(
        client, slug=slug, normalization={"enabled": True, "baseline": baseline}
    )


def _ready_v2(client, slug: str, *, baseline: float) -> dict:
    return publish_v2_competition(
        client, slug=slug, normalization={"enabled": True, "baseline": baseline}
    )


def _participant(client) -> dict:
    return _run(_db(client)["accounts"].find_one({"email": "thi.sinh@vku.vn"}))


def _create_account(client, name: str, email: str) -> ObjectId:
    account_id = ObjectId()
    _run(
        _db(client)["accounts"].insert_one(
            {
                "_id": account_id,
                "email": email,
                "name": name,
                "password_hash": "unused-in-snapshot-tests",
                "role": "participant",
                "active": True,
                "created_at": BASE,
                "updated_at": BASE,
            }
        )
    )
    return account_id


def _submission(client, competition: dict, account_id: ObjectId, score: float, created_at) -> ObjectId:
    """Bài `completed` ghi thẳng - chỉ để dựng mặt bằng điểm cho các bài nộp thật."""
    submission_id = ObjectId()
    _run(
        _db(client)[SUBMISSIONS_COLLECTION].insert_one(
            {
                "_id": submission_id,
                "competition_id": ObjectId(competition["id"]),
                "account_id": account_id,
                "status": "completed",
                "created_at": created_at,
                "metrics": {"f1": score, "precision": score, "recall": score},
                "primary_score": score,
            }
        )
    )
    return submission_id


def _touch(competition: dict) -> None:
    leaderboard_service.invalidate_competition(ObjectId(competition["id"]))


def _review(client, submission_id: ObjectId, status: str) -> None:
    login(client)
    body = {"status": status}
    if status == "rejected":
        body["note"] = "Lý do kiểm thử"
    response = client.patch(f"/api/admin/submissions/{submission_id}/review", json=body)
    assert response.status_code == 200, response.text


def _patch_attempt(client, attempt_id: str, patch: dict) -> None:
    _run(
        _db(client)[ATTEMPTS_COLLECTION].update_one({"_id": ObjectId(attempt_id)}, patch)
    )


def _stored(client, submission_id) -> dict:
    documents = submission_documents(client, {"_id": ObjectId(submission_id)})
    assert len(documents) == 1
    return documents[0]


def _board(client, competition: dict) -> dict:
    login(client)
    response = client.get(f"/api/admin/competitions/{competition['id']}/leaderboard")
    assert response.status_code == 200, response.text
    return response.json()


def _history(client, competition: dict) -> list[dict]:
    login_participant(client)
    response = client.get(f"/api/competitions/{competition['id']}/submissions/me")
    assert response.status_code == 200, response.text
    return response.json()["submissions"]


def test_v1_snapshot_counts_the_incoming_score_in_its_own_reference(client, fake_artifact_storage):
    """Bài đầu tiên vượt baseline được đúng 50 - điểm đang ghi phải nằm trong mẫu số của nó."""
    competition = _ready(client, "snap-first", baseline=0.4)
    login_participant(client)
    response = submit(client, competition["id"], HALF_PREDICTION)
    assert response.status_code == 201, response.text

    # Thí sinh nhận dạng rút gọn; raw và metrics không bị đụng tới.
    assert response.json()["primary_score"] == 0.5
    assert set(response.json()["normalization_snapshot"]) == {"score", "calculated_at"}
    assert response.json()["normalization_snapshot"]["score"] == pytest.approx(50.0)

    stored = _stored(client, response.json()["id"])
    snapshot = stored["normalization_snapshot"]
    assert snapshot["version"] == 1
    assert snapshot["source_metric"] == "f1"
    assert snapshot["higher_is_better"] is True
    assert snapshot["baseline"] == 0.4
    assert snapshot["reference_best"] == 0.5
    assert snapshot["score"] == pytest.approx(50.0)
    assert stored["primary_score"] == 0.5
    assert stored["metrics"] == {"f1": 0.5, "precision": 0.5, "recall": 0.5}

    # BXH lúc này khớp snapshot vì chưa có gì khác - nhưng đó là trùng hợp, không phải hợp đồng.
    board = _board(client, competition)
    assert board["entries"][0]["normalized_score"] == pytest.approx(50.0)
    assert board["normalization"]["reference_best"] == 0.5


def test_v1_below_baseline_records_zero_without_blocking_the_submission(
    client, fake_artifact_storage
):
    """Không vượt baseline là 0 điểm, nhưng bài vẫn được nhận và vẫn có snapshot hợp lệ."""
    competition = _ready(client, "snap-zero", baseline=0.9)
    login_participant(client)
    response = submit(client, competition["id"], HALF_PREDICTION)
    assert response.status_code == 201, response.text
    assert response.json()["normalization_snapshot"]["score"] == 0.0

    stored = _stored(client, response.json()["id"])
    assert stored["normalization_snapshot"]["reference_best"] == 0.5
    assert stored["normalization_snapshot"]["score"] == 0.0

    board = _board(client, competition)
    assert board["entries"][0]["normalized_score"] == 0.0
    assert board["normalization"]["reference_best"] == 0.5


def test_v1_stored_snapshot_never_moves_when_the_board_recomputes(
    client, fake_artifact_storage
):
    """Best mới rồi bài best bị từ chối: norm live đổi, snapshot trong lịch sử thì không."""
    competition = _ready(client, "snap-immutable", baseline=0.4)
    participant = _participant(client)
    login_participant(client)
    created = submit(client, competition["id"], HALF_PREDICTION)
    assert created.status_code == 201, created.text
    submission_id = created.json()["id"]
    before = _stored(client, submission_id)["normalization_snapshot"]

    rival_id = _create_account(client, "Đội Vượt", "snap-immutable-rival@vku.vn")
    rival_submission = _submission(
        client, competition, rival_id, 0.9, BASE + timedelta(minutes=5)
    )
    _touch(competition)

    board = _board(client, competition)
    norms = {entry["account_id"]: entry["normalized_score"] for entry in board["entries"]}
    assert norms[str(rival_id)] == 50.0
    assert norms[str(participant["_id"])] == pytest.approx(10.0)  # 50 × (0,5 − 0,4) ÷ (0,9 − 0,4)
    # Mặt bằng BXH đã khác mẫu số trong snapshot: hai con số phải được phép lệch nhau.
    assert board["normalization"]["reference_best"] == 0.9
    assert before["reference_best"] == 0.5

    _review(client, rival_submission, "rejected")
    board = _board(client, competition)
    assert board["entries"][0]["normalized_score"] == pytest.approx(50.0)

    after = _stored(client, submission_id)["normalization_snapshot"]
    assert after == before  # kể cả khi mẫu số BXH quay về 0.5, snapshot vẫn là bản ghi lúc nộp


def test_admin_sees_the_full_snapshot_and_revoking_visibility_hides_it_at_once(
    client, fake_artifact_storage
):
    """Snapshot là dữ liệu dẫn xuất: ẩn BXH là thí sinh mất ngay, DB và admin giữ nguyên."""
    competition = _ready(client, "snap-privacy", baseline=0.4)
    login_participant(client)
    created = submit(client, competition["id"], HALF_PREDICTION)
    assert created.status_code == 201, created.text

    item = _history(client, competition)[0]
    assert set(item["normalization_snapshot"]) == {"score", "calculated_at"}

    login(client)
    rows = client.get(f"/api/admin/competitions/{competition['id']}/submissions").json()[
        "submissions"
    ]
    admin_snapshot = rows[0]["normalization_snapshot"]
    assert admin_snapshot["baseline"] == 0.4
    assert admin_snapshot["reference_best"] == 0.5
    assert admin_snapshot["source_metric"] == "f1"

    hidden = client.patch(
        f"/api/admin/competitions/{competition['id']}", json={"leaderboard_visible": False}
    )
    assert hidden.status_code == 200, hidden.text
    assert "normalization_snapshot" not in _history(client, competition)[0]
    # Quyền xem không được sửa dữ liệu: bản ghi trong DB vẫn đủ để admin hậu kiểm.
    stored = _stored(client, created.json()["id"])["normalization_snapshot"]
    assert stored["baseline"] == 0.4
    assert stored["reference_best"] == 0.5


def test_two_commits_stay_provisional_and_the_board_gets_one_denominator(
    client, fake_artifact_storage
):
    """Hai bài nộp thật: mỗi snapshot chụp một mặt bằng, BXH sau đó chỉ còn một mẫu số dùng chung."""
    competition = _ready(client, "snap-converge", baseline=0.4)
    login_participant(client)
    first = submit(client, competition["id"], HALF_PREDICTION)
    assert first.status_code == 201, first.text

    login(client)
    created_account = client.post(
        "/api/admin/accounts",
        json={
            "email": "doi-hai-snap@vku.vn",
            "name": "Đội Hai",
            "password": "matkhaudoihai1",
            "role": "participant",
        },
    )
    assert created_account.status_code == 201, created_account.text
    second_id = ObjectId(created_account.json()["id"])
    login(client, "doi-hai-snap@vku.vn", "matkhaudoihai1")
    assert client.post("/api/competitions/snap-converge/join", json={}).status_code == 200
    second = submit(client, competition["id"], PERFECT_PREDICTION)
    assert second.status_code == 201, second.text
    assert second.json()["primary_score"] == 1.0

    # Mỗi lượt ghi là một quan sát riêng, cả hai đều là snapshot tạm hợp lệ tại lúc ghi.
    first_snapshot = _stored(client, first.json()["id"])["normalization_snapshot"]
    second_snapshot = _stored(client, second.json()["id"])["normalization_snapshot"]
    assert first_snapshot["reference_best"] == 0.5
    assert first_snapshot["score"] == pytest.approx(50.0)
    assert second_snapshot["reference_best"] == 1.0
    assert second_snapshot["score"] == pytest.approx(50.0)

    # BXH hội tụ về một mẫu số: đội thứ nhất không còn được 50 như snapshot của chính họ.
    board = _board(client, competition)
    norms = {entry["account_id"]: entry["normalized_score"] for entry in board["entries"]}
    assert board["normalization"]["reference_best"] == 1.0
    assert norms[str(second_id)] == pytest.approx(50.0)
    assert norms[str(_participant(client)["_id"])] == pytest.approx(50 * 0.1 / 0.6)


def test_v2_commit_keeps_admission_time_separate_from_the_snapshot_time(
    client, fake_runner, fake_artifact_storage
):
    """Giờ nộp giữ theo lượt nhận bài, giờ chấm nằm trong snapshot: hai mốc khác nhau."""
    competition = _ready_v2(client, "snap-v2", baseline=0.5)  # FakeRunner trả accuracy 0.75
    participant = _participant(client)
    login_participant(client)
    accepted = submit(client, competition["id"], V2_SUBMISSION)
    assert accepted.status_code == 202, accepted.text
    attempt_id = accepted.json()["attempt_id"]
    # Thí sinh nhấn Nút từ rất lâu rồi worker mới chấm xong.
    _patch_attempt(client, attempt_id, {"$set": {"created_at": BASE}})

    assert run_worker(client) >= 1
    stored = _stored(client, attempt_id)
    assert as_utc(stored["created_at"]) == BASE
    snapshot = stored["normalization_snapshot"]
    assert snapshot["reference_best"] == 0.75
    assert snapshot["score"] == pytest.approx(50.0)
    assert as_utc(snapshot["calculated_at"]) > BASE

    # Poll của thí sinh chỉ thấy điểm tạm và thời điểm, không thấy mặt bằng điểm người khác.
    polled = attempt_status(client, competition["id"], attempt_id)["submission"]
    assert set(polled["normalization_snapshot"]) == {"score", "calculated_at"}
    assert polled["normalization_snapshot"]["calculated_at"] == iso_z(snapshot["calculated_at"])

    # Tie-break của BXH theo giờ nhận bài, không theo giờ chấm.
    board = _board(client, competition)
    assert board["entries"][0]["best_submission_at"] == iso_z(BASE)
    assert board["normalization"]["reference_best"] == 0.75
    assert board["entries"][0]["account_id"] == str(participant["_id"])


def test_reconcile_resolves_without_rewriting_the_stored_snapshot(
    client, fake_runner, fake_artifact_storage
):
    """Lượt đối soát gặp bài đã ghi: đóng lượt, không chấm lại, không viết lại snapshot."""
    competition = _ready_v2(client, "snap-reconcile", baseline=0.5)
    login_participant(client)
    attempt_id = submit(client, competition["id"], V2_SUBMISSION).json()["attempt_id"]
    assert run_worker(client) >= 1
    before = _stored(client, attempt_id)["normalization_snapshot"]

    # Worker chết sau khi bài đã ghi nhưng trước khi đóng lượt; mặt bằng điểm đổi trong lúc đó.
    _patch_attempt(client, attempt_id, {"$set": {"status": "RESOLVING"}})
    rival_id = _create_account(client, "Đội Mới", "snap-reconcile-rival@vku.vn")
    _submission(
        client,
        competition,
        rival_id,
        0.95,
        BASE + timedelta(minutes=1),
    )

    stats = _run(
        worker.reconcile(_db(client), settings=get_settings(), now=datetime.now(timezone.utc))
    )
    assert stats["resolved"] == 1
    assert attempt_status(client, competition["id"], attempt_id)["status"] == "COMPLETED"
    # Bài không bị nhân đôi và snapshot giữ nguyên mẫu số 0.75 dù mặt bằng đã lên 0.95.
    assert len(submission_documents(client, {"_id": ObjectId(attempt_id)})) == 1
    assert _stored(client, attempt_id)["normalization_snapshot"] == before
    assert before["reference_best"] == 0.75
    assert membership_document(client, competition["id"])["quota_used"] == 1
