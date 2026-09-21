"""Vòng lặp worker: drain hàng đợi, dừng theo tín hiệu, heartbeat, và từ chối cấu hình sai."""

import asyncio
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from bson import ObjectId

from app.ai_review import constants, queue, service, worker
from app.core.config import get_settings
from tests.ai_review_helpers import (  # noqa: F401 - fixture tái xuất cho pytest
    CLEAR_OUTPUT,
    ai_env,
    ai_indexes,
    handler,
    public_dns,
    seed,
)


@pytest.fixture(autouse=True)
def heartbeat_file(tmp_path, monkeypatch):
    """Mỗi test một file riêng: đây là thứ healthcheck của container dựa vào.

    Đặt qua biến môi trường chứ không vá instance: `ai_env` xoá cache settings ở setup, nên bản
    instance bị vá trước đó sẽ không còn là bản mà worker đọc.
    """
    path = tmp_path / "worker.heartbeat"
    monkeypatch.setenv("AI_REVIEW_HEARTBEAT_FILE", str(path))
    return path


def _stop() -> worker.Stop:
    return worker.Stop()


async def serve(mock_db, *, stop=None, respond=None, once=False, max_jobs=None) -> int:
    """Chạy vòng lặp thật với provider giả; `respond` mặc định là một verdict sạch."""
    stop = stop or _stop()
    respond = respond or handler(CLEAR_OUTPUT)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        return await worker.serve(
            client=client,
            db=mock_db,
            settings=get_settings(),
            stop=stop,
            max_jobs=max_jobs,
            once=once,
        )


async def test_once_drains_the_queue_and_returns(mock_db, ai_env, heartbeat_file):
    submission = await seed(mock_db)

    assert await serve(mock_db, once=True) == 1

    stored = await mock_db[service.REVIEWS_COLLECTION].find_one({})
    assert stored["submission_id"] == submission["_id"]
    assert heartbeat_file.exists()


async def test_once_returns_immediately_when_there_is_nothing_to_do(mock_db, ai_env):
    assert await serve(mock_db, once=True) == 0


async def test_max_jobs_stops_the_loop_early(mock_db, ai_env):
    for _ in range(3):
        await seed(mock_db, account_id=ObjectId(), content_hash=str(ObjectId()))

    assert await serve(mock_db, max_jobs=2) == 2
    assert (await mock_db[service.REVIEWS_COLLECTION].count_documents({})) == 2


async def test_a_requested_stop_ends_the_loop_before_the_next_claim(mock_db, ai_env):
    await seed(mock_db)
    stop = _stop()
    stop.requested = True

    assert await serve(mock_db, stop=stop) == 0
    assert (await mock_db[service.REVIEWS_COLLECTION].count_documents({})) == 0
    assert (await mock_db[queue.JOBS_COLLECTION].find_one({}))["status"] == constants.JOB_QUEUED


async def test_reconcile_runs_before_the_first_claim(mock_db, ai_env):
    """Submission QUEUED mà mất job phải được xử lý ngay trong vòng này, không chờ vòng sau."""
    submission = await seed(mock_db)
    await mock_db[queue.JOBS_COLLECTION].delete_many({})

    assert await serve(mock_db, once=True) == 1
    stored = await mock_db[service.REVIEWS_COLLECTION].find_one({})
    assert stored["submission_id"] == submission["_id"]


async def test_a_terminal_failure_does_not_stop_the_worker(mock_db, ai_env):
    failed = await seed(mock_db, content_hash="broken", notebook=b"khong phai notebook")
    healthy = await seed(mock_db, account_id=ObjectId(), content_hash="fine")

    assert await serve(mock_db, once=True) == 2

    verdicts = {
        review["submission_id"]: review["verdict"]
        async for review in mock_db[service.REVIEWS_COLLECTION].find({})
    }
    assert verdicts[failed["_id"]] == constants.VERDICT_ERROR
    assert verdicts[healthy["_id"]] == constants.VERDICT_CLEAR


async def test_an_infrastructure_error_in_reconcile_does_not_kill_the_loop(mock_db, ai_env, monkeypatch):
    await seed(mock_db)
    real = service.reconcile
    attempts = {"count": 0}

    async def flaky(*args, **kwargs):
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise RuntimeError("Mongo chập chờn")
        return await real(*args, **kwargs)

    monkeypatch.setattr(service, "reconcile", flaky)

    assert await serve(mock_db, once=True) == 1
    assert attempts["count"] == 1


async def test_a_job_that_explodes_leaves_a_lease_for_recover_expired_to_reclaim(
    mock_db, ai_env, monkeypatch
):
    submission = await seed(mock_db)

    async def boom(*args, **kwargs):
        raise RuntimeError("lỗi ngoài dự kiến")

    monkeypatch.setattr(service, "process_job", boom)

    assert await serve(mock_db, max_jobs=1) == 1

    # Job ở lại RUNNING kèm lease: `recover_expired` mới là đường thu hồi, không phải crash tiến trình.
    job = await mock_db[queue.JOBS_COLLECTION].find_one({"submission_id": submission["_id"]})
    assert job["status"] == constants.JOB_RUNNING
    assert job["lease_expires_at"] is not None


async def test_heartbeat_gives_up_once_the_lease_is_gone(mock_db, ai_env, monkeypatch):
    monkeypatch.setattr(get_settings(), "ai_review_heartbeat_seconds", 0.01)
    await seed(mock_db)
    job = await queue.claim_next(
        mock_db, worker_id="w1", now=datetime.now(timezone.utc), lease_seconds=60
    )
    # Worker khác đã giành mất job: nhịp tim phải tự tắt thay vì gia hạn hộ.
    await mock_db[queue.JOBS_COLLECTION].update_one(
        {"_id": job["_id"]}, {"$set": {"lease_token": "f" * 32}}
    )

    await asyncio.wait_for(
        worker._heartbeat(mock_db, job, settings=get_settings(), stop=_stop()), timeout=5
    )


async def test_heartbeat_keeps_extending_the_lease_while_it_is_held(mock_db, ai_env, monkeypatch):
    monkeypatch.setattr(get_settings(), "ai_review_heartbeat_seconds", 0.01)
    await seed(mock_db)
    job = await queue.claim_next(
        mock_db, worker_id="w1", now=datetime.now(timezone.utc), lease_seconds=1
    )
    stop = _stop()
    task = asyncio.create_task(
        worker._heartbeat(mock_db, job, settings=get_settings(), stop=stop)
    )
    await asyncio.sleep(0.1)
    stop.requested = True
    await asyncio.wait_for(task, timeout=5)

    stored = await mock_db[queue.JOBS_COLLECTION].find_one({"_id": job["_id"]})
    assert stored["lease_token"] == job["lease_token"]
    assert stored["status"] == constants.JOB_RUNNING


async def test_sleep_returns_promptly_when_stop_is_requested():
    stop = _stop()

    async def request_soon():
        await asyncio.sleep(0.01)
        stop.requested = True

    asyncio.create_task(request_soon())
    started = asyncio.get_running_loop().time()
    await worker._sleep(30, stop)
    assert asyncio.get_running_loop().time() - started < 5


async def test_the_loop_releases_an_expired_lease_of_a_dead_worker(mock_db, ai_env):
    """Job mồ côi phải về lại hàng đợi trong cùng vòng quét, không kẹt ở RUNNING mãi mãi."""
    past = datetime.now(timezone.utc) - timedelta(seconds=60)
    await seed(mock_db, run_after=past)
    job = await queue.claim_next(mock_db, worker_id="dead-worker", now=past, lease_seconds=1)
    assert job["status"] == constants.JOB_RUNNING

    # Chưa có gì để chạy ngay: job vừa được thả về hàng đợi kèm backoff.
    assert await serve(mock_db, once=True) == 0

    released = await mock_db[queue.JOBS_COLLECTION].find_one({})
    assert released["status"] == constants.JOB_QUEUED
    assert released["claimed_by"] is None
    # Backoff đẩy job ra tương lai; Mongo trả datetime naive UTC nên phải so bằng naive.
    assert released["run_after"] > datetime.now(timezone.utc).replace(tzinfo=None)
    assert (await mock_db[service.REVIEWS_COLLECTION].count_documents({})) == 0


def test_main_refuses_a_heartbeat_that_is_longer_than_the_lease(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "ai_review_heartbeat_seconds", 600)
    monkeypatch.setattr(settings, "ai_review_lease_seconds", 180)
    assert worker.main(["--once"]) == 2


def test_parse_args_accepts_once_and_max_jobs():
    args = worker._parse_args(["--once", "--max-jobs", "5"])
    assert args.once is True and args.max_jobs == 5
    args = worker._parse_args([])
    assert args.once is False and args.max_jobs is None
