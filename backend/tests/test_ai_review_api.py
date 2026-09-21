"""Hợp đồng HTTP của AI review: submit path, projection participant/admin, filter, chi tiết, chạy lại.

Nguyên tắc xuyên suốt: tính năng AI không bao giờ được đổi hành vi của đường nộp bài. Mọi test ở
đây đều hỏi cùng một câu - khi AI tắt, hỏng, hay chưa từng được cấu hình thì bài nộp có còn nguyên
kết quả chấm điểm, quota và quyết định của BTC hay không.
"""

import asyncio
from datetime import datetime, timezone

import httpx
import pytest
from bson import ObjectId

from app.ai_review import constants, queue, service
from app.content.service import CONTENTS_COLLECTION
from app.core.config import get_settings
from app.submissions.service import SUBMISSIONS_COLLECTION
from tests.ai_review_helpers import (  # noqa: F401 - fixture tái xuất cho pytest
    CLEAR_OUTPUT,
    ai_env,
    ai_indexes,
    handler,
    public_dns,
)
from tests.helpers import (
    SUBMISSION_GROUND_TRUTH,
    login,
    login_participant,
    ready_competition,
    submit,
)

HOST = "api.example.com"
BASE_URL = f"https://{HOST}/v1"
API_KEY = "sk-live-do-not-leak-me"
MODEL = "gpt-oss-120b"
RULE_MARKDOWN = "# Thể lệ\n\nKhông được dùng dữ liệu ngoài cuộc thi.\n"
PREDICTION_CSV = b"id,prediction\n1,1\n2,0\n3,1\n4,0\n"


# --- Thao tác trên dữ liệu thật của app (TestClient chạy trong thread riêng) -------------------


def _db(client):
    return client.app.state.mongo.db


def documents(client, collection: str, query: dict | None = None) -> list[dict]:
    async def load():
        return [doc async for doc in _db(client)[collection].find(query or {})]

    return asyncio.run(load())


def document(client, collection: str, query: dict) -> dict | None:
    return asyncio.run(_db(client)[collection].find_one(query))


def run_worker(client, respond=None) -> str:
    """Chạy đúng một job đang chờ qua provider giả, trong event loop riêng của test đồng bộ."""
    db = _db(client)
    respond = respond or handler(CLEAR_OUTPUT)

    async def go():
        job = await queue.claim_next(
            db, worker_id="test-worker", now=datetime.now(timezone.utc), lease_seconds=60
        )
        assert job is not None, "không có job nào đang chờ"
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            return await service.process_job(db, job, client=http, settings=get_settings())

    return asyncio.run(go())


# --- Dựng cuộc thi có AI ----------------------------------------------------------------------


def _add_rules(client, competition_id: str) -> None:
    """Thêm page Markdown - không có nó thì snapshot policy thất bại vì cuộc thi rỗng."""
    login(client)
    created = client.post(
        f"/api/admin/competitions/{competition_id}/contents",
        json={"title": "Thể lệ", "slug": "rules", "visibility": "public"},
    )
    assert created.status_code == 201, created.text
    uploaded = client.put(
        f"/api/admin/competitions/{competition_id}/contents/{created.json()['id']}/file",
        files={"file": ("rules.md", RULE_MARKDOWN.encode(), "text/markdown")},
    )
    assert uploaded.status_code == 200, uploaded.text


def enable_ai(
    client,
    competition_id: str,
    *,
    enabled: bool = True,
    auto_review: bool = True,
    participant_visible: bool = True,
    base_url: str = BASE_URL,
):
    login(client)
    return client.put(
        f"/api/admin/competitions/{competition_id}/ai-review",
        json={
            "enabled": enabled,
            "auto_review": auto_review,
            "participant_visible": participant_visible,
            "base_url": base_url,
            "model": MODEL,
            "api_key": API_KEY,
            "acknowledge_transfer": True,
        },
    )


@pytest.fixture()
def competition(ai_env, client):
    """Cuộc thi đã publish, có thể lệ Markdown, participant đã join, AI chưa bật."""
    created = ready_competition(client, slug="ai-cup", ground_truth=SUBMISSION_GROUND_TRUTH)
    _add_rules(client, created["id"])
    return created


def submit_as_participant(client, competition_id: str, **kwargs):
    login_participant(client)
    return submit(client, competition_id, PREDICTION_CSV, **kwargs)


# --- Submit path ------------------------------------------------------------------------------


def test_ai_off_keeps_the_submission_response_and_document_unchanged(client, competition):
    response = submit_as_participant(client, competition["id"])

    assert response.status_code == 201, response.text
    assert "ai_review" not in response.json()
    stored = document(client, SUBMISSIONS_COLLECTION, {})
    assert "ai_review" not in stored and "content_snapshot" not in stored
    assert documents(client, queue.JOBS_COLLECTION) == []


def test_auto_review_off_captures_the_policy_without_queueing_anything(client, competition):
    assert enable_ai(client, competition["id"], auto_review=False).status_code == 200

    response = submit_as_participant(client, competition["id"])

    assert response.status_code == 201, response.text
    stored = document(client, SUBMISSIONS_COLLECTION, {})
    assert stored["content_snapshot"]["state"] == constants.SNAPSHOT_CAPTURED
    assert stored["content_snapshot"]["revision_id"] is not None
    assert "ai_review" not in stored
    assert documents(client, queue.JOBS_COLLECTION) == []


def test_auto_review_on_queues_a_job_and_exposes_a_pending_projection(client, competition):
    assert enable_ai(client, competition["id"]).status_code == 200

    response = submit_as_participant(client, competition["id"])

    assert response.status_code == 201, response.text
    assert response.json()["ai_review"]["state"] == constants.AI_STATE_QUEUED
    assert response.json()["ai_review"]["verdict"] is None
    jobs = documents(client, queue.JOBS_COLLECTION)
    assert len(jobs) == 1 and jobs[0]["status"] == constants.JOB_QUEUED
    assert jobs[0]["source"] == constants.JOB_SOURCE_AUTO


def test_the_notebook_hash_is_recorded_at_submit_time(client, competition):
    assert enable_ai(client, competition["id"], auto_review=False).status_code == 200

    submit_as_participant(client, competition["id"])

    stored = document(client, SUBMISSIONS_COLLECTION, {})
    assert stored["artifacts"]["notebook"]["sha256"]


def test_a_snapshot_failure_still_returns_201_with_an_error_projection(client, competition):
    """Nội dung rỗng là lỗi chụp snapshot, không phải lỗi nộp bài."""
    login(client)
    for content in documents(client, CONTENTS_COLLECTION):
        client.delete(
            f"/api/admin/competitions/{competition['id']}/contents/{content['_id']}"
        )
    assert enable_ai(client, competition["id"]).status_code == 200

    response = submit_as_participant(client, competition["id"])

    assert response.status_code == 201, response.text
    assert response.json()["primary_score"] is not None
    stored = document(client, SUBMISSIONS_COLLECTION, {})
    assert stored["content_snapshot"]["state"] == constants.SNAPSHOT_ERROR
    assert stored["content_snapshot"]["error_code"] == constants.SNAPSHOT_CONTENT_EMPTY
    assert stored["ai_review"]["state"] == constants.AI_STATE_ERROR
    # Không có policy để đối chiếu thì cũng không có gì để gọi provider.
    assert documents(client, queue.JOBS_COLLECTION) == []


def test_a_missing_job_is_repaired_by_reconcile_instead_of_breaking_the_submission(
    client, competition
):
    assert enable_ai(client, competition["id"]).status_code == 200
    submit_as_participant(client, competition["id"])
    db = _db(client)

    async def clear():
        await db[queue.JOBS_COLLECTION].delete_many({})
        return await service.reconcile(
            db, settings=get_settings(), now=datetime.now(timezone.utc), limit=100
        )

    stats = asyncio.run(clear())

    assert stats["enqueued"] == 1
    assert len(documents(client, queue.JOBS_COLLECTION)) == 1


# --- Projection cho participant ---------------------------------------------------------------


def test_the_participant_sees_a_safe_verdict_and_never_a_technical_code(client, competition):
    assert enable_ai(client, competition["id"]).status_code == 200
    submitted = submit_as_participant(client, competition["id"]).json()
    run_worker(client)

    per_submission = submit_as_participant(client, competition["id"])
    listed = client.get(f"/api/competitions/{competition['id']}/submissions/me").json()
    by_id = {item["id"]: item for item in listed["submissions"]}

    assert per_submission.status_code == 201
    done = by_id[submitted["id"]]["ai_review"]
    assert done["state"] == constants.AI_STATE_COMPLETED
    assert done["verdict"] == constants.VERDICT_CLEAR
    # Bài vừa nộp chưa có kết luận: thí sinh thấy trạng thái đang chờ, không thấy gì khác.
    fresh = by_id[per_submission.json()["id"]]["ai_review"]
    assert fresh["state"] == constants.AI_STATE_QUEUED and fresh["verdict"] is None
    serialized = str(listed)
    assert API_KEY not in serialized and HOST not in serialized
    assert "cache_key" not in serialized and "prompt_version" not in serialized


def test_a_participant_error_projection_never_leaks_the_error_code(client, competition):
    assert enable_ai(client, competition["id"]).status_code == 200
    submit_as_participant(client, competition["id"])
    db = _db(client)

    async def abort():
        await db[SUBMISSIONS_COLLECTION].update_one(
            {},
            {"$set": {"ai_review.state": constants.AI_STATE_ERROR,
                      "ai_review.verdict": constants.VERDICT_ERROR,
                      "ai_review.summary": constants.PARTICIPANT_ERROR_SUMMARY}},
        )

    asyncio.run(abort())
    listed = client.get(f"/api/competitions/{competition['id']}/submissions/me").json()

    projection = listed["submissions"][0]["ai_review"]
    assert projection["state"] == constants.AI_STATE_ERROR
    assert projection["summary"] == constants.PARTICIPANT_ERROR_SUMMARY
    # Thí sinh không nhận verdict, mã lỗi, hay tên provider - chỉ biết là chưa có kết luận.
    assert projection["verdict"] is None
    assert set(projection) == {"state", "verdict", "summary", "updated_at"}


def test_turning_participant_visibility_off_hides_the_projection_from_the_response(
    client, competition
):
    assert enable_ai(client, competition["id"], participant_visible=False).status_code == 200

    response = submit_as_participant(client, competition["id"])

    assert response.status_code == 201
    assert "ai_review" not in response.json()
    assert "ai_review" not in (
        client.get(f"/api/competitions/{competition['id']}/submissions/me").json()["submissions"][0]
    )


# --- Bảng admin -------------------------------------------------------------------------------


def _admin_list(client, competition_id: str, **params) -> dict:
    login(client)
    response = client.get(
        f"/api/admin/competitions/{competition_id}/submissions", params=params
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_admin_list_carries_the_compact_projection(client, competition):
    assert enable_ai(client, competition["id"]).status_code == 200
    submit_as_participant(client, competition["id"])
    run_worker(client)

    item = _admin_list(client, competition["id"])["submissions"][0]

    assert item["ai_review"]["state"] == constants.AI_STATE_COMPLETED
    assert item["ai_review"]["verdict"] == constants.VERDICT_CLEAR
    assert item["ai_review"]["run_id"]


def test_every_ai_filter_value_is_independent_from_scoring_and_human_review(client, competition):
    assert enable_ai(client, competition["id"]).status_code == 200
    flagged = submit_as_participant(client, competition["id"])
    assert flagged.status_code == 201
    run_worker(
        client,
        handler(
            {
                "verdict": "FLAGGED",
                "summary": "Có dấu hiệu.",
                "findings": [
                    {
                        "source_content_title": "Thể lệ",
                        "source_content_slug": "rules",
                        "rule_text": "Không được dùng dữ liệu ngoài cuộc thi.",
                        "checkability": constants.CHECKABLE,
                        "status": constants.FINDING_VIOLATION,
                        "reason": "vì sao",
                        "evidence": [
                            {"cell": 1, "start_line": 1, "end_line": 1, "snippet": "import pandas"}
                        ],
                    }
                ],
            }
        ),
    )
    login_participant(client)
    submit(client, competition["id"], PREDICTION_CSV)

    assert len(_admin_list(client, competition["id"], ai_review="flagged")["submissions"]) == 1
    assert _admin_list(client, competition["id"], ai_review="clear")["submissions"] == []
    assert len(_admin_list(client, competition["id"], ai_review="pending")["submissions"]) == 1
    assert len(_admin_list(client, competition["id"], ai_review="all")["submissions"]) == 2
    # Trục AI không được kéo theo trục chấm điểm hay trục duyệt của BTC.
    assert len(_admin_list(client, competition["id"], status="completed")["submissions"]) == 2
    assert len(_admin_list(client, competition["id"], review="accepted")["submissions"]) == 2


def test_a_legacy_submission_is_the_only_thing_under_none(client, competition):
    assert enable_ai(client, competition["id"]).status_code == 200
    submit_as_participant(client, competition["id"])
    db = _db(client)

    async def forget():
        await db[SUBMISSIONS_COLLECTION].update_one(
            {}, {"$unset": {"ai_review": "", "content_snapshot": ""}}
        )

    asyncio.run(forget())

    assert len(_admin_list(client, competition["id"], ai_review="none")["submissions"]) == 1
    assert _admin_list(client, competition["id"], ai_review="pending")["submissions"] == []


def test_an_unknown_ai_filter_is_rejected(client, competition):
    login(client)
    response = client.get(
        f"/api/admin/competitions/{competition['id']}/submissions", params={"ai_review": "yes"}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


# --- Chi tiết và chạy lại ---------------------------------------------------------------------


def _detail(client, submission_id: str) -> dict:
    login(client)
    response = client.get(f"/api/admin/submissions/{submission_id}/ai-review")
    assert response.status_code == 200, response.text
    return response.json()


def test_the_detail_shows_the_history_without_raw_payload_or_object_key(client, competition):
    assert enable_ai(client, competition["id"]).status_code == 200
    submitted = submit_as_participant(client, competition["id"]).json()
    run_worker(client)

    detail = _detail(client, submitted["id"])

    assert detail["ai_review"]["verdict"] == constants.VERDICT_CLEAR
    assert len(detail["history"]) == 1
    assert detail["history"][0]["provider_host"] == HOST
    assert detail["history"][0]["source"] == constants.SOURCE_PROVIDER
    assert detail["content_snapshot"]["state"] == constants.SNAPSHOT_CAPTURED
    serialized = str(detail)
    for forbidden in ("object_key", API_KEY, "sk-live", "messages", "api_key_ciphertext"):
        assert forbidden not in serialized


def test_rerun_requires_a_captured_snapshot(client, competition):
    assert enable_ai(client, competition["id"], auto_review=False).status_code == 200
    submitted = submit_as_participant(client, competition["id"]).json()
    db = _db(client)

    async def break_snapshot():
        await db[SUBMISSIONS_COLLECTION].update_one(
            {}, {"$set": {"content_snapshot.state": constants.SNAPSHOT_ERROR}}
        )

    asyncio.run(break_snapshot())
    login(client)
    response = client.post(f"/api/admin/submissions/{submitted['id']}/ai-review/rerun")

    assert response.status_code == 422
    assert response.json()["error"]["code"] == constants.AI_CONTENT_SNAPSHOT_UNAVAILABLE


def test_rerun_starts_a_manual_generation_that_bypasses_the_cache(client, competition):
    assert enable_ai(client, competition["id"], auto_review=False).status_code == 200
    submitted = submit_as_participant(client, competition["id"]).json()
    revision_before = document(client, SUBMISSIONS_COLLECTION, {})["content_snapshot"][
        "revision_id"
    ]

    login(client)
    started = client.post(f"/api/admin/submissions/{submitted['id']}/ai-review/rerun")

    assert started.status_code == 200, started.text
    projection = document(client, SUBMISSIONS_COLLECTION, {})["ai_review"]
    assert projection["state"] == constants.AI_STATE_QUEUED
    assert projection["generation"] == 1
    job = documents(client, queue.JOBS_COLLECTION)[0]
    assert job["source"] == constants.JOB_SOURCE_MANUAL
    assert job["bypass_cache"] is True
    assert job["requested_by"] is not None

    run_worker(client)

    # Lượt chạy dùng đúng revision đã chốt lúc nộp, không chụp lại nội dung hiện tại.
    review = documents(client, service.REVIEWS_COLLECTION)[0]
    assert review["content_revision_id"] == revision_before
    assert review["manual"] is True
    assert review["bypass_cache"] is True


def test_rerun_advances_the_generation_and_keeps_older_audit_rows(client, competition):
    assert enable_ai(client, competition["id"]).status_code == 200
    submitted = submit_as_participant(client, competition["id"]).json()
    run_worker(client)

    login(client)
    assert (
        client.post(f"/api/admin/submissions/{submitted['id']}/ai-review/rerun").status_code == 200
    )
    run_worker(client)

    review = document(client, SUBMISSIONS_COLLECTION, {})["ai_review"]
    assert review["generation"] == 2
    assert len(documents(client, service.REVIEWS_COLLECTION)) == 2


def test_rerun_is_refused_while_a_review_is_still_queued(client, competition):
    assert enable_ai(client, competition["id"]).status_code == 200
    submitted = submit_as_participant(client, competition["id"]).json()

    login(client)
    response = client.post(f"/api/admin/submissions/{submitted['id']}/ai-review/rerun")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == constants.AI_REVIEW_IN_PROGRESS


def test_rerun_is_refused_when_the_competition_turned_ai_off(client, competition):
    assert enable_ai(client, competition["id"], auto_review=False).status_code == 200
    submitted = submit_as_participant(client, competition["id"]).json()
    assert enable_ai(client, competition["id"], enabled=False).status_code == 200

    login(client)
    response = client.post(f"/api/admin/submissions/{submitted['id']}/ai-review/rerun")

    assert response.status_code == 422
    assert response.json()["error"]["code"] == constants.AI_REVIEW_DISABLED


def test_a_malformed_allowlist_is_a_config_error_not_a_500(client, competition, monkeypatch):
    # Allowlist sai định dạng là lỗi cấu hình vận hành: phải trả mã lỗi đọc được, không phải 500.
    monkeypatch.setenv("AI_REVIEW_ALLOWED_PORTS", "khong-phai-so")
    get_settings.cache_clear()

    login(client)
    response = client.get(f"/api/admin/competitions/{competition['id']}/ai-review")

    assert response.status_code == 422
    assert response.json()["error"]["code"] == constants.AI_ENDPOINT_INVALID


def test_ai_endpoints_are_admin_only(client, competition):
    submitted = submit_as_participant(client, competition["id"]).json()

    assert client.get(f"/api/admin/submissions/{submitted['id']}/ai-review").status_code == 403
    assert (
        client.post(f"/api/admin/submissions/{submitted['id']}/ai-review/rerun").status_code == 403
    )


# --- Vòng đời và xóa --------------------------------------------------------------------------


def test_deleting_a_competition_takes_its_jobs_and_audit_rows_with_it(client, competition):
    assert enable_ai(client, competition["id"]).status_code == 200
    submit_as_participant(client, competition["id"])
    run_worker(client)
    assert documents(client, service.REVIEWS_COLLECTION)

    login(client)
    assert client.post(f"/api/admin/competitions/{competition['id']}/close").status_code == 200
    deleted = client.delete(
        f"/api/admin/competitions/{competition['id']}?confirm_slug={competition['slug']}"
    )

    assert deleted.status_code == 200, deleted.text
    assert documents(client, queue.JOBS_COLLECTION) == []
    assert documents(client, service.REVIEWS_COLLECTION) == []


def test_a_competition_without_ai_config_publishes_and_scores_normally(client, ai_env):
    """Thiếu cấu hình AI không được chặn publish, nộp bài hay chấm điểm."""
    created = ready_competition(client, slug="no-ai-cup")
    stored = document(client, SUBMISSIONS_COLLECTION, {}) or {}
    assert ObjectId(created["id"])

    login(client)
    assert client.get(f"/api/admin/competitions/{created['id']}/ai-review").json()["config"] == {
        "enabled": False,
        "auto_review": True,
        "participant_visible": True,
        "provider": constants.PROVIDER_OPENAI_COMPATIBLE,
        "base_url": "",
        "model": "",
        "api_key_configured": False,
        "acknowledged_host": None,
        "updated_at": None,
    }

    response = submit_as_participant(client, created["id"])

    assert response.status_code == 201, response.text
    assert response.json()["primary_score"] is not None
    assert stored == {}
