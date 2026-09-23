"""Vòng lặp worker: drain hàng đợi, dừng theo tín hiệu, heartbeat, và từ chối cấu hình sai."""

import asyncio
import contextlib
import time
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
    reviews,
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


def _use_concurrency(monkeypatch, value: int) -> None:
    """Mở song song cho một test. `ai_env` đã ghim 1 nên phải ghi đè rồi xoá cache settings."""
    monkeypatch.setenv("AI_REVIEW_CONCURRENCY", str(value))
    get_settings.cache_clear()


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


async def test_four_jobs_call_the_provider_at_the_same_time(mock_db, ai_env, monkeypatch):
    """Bốn lượt gọi provider phải chồng lấn thật, không phải bốn job xếp hàng rồi lần lượt chạy.

    Cửa ải chỉ mở khi cả bốn job cùng nằm trong transport: một vòng lặp tuần tự sẽ không bao giờ
    chạm tới `peak = 4`, nên đây là bằng chứng song song chứ không phải suy đoán từ thời gian chạy.
    """
    _use_concurrency(monkeypatch, 4)
    submissions = [
        await seed(mock_db, account_id=ObjectId(), content_hash=str(ObjectId()))
        for _ in range(4)
    ]

    clean = handler(CLEAR_OUTPUT)
    together = asyncio.Event()
    in_flight = 0
    peak = 0

    async def respond(request):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        if in_flight == len(submissions):
            together.set()
        # Hết thời gian chờ thì thôi chứ không treo test: peak sẽ nói đúng điều cần biết.
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(together.wait(), timeout=1)
        in_flight -= 1
        return clean(request)

    assert await serve(mock_db, respond=respond, once=True) == 4

    assert peak == 4
    # Song song không được đổi cách settle: đúng một lượt audit cho mỗi submission, không job mồ côi.
    stored = await reviews(mock_db)
    assert {review["submission_id"]: review["verdict"] for review in stored} == {
        submission["_id"]: constants.VERDICT_CLEAR for submission in submissions
    }
    assert {review["source"] for review in stored} == {constants.SOURCE_PROVIDER}
    jobs = [job async for job in mock_db[queue.JOBS_COLLECTION].find({})]
    assert {job["status"] for job in jobs} == {constants.JOB_COMPLETED}
    assert {job["claimed_by"] for job in jobs} == {jobs[0]["claimed_by"]}


async def test_one_exploding_job_does_not_take_down_its_siblings(mock_db, ai_env, monkeypatch):
    """Bốn job dùng chung một event loop: cú nổ phải ở lại trong task của chính nó."""
    _use_concurrency(monkeypatch, 4)
    submissions = [
        await seed(mock_db, account_id=ObjectId(), content_hash=str(ObjectId()))
        for _ in range(4)
    ]
    doomed = submissions[0]["_id"]
    process_job = service.process_job

    async def exploding(db, job, **kwargs):
        if job["submission_id"] == doomed:
            raise RuntimeError("nổ ngoài dự kiến")
        return await process_job(db, job, **kwargs)

    monkeypatch.setattr(service, "process_job", exploding)

    assert await serve(mock_db, max_jobs=4) == 4

    stored = await reviews(mock_db)
    assert {review["submission_id"]: review["verdict"] for review in stored} == {
        submission["_id"]: constants.VERDICT_CLEAR for submission in submissions[1:]
    }
    # Job nổ không settle: nó giữ nguyên lease để `recover_expired` thu hồi ở nhịp sau.
    orphan = await mock_db[queue.JOBS_COLLECTION].find_one({"submission_id": doomed})
    assert orphan["status"] == constants.JOB_RUNNING


async def test_a_burst_of_claims_never_overshoots_max_jobs(mock_db, ai_env, monkeypatch):
    """Lấp bốn slot một mạch không được tiêu quá ngân sách job của cả vòng lặp."""
    _use_concurrency(monkeypatch, 4)
    for _ in range(6):
        await seed(mock_db, account_id=ObjectId(), content_hash=str(ObjectId()))

    assert await serve(mock_db, max_jobs=2) == 2

    assert await mock_db[service.REVIEWS_COLLECTION].count_documents({}) == 2
    assert await mock_db[queue.JOBS_COLLECTION].count_documents(
        {"status": constants.JOB_QUEUED}
    ) == 4


async def test_a_stop_lets_the_jobs_already_in_flight_finish(mock_db, ai_env, monkeypatch):
    """Dừng ở ranh giới job: bốn slot đang bận thì chạy cho xong, nhưng không claim thêm."""
    _use_concurrency(monkeypatch, 4)
    for _ in range(5):
        await seed(mock_db, account_id=ObjectId(), content_hash=str(ObjectId()))

    stop = _stop()
    clean = handler(CLEAR_OUTPUT)
    together = asyncio.Event()
    calls = 0

    async def respond(request):
        nonlocal calls
        calls += 1
        if calls == 4:
            together.set()
        # Chỉ ra tay khi cả bốn job đã nằm trong transport, tức là cả bốn đã được claim.
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(together.wait(), timeout=1)
        stop.requested = True
        return clean(request)

    assert await serve(mock_db, stop=stop, respond=respond) == 4

    assert await mock_db[service.REVIEWS_COLLECTION].count_documents({}) == 4
    left = await mock_db[queue.JOBS_COLLECTION].find_one({"status": constants.JOB_QUEUED})
    assert left is not None and left["claimed_by"] is None


async def test_the_loop_keeps_touching_the_heartbeat_while_all_slots_are_busy(
    mock_db, ai_env, heartbeat_file, monkeypatch
):
    """Chờ bốn job là chờ có trần: nhịp tim vẫn phải chảy trong lúc provider còn đang trả lời."""
    _use_concurrency(monkeypatch, 4)
    monkeypatch.setattr(get_settings(), "ai_review_request_timeout_seconds", 0.05)
    for _ in range(4):
        await seed(mock_db, account_id=ObjectId(), content_hash=str(ObjectId()))

    touched: list[float] = []
    real_touch = worker._touch

    def spy(path):
        touched.append(time.monotonic())
        real_touch(path)

    monkeypatch.setattr(worker, "_touch", spy)

    clean = handler(CLEAR_OUTPUT)
    started: list[float] = []
    finished: list[float] = []

    async def respond(request):
        started.append(time.monotonic())
        await asyncio.sleep(0.3)
        finished.append(time.monotonic())
        return clean(request)

    assert await serve(mock_db, respond=respond, once=True) == 4

    assert heartbeat_file.exists()
    # Có ít nhất một nhịp rơi vào lúc cả bốn job còn đang gọi provider: vòng lặp không đứng im chờ
    # trọn một lượt gọi, nên healthcheck của container không bị coi là chết.
    assert [t for t in touched if started[0] < t < finished[-1]]


def test_main_refuses_a_heartbeat_that_is_longer_than_the_lease(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "ai_review_heartbeat_seconds", 600)
    monkeypatch.setattr(settings, "ai_review_lease_seconds", 180)
    assert worker.main(["--once"]) == 2


@pytest.mark.parametrize("value", [0, 17])
def test_main_refuses_a_concurrency_outside_the_supported_range(monkeypatch, value):
    """Sai cấu hình phải thoát ngay: 0 treo worker, còn quá lớn thì vượt xa thứ VM hai vCPU chở được."""
    monkeypatch.setattr(get_settings(), "ai_review_concurrency", value)
    assert worker.main(["--once"]) == 2


def test_four_workers_pass_the_config_gate(monkeypatch):
    monkeypatch.setattr(get_settings(), "ai_review_concurrency", 4)
    assert get_settings().ai_review_worker_config_valid


def test_parse_args_accepts_once_and_max_jobs():
    args = worker._parse_args(["--once", "--max-jobs", "5"])
    assert args.once is True and args.max_jobs == 5
    args = worker._parse_args([])
    assert args.once is False and args.max_jobs is None
