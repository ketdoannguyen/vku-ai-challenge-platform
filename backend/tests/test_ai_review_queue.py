"""Hàng đợi job trên Mongo: enqueue idempotent, claim nguyên tử, fencing token, backoff, thu hồi lease.

Mongo standalone không có transaction, nên đây là nơi kiểm chứng thứ thay thế cho transaction:
unique index, `find_one_and_update` khi claim, và lease token có mặt trong mọi filter ghi.
"""

from datetime import datetime, timedelta

import pytest
from bson import ObjectId

from app.ai_review import constants, queue

# Naive UTC đúng bằng thứ pymongo trả về sau một vòng ghi/đọc (`tz_aware=False` là mặc định),
# nên so sánh ở đây phản ánh đúng giá trị worker nhìn thấy trong production.
NOW = datetime(2026, 9, 21, 12, 0)
LEASE = 180


def _submission(*, generation=1, run_id="run-1", state=None):
    return {
        "_id": ObjectId(),
        "competition_id": ObjectId(),
        "account_id": ObjectId(),
        "ai_review": {
            "state": state or constants.AI_STATE_QUEUED,
            "generation": generation,
            "run_id": run_id,
        },
    }


async def _jobs(db):
    return [job async for job in db[queue.JOBS_COLLECTION].find({})]


async def _enqueue(db, submission, **overrides):
    options = {"source": constants.JOB_SOURCE_AUTO, "now": NOW}
    options.update(overrides)
    await queue.ensure_job(db, submission, **options)


async def _claim(db, *, worker_id="w1", now=NOW):
    return await queue.claim_next(db, worker_id=worker_id, now=now, lease_seconds=LEASE)


async def test_ensure_indexes_makes_submission_id_unique(mock_db):
    await queue.ensure_indexes(mock_db)
    indexes = await mock_db[queue.JOBS_COLLECTION].index_information()
    unique = {tuple(spec["key"]) for spec in indexes.values() if spec.get("unique")}
    assert (("submission_id", 1),) in unique


async def test_enqueue_creates_one_queued_job_for_the_desired_state(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)

    jobs = await _jobs(mock_db)
    assert len(jobs) == 1
    job = jobs[0]
    assert job["submission_id"] == submission["_id"]
    assert job["competition_id"] == submission["competition_id"]
    assert job["account_id"] == submission["account_id"]
    assert job["status"] == constants.JOB_QUEUED
    assert job["generation"] == 1
    assert job["run_id"] == "run-1"
    assert job["attempts"] == 0
    assert job["run_after"] == NOW
    assert job["lease_token"] is None
    assert job["projection_applied"] is False


async def test_enqueue_is_idempotent_and_does_not_disturb_an_existing_job(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    await _enqueue(mock_db, submission)

    jobs = await _jobs(mock_db)
    assert len(jobs) == 1
    assert jobs[0]["attempts"] == 0


async def test_enqueue_refuses_a_submission_with_no_desired_state(mock_db):
    submission = _submission(generation=None, run_id=None)
    with pytest.raises(ValueError):
        await _enqueue(mock_db, submission)
    assert await _jobs(mock_db) == []


async def test_a_new_generation_resets_the_existing_job_in_place(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    claimed = await _claim(mock_db)
    assert await queue.heartbeat(mock_db, claimed, now=NOW, lease_seconds=LEASE) is True

    submission["ai_review"] = {"generation": 2, "run_id": "run-2"}
    await _enqueue(mock_db, submission, source=constants.JOB_SOURCE_MANUAL, bypass_cache=True)

    jobs = await _jobs(mock_db)
    assert len(jobs) == 1
    job = jobs[0]
    assert job["generation"] == 2
    assert job["run_id"] == "run-2"
    assert job["status"] == constants.JOB_QUEUED
    assert job["attempts"] == 0
    assert job["lease_token"] is None
    assert job["bypass_cache"] is True
    assert job["source"] == constants.JOB_SOURCE_MANUAL


async def test_claim_returns_none_on_an_empty_queue(mock_db):
    assert await _claim(mock_db) is None


async def test_claim_marks_running_issues_a_lease_and_counts_the_attempt(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)

    job = await _claim(mock_db)
    assert job["status"] == constants.JOB_RUNNING
    assert job["claimed_by"] == "w1"
    assert job["attempts"] == 1
    assert len(job["lease_token"]) == 32
    assert job["lease_expires_at"] == NOW + timedelta(seconds=LEASE)
    # Đã RUNNING thì worker thứ hai không thấy nó nữa.
    assert await _claim(mock_db, worker_id="w2") is None


async def test_claim_skips_jobs_whose_backoff_has_not_elapsed(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    await mock_db[queue.JOBS_COLLECTION].update_one(
        {"submission_id": submission["_id"]}, {"$set": {"run_after": NOW + timedelta(seconds=60)}}
    )
    assert await _claim(mock_db) is None
    assert (await _claim(mock_db, now=NOW + timedelta(seconds=61)))["status"] == (
        constants.JOB_RUNNING
    )


async def test_claim_takes_the_oldest_due_job_first(mock_db):
    first = _submission()
    second = _submission()
    await _enqueue(mock_db, first, now=NOW - timedelta(seconds=10))
    await _enqueue(mock_db, second, now=NOW)

    job = await _claim(mock_db)
    assert job["submission_id"] == first["_id"]


async def test_heartbeat_extends_the_lease_only_for_the_lease_holder(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    job = await _claim(mock_db)

    later = NOW + timedelta(seconds=30)
    assert await queue.heartbeat(mock_db, job, now=later, lease_seconds=LEASE) is True
    stored = (await _jobs(mock_db))[0]
    assert stored["lease_expires_at"] == later + timedelta(seconds=LEASE)

    stale = {**job, "lease_token": "0" * 32}
    assert await queue.heartbeat(mock_db, stale, now=later, lease_seconds=LEASE) is False


async def test_a_stale_worker_cannot_finish_a_job_it_no_longer_owns(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    job = await _claim(mock_db)
    stale = {**job, "lease_token": "0" * 32}

    assert await queue.mark_completed(mock_db, stale, review_id=ObjectId(), now=NOW) is False
    assert await queue.mark_failed(
        mock_db, stale, now=NOW, error={"code": "X", "message": "x", "occurred_at": NOW}
    ) is False
    assert (await _jobs(mock_db))[0]["status"] == constants.JOB_RUNNING


async def test_the_lease_holder_can_finish_the_job_and_record_the_review(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    job = await _claim(mock_db)
    review_id = ObjectId()

    assert await queue.mark_completed(mock_db, job, review_id=review_id, now=NOW) is True
    stored = (await _jobs(mock_db))[0]
    assert stored["status"] == constants.JOB_COMPLETED
    assert stored["latest_review_id"] == review_id
    assert stored["projection_applied"] is True
    assert stored["lease_token"] is None
    assert stored["completed_at"] == NOW


async def test_a_generation_change_invalidates_the_fence(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    job = await _claim(mock_db)

    submission["ai_review"] = {"generation": 2, "run_id": "run-2"}
    await _enqueue(mock_db, submission)

    # Worker cũ vẫn giữ dict của generation 1: mọi ghi của nó phải bị từ chối.
    assert await queue.mark_completed(mock_db, job, review_id=ObjectId(), now=NOW) is False
    assert (await _jobs(mock_db))[0]["generation"] == 2


async def test_requeue_clears_the_lease_and_schedules_a_future_attempt(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    job = await _claim(mock_db)
    error = {"code": constants.AI_CONNECTION_FAILED, "message": "hỏng", "occurred_at": NOW}

    assert await queue.requeue(mock_db, job, now=NOW, error=error) is True
    stored = (await _jobs(mock_db))[0]
    assert stored["status"] == constants.JOB_QUEUED
    assert stored["lease_token"] is None
    assert stored["claimed_by"] is None
    assert stored["last_error"] == error
    assert NOW + timedelta(seconds=15) <= stored["run_after"] <= NOW + timedelta(seconds=30)
    # `attempts` đã tăng lúc claim nên lần thử sau không quay lại từ đầu.
    assert stored["attempts"] == 1


async def test_expired_jobs_lists_only_running_jobs_past_their_lease(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    job = await _claim(mock_db)

    assert await queue.expired_jobs(mock_db, now=NOW + timedelta(seconds=1)) == []
    expired = await queue.expired_jobs(mock_db, now=NOW + timedelta(seconds=LEASE + 1))
    assert [item["_id"] for item in expired] == [job["_id"]]


async def test_expired_jobs_ignores_queued_jobs(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    assert await queue.expired_jobs(mock_db, now=NOW + timedelta(days=1)) == []


async def test_force_complete_finishes_a_queued_job_that_already_has_a_result(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    job = (await _jobs(mock_db))[0]
    review_id = ObjectId()

    assert await queue.force_complete(mock_db, job, review_id=review_id, now=NOW) is True
    stored = (await _jobs(mock_db))[0]
    assert stored["status"] == constants.JOB_COMPLETED
    assert stored["latest_review_id"] == review_id


async def test_force_complete_refuses_to_touch_a_running_job(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    job = await _claim(mock_db)

    # Job RUNNING nghĩa là còn worker đang chạy: ghi đè lên nó là phá chính thứ lease bảo vệ.
    assert await queue.force_complete(mock_db, job, review_id=ObjectId(), now=NOW) is False
    assert (await _jobs(mock_db))[0]["status"] == constants.JOB_RUNNING


async def test_force_complete_refuses_a_job_from_another_generation(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    job = (await _jobs(mock_db))[0]
    submission["ai_review"] = {"generation": 2, "run_id": "run-2"}
    await _enqueue(mock_db, submission)

    assert await queue.force_complete(mock_db, job, review_id=ObjectId(), now=NOW) is False


async def test_enqueue_upgrades_bypass_cache_when_the_generation_already_matches(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    # Lượt chạy tay phải luôn bỏ cache, kể cả khi reconciler đã kịp tạo job cho generation đó.
    await _enqueue(
        mock_db, submission, source=constants.JOB_SOURCE_MANUAL, bypass_cache=True
    )

    job = (await _jobs(mock_db))[0]
    assert job["bypass_cache"] is True
    assert job["source"] == constants.JOB_SOURCE_MANUAL
    assert job["attempts"] == 0


async def test_a_stale_reset_cannot_overwrite_a_newer_generation(mock_db):
    submission = _submission()
    await _enqueue(mock_db, submission)
    stale = (await _jobs(mock_db))[0]

    moved = _submission(generation=2, run_id="run-2")
    assert await queue.reset_job(
        mock_db, stale, moved, source=constants.JOB_SOURCE_AUTO, now=NOW
    )
    # Cùng bản đọc cũ: generation trong filter không còn khớp, nên lượt ghi này phải thua.
    assert not await queue.reset_job(
        mock_db, stale, moved, source=constants.JOB_SOURCE_AUTO, now=NOW
    )
    job = (await _jobs(mock_db))[0]
    assert job["generation"] == 2
    assert job["run_id"] == "run-2"


@pytest.mark.parametrize("attempt", [1, 2, 3, 4, 5, 6, 20])
def test_backoff_grows_then_plateaus(attempt):
    assert 15 <= queue.backoff_ceiling(attempt) <= queue.BACKOFF_MAX_SECONDS


def test_next_run_after_uses_the_lower_half_of_the_ceiling_as_a_floor():
    for attempt in range(1, 8):
        delay = (queue.next_run_after(attempt, NOW) - NOW).total_seconds()
        ceiling = queue.backoff_ceiling(attempt)
        assert ceiling / 2 <= delay <= ceiling
