"""Bộ chấm Python v2 qua API: cấu hình và xác minh của admin, rồi luồng chấm bài thật.

Runner thật nằm trong container riêng nên test thay nó bằng `FakeRunner`; phần kiểm tra dữ liệu,
đối chiếu hợp đồng metric và dấu vân tay vẫn là code thật của `app.scoring.execution`.
"""

import asyncio
from copy import deepcopy

import pytest
from bson import ObjectId

from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.config import get_settings
from app.scoring import revisions
from app.scoring.errors import EvaluatorError
from tests.helpers import (
    V2_CONTRACT,
    V2_GROUND_TRUTH,
    V2_PREPARED_SUBMISSION,
    V2_RUNTIME_ID,
    V2_SCHEMA,
    V2_SOURCE,
    V2_SUBMISSION,
    attempt_documents,
    attempt_status,
    login,
    login_participant,
    membership_document,
    publish_v2_competition,
    put_scoring_v2,
    run_scoring_test_v2,
    run_worker,
    submission_documents,
    submit,
    upload_v2_ground_truth,
)


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


def _competition(client, slug="v2-setup-cup") -> dict:
    login(client)
    created = client.post(
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
    assert created.status_code == 201
    return created.json()


def _revision(client, competition_id: str) -> int:
    view = client.get(f"/api/admin/competitions/{competition_id}/scoring")
    assert view.status_code == 200
    return view.json()["scoring"]["revision"]


def test_v2_draft_saves_source_and_blocks_publish_without_contract(client):
    cid = _competition(client)["id"]
    saved = put_scoring_v2(client, cid, expected_revision=0)
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["version"] == 2
    assert body["config"] is None
    assert body["scoring"]["revision"] == 1
    assert body["scoring"]["evaluator"] == {
        "name": "Bộ chấm thử",
        "source_sha256": revisions.sha256_bytes(V2_SOURCE.encode()),
        "runtime_id": None,
        "source_code": V2_SOURCE,
    }
    assert body["scoring"]["output_contract"] is None
    assert body["scoring"]["verified"] is False
    assert body["ready"] is False
    assert body["not_ready_reason"] == {
        "code": "SCORING_CONFIG_REQUIRED",
        "message": "Cần khai báo metric và chọn metric chính.",
    }

    blocked = client.post(f"/api/admin/competitions/{cid}/publish")
    assert blocked.status_code == 422
    assert blocked.json()["error"]["code"] == "SCORING_CONFIG_REQUIRED"


def test_v2_contract_without_primary_metric_is_a_draft_that_cannot_publish(client):
    """Hợp đồng thiếu metric chính vẫn lưu được (bản nháp) nhưng publish phải chặn: chấm thì ra
    điểm, còn lấy điểm chính và xếp hạng thì không - mọi bài nộp sau đó sẽ hỏng ở bước đó."""
    cid = _competition(client)["id"]
    saved = put_scoring_v2(
        client, cid, expected_revision=0, output_contract={**V2_CONTRACT, "primary_metric": None}
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["ready"] is False
    assert saved.json()["not_ready_reason"] == {
        "code": "SCORING_CONFIG_REQUIRED",
        "message": "Cần khai báo metric và chọn metric chính.",
    }
    blocked = client.post(f"/api/admin/competitions/{cid}/publish")
    assert blocked.status_code == 422
    assert blocked.json()["error"]["code"] == "SCORING_CONFIG_REQUIRED"

    # Chọn metric chính rồi thì chặn kế tiếp là ground truth, không còn là cấu hình.
    fixed = put_scoring_v2(client, cid, expected_revision=1, output_contract=V2_CONTRACT)
    assert fixed.status_code == 200, fixed.text
    assert fixed.json()["not_ready_reason"]["code"] == "GROUND_TRUTH_REQUIRED"


def test_v2_save_without_source_is_a_draft_that_cannot_publish(client):
    """Schema-first: lưu bản nháp khi chưa có source (và chưa đặt tên bộ chấm) vẫn được; publish và
    lượt chạy thử là hai chỗ đòi source, và cả hai phải nói đúng việc cần làm."""
    cid = _competition(client)["id"]
    draft = put_scoring_v2(
        client, cid, expected_revision=0, source_code=None, name="", output_contract=V2_CONTRACT
    )
    assert draft.status_code == 200, draft.text
    body = draft.json()
    assert body["scoring"]["evaluator"]["source_sha256"] is None
    assert body["ready"] is False
    assert body["not_ready_reason"] == {
        "code": "SCORING_CONFIG_INVALID",
        "message": "Bộ chấm cần có tên để hiển thị và đối chiếu.",
    }

    tested = run_scoring_test_v2(client, cid, expected_revision=1)
    assert tested.status_code == 422
    assert tested.json()["error"]["code"] == "EVALUATOR_REQUIRED"
    assert tested.json()["error"]["message"] == "Cần lưu source bộ chấm trước khi chạy thử."

    # Lưu tiếp source trên cùng bản nháp: revision tiến lên, chặn kế tiếp là ground truth.
    saved = put_scoring_v2(client, cid, expected_revision=1, output_contract=V2_CONTRACT)
    assert saved.status_code == 200, saved.text
    assert saved.json()["scoring"]["evaluator"]["source_sha256"] == revisions.sha256_bytes(
        V2_SOURCE.encode()
    )
    assert saved.json()["not_ready_reason"]["code"] == "GROUND_TRUTH_REQUIRED"

    broken = put_scoring_v2(client, cid, expected_revision=2, source_code="x = 1\n")
    assert broken.status_code == 422
    assert broken.json()["error"]["code"] == "EVALUATOR_INVALID"


def test_v2_save_rejects_stale_revision(client):
    cid = _competition(client)["id"]
    assert put_scoring_v2(client, cid, expected_revision=0).status_code == 200

    stale = put_scoring_v2(client, cid, expected_revision=0)
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "SCORING_REVISION_CONFLICT"

    # Revision 1 mới là bản đang có; sửa tiếp trên nó phải qua được.
    assert put_scoring_v2(client, cid, expected_revision=1).status_code == 200
    assert _revision(client, cid) == 2


def test_v2_save_rejects_text_allowed_values_on_a_number_column(client):
    """Ô của cột số được parse thành số trước khi so với danh sách cho phép, nên giá trị cho phép
    dạng chuỗi phải bị chặn lúc lưu - không phải để vỡ ở lượt chấm đầu tiên."""
    cid = _competition(client)["id"]
    schema = deepcopy(V2_SCHEMA)
    schema["ground_truth"]["columns"][1] = {
        "name": "label",
        "type": "number",
        "allowed_values": ["0", "A"],
    }
    rejected = put_scoring_v2(client, cid, expected_revision=0, input_schema=schema)
    assert rejected.status_code == 422
    assert rejected.json()["error"]["code"] == "SCORING_CONFIG_INVALID"

    schema["ground_truth"]["columns"][1]["allowed_values"] = [0, 1]
    assert put_scoring_v2(
        client, cid, expected_revision=0, input_schema=schema
    ).status_code == 200


def test_v2_config_cannot_be_downgraded_by_a_v1_body(client):
    """Body v1 đè lên cấu hình v2 sẽ đổi cách chấm của mọi bài nộp sau trong khi bài cũ vẫn giữ
    metric v2, nên phải bị từ chối thay vì lặng lẽ hạ cấp cuộc thi."""
    cid = _competition(client)["id"]
    assert put_scoring_v2(
        client, cid, expected_revision=0, output_contract=V2_CONTRACT
    ).status_code == 200

    refused = client.put(
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
    assert refused.status_code == 422
    assert refused.json()["error"]["code"] == "SCORING_CONFIG_INVALID"
    view = client.get(f"/api/admin/competitions/{cid}/scoring").json()
    assert view["version"] == 2
    assert view["scoring"]["revision"] == 1


def test_broken_v2_config_can_still_fall_back_to_a_v1_body(client):
    """Bản ghi v2 không đọc được thì đường lùi về bộ chấm cột cố định phải còn mở, nếu không cuộc
    thi kẹt vĩnh viễn ở một cấu hình mà cả UI lẫn backend đều không dùng được."""
    cid = _competition(client)["id"]
    assert put_scoring_v2(
        client, cid, expected_revision=0, output_contract=V2_CONTRACT
    ).status_code == 200

    async def break_config():
        await client.app.state.mongo.db[COMPETITIONS_COLLECTION].update_one(
            {"_id": ObjectId(cid)}, {"$set": {"scoring_config.input_schema": None}}
        )

    asyncio.run(break_config())
    recovered = client.put(
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
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["version"] == 1


def test_v2_ground_truth_is_checked_against_schema(client):
    cid = _competition(client)["id"]
    assert put_scoring_v2(
        client, cid, expected_revision=0, output_contract=V2_CONTRACT
    ).status_code == 200

    outside_enum = b"id,label,predict_type\n1,1,C\n2,0,B\n3,1,A\n4,0,B\n"
    rejected = upload_v2_ground_truth(client, cid, expected_revision=1, data=outside_enum)
    assert rejected.status_code == 422
    assert rejected.json()["error"]["code"] == "GROUND_TRUTH_INVALID"

    uploaded = upload_v2_ground_truth(client, cid, expected_revision=1)
    assert uploaded.status_code == 200, uploaded.text
    body = uploaded.json()
    assert body["ground_truth"]["row_count"] == 4
    assert body["ground_truth"]["columns"] == ["id", "label", "predict_type"]
    assert body["scoring"]["revision"] == 2
    # Có dữ liệu và bộ chấm nhưng chưa chạy thử lần nào.
    assert body["not_ready_reason"]["code"] == "SCORING_TEST_REQUIRED"


def test_v2_test_run_discovers_keys_then_verifies_contract(client, fake_runner):
    cid = _competition(client)["id"]
    assert put_scoring_v2(client, cid, expected_revision=0).status_code == 200
    assert upload_v2_ground_truth(client, cid, expected_revision=1).status_code == 200

    discovery = run_scoring_test_v2(client, cid, expected_revision=2)
    assert discovery.status_code == 200, discovery.text
    assert discovery.json()["test"] == {
        "observed_keys": ["accuracy", "n_items"],
        "metrics": {"accuracy": 0.75, "n_items": 4.0},
        "duration_ms": 7,
        "matches_contract": False,
    }
    # Bằng chứng của lượt chạy còn hiệu lực, nhưng chưa khai báo metric thì chưa publish được.
    assert discovery.json()["scoring"]["verified"] is True
    assert discovery.json()["ready"] is False
    assert discovery.json()["not_ready_reason"]["code"] == "SCORING_CONFIG_REQUIRED"
    assert discovery.json()["scoring"]["evaluator"]["runtime_id"] == V2_RUNTIME_ID
    # Bộ chấm nhận ground truth nguyên văn và submission đã căn theo thứ tự ID của ground truth.
    assert fake_runner.calls[-1]["ground_truth_csv"] == V2_GROUND_TRUTH.decode()
    assert fake_runner.calls[-1]["submission_csv"] == V2_PREPARED_SUBMISSION

    declared = put_scoring_v2(client, cid, expected_revision=2, output_contract=V2_CONTRACT)
    assert declared.status_code == 200, declared.text
    assert declared.json()["primary_metric"] == "accuracy"
    assert declared.json()["higher_is_better"] is True
    # Khai đúng tập khóa vừa dò không làm lượt chạy thử hết hiệu lực: một lượt vừa dò vừa xác minh,
    # publish mở ngay mà không cần chạy lại.
    assert declared.json()["scoring"]["verified"] is True
    assert declared.json()["ready"] is True
    assert declared.json()["scoring"]["verification"]["tested_by"] == "admin@vku.vn"
    assert declared.json()["scoring"]["verification"]["observed_keys"] == ["accuracy", "n_items"]

    assert client.post(f"/api/admin/competitions/{cid}/publish").status_code == 200


def test_v2_khai_lech_tap_khoa_lam_bang_chung_het_hieu_luc(client, fake_runner):
    cid = _competition(client)["id"]
    assert put_scoring_v2(client, cid, expected_revision=0).status_code == 200
    assert upload_v2_ground_truth(client, cid, expected_revision=1).status_code == 200
    assert run_scoring_test_v2(client, cid, expected_revision=2).status_code == 200

    # Khai một khóa bộ chấm không trả về: tập khóa lệch nên bằng chứng cũ hết hiệu lực.
    wrong = {
        **V2_CONTRACT,
        "metrics": [
            *V2_CONTRACT["metrics"],
            {"key": "f1_macro", "label": "Macro F1", "decimals": 4},
        ],
    }
    declared = put_scoring_v2(client, cid, expected_revision=2, output_contract=wrong)
    assert declared.status_code == 200, declared.text
    assert declared.json()["scoring"]["verified"] is False
    assert declared.json()["not_ready_reason"]["code"] == "SCORING_TEST_REQUIRED"

    # Chạy thử lại với hợp đồng lệch cũng không cứu được: bộ chấm thiếu khóa đã khai nên bị chặn
    # ngay ở bước đối chiếu, không có bằng chứng nào được ghi.
    mismatched = run_scoring_test_v2(client, cid, expected_revision=3)
    assert mismatched.status_code == 422
    assert mismatched.json()["error"]["code"] == "EVALUATOR_OUTPUT_MISMATCH"

    # Khai lại đúng tập khóa vừa dò là bằng chứng cũ sống lại, không cần lượt chạy mới.
    fixed = put_scoring_v2(client, cid, expected_revision=3, output_contract=V2_CONTRACT)
    assert fixed.status_code == 200, fixed.text
    assert fixed.json()["scoring"]["verified"] is True
    assert fixed.json()["ready"] is True

    # Chạy thử khi hợp đồng đã đúng vẫn chạy được và báo khớp hợp đồng.
    rerun = run_scoring_test_v2(client, cid, expected_revision=4)
    assert rerun.status_code == 200, rerun.text
    assert rerun.json()["test"]["matches_contract"] is True
    assert rerun.json()["ready"] is True


def test_v2_test_run_rejects_output_outside_contract(client, fake_runner):
    cid = _competition(client)["id"]
    contract = {
        "metrics": [{"key": "accuracy", "label": "Accuracy", "decimals": 4}],
        "primary_metric": "accuracy",
        "higher_is_better": True,
    }
    assert put_scoring_v2(
        client, cid, expected_revision=0, output_contract=contract
    ).status_code == 200
    assert upload_v2_ground_truth(client, cid, expected_revision=1).status_code == 200

    rejected = run_scoring_test_v2(client, cid, expected_revision=2)
    assert rejected.status_code == 422
    error = rejected.json()["error"]
    assert error["code"] == "EVALUATOR_OUTPUT_MISMATCH"
    assert "thừa n_items" in error["message"]
    # Lượt chạy hỏng không để lại dấu xác minh nào.
    assert _revision(client, cid) == 2


def test_v2_test_run_maps_evaluator_failures(client, fake_runner):
    cid = _competition(client)["id"]
    assert put_scoring_v2(client, cid, expected_revision=0).status_code == 200
    assert upload_v2_ground_truth(client, cid, expected_revision=1).status_code == 200

    fake_runner.error = EvaluatorError(
        "EVALUATOR_FAILED", "Bộ chấm lỗi khi chạy.", detail="Traceback (most recent call last): ..."
    )
    failed = run_scoring_test_v2(client, cid, expected_revision=2)
    assert failed.status_code == 422
    assert failed.json()["error"]["code"] == "EVALUATOR_FAILED"
    assert failed.json()["error"]["detail"].startswith("Traceback")

    fake_runner.error = EvaluatorError("EVALUATOR_UNAVAILABLE", "Máy chấm đang không sẵn sàng.")
    busy = run_scoring_test_v2(client, cid, expected_revision=2)
    assert busy.status_code == 503
    assert busy.json()["error"] == {
        "code": "EVALUATOR_UNAVAILABLE",
        "message": "Máy chấm đang không sẵn sàng.",
    }


def test_v2_verification_dies_with_source_or_ground_truth(client, fake_runner):
    competition = publish_v2_competition(client)
    cid = competition["id"]
    login(client)

    # Sửa nội dung bộ chấm (kết quả trả về vẫn thế) là bằng chứng xác minh cũ hết hiệu lực.
    changed_source = put_scoring_v2(
        client,
        cid,
        expected_revision=_revision(client, cid),
        source_code=V2_SOURCE.replace("len(truth)", "sum(1 for _ in truth)"),
        output_contract=V2_CONTRACT,
    )
    assert changed_source.status_code == 200
    assert changed_source.json()["not_ready_reason"]["code"] == "SCORING_TEST_REQUIRED"

    # Ground truth khác nội dung nhưng vẫn đủ 4 ID để lượt chạy thử lại dùng được mẫu cũ.
    other_truth = b"id,label,predict_type\n1,0,A\n2,1,B\n3,1,A\n4,0,B\n"
    changed_truth = upload_v2_ground_truth(
        client, cid, expected_revision=_revision(client, cid), data=other_truth
    )
    assert changed_truth.status_code == 200
    assert changed_truth.json()["ground_truth"]["row_count"] == 4
    assert changed_truth.json()["not_ready_reason"]["code"] == "SCORING_TEST_REQUIRED"

    retested = run_scoring_test_v2(client, cid, expected_revision=_revision(client, cid))
    assert retested.status_code == 200
    assert retested.json()["ready"] is True


def test_v2_submission_is_scored_by_evaluator_and_records_scoring_ref(
    client, fake_runner, fake_artifact_storage
):
    competition = publish_v2_competition(client)
    cid = competition["id"]
    login(client)
    revision = _revision(client, cid)
    login_participant(client)

    # Lượt chạy thử lúc publish đã gọi runner; chỉ đếm thêm từ mốc này.
    calls_after_publish = len(fake_runner.calls)
    accepted = submit(client, cid, V2_SUBMISSION)
    assert accepted.status_code == 202, accepted.text
    queued = accepted.json()
    assert queued["status"] == "QUEUED"
    assert queued["queue_position"] == 1
    assert queued["submission"] is None
    # Vào hàng đợi là chưa chấm gì và chưa có bài nộp nào.
    assert len(fake_runner.calls) == calls_after_publish
    assert submission_documents(client) == []

    assert run_worker(client) == 1

    body = attempt_status(client, cid, queued["attempt_id"])
    assert body["status"] == "COMPLETED"
    assert body["submission"]["metrics"] == {"accuracy": 0.75, "n_items": 4.0}
    assert body["submission"]["primary_score"] == 0.75
    assert body["submission"]["quota_remaining"] == 4
    assert fake_runner.calls[-1]["submission_csv"] == V2_PREPARED_SUBMISSION

    stored = submission_documents(client)[0]
    assert str(stored["_id"]) == queued["attempt_id"]
    assert stored["metrics"] == {"accuracy": 0.75, "n_items": 4.0}
    assert stored["primary_score"] == 0.75
    # `created_at` là lúc thí sinh nhấn Nút: suất quota giữ lúc nhận bài phải cùng ngày với bài nộp.
    assert stored["created_at"] == attempt_documents(client)[0]["created_at"]
    # Dấu vết của lượt chấm: đối chiếu lại được với đúng bộ chấm, đúng ground truth, đúng file đã nộp.
    scoring_ref = stored["scoring_ref"]
    assert {
        key: value for key, value in scoring_ref.items() if key != "config_fingerprint"
    } == {
        "version": 2,
        "revision": revision,
        "source_sha256": revisions.sha256_bytes(V2_SOURCE.encode()),
        "ground_truth_sha256": revisions.sha256_bytes(V2_GROUND_TRUTH),
        "submission_sha256": revisions.sha256_bytes(V2_SUBMISSION),
        "runtime_id": V2_RUNTIME_ID,
    }
    assert len(scoring_ref["config_fingerprint"]) == 64
    assert membership_document(client, cid)["quota_used"] == 1
    # File tạm dọn sau khi ghi bài: kho không giữ lại bản sao thứ hai của cùng bài nộp.
    assert not [key for key in fake_artifact_storage.objects if "staging/" in key]


def test_v2_moi_truong_cham_duoc_ghim_bang_id_noi_dung(client, fake_runner):
    """`runtime_id` là ID nội dung của image: build đè cùng tag là một môi trường khác, và bằng chứng
    của lượt chạy thử trước đó không còn là bằng chứng cho môi trường đang chạy."""
    first = "sha256:" + "1" * 64
    second = "sha256:" + "2" * 64
    fake_runner.runtime_id = first
    competition = publish_v2_competition(client)
    cid = competition["id"]
    login(client)

    verified = client.get(f"/api/admin/competitions/{cid}/scoring").json()["scoring"]
    assert verified["evaluator"]["runtime_id"] == first
    assert verified["verified"] is True
    first_fingerprint = verified["verification"]["execution_fingerprint"]

    # Image được build lại (cùng tag, nội dung khác) rồi admin chạy thử lại: cấu hình ghim ID mới và
    # vân tay đổi theo, nên lượt chấm sau ghi vào `scoring_ref` đúng môi trường đã sinh ra điểm.
    fake_runner.runtime_id = second
    retested = run_scoring_test_v2(client, cid, expected_revision=_revision(client, cid))
    assert retested.status_code == 200, retested.text
    scoring = retested.json()["scoring"]
    assert scoring["evaluator"]["runtime_id"] == second
    assert scoring["verified"] is True
    assert scoring["verification"]["execution_fingerprint"] != first_fingerprint


def test_v2_submission_rejects_bad_csv_without_running_evaluator(client, fake_runner):
    competition = publish_v2_competition(client)
    cid = competition["id"]
    # Lượt chạy thử lúc publish đã gọi runner; chỉ đếm thêm từ mốc này.
    calls_after_publish = len(fake_runner.calls)

    cases = {
        "SUBMISSION_SCHEMA_INVALID": b"id\n1\n2\n3\n4\n",
        "SUBMISSION_VALUE_INVALID": b"id,predict_type\n1,C\n2,B\n3,A\n4,B\n",
        "SUBMISSION_ID_MISMATCH": b"id,predict_type\n1,A\n2,B\n3,A\n",
        "SUBMISSION_DUPLICATE_IDS": b"id,predict_type\n1,A\n1,A\n3,A\n4,B\n",
    }
    for expected_code, payload in cases.items():
        response = submit(client, cid, payload)
        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == expected_code

    # CSV hỏng bị chặn trước khi bộ chấm được gọi: không tốn lượt chấm nào.
    assert len(fake_runner.calls) == calls_after_publish
    assert submission_documents(client) == []
    assert membership_document(client, cid).get("quota_used", 0) == 0


def test_v2_evaluator_failure_is_a_system_error_for_the_student(client, fake_runner):
    competition = publish_v2_competition(client)
    cid = competition["id"]

    fake_runner.error = EvaluatorError(
        "EVALUATOR_FAILED", "Bộ chấm lỗi khi chạy.", detail="Traceback (most recent call last): ..."
    )
    broken = submit(client, cid, V2_SUBMISSION)
    assert broken.status_code == 202
    assert run_worker(client) == 1

    # Chi tiết lỗi nội bộ không ra tới thí sinh: chỉ còn một câu chung, mã lỗi giữ để tra log.
    failed = attempt_status(client, cid, broken.json()["attempt_id"])
    assert failed["status"] == "FAILED"
    assert failed["error"] == {
        "code": "EVALUATOR_FAILED",
        "message": "Không thể chấm điểm bài nộp này.",
    }

    fake_runner.error = EvaluatorError("EVALUATOR_UNAVAILABLE", "Máy chấm đang không sẵn sàng.")
    busy = submit(client, cid, V2_SUBMISSION)
    assert busy.status_code == 202
    assert run_worker(client) == 1
    assert attempt_status(client, cid, busy.json()["attempt_id"])["error"]["code"] == (
        "EVALUATOR_UNAVAILABLE"
    )

    # Lỗi hệ thống không tiêu lượt và không để lại bài nộp giả.
    assert submission_documents(client) == []
    assert membership_document(client, cid).get("quota_used", 0) == 0


def test_v2_config_is_locked_after_the_first_submission(client, fake_runner):
    """Khóa cấu hình tính theo bài đã có điểm: lượt còn nằm chờ chưa khóa, chấm xong mới khóa."""
    competition = publish_v2_competition(client)
    cid = competition["id"]
    queued = submit(client, cid, V2_SUBMISSION)
    assert queued.status_code == 202

    login(client)
    # Chưa có điểm nào nên cấu hình còn sửa được, dù đã có một lượt nằm chờ.
    editable = put_scoring_v2(
        client, cid, expected_revision=_revision(client, cid), output_contract=V2_CONTRACT
    )
    assert editable.status_code == 200, editable.text

    login_participant(client)
    assert run_worker(client) == 1
    assert attempt_status(client, cid, queued.json()["attempt_id"])["status"] == "COMPLETED"

    login(client)
    locked = put_scoring_v2(client, cid, expected_revision=_revision(client, cid))
    assert locked.status_code == 422
    assert locked.json()["error"]["code"] == "SCORING_LOCKED"
    ground_truth = upload_v2_ground_truth(
        client, cid, expected_revision=_revision(client, cid)
    )
    assert ground_truth.status_code == 422


def test_v2_participant_sees_schema_and_contract(client, fake_runner):
    publish_v2_competition(client, slug="v2-public-cup")

    view = client.get("/api/competitions/v2-public-cup")
    assert view.status_code == 200
    config = view.json()["submission_config"]
    assert config["version"] == 2
    assert config["ready"] is True
    assert config["id_column"] == "id"
    # Cột trả về đủ để UI dựng bảng mẫu: tên, kiểu, cho phép rỗng và tập giá trị hợp lệ.
    assert config["columns"] == [
        {"name": "id", "type": "string", "nullable": False, "allowed_values": None},
        {
            "name": "predict_type",
            "type": "string",
            "nullable": False,
            "allowed_values": ["A", "B"],
        },
    ]
    assert config["result_contract"] == V2_CONTRACT
    assert config["primary_metric"] == "accuracy"
    assert config["higher_is_better"] is True
    # Không còn khái niệm cột prediction/pos_label của bộ chấm cố định.
    assert "prediction_column" not in config
    assert "average" not in config
    assert "pos_label" not in config


def test_v2_clone_copies_evaluator_but_not_ground_truth(client, fake_runner, isolated_data_dir):
    """Bản sao nhận source, schema và hợp đồng metric; tự lo ground truth và lượt chạy thử riêng."""
    competition = publish_v2_competition(client, slug="v2-clone-cup")
    login(client)

    cloned = client.post(f"/api/admin/competitions/{competition['id']}/clone")
    assert cloned.status_code == 201, cloned.text
    clone = cloned.json()
    assert clone["status"] == "draft"
    assert clone["submission_config"]["version"] == 2
    assert clone["submission_config"]["id_column"] == "id"
    assert clone["submission_config"]["result_contract"] == V2_CONTRACT
    assert clone["submission_config"]["ready"] is False

    view = client.get(f"/api/admin/competitions/{clone['id']}/scoring").json()
    assert view["scoring"]["revision"] == 0
    assert view["scoring"]["evaluator"] == {
        "name": "Bộ chấm thử",
        "source_sha256": revisions.sha256_bytes(V2_SOURCE.encode()),
        # Runtime là bằng chứng của lượt chạy thử ở cuộc thi gốc, không đi theo bản sao.
        "runtime_id": None,
        "source_code": V2_SOURCE,
    }
    assert view["scoring"]["output_contract"] == V2_CONTRACT
    assert view["scoring"]["verified"] is False
    assert view["ground_truth"] is None
    assert view["not_ready_reason"]["code"] == "GROUND_TRUTH_REQUIRED"

    # Source được ghi lại trong thư mục riêng của bản sao, không dùng chung file với cuộc thi gốc.
    source_file = (
        isolated_data_dir
        / "competitions"
        / clone["id"]
        / "private"
        / "evaluator"
        / f"{revisions.sha256_bytes(V2_SOURCE.encode())}.py"
    )
    assert source_file.read_text(encoding="utf-8") == V2_SOURCE

    # Bản sao độc lập: tải ground truth riêng, chạy thử rồi publish được.
    assert upload_v2_ground_truth(client, clone["id"], expected_revision=0).status_code == 200
    assert run_scoring_test_v2(client, clone["id"], expected_revision=1).status_code == 200
    assert client.post(f"/api/admin/competitions/{clone['id']}/publish").status_code == 200


def test_v2_publish_rejects_a_guard_that_no_longer_matches(client, fake_runner, monkeypatch):
    """Cấu hình đổi giữa lượt kiểm tra readiness và lượt ghi status thì publish bị từ chối.

    Dựng lại đúng khe thời gian đó bằng cách trả về revision đã cũ thay vì revision đang có.
    """
    from app.competitions import admin_router

    cid = _competition(client, slug="v2-race-cup")["id"]
    assert put_scoring_v2(
        client, cid, expected_revision=0, output_contract=V2_CONTRACT
    ).status_code == 200
    assert upload_v2_ground_truth(client, cid, expected_revision=1).status_code == 200
    assert run_scoring_test_v2(client, cid, expected_revision=2).status_code == 200

    monkeypatch.setattr(
        admin_router, "_verified_config", lambda competition: {"scoring_config.revision": 0}
    )
    refused = client.post(f"/api/admin/competitions/{cid}/publish")
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "SCORING_REVISION_CONFLICT"

    async def status():
        document = await client.app.state.mongo.db[COMPETITIONS_COLLECTION].find_one(
            {"_id": ObjectId(cid)}
        )
        return document["status"]

    assert asyncio.run(status()) == "draft"
