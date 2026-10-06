"""Entrypoint worker hàng đợi chấm v2: `python -m app.scoring_attempts.worker`.

Worker là tiến trình riêng và KHÔNG có docker socket: nó gọi runner qua kênh nội bộ y như API. Mọi
trạng thái nằm ở Mongo - không có hàng đợi nào trong RAM - nên tiến trình chết rồi khởi động lại vẫn
đúng, phần dở dang do nhịp đối soát dọn.

Vòng lặp có ba nhịp: đối soát (đóng lượt quá hạn, thu hồi lượt mất lease, hoàn quota còn treo), claim
tối đa `SCORING_WORKER_CONCURRENCY` lượt cũ nhất, rồi chạy chúng song song.

Một lượt chấm tốn tối đa 30 giây CPU của container chấm và luôn ngắn hơn hạn 60 giây của bài, nên
lease cấp lúc claim dài hơn cả hai: không cần heartbeat giữ lease, và một worker đứng hình chỉ bị thu
hồi sau khi lease hết - lúc đó reconciler quyết định chạy lại hay đóng lượt.
"""

import argparse
import asyncio
import logging
import os
import secrets
import signal
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from app.accounts import service as accounts_service
from app.accounts.service import ACCOUNTS_COLLECTION
from app.ai_review import service as ai_service
from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.config import get_settings
from app.core.database import mongo_lifespan
from app.core.datetimes import as_utc
from app.memberships.service import get_membership
from app.scoring import models
from app.scoring.errors import EvaluatorError, ScoringValidationError
from app.scoring_attempts import service, store
from app.submission_artifacts import storage as artifact_storage
from app.submission_artifacts.naming import (
    ARTIFACT_MEDIA_TYPES,
    NOTEBOOK_ARTIFACT,
    PREDICTION_ARTIFACT,
)
from app.submissions import scoring as scoring_flow
from app.submissions import service as submissions_service

logger = logging.getLogger(__name__)


class Stop:
    """Cờ dừng do tín hiệu đặt; vòng lặp đọc nó ở ranh giới lượt, không cắt ngang lượt đang chạy."""

    def __init__(self) -> None:
        self.requested = False

    def request(self, signum, _frame) -> None:
        logger.info("Nhận tín hiệu %s; dừng sau lượt hiện tại.", signum)
        self.requested = True


class _Rejected(Exception):
    """Lượt không chấm được; mã và câu chữ ở đây là thứ thí sinh nhìn thấy."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class _Context:
    """Mọi thứ một lượt cần để chấm và ghi, đã kiểm lại còn hợp lệ."""

    competition: dict
    account: dict
    membership: dict
    config: models.ScoringConfigV2


async def serve(
    *, db, settings, stop: Stop, max_attempts: int | None = None, once: bool = False
) -> int:
    """Vòng lặp chính; trả số lượt đã chạy."""
    concurrency = max(1, settings.scoring_worker_concurrency)
    worker_id = f"{os.uname().nodename}:{os.getpid()}:{secrets.token_hex(4)}"
    logger.info(
        "Worker khởi động id=%s once=%s max_attempts=%s concurrency=%d",
        worker_id,
        once,
        max_attempts,
        concurrency,
    )

    started = 0
    next_reconcile_at = 0.0
    in_flight: set[asyncio.Task] = set()

    def schedule(attempt: dict) -> None:
        task = asyncio.create_task(_run(db, attempt, settings=settings))
        in_flight.add(task)
        task.add_done_callback(in_flight.discard)
        task.add_done_callback(_report)

    try:
        while not stop.requested:
            _touch(settings.scoring_heartbeat_file)

            now = datetime.now(timezone.utc)
            if time.monotonic() >= next_reconcile_at:
                next_reconcile_at = (
                    time.monotonic() + settings.scoring_reconcile_interval_seconds
                )
                try:
                    stats = await reconcile(db, settings=settings, now=now)
                except Exception:
                    logger.exception("Bỏ qua nhịp đối soát do lỗi hạ tầng.")
                else:
                    if any(stats.values()):
                        logger.info("reconcile %s", stats)

            # Lấp đầy slot trước khi chờ: chỉ claim khi còn slot nên không bao giờ vượt trần.
            while len(in_flight) < concurrency and not stop.requested:
                if max_attempts is not None and started >= max_attempts:
                    break
                # Lỗi hạ tầng (Mongo chập chờn) chỉ được làm mất một nhịp, không được giết tiến trình.
                try:
                    attempt = await store.claim_next(
                        db,
                        worker_id=worker_id,
                        now=datetime.now(timezone.utc),
                        lease_seconds=settings.scoring_lease_seconds,
                    )
                except Exception:
                    logger.exception("Không claim được lượt; thử lại ở nhịp sau.")
                    break
                if attempt is None:
                    break
                schedule(attempt)
                started += 1

            if not in_flight:
                if once:
                    break
                await _sleep(settings.scoring_poll_interval_seconds, stop)
                continue

            # Chờ lượt kế tiếp xong, nhưng không lâu hơn một nhịp poll: `_touch` ở đầu vòng sau là
            # thứ giữ healthcheck sống.
            await asyncio.wait(
                set(in_flight),
                timeout=settings.scoring_poll_interval_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )
    finally:
        # Dừng ở ranh giới lượt: ngừng claim nhưng KHÔNG cắt ngang lượt đang chấm.
        if in_flight:
            await asyncio.gather(*in_flight, return_exceptions=True)

    logger.info("Worker dừng id=%s đã chạy %d lượt.", worker_id, started)
    return started


async def reconcile(db, *, settings, now: datetime) -> dict:
    """Dọn những gì một tiến trình chết để lại: lượt quá hạn, lượt mất lease, quota còn treo."""
    limit = settings.scoring_reconcile_batch
    stats = {"expired": 0, "requeued": 0, "resolved": 0, "refunded": 0}

    for attempt in await store.overdue(db, now=now, limit=limit):
        await service.expire(db, attempt, now=now)
        stats["expired"] += 1

    for attempt in await store.abandoned(db, now=now, limit=limit):
        if _out_of_time(as_utc(attempt["deadline_at"]), settings, now):
            await service.expire(db, attempt, now=now)
            stats["expired"] += 1
        elif await store.requeue(db, attempt, now=now):
            stats["requeued"] += 1

    for attempt in await store.resolving(db, limit=limit):
        outcome = await _resolve(db, attempt, settings=settings, now=now)
        logger.info("Đối soát lượt %s: %s", attempt["_id"], outcome)
        stats["resolved"] += 1

    for attempt in await store.refundable(db, limit=limit):
        await service.refund(db, attempt, now=now)
        stats["refunded"] += 1

    return stats


async def _run(db, attempt: dict, *, settings) -> None:
    """Chạy một lượt đã claim và ghi lại kết cục; không bao giờ ném lỗi ra ngoài vòng lặp."""
    try:
        outcome = await _process(db, attempt, settings=settings)
    except Exception:
        # Lượt còn lease nên reconciler sẽ gặp lại nó; ở đây chỉ ghi log, không đoán kết quả.
        logger.exception("Lượt %s hỏng ngoài dự kiến.", attempt["_id"])
        outcome = "CRASHED"
    logger.info("attempt=%s outcome=%s", attempt["_id"], outcome)


async def _process(db, attempt: dict, *, settings) -> str:
    """Chấm một lượt rồi ghi bài nộp; mọi nhánh đều kết thúc ở một trạng thái cuối."""
    now = datetime.now(timezone.utc)
    deadline = as_utc(attempt["deadline_at"])
    if _out_of_time(deadline, settings, now):
        return await _close(db, attempt, expired=True)

    try:
        context = await _context(db, attempt, now=now)
        data, notebook_data = await _staged_files(attempt, settings=settings)
        scored = await _score(attempt, context, data=data, deadline=deadline, settings=settings)
    except artifact_storage.ArtifactStorageUnavailable:
        # Kho tạm không tới được là trục trặc tạm thời: để nguyên lượt cho reconciler thử lại.
        logger.warning("Chưa đọc được kho tạm attempt=%s", attempt["_id"])
        return "RETRY"
    except _Rejected as rejected:
        return await _close(
            db,
            attempt,
            expired=rejected.code == service.EXPIRED_CODE,
            code=rejected.code,
            message=rejected.message,
        )

    now = datetime.now(timezone.utc)
    result = {
        "metrics": scored.metrics,
        "primary_score": scored.primary_score,
        "scoring_ref": scored.scoring_ref,
    }
    if not await store.store_result(db, attempt, result=result, now=now):
        # Mất lease: lượt đã thuộc worker khác, không ghi thêm gì nữa.
        logger.warning("Mất lease attempt=%s", attempt["_id"])
        return "LOST"

    try:
        await _commit(
            db,
            attempt,
            context=context,
            scored=scored,
            data=data,
            notebook_data=notebook_data,
            now=now,
        )
    except Exception:
        # Ghi bài nộp có thể đã xong hoặc chưa - không đoán, để reconciler đọc lại theo `_id`.
        logger.exception("Chưa rõ kết quả ghi bài nộp attempt=%s", attempt["_id"])
        await store.mark_resolving(
            db,
            attempt,
            error={"code": "SUBMISSION_RESOLVING", "message": service.GENERIC_MESSAGE},
            now=datetime.now(timezone.utc),
        )
        return "RESOLVING"
    return "COMPLETED"


async def _close(
    db, attempt: dict, *, expired: bool, code: str = "", message: str = ""
) -> str:
    """Đóng một lượt không chấm được; lượt đã thuộc nơi khác thì báo LOST chứ không nhận là của mình."""
    now = datetime.now(timezone.utc)
    if expired:
        closed = await service.expire(db, attempt, now=now)
    else:
        closed = await service.fail(db, attempt, code=code, message=message, now=now)
    return ("EXPIRED" if expired else "FAILED") if closed else "LOST"


async def _resolve(db, attempt: dict, *, settings, now: datetime) -> str:
    """Kết thúc một lượt RESOLVING bằng sự thật: bài đã ghi, chưa ghi, hay hết giờ."""
    stored = await db[submissions_service.SUBMISSIONS_COLLECTION].find_one(
        {"_id": attempt["_id"]}, {"_id": 1}
    )
    if stored is not None:
        await store.complete(db, attempt, now=now)
        return "COMPLETED"
    if not attempt.get("result"):
        # Không có kết quả chấm nghĩa là lượt chết trước khi chấm xong: chấm lại tốn 30 giây CPU mà
        # thí sinh đã hết 60 giây, nên đóng luôn và hoàn suất.
        return await _close(
            db, attempt, expired=False, code="SCORING_FAILED", message=service.GENERIC_MESSAGE
        )
    if _out_of_time(as_utc(attempt["deadline_at"]), settings, now):
        return await _close(db, attempt, expired=True)
    try:
        context = await _context(db, attempt, now=now)
        data, notebook_data = await _staged_files(attempt, settings=settings)
        await _commit(
            db,
            attempt,
            context=context,
            scored=_scored_from(attempt["result"]),
            data=data,
            notebook_data=notebook_data,
            now=now,
        )
    except _Rejected as rejected:
        return await _close(db, attempt, expired=False, code=rejected.code, message=rejected.message)
    except Exception:
        # Chưa ghi được: để nguyên cho nhịp sau; quá hạn thì nhịp sau sẽ đóng lượt và hoàn quota.
        logger.exception("Vẫn chưa ghi được bài nộp attempt=%s", attempt["_id"])
        return "RESOLVING"
    return "COMPLETED"


async def _context(db, attempt: dict, *, now: datetime) -> _Context:
    """Nạp lại mọi thứ lượt cần và kiểm còn hợp lệ - lượt nằm chờ có thể đã hết điều kiện chấm.

    Worker tự kiểm chứ không tin trạng thái lúc nhận bài: cuộc thi có thể đã bị đóng, xoá, hoặc
    membership bị vô hiệu hoá trong lúc lượt còn trong hàng đợi.
    """
    competition = await db[COMPETITIONS_COLLECTION].find_one({"_id": attempt["competition_id"]})
    if competition is None or competition["status"] != "published":
        raise _Rejected("SUBMISSION_CLOSED", "Cuộc thi hiện không nhận bài nộp.")
    if now > as_utc(competition["end_at"]):
        raise _Rejected("SUBMISSION_DEADLINE_PASSED", "Đã hết hạn nộp bài.")
    membership = await get_membership(db, competition["_id"], attempt["account_id"])
    if membership is None or not membership.get("active", True):
        raise _Rejected("MEMBERSHIP_INACTIVE", "Quyền tham gia cuộc thi đã bị vô hiệu hóa.")
    account = await db[ACCOUNTS_COLLECTION].find_one({"_id": attempt["account_id"]})
    if account is None:
        raise _Rejected("ACCOUNT_MISSING", "Không tìm thấy tài khoản.")
    try:
        config = models.stored_config(competition)
    except Exception:
        config = None
    if config is None:
        raise _Rejected("SCORING_NOT_READY", scoring_flow.SCORING_NOT_READY_MESSAGE)
    return _Context(
        competition=competition, account=account, membership=membership, config=config
    )


async def _staged_files(attempt: dict, *, settings) -> tuple[bytes, bytes]:
    """Đọc lại hai file từ kho tạm; thiếu file nghĩa là lượt không thể chấm."""
    artifacts = attempt.get("artifacts") or {}
    try:
        data = await artifact_storage.get_bytes(
            artifacts[PREDICTION_ARTIFACT]["staging_key"], settings.max_upload_mb * 1024 * 1024
        )
        notebook_data = await artifact_storage.get_bytes(
            artifacts[NOTEBOOK_ARTIFACT]["staging_key"], settings.max_notebook_mb * 1024 * 1024
        )
    except (KeyError, artifact_storage.ArtifactNotFound):
        raise _Rejected("ARTIFACT_MISSING", "Bài nộp không còn đủ file để chấm.")
    return data, notebook_data


async def _score(
    attempt: dict, context: _Context, *, data: bytes, deadline: datetime, settings
) -> scoring_flow.Scored:
    """Chấm bài bằng đúng hàm API dùng, với trần gọi runner cắt theo thời gian còn lại của lượt."""
    remaining = (
        deadline - datetime.now(timezone.utc)
    ).total_seconds() - settings.scoring_commit_reserve_seconds
    if remaining <= 0:
        raise _Rejected(service.EXPIRED_CODE, service.EXPIRED_MESSAGE)
    try:
        return await scoring_flow.score_v2(
            context.competition,
            context.config,
            data,
            client_timeout=min(remaining, settings.evaluator_client_timeout_seconds),
        )
    except ScoringValidationError as exc:
        raise _Rejected(exc.code, exc.message)
    except EvaluatorError as exc:
        if _out_of_time(deadline, settings, datetime.now(timezone.utc)):
            # Hết 60 giây trong lúc chờ runner: lượt không được tính, không phải bài của thí sinh hỏng.
            raise _Rejected(service.EXPIRED_CODE, service.EXPIRED_MESSAGE)
        raise _Rejected(exc.code, exc.message)
    except HTTPException as exc:
        # Tầng đọc file của `scoring_flow` đã dịch lỗi cấu hình thành HTTP; dùng lại đúng mã và câu chữ.
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        raise _Rejected(
            detail.get("code") or "SCORING_FAILED",
            detail.get("message") or service.GENERIC_MESSAGE,
        )
    except Exception:
        logger.exception("Bộ chấm hỏng attempt=%s", attempt["_id"])
        raise _Rejected("SCORING_FAILED", service.GENERIC_MESSAGE)


async def _commit(
    db, attempt: dict, *, context: _Context, scored: scoring_flow.Scored,
    data: bytes, notebook_data: bytes, now: datetime,
) -> None:
    """Ghi bài nộp đã chấm: cấp số, copy artifact ra key chính thức, insert, đóng lượt.

    `_id` của submission là `_id` của lượt, nên chạy lại bước này (sau lỗi mạng, sau khi worker chết,
    sau khi reconciler đối soát) không thể sinh ra bài nộp thứ hai.
    """
    settings = get_settings()
    submission_no = attempt.get("submission_no")
    if submission_no is None:
        submission_no = await submissions_service.allocate_submission_no(db, context.membership)
        attempt = await store.set_submission_no(db, attempt, submission_no, now=now)
    account_slug = await accounts_service.ensure_account_slug(db, context.account)
    prediction_key = artifact_storage.prediction_key(
        context.competition["slug"], account_slug, submission_no
    )
    notebook_key = artifact_storage.notebook_key(
        context.competition["slug"], account_slug, submission_no
    )
    staged = attempt["artifacts"]
    document = {
        "_id": attempt["_id"],
        "competition_id": context.competition["_id"],
        "account_id": attempt["account_id"],
        "submission_no": submission_no,
        "artifacts": {
            PREDICTION_ARTIFACT: {
                "object_key": prediction_key,
                "original_filename": staged[PREDICTION_ARTIFACT]["original_filename"],
                "size_bytes": staged[PREDICTION_ARTIFACT]["size_bytes"],
            },
            NOTEBOOK_ARTIFACT: {
                "object_key": notebook_key,
                "original_filename": staged[NOTEBOOK_ARTIFACT]["original_filename"],
                "size_bytes": staged[NOTEBOOK_ARTIFACT]["size_bytes"],
                "sha256": staged[NOTEBOOK_ARTIFACT]["sha256"],
            },
        },
        "status": "completed",
        "metrics": scored.metrics,
        "primary_score": scored.primary_score,
        # Thời điểm thí sinh nhấn Nút, không phải lúc chấm xong: cùng ngày với suất quota đã giữ.
        "created_at": attempt["created_at"],
    }
    if scored.scoring_ref is not None:
        document["scoring_ref"] = scored.scoring_ref
    snapshot, projection = await ai_service.plan_submission_state(
        db, context.competition, settings=settings, now=now
    )
    if snapshot is not None:
        document["content_snapshot"] = snapshot
    if projection is not None:
        document["ai_review"] = projection

    stored = await db[submissions_service.SUBMISSIONS_COLLECTION].find_one(
        {"_id": attempt["_id"]}, {"_id": 1}
    )
    if stored is None:
        # Snapshot norm tạm dựng ngay trước khi ghi, chỉ ở nhánh chưa có bài: lượt đối soát bắt gặp
        # bài đã ghi sẽ không bao giờ tính lại, nên snapshot đã lưu giữ nguyên vĩnh viễn.
        norm_snapshot = await submissions_service.normalization_snapshot(
            db, context.competition, raw=scored.primary_score, now=now
        )
        if norm_snapshot is not None:
            document["normalization_snapshot"] = norm_snapshot
        await artifact_storage.put_bytes(
            prediction_key, data, ARTIFACT_MEDIA_TYPES[PREDICTION_ARTIFACT]
        )
        await artifact_storage.put_bytes(
            notebook_key, notebook_data, ARTIFACT_MEDIA_TYPES[NOTEBOOK_ARTIFACT]
        )
        await db[submissions_service.SUBMISSIONS_COLLECTION].insert_one(document)
    await store.complete(db, attempt, now=now)
    await artifact_storage.remove_prefix(attempt["staging_prefix"])
    await ai_service.wake_worker(db, document, settings=settings, now=now)


def _scored_from(result: dict) -> scoring_flow.Scored:
    """Dựng lại kết quả đã chấm từ document của lượt - đường đối soát không chấm lại lần hai."""
    return scoring_flow.Scored(
        metrics=result["metrics"],
        primary_score=result["primary_score"],
        scoring_ref=result.get("scoring_ref"),
    )


def _out_of_time(deadline: datetime, settings, now: datetime) -> bool:
    """Hết giờ nếu phần còn lại không đủ cho bước ghi cuối."""
    return (deadline - now).total_seconds() <= settings.scoring_commit_reserve_seconds


def _report(task: asyncio.Task) -> None:
    """Một lượt hỏng không được làm sập cả vòng lặp; lỗi bất ngờ đã được log ở `_run`."""
    try:
        task.result()
    except asyncio.CancelledError:
        pass
    except Exception:
        logger.exception("Lượt chấm hỏng ngoài dự kiến.")


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
    parser = argparse.ArgumentParser(prog="python -m app.scoring_attempts.worker")
    parser.add_argument(
        "--once", action="store_true", help="Chạy một lượt rồi thoát khi hàng đợi rỗng."
    )
    parser.add_argument("--max-attempts", type=int, default=None, help="Dừng sau N lượt.")
    return parser.parse_args(argv)


async def _run_worker(*, settings, stop: Stop, args: argparse.Namespace) -> int:
    async with mongo_lifespan(settings) as ctx:
        # Worker tự tạo index: nó có thể khởi động trước cả API.
        await store.ensure_indexes(ctx.db)
        await serve(
            db=ctx.db,
            settings=settings,
            stop=stop,
            max_attempts=args.max_attempts,
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
    if not settings.scoring_worker_config_valid:
        logger.error(
            "Cấu hình worker chấm không hợp lệ: concurrency=%s (trần runner=%s), capacity=%s, "
            "reserve=%ss (hạn %ss).",
            settings.scoring_worker_concurrency,
            settings.evaluator_max_concurrency,
            settings.scoring_queue_capacity,
            settings.scoring_commit_reserve_seconds,
            settings.scoring_deadline_seconds,
        )
        return 2

    stop = Stop()
    signal.signal(signal.SIGTERM, stop.request)
    signal.signal(signal.SIGINT, stop.request)
    return asyncio.run(_run_worker(settings=settings, stop=stop, args=args))


if __name__ == "__main__":
    sys.exit(main())
