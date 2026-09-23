"""Entrypoint worker AI review: `python -m app.ai_review.worker`.

Worker là tiến trình RIÊNG, không phải background task trong API process: một cuộc gọi provider mất
hàng chục giây, và API phải luôn trả lời được kể cả khi LLM hỏng hoàn toàn (quyết định sản phẩm #3).

Vòng lặp có đúng ba nhịp: thu hồi job hết lease, reconcile các khoảng trống, rồi claim và chạy.
Trong lúc chạy một job, một task phụ gửi heartbeat để lease không hết hạn giữa chừng.

Một tiến trình giữ tối đa `AI_REVIEW_CONCURRENCY` job chạy song song (ADR-046): phần lớn thời gian
của một job là chờ provider trả lời, nên bốn job cùng lúc không cần bốn nhân CPU. Queue đã an toàn
cho nhiều runner từ trước - claim là một `find_one_and_update` nguyên tử, và mọi lượt ghi sau đó đều
đi qua fence `lease_token` - nên song song ở đây không mở thêm đường ghi trùng.
"""

import argparse
import asyncio
import contextlib
import logging
import os
import secrets
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from app.ai_review import queue, service
from app.core.config import get_settings
from app.core.database import mongo_lifespan

logger = logging.getLogger(__name__)


class Stop:
    """Cờ dừng do tín hiệu đặt; vòng lặp đọc nó ở ranh giới job, không cắt ngang một job đang chạy."""

    def __init__(self) -> None:
        self.requested = False

    def request(self, signum, _frame) -> None:
        logger.info("Nhận tín hiệu %s; dừng sau job hiện tại.", signum)
        self.requested = True


async def serve(*, client: httpx.AsyncClient, db, settings, stop: Stop,
                max_jobs: int | None = None, once: bool = False) -> int:
    """Vòng lặp chính; trả số job đã xử lý.

    Chạy tối đa `ai_review_concurrency` job cùng lúc. Reconcile vẫn là nhịp DUY NHẤT của tiến trình
    này: nó chỉ chạy ở vòng lặp, không nằm trong task của job, nên chậm bao nhiêu job cũng không
    nhân bản vòng quét lên.
    """
    concurrency = max(1, settings.ai_review_concurrency)
    worker_id = f"{os.uname().nodename}:{os.getpid()}:{secrets.token_hex(4)}"
    logger.info(
        "Worker khởi động id=%s once=%s max_jobs=%s concurrency=%d",
        worker_id,
        once,
        max_jobs,
        concurrency,
    )

    processed = 0
    next_reconcile_at = 0.0
    in_flight: dict[asyncio.Task, str] = {}
    # Job đã chạy xong nhưng chưa được đếm: callback dọn task chạy ở lượt kế tiếp của event loop,
    # nên giữa lúc `gather` trả về và lúc counter nhích lên vẫn còn một khe. Bù ở `_harvest`.
    finished: list[tuple[asyncio.Task, dict]] = []

    def schedule(job: dict) -> None:
        """Đưa một job vừa claim vào tập đang chạy; task tự dọn mình khi xong."""
        task = asyncio.create_task(_run_job(db, job, client=client, settings=settings, stop=stop))
        in_flight[task] = job["_id"]
        task.add_done_callback(lambda t: _finish(t, job, in_flight, finished))

    def harvest() -> int:
        """Đếm mọi job đã xong kể cả khi callback chưa kịp chạy; trả về counter mới."""
        nonlocal processed
        for task, job in finished:
            _report(task, job)
            processed += 1
        finished.clear()
        return processed

    try:
        while not stop.requested:
            if max_jobs is not None and harvest() >= max_jobs:
                break
            _touch(settings.ai_review_heartbeat_file)

            now = datetime.now(timezone.utc)
            if time.monotonic() >= next_reconcile_at:
                next_reconcile_at = (
                    time.monotonic() + settings.ai_review_reconcile_interval_seconds
                )
                try:
                    await service.recover_expired(db, now=now)
                    stats = await service.reconcile(
                        db, settings=settings, now=now, limit=settings.ai_review_reconcile_batch
                    )
                except Exception:
                    logger.exception("Bỏ qua nhịp reconcile do lỗi hạ tầng.")
                else:
                    if any(stats.values()):
                        logger.info("reconcile %s", stats)

            # Lấp đầy slot trước khi chờ: claim bao nhiêu job thì chạy bấy nhiêu. Chỉ claim khi còn
            # slot, nên `max_jobs` không bao giờ bị vượt bởi một loạt claim liền nhau.
            while len(in_flight) < concurrency and not stop.requested:
                if max_jobs is not None and harvest() + len(in_flight) >= max_jobs:
                    break
                # Mọi lỗi hạ tầng (Mongo chập chờn, DNS hỏng) chỉ được làm mất một nhịp, không được
                # giết tiến trình: job đang chạy vẫn còn lease để `recover_expired` thu hồi sau.
                try:
                    job = await queue.claim_next(
                        db,
                        worker_id=worker_id,
                        now=datetime.now(timezone.utc),
                        lease_seconds=settings.ai_review_lease_seconds,
                    )
                except Exception:
                    logger.exception("Không claim được job; thử lại ở nhịp sau.")
                    break
                if job is None:
                    break
                schedule(job)

            if not in_flight:
                if once:
                    break
                await _sleep(settings.ai_review_poll_interval_seconds, stop)
                continue

            # Chờ job kế tiếp xong, nhưng không lâu hơn một lượt gọi provider: `_touch` ở đầu vòng
            # sau là thứ giữ healthcheck sống, nên khoảng chờ không được dài hơn nhịp đó.
            await asyncio.wait(
                set(in_flight),
                timeout=settings.ai_review_request_timeout_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )
    finally:
        # Dừng ở ranh giới job: ngừng claim, nhưng KHÔNG cắt ngang lượt gọi provider đang chạy -
        # hợp đồng này là lý do `stop_grace_period` của container có nghĩa.
        if in_flight:
            await asyncio.gather(*in_flight, return_exceptions=True)

    processed = harvest()
    logger.info("Worker dừng id=%s đã xử lý %d job.", worker_id, processed)
    return processed


def _finish(task: asyncio.Task, job: dict, in_flight: dict, finished: list) -> None:
    """Dọn task đã xong khỏi tập đang chạy; việc đếm và ghi log để `serve.harvest` làm."""
    in_flight.pop(task, None)
    finished.append((task, job))


def _report(task: asyncio.Task, job: dict) -> None:
    """Ghi kết quả một job đã xong; một job hỏng không được làm sập cả vòng lặp."""
    try:
        outcome = task.result()
    except asyncio.CancelledError:
        return
    except Exception:
        logger.exception("Job %s hỏng ngoài dự kiến; lease sẽ được thu hồi.", job["_id"])
        outcome = "CRASHED"
    logger.info("job=%s submission=%s outcome=%s", job["_id"], job["submission_id"], outcome)


async def _run_job(db, job: dict, *, client, settings, stop: Stop) -> str:
    """Chạy job kèm task heartbeat; luôn dừng task phụ dù job kết thúc thế nào."""
    heartbeat = asyncio.create_task(_heartbeat(db, job, settings=settings, stop=stop))
    try:
        return await service.process_job(db, job, client=client, settings=settings)
    finally:
        heartbeat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat


async def _heartbeat(db, job: dict, *, settings, stop: Stop) -> None:
    while not stop.requested:
        await asyncio.sleep(settings.ai_review_heartbeat_seconds)
        if not await queue.heartbeat(
            db, job, now=datetime.now(timezone.utc), lease_seconds=settings.ai_review_lease_seconds
        ):
            # Mất lease: job đã thuộc worker khác, dừng ngay thay vì gia hạn hộ người khác.
            logger.warning("Mất lease job=%s", job["_id"])
            return


async def _sleep(seconds: float, stop: Stop) -> None:
    """Ngủ theo từng lát ngắn để tín hiệu dừng không phải chờ hết khoảng poll."""
    deadline = time.monotonic() + seconds
    while not stop.requested:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        await asyncio.sleep(min(0.5, remaining))


def _touch(path: str) -> None:
    try:
        Path(path).write_text(str(int(time.time())), encoding="utf-8")
    except OSError:
        # Healthcheck mất dấu worker là chuyện nhỏ so với việc làm hỏng cả vòng lặp vì nó.
        logger.debug("Không ghi được heartbeat file=%s", path)


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m app.ai_review.worker")
    parser.add_argument(
        "--once", action="store_true", help="Chạy một lượt rồi thoát khi hàng đợi rỗng."
    )
    parser.add_argument("--max-jobs", type=int, default=None, help="Dừng sau N job.")
    return parser.parse_args(argv)


async def _run(*, settings, stop: Stop, args: argparse.Namespace) -> int:
    async with mongo_lifespan(settings) as ctx:
        # Worker tự tạo index: nó có thể khởi động trước cả API.
        await service.ensure_indexes(ctx.db)
        # `trust_env=False`: proxy cấu hình qua biến môi trường sẽ đổi đích thật của request và
        # vòng qua network policy (private/metadata vẫn phải bị chặn), nên nó không được phép can
        # thiệp vào đường ra của worker.
        async with httpx.AsyncClient(trust_env=False) as client:
            await serve(
                client=client,
                db=ctx.db,
                settings=settings,
                stop=stop,
                max_jobs=args.max_jobs,
                once=args.once,
            )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    settings = get_settings()
    if not settings.ai_review_worker_config_valid:
        logger.error(
            "AI_REVIEW_HEARTBEAT_SECONDS (%s) phải nhỏ hơn AI_REVIEW_LEASE_SECONDS (%s).",
            settings.ai_review_heartbeat_seconds,
            settings.ai_review_lease_seconds,
        )
        return 2

    stop = Stop()
    # SIGINT cũng đi qua cờ dừng: vòng lặp thoát ở ranh giới job nên không cần bắt KeyboardInterrupt.
    signal.signal(signal.SIGTERM, stop.request)
    signal.signal(signal.SIGINT, stop.request)
    return asyncio.run(_run(settings=settings, stop=stop, args=args))


if __name__ == "__main__":
    sys.exit(main())
