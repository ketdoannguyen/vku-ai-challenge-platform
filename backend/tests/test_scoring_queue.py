"""Hàng đợi chấm v2 (ADR-048): trần chờ, idempotency, hạn 60 giây, quota và đối soát.

Test chạy worker thật trên Mongo mock (`tests.helpers.run_worker`), nên đường được kiểm là đường
thật: API nhận bài → giữ chỗ trong hàng đợi → worker claim → chấm → ghi submission → đóng lượt.
Thời gian được tua bằng cách sửa thẳng document của lượt, không bằng cách ngủ.
"""

import asyncio
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.core.config import get_settings
from app.scoring.errors import EvaluatorError
from app.scoring_attempts import worker
from app.scoring_attempts.store import ATTEMPTS_COLLECTION
from app.submissions import service as submissions_service
from tests.helpers import (
    V2_SUBMISSION,
    VALID_NOTEBOOK,
    attempt_documents,
    attempt_status,
    login,
    login_participant,
    membership_document,
    publish_v2_competition,
    run_worker,
    submission_documents,
    submit,
)

EXPIRED_MESSAGE = "Bài nộp quá hạn chờ chấm nên không bị tính lượt. Bạn hãy nộp lại."


def _db(client):
    return client.app.state.mongo.db


def _patch_attempt(client, attempt_id: str, patch: dict) -> None:
    async def run():
        await _db(client)[ATTEMPTS_COLLECTION].update_one(
            {"_id": ObjectId(attempt_id)}, patch
        )

    asyncio.run(run())


def _quota_used(client, competition_id: str) -> int:
    return membership_document(client, competition_id).get("quota_used", 0)


def _out_of_time(client, attempt_id: str) -> None:
    """Tua lượt về quá khứ: hạn 60 giây của nó đã trôi qua."""
    _patch_attempt(
        client,
        attempt_id,
        {"$set": {"deadline_at": datetime.now(timezone.utc) - timedelta(seconds=1)}},
    )


def _reconcile(client) -> dict:
    return asyncio.run(
        worker.reconcile(
            _db(client), settings=get_settings(), now=datetime.now(timezone.utc)
        )
    )


def _attempts_url(competition_id: str) -> str:
    return f"/api/competitions/{competition_id}/submissions/attempts"


def test_mot_lan_nhan_nut_la_mot_luot_cho_duoc_cham(client, fake_runner, fake_artifact_storage):
    competition = publish_v2_competition(client)
    cid = competition["id"]

    accepted = submit(client, cid, V2_SUBMISSION)
    assert accepted.status_code == 202, accepted.text
    queued = accepted.json()
    assert queued["status"] == "QUEUED"
    assert queued["queue_position"] == 1
    assert queued["error"] is None
    assert queued["submission"] is None
    # Hạn 60 giây tính từ lúc API nhận request, nên trừ hao thời gian xử lý vẫn còn gần đủ.
    deadline = datetime.fromisoformat(queued["deadline_at"].replace("Z", "+00:00"))
    created = datetime.fromisoformat(queued["created_at"].replace("Z", "+00:00"))
    assert timedelta(seconds=55) < deadline - created <= timedelta(seconds=60)

    # File đã nằm trong kho tạm, bài nộp thật thì chưa có.
    assert [key for key in fake_artifact_storage.objects if "staging/scoring" in key]
    assert submission_documents(client) == []
    assert _quota_used(client, cid) == 1

    assert run_worker(client) == 1
    assert attempt_status(client, cid, queued["attempt_id"])["status"] == "COMPLETED"
    assert len(submission_documents(client)) == 1
    # Lượt đã kết thúc nên không còn trong danh sách chưa xong, và kho tạm đã được dọn.
    assert client.get(_attempts_url(cid)).json() == {"attempts": []}
    assert not [key for key in fake_artifact_storage.objects if "staging/scoring" in key]


def test_cung_mot_lan_nhan_nut_thi_khong_tao_luot_thu_hai(client, fake_runner):
    competition = publish_v2_competition(client)
    cid = competition["id"]

    first = submit(client, cid, V2_SUBMISSION, key="nut-bam-1")
    again = submit(client, cid, V2_SUBMISSION, key="nut-bam-1")
    assert (first.status_code, again.status_code) == (202, 202)
    assert again.json()["attempt_id"] == first.json()["attempt_id"]
    assert len(attempt_documents(client)) == 1
    assert _quota_used(client, cid) == 1

    # Cùng key mà bài khác là lỗi của client: không được trả về lượt cũ như thể đã nhận bài mới.
    other = submit(client, cid, b"id,predict_type\n1,B\n2,A\n3,B\n4,A\n", key="nut-bam-1")
    assert other.status_code == 409
    assert other.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert len(attempt_documents(client)) == 1


def test_thieu_idempotency_key_thi_khong_vao_hang_doi(client, fake_runner):
    competition = publish_v2_competition(client)
    cid = competition["id"]

    missing = client.post(
        f"/api/competitions/{cid}/submissions",
        files={
            "file": ("answers.csv", V2_SUBMISSION, "text/csv"),
            "notebook": ("solution.ipynb", VALID_NOTEBOOK, "application/x-ipynb+json"),
        },
    )
    assert missing.status_code == 400
    assert missing.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"
    assert attempt_documents(client) == []
    assert _quota_used(client, cid) == 0


def test_hang_doi_day_thi_tra_503_ngay_va_khong_giu_luot(client, fake_runner, monkeypatch):
    monkeypatch.setenv("SCORING_QUEUE_CAPACITY", "2")
    get_settings.cache_clear()
    competition = publish_v2_competition(client, quota=10)
    cid = competition["id"]

    assert submit(client, cid, V2_SUBMISSION).status_code == 202
    assert submit(client, cid, V2_SUBMISSION).status_code == 202
    full = submit(client, cid, V2_SUBMISSION)
    assert full.status_code == 503
    assert full.json()["error"] == {
        "code": "SCORING_QUEUE_FULL",
        "message": "Hàng đợi chấm điểm đang đầy. Bạn thử lại sau ít phút nhé.",
    }
    # Lượt bị từ chối không để lại dấu vết nào và không tiêu suất quota.
    assert len(attempt_documents(client)) == 2
    assert _quota_used(client, cid) == 2

    # Chấm xong hai lượt đầu thì chỗ trong hàng đợi được trả lại cho lượt kế.
    assert run_worker(client) == 2
    assert submit(client, cid, V2_SUBMISSION).status_code == 202


def test_qua_60_giay_thi_luot_bi_dong_va_khong_ton_luot(client, fake_runner, fake_artifact_storage):
    competition = publish_v2_competition(client)
    cid = competition["id"]
    queued = submit(client, cid, V2_SUBMISSION).json()
    assert _quota_used(client, cid) == 1

    _out_of_time(client, queued["attempt_id"])
    # Đối soát là thứ đóng lượt quá hạn; worker chỉ chấm những lượt còn kịp 60 giây.
    assert _reconcile(client)["expired"] == 1
    assert run_worker(client) == 0

    body = attempt_status(client, cid, queued["attempt_id"])
    assert body["status"] == "EXPIRED"
    assert body["error"] == {"code": "SUBMISSION_EXPIRED", "message": EXPIRED_MESSAGE}
    # Không tốn lượt, không có bài nộp, và file tạm cũng không ở lại.
    assert _quota_used(client, cid) == 0
    assert submission_documents(client) == []
    assert not [key for key in fake_artifact_storage.objects if "staging/scoring" in key]
    assert submit(client, cid, V2_SUBMISSION).status_code == 202


def test_bai_hong_thi_hoan_luot_va_khong_giu_file_tam(client, fake_runner, fake_artifact_storage):
    competition = publish_v2_competition(client)
    cid = competition["id"]
    fake_runner.error = EvaluatorError("EVALUATOR_FAILED", "Bộ chấm lỗi khi chạy.")

    queued = submit(client, cid, V2_SUBMISSION).json()
    assert run_worker(client) == 1

    assert attempt_status(client, cid, queued["attempt_id"])["status"] == "FAILED"
    assert _quota_used(client, cid) == 0
    assert not [key for key in fake_artifact_storage.objects if "staging/scoring" in key]
    # Lượt hỏng không tiêu lượt nên thí sinh nộp lại được ngay.
    assert submit(client, cid, V2_SUBMISSION).status_code == 202


def test_hoan_luot_hai_lan_khong_thanh_hai_suat(client, fake_runner):
    """Đối soát chạy lại sau khi worker đã hoàn suất thì bộ đếm phải đứng yên."""
    competition = publish_v2_competition(client)
    cid = competition["id"]
    queued = submit(client, cid, V2_SUBMISSION).json()
    _out_of_time(client, queued["attempt_id"])

    assert _reconcile(client)["expired"] == 1
    assert _quota_used(client, cid) == 0
    assert _reconcile(client) == {"expired": 0, "requeued": 0, "resolved": 0, "refunded": 0}
    assert _quota_used(client, cid) == 0


def test_quota_chi_duoc_cap_dung_so_suat_khi_nop_dong_thoi(client, fake_runner):
    """Cổng chặn thật là `$inc` có điều kiện trên một document membership, không phải phép đếm."""
    competition = publish_v2_competition(client, quota=5)
    cid = competition["id"]

    membership = membership_document(client, cid)

    async def reserve():
        return await submissions_service.reserve_quota_slot(
            _db(client), membership, 5, datetime.now(timezone.utc)
        )

    async def race():
        return await asyncio.gather(*[reserve() for _ in range(8)])

    results = asyncio.run(race())
    assert len([item for item in results if item is not None]) == 5
    assert _quota_used(client, cid) == 5


def test_dong_cuoc_thi_giua_luc_cho_thi_luot_khong_thanh_cong(client, fake_runner):
    competition = publish_v2_competition(client)
    cid = competition["id"]
    queued = submit(client, cid, V2_SUBMISSION).json()

    login(client)
    assert client.post(f"/api/admin/competitions/{cid}/close").status_code == 200
    assert run_worker(client) == 1

    login_participant(client)
    body = attempt_status(client, cid, queued["attempt_id"])
    assert body["status"] == "FAILED"
    assert body["error"]["code"] == "SUBMISSION_CLOSED"
    assert submission_documents(client) == []
    assert _quota_used(client, cid) == 0


def test_vo_hieu_hoa_membership_thi_luot_khong_duoc_cham(client, fake_runner):
    competition = publish_v2_competition(client)
    cid = competition["id"]
    queued = submit(client, cid, V2_SUBMISSION).json()

    login(client)
    membership = membership_document(client, cid)
    deactivated = client.patch(
        f"/api/admin/competitions/{cid}/members/{membership['account_id']}",
        json={"active": False},
    )
    assert deactivated.status_code == 200, deactivated.text

    assert run_worker(client) == 1
    login_participant(client)
    body = attempt_status(client, cid, queued["attempt_id"])
    assert body["status"] == "FAILED"
    assert body["error"]["code"] == "MEMBERSHIP_INACTIVE"
    assert submission_documents(client) == []


def test_kho_tam_hong_khi_nhan_bai_thi_khong_giu_luot(client, fake_runner, fake_artifact_storage):
    competition = publish_v2_competition(client)
    cid = competition["id"]
    fake_artifact_storage.unavailable = True

    failed = submit(client, cid, V2_SUBMISSION)
    assert failed.status_code == 503
    assert failed.json()["error"]["code"] == "ARTIFACT_STORAGE_UNAVAILABLE"
    assert _quota_used(client, cid) == 0
    # Lượt đã được tạo nhưng không bao giờ vào hàng đợi, và nó không chờ ai cả.
    attempts = attempt_documents(client)
    assert [attempt["status"] for attempt in attempts] == ["FAILED"]
    assert "queue_slot" not in attempts[0]


def test_worker_chet_giua_luc_cham_thi_doi_soat_tra_luot_ve_hang_doi(client, fake_runner):
    competition = publish_v2_competition(client)
    cid = competition["id"]
    queued = submit(client, cid, V2_SUBMISSION).json()

    # Worker A claim rồi chết: lượt đang RUNNING với lease đã hết hạn, nhưng vẫn còn kịp 60 giây.
    claimed = asyncio.run(
        worker.store.claim_next(
            _db(client),
            worker_id="worker-a",
            now=datetime.now(timezone.utc),
            lease_seconds=get_settings().scoring_lease_seconds,
        )
    )
    assert claimed is not None
    _patch_attempt(
        client,
        queued["attempt_id"],
        {"$set": {"lease_expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)}},
    )

    assert _reconcile(client)["requeued"] == 1
    assert attempt_status(client, cid, queued["attempt_id"])["status"] == "QUEUED"
    # Worker B nhận lại đúng lượt đó và chấm xong.
    assert run_worker(client) == 1
    assert attempt_status(client, cid, queued["attempt_id"])["status"] == "COMPLETED"
    assert _quota_used(client, cid) == 1


def test_worker_chet_qua_han_thi_dong_luot_va_hoan_suat(client, fake_runner):
    competition = publish_v2_competition(client)
    cid = competition["id"]
    queued = submit(client, cid, V2_SUBMISSION).json()
    asyncio.run(
        worker.store.claim_next(
            _db(client),
            worker_id="worker-a",
            now=datetime.now(timezone.utc),
            lease_seconds=get_settings().scoring_lease_seconds,
        )
    )
    _patch_attempt(
        client,
        queued["attempt_id"],
        {
            "$set": {
                "lease_expires_at": datetime.now(timezone.utc) - timedelta(seconds=1),
                "deadline_at": datetime.now(timezone.utc) - timedelta(seconds=1),
            }
        },
    )

    stats = _reconcile(client)
    assert stats == {"expired": 1, "requeued": 0, "resolved": 0, "refunded": 0}
    assert attempt_status(client, cid, queued["attempt_id"])["status"] == "EXPIRED"
    assert _quota_used(client, cid) == 0


def test_ket_qua_cham_da_co_thi_doi_soat_ghi_not_bai_nop(client, fake_runner):
    """Worker chết sau khi chấm nhưng trước khi ghi: đối soát hoàn tất lượt, không chấm lại."""
    competition = publish_v2_competition(client)
    cid = competition["id"]
    queued = submit(client, cid, V2_SUBMISSION).json()

    claimed = asyncio.run(
        worker.store.claim_next(
            _db(client),
            worker_id="worker-a",
            now=datetime.now(timezone.utc),
            lease_seconds=get_settings().scoring_lease_seconds,
        )
    )
    asyncio.run(
        worker.store.store_result(
            _db(client),
            claimed,
            result={"metrics": {"accuracy": 0.5}, "primary_score": 0.5, "scoring_ref": None},
            now=datetime.now(timezone.utc),
        )
    )
    asyncio.run(
        worker.store.mark_resolving(
            _db(client),
            claimed,
            error={"code": "SUBMISSION_RESOLVING", "message": "x"},
            now=datetime.now(timezone.utc),
        )
    )
    calls_before = len(fake_runner.calls)

    assert _reconcile(client)["resolved"] == 1
    assert len(fake_runner.calls) == calls_before
    body = attempt_status(client, cid, queued["attempt_id"])
    assert body["status"] == "COMPLETED"
    assert body["submission"]["primary_score"] == 0.5
    assert _quota_used(client, cid) == 1


def test_ghi_bai_khong_ro_ket_qua_ma_khong_co_diem_thi_dong_luot(client, fake_runner):
    competition = publish_v2_competition(client)
    cid = competition["id"]
    queued = submit(client, cid, V2_SUBMISSION).json()
    _patch_attempt(client, queued["attempt_id"], {"$set": {"status": "RESOLVING"}})

    assert _reconcile(client)["resolved"] == 1
    body = attempt_status(client, cid, queued["attempt_id"])
    assert body["status"] == "FAILED"
    assert body["error"]["message"] == "Không thể chấm điểm bài nộp này."
    assert _quota_used(client, cid) == 0


def test_xoa_cuoc_thi_thi_luot_dang_cho_bi_xoa_luon(client, fake_runner, fake_artifact_storage):
    """Xoá cuộc thi lúc còn lượt chờ: lượt và file tạm của nó biến mất, worker không còn gì để chấm."""
    competition = publish_v2_competition(client)
    cid, slug = competition["id"], competition["slug"]
    submit(client, cid, V2_SUBMISSION)
    assert [key for key in fake_artifact_storage.objects if "staging/scoring" in key]

    login(client)
    assert client.post(f"/api/admin/competitions/{cid}/close").status_code == 200
    deleted = client.delete(f"/api/admin/competitions/{cid}?confirm_slug={slug}")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["files_removed"] is True

    assert attempt_documents(client) == []
    assert not [key for key in fake_artifact_storage.objects if "staging/scoring" in key]
    assert run_worker(client) == 0
    assert submission_documents(client) == []


def test_luot_cua_nguoi_khac_khong_doc_duoc(client, fake_runner):
    competition = publish_v2_competition(client)
    cid = competition["id"]
    queued = submit(client, cid, V2_SUBMISSION).json()

    login_participant(client)
    assert client.get(_attempts_url(cid)).json()["attempts"][0]["attempt_id"] == (
        queued["attempt_id"]
    )
    assert client.get(f"{_attempts_url(cid)}/{queued['attempt_id']}").status_code == 200
    assert client.get(f"{_attempts_url(cid)}/khong-phai-object-id").status_code == 404
    assert client.get(f"{_attempts_url(cid)}/{ObjectId()}").status_code == 404

    # Tài khoản khác không thấy lượt nào của cuộc thi này.
    login(client)
    created = client.post(
        "/api/admin/accounts",
        json={
            "email": "nguoi.khac@vku.vn",
            "name": "Người Khác",
            "password": "matkhaukhac1",
            "role": "participant",
        },
    )
    assert created.status_code == 201, created.text
    login(client, "nguoi.khac@vku.vn", "matkhaukhac1")
    assert client.post(f"/api/competitions/{competition['slug']}/join", json={}).status_code == 200
    assert client.get(_attempts_url(cid)).json() == {"attempts": []}
    assert client.get(f"{_attempts_url(cid)}/{queued['attempt_id']}").status_code == 404
