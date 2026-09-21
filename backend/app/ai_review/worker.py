"""Entrypoint worker AI review: `python -m app.ai_review.worker`.

Worker là tiến trình RIÊNG, không phải background task trong API process: một cuộc gọi provider mất
hàng chục giây, và API phải luôn trả lời được kể cả khi LLM hỏng hoàn toàn (quyết định sản phẩm #3).

Vòng lặp có đúng ba nhịp: thu hồi job hết lease, reconcile các khoảng trống, rồi claim và chạy.
Trong lúc chạy một job, một task phụ gửi heartbeat để lease không hết hạn giữa chừng.
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
    """Vòng lặp chính; trả số job đã xử lý."""
    worker_id = f"{os.uname().nodename}:{os.getpid()}:{secrets.token_hex(4)}"
    logger.info("Worker khởi động id=%s once=%s max_jobs=%s", worker_id, once, max_jobs)

    processed = 0
    next_reconcile_at = 0.0
    while not stop.requested:
        if max_jobs is not None and processed >= max_jobs:
            break
        _touch(settings.ai_review_heartbeat_file)

        now = datetime.now(timezone.utc)
        if time.monotonic() >= next_reconcile_at:
            next_reconcile_at = time.monotonic() + settings.ai_review_reconcile_interval_seconds
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

        # Mọi lỗi hạ tầng (Mongo chập chờn, DNS hỏng) chỉ được làm mất một nhịp, không được giết
        # tiến trình: job đang chạy vẫn còn lease để `recover_expired` thu hồi ở vòng sau.
        try:
            job = await queue.claim_next(
                db, worker_id=worker_id, now=now, lease_seconds=settings.ai_review_lease_seconds
            )
        except Exception:
            logger.exception("Không claim được job; thử lại ở nhịp sau.")
            await _sleep(settings.ai_review_poll_interval_seconds, stop)
            continue
        if job is None:
            if once:
                break
            await _sleep(settings.ai_review_poll_interval_seconds, stop)
            continue

        try:
            outcome = await _run_job(db, job, client=client, settings=settings, stop=stop)
        except Exception:
            logger.exception("Job %s hỏng ngoài dự kiến; lease sẽ được thu hồi.", job["_id"])
            outcome = "CRASHED"
        processed += 1
        logger.info(
            "job=%s submission=%s outcome=%s", job["_id"], job["submission_id"], outcome
        )

    logger.info("Worker dừng id=%s đã xử lý %d job.", worker_id, processed)
    return processed


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
        # `trust_env=False`: proxy cấu hình qua biến môi trường sẽ đổi đích thật của request và đi
        # vòng qua allowlist, nên nó không được phép can thiệp vào đường ra của worker.
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
