"""Kết luận AI không bao giờ được chạm vào kết quả thi.

Bốn kết cục của trục AI - CLEAR, FLAGGED, INCONCLUSIVE, ERROR - đều chỉ là thông tin tham khảo. Bài
nộp giữ nguyên điểm, metrics, artifact, quota và tư cách trên bảng xếp hạng; chỉ có một quyết định
của con người (từ chối hậu kiểm, ADR-035) mới loại được một bài. Test ở đây khoá đúng ranh giới đó.
"""

import copy

import httpx
import pytest

from app.ai_review import constants
from app.submissions.service import SUBMISSIONS_COLLECTION, eligible_query
from tests.ai_review_helpers import (  # noqa: F401 - fixture tái xuất cho pytest
    FLAGGED_OUTPUT,
    ai_env,
    ai_indexes,
    handler,
    public_dns,
)
from tests.test_ai_review_api import (
    _add_rules,
    document,
    documents,
    enable_ai,
    run_worker,
    submit_as_participant,
)
from tests.helpers import SUBMISSION_GROUND_TRUTH, login, ready_competition

# Mỗi kết cục: một output model hợp lệ, hoặc một transport hỏng để worker kết thúc ở ERROR.
INCONCLUSIVE_OUTPUT = {"verdict": "INCONCLUSIVE", "summary": "Thiếu căn cứ.", "findings": []}

VERDICT_CASES = {
    "clear": handler({"verdict": "CLEAR", "summary": "Không thấy vi phạm.", "findings": []}),
    "flagged": handler(FLAGGED_OUTPUT),
    "inconclusive": handler(INCONCLUSIVE_OUTPUT),
    # 401 là lỗi terminal (không thử lại), nên worker kết thúc lượt ngay ở ERROR.
    "error": lambda request: httpx.Response(401, json={"error": {"message": "unauthorized"}}),
}

SCORING_FIELDS = ("status", "primary_score", "metrics", "artifacts", "submission_no", "review")


@pytest.fixture()
def scored_submission(ai_env, client):
    """Cuộc thi có thể lệ, AI bật, và đúng một bài đã chấm điểm xong."""
    created = ready_competition(client, slug="iso-cup", ground_truth=SUBMISSION_GROUND_TRUTH)
    _add_rules(client, created["id"])
    assert enable_ai(client, created["id"]).status_code == 200
    submitted = submit_as_participant(client, created["id"])
    assert submitted.status_code == 201, submitted.text
    return created, submitted.json(), document(client, SUBMISSIONS_COLLECTION, {})


def scoring_snapshot(stored: dict) -> dict:
    return {field: copy.deepcopy(stored.get(field)) for field in SCORING_FIELDS}


@pytest.mark.parametrize("case", sorted(VERDICT_CASES))
def test_a_verdict_never_changes_anything_the_scoring_axis_owns(client, scored_submission, case):
    competition, _submitted, before = scored_submission
    quota_used = membership_quota_used(client, competition["id"])

    run_worker(client, VERDICT_CASES[case])

    after = document(client, SUBMISSIONS_COLLECTION, {})
    assert scoring_snapshot(after) == scoring_snapshot(before)
    assert after["ai_review"]["state"] in (
        constants.AI_STATE_COMPLETED,
        constants.AI_STATE_ERROR,
    )
    assert membership_quota_used(client, competition["id"]) == quota_used


def membership_quota_used(client, competition_id: str) -> dict:
    from bson import ObjectId

    from app.memberships.service import MEMBERSHIPS_COLLECTION

    membership = document(
        client, MEMBERSHIPS_COLLECTION, {"competition_id": ObjectId(competition_id)}
    )
    return membership.get("quota_used", {}) if membership else {}


@pytest.mark.parametrize("case", ["flagged", "error"])
def test_an_adverse_verdict_still_counts_for_eligibility_and_the_leaderboard(
    client, scored_submission, case
):
    competition, _submitted, _before = scored_submission
    run_worker(client, VERDICT_CASES[case])

    assert document(client, SUBMISSIONS_COLLECTION, {})["ai_review"]["verdict"] in (
        constants.VERDICT_FLAGGED,
        constants.VERDICT_ERROR,
    )

    login(client)
    leaderboard = client.get(f"/api/competitions/{competition['id']}/leaderboard").json()
    assert [entry["rank"] for entry in leaderboard["entries"]] == [1]
    assert leaderboard["total"] == 1

    admin_list = client.get(f"/api/admin/submissions?competition_id={competition['id']}").json()
    assert admin_list["stats"]["completed"] == 1
    assert len(admin_list["submissions"]) == 1

    admin_leaderboard = client.get(
        f"/api/admin/competitions/{competition['id']}/leaderboard"
    ).json()
    assert admin_leaderboard["total"] == 1

    export = client.get(f"/api/admin/competitions/{competition['id']}/export.xlsx")
    assert export.status_code == 200
    assert len(export.content) > 0


def test_only_a_human_rejection_removes_a_submission_from_the_results(client, scored_submission):
    competition, submitted, _before = scored_submission
    run_worker(client, VERDICT_CASES["flagged"])

    login(client)
    rejected = client.patch(
        f"/api/admin/submissions/{submitted['id']}/review",
        json={"status": "rejected", "note": "Dùng dữ liệu ngoài cuộc thi."},
    )
    assert rejected.status_code == 200, rejected.text
    assert client.get(f"/api/competitions/{competition['id']}/leaderboard").json()["total"] == 0

    restored = client.patch(
        f"/api/admin/submissions/{submitted['id']}/review", json={"status": "accepted"}
    )
    assert restored.status_code == 200, restored.text
    assert client.get(f"/api/competitions/{competition['id']}/leaderboard").json()["total"] == 1
    # Khôi phục không đụng tới kết luận AI đã có.
    assert document(client, SUBMISSIONS_COLLECTION, {})["ai_review"]["verdict"] == (
        constants.VERDICT_FLAGGED
    )


def test_the_worker_never_writes_the_human_review_axis(client, scored_submission):
    _competition, submitted, before = scored_submission
    # Bài chưa từng bị xét duyệt thì không có field `review` nào để mà ghi đè.
    assert "review" not in before
    login(client)

    for case in sorted(VERDICT_CASES):
        run_worker(client, VERDICT_CASES[case])
        assert "review" not in document(client, SUBMISSIONS_COLLECTION, {})
        assert (
            client.post(f"/api/admin/submissions/{submitted['id']}/ai-review/rerun").status_code
            == 200
        )

    # Tư cách tính kết quả chỉ phụ thuộc quyết định của con người - không có điều kiện nào về AI.
    query = eligible_query({"status": "completed"})
    assert query == {"status": "completed", "review.status": {"$ne": "rejected"}}
    assert not any("ai" in key for key in query)


def test_reruns_never_accumulate_eligible_rows(client, scored_submission):
    """Chạy lại AI nhiều lần chỉ thêm audit row, không bao giờ thêm dòng trên bảng xếp hạng."""
    competition, submitted, _before = scored_submission
    login(client)

    for _ in range(3):
        run_worker(client, VERDICT_CASES["clear"])
        assert (
            client.post(f"/api/admin/submissions/{submitted['id']}/ai-review/rerun").status_code
            == 200
        )

    assert client.get(f"/api/competitions/{competition['id']}/leaderboard").json()["total"] == 1
    assert len(documents(client, SUBMISSIONS_COLLECTION)) == 1
