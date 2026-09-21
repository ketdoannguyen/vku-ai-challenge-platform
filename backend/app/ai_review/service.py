"""Điều phối AI review: index, cache, audit row bất biến, projection trên submission, xử lý job.

Ba nguyên tắc xuyên suốt module:

- **Một chiều**: AI chỉ ghi vào `ai_review.*`. `status`, `review`, `metrics`, `primary_score`, quota,
  `submission_no`, metadata artifact và tư cách xếp hạng đều nằm ngoài tầm với của mọi hàm ở đây.
- **Idempotent**: mọi lượt ghi kết quả đều khoá theo `(submission_id, generation)`, nên worker chạy
  lại sau crash không sinh thêm audit row và không đốt thêm lượt gọi provider.
- **Fail closed**: thiếu cấu hình, thiếu artifact hay sai hash đều dừng pipeline thành audit row
  ERROR, không bao giờ âm thầm bỏ qua rồi kết luận dựa trên dữ liệu thiếu.
"""

import hashlib
import logging
from dataclasses import asdict
from datetime import datetime, timezone
from uuid import uuid4

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.accounts.service import ACCOUNTS_COLLECTION
from app.ai_review import constants, content_snapshot, prompt, queue, serializers
from app.ai_review import settings as config
from app.ai_review import url_policy
from app.ai_review import verdict as verdict_module
from app.ai_review.models import ModelReviewOutput
from app.ai_review.notebook import (
    NotebookNormalizationError,
    normalize_notebook,
    notebook_sha256,
    snapshot_stats,
)
from app.ai_review.provider import ProviderError, chat_completions
from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.datetimes import as_utc, iso_z
from app.submission_artifacts import storage as artifact_storage
from app.submission_artifacts.naming import NOTEBOOK_ARTIFACT
from app.submissions.service import SUBMISSIONS_COLLECTION

logger = logging.getLogger(__name__)

REVIEWS_COLLECTION = "ai_reviews"

OUTCOME_COMPLETED = "COMPLETED"
OUTCOME_FAILED = "FAILED"
OUTCOME_RETRY = "RETRY"

# Mã nội bộ cho lượt chạy bị generation mới thay thế: không phải lỗi cấu hình lẫn lỗi provider.
_SUPERSEDED = "AI_REVIEW_SUPERSEDED"


class NotebookUnavailable(Exception):
    """Notebook không dùng được cho pipeline; `retryable` phân biệt lỗi dữ liệu với lỗi hạ tầng."""

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


async def ensure_indexes(db) -> None:
    # Unique trên (submission_id, generation): chốt chống sinh hai audit row cho cùng một lượt chạy,
    # kể cả khi reconciler và worker cùng ghi một lúc.
    await db[REVIEWS_COLLECTION].create_index(
        [("submission_id", 1), ("generation", 1)], unique=True
    )
    # Tra cache: chỉ đọc review đã COMPLETED nên index phủ luôn hai field lọc.
    await db[REVIEWS_COLLECTION].create_index(
        [("competition_id", 1), ("cache_key", 1), ("status", 1)]
    )
    await db[REVIEWS_COLLECTION].create_index([("submission_id", 1), ("created_at", -1)])
    await queue.ensure_indexes(db)
    # Revision nội dung là bất biến theo `(competition_id, content_hash)`: unique index vừa là chốt
    # chống ghi trùng, vừa là đường tra cứu duy nhất của `get_revision`.
    await content_snapshot.ensure_indexes(db)


async def ensure_job(db, submission: dict, *, source: str, now: datetime, requested_by=None,
                     bypass_cache: bool = False, max_attempts: int | None = None) -> None:
    """Tạo/đánh thức job cho desired state hiện tại; tầng gọi chỉ cần thấy một API duy nhất."""
    await queue.ensure_job(
        db,
        submission,
        source=source,
        now=now,
        requested_by=requested_by,
        bypass_cache=bypass_cache,
        max_attempts=max_attempts,
    )


def captured_snapshot(revision: content_snapshot.CapturedRevision, *, now: datetime) -> dict:
    """Ảnh chụp policy tại thời điểm nộp - bất biến với mọi sửa đổi thể lệ về sau."""
    return {
        "state": constants.SNAPSHOT_CAPTURED,
        "revision_id": revision.revision_id,
        "content_hash": revision.content_hash,
        "error_code": None,
        "captured_at": now,
    }


def failed_snapshot(error_code: str, *, now: datetime) -> dict:
    """Không chụp được nội dung: ghi nhận sự thật, không chặn bài nộp."""
    return {
        "state": constants.SNAPSHOT_ERROR,
        "revision_id": None,
        "content_hash": None,
        "error_code": error_code,
        "captured_at": now,
    }


def initial_projection(*, captured: bool, now: datetime) -> dict:
    """Desired state tại thời điểm nộp: chờ chạy, hoặc ERROR sẵn khi không có policy để đối chiếu.

    Lượt ERROR vẫn có `run_id` để reconciler sinh đúng một audit row cho nó.
    """
    return {
        "state": constants.AI_STATE_QUEUED if captured else constants.AI_STATE_ERROR,
        "verdict": None if captured else constants.VERDICT_ERROR,
        "summary": None if captured else constants.PARTICIPANT_ERROR_SUMMARY,
        "generation": 1,
        "run_id": uuid4().hex,
        "latest_review_id": None,
        "requested_at": now,
        "updated_at": now,
    }


def cache_key(*, competition_id, content_hash: str, notebook_sha256: str, provider: str,
              host: str, model: str, max_notebook_chars: int) -> str:
    """Băm mọi thứ ảnh hưởng tới nội dung gửi model; đổi bất kỳ thành phần nào là đổi khoá.

    `max_notebook_chars` nằm trong khoá vì nó CẮT BỚT nội dung: hạ trần xuống thì notebook dài bị
    bỏ bớt cell, mà hash thô của artifact thì không đổi - thiếu nó ở đây là phục vụ lại kết luận
    của một đoạn văn bản khác.
    """
    material = "\x1f".join(
        [
            str(competition_id),
            content_hash,
            notebook_sha256,
            provider,
            host,
            model,
            str(max_notebook_chars),
            constants.PROMPT_VERSION,
            constants.NORMALIZATION_VERSION,
            constants.CONTEXT_POLICY_VERSION,
        ]
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


async def process_job(db, job: dict, *, client, settings, now: datetime | None = None) -> str:
    """Chạy trọn một job đã claim; trả `OUTCOME_*` và không bao giờ ném lỗi ra ngoài vòng worker."""
    now = now or datetime.now(timezone.utc)

    submission = await db[SUBMISSIONS_COLLECTION].find_one({"_id": job["submission_id"]})
    if submission is None:
        return await _finish_error(
            db, job, now=now, code=constants.AI_REVIEW_NOT_AVAILABLE,
            message="Submission không còn tồn tại.", snapshot={},
        )

    projection = submission.get("ai_review") or {}
    if (
        projection.get("generation") != job["generation"]
        or projection.get("run_id") != job["run_id"]
    ):
        # Lượt chạy này đã bị generation mới thay thế: không sinh audit row cho desired state đã chết.
        await queue.mark_failed(
            db, job, now=now, error=_error(_SUPERSEDED, "Lượt chạy đã bị thay thế.", now)
        )
        return OUTCOME_FAILED

    snapshot = submission.get("content_snapshot") or {}
    revision = None
    if snapshot.get("revision_id") is not None:
        revision = await content_snapshot.get_revision(
            db, job["competition_id"], snapshot["revision_id"]
        )
    if revision is None:
        return await _finish_error(
            db, job, now=now, code=constants.AI_CONTENT_SNAPSHOT_UNAVAILABLE,
            message="Revision nội dung cuộc thi không còn đọc được.", snapshot=snapshot,
        )

    competition = await db[COMPETITIONS_COLLECTION].find_one({"_id": job["competition_id"]})
    if competition is None:
        return await _finish_error(
            db, job, now=now, code=constants.AI_REVIEW_NOT_AVAILABLE,
            message="Cuộc thi không còn tồn tại.", snapshot=snapshot,
        )

    try:
        policy = url_policy.policy_from_settings(settings)
        active, endpoint, model, api_key = config.resolve_target(competition, policy=policy)
    except (config.SettingsError, url_policy.UrlPolicyError) as exc:
        return await _finish_error(
            db, job, now=now, code=exc.code, message=exc.message, snapshot=snapshot
        )

    try:
        raw = await _load_notebook(submission, settings)
    except NotebookUnavailable as exc:
        if exc.retryable:
            return await _retry_or_fail(
                db, job, now=now, code=exc.code, message=exc.message, snapshot=snapshot
            )
        return await _finish_error(
            db, job, now=now, code=exc.code, message=exc.message, snapshot=snapshot
        )

    try:
        notebook = normalize_notebook(raw, max_chars=settings.ai_review_max_notebook_chars)
    except NotebookNormalizationError as exc:
        return await _finish_error(
            db, job, now=now, code=constants.AI_NOTEBOOK_MISSING,
            message=exc.message, snapshot=snapshot,
        )

    # Hai hash thuộc hợp đồng `ai_reviews`: từ đây mọi audit row đều ghi lại đúng bytes đã đưa cho
    # model. Row hỏng trước bước chuẩn hoá không có gì để ghi, và điều đó hiện ra thành field vắng.
    snapshot = {
        **snapshot,
        "notebook_sha256": notebook.raw_sha256,
        "notebook_normalized_sha256": notebook.normalized_sha256,
    }

    # Revision phải được gửi TRỌN VẸN: gửi một phần thể lệ rồi kết luận là kết luận sai.
    if prompt.exceeds_policy_cap(revision, settings.ai_review_max_policy_chars):
        return await _finish_error(
            db, job, now=now, code=constants.AI_CONTENT_TOO_LARGE,
            message="Nội dung cuộc thi vượt giới hạn ngữ cảnh của model.", snapshot=snapshot,
        )

    key = cache_key(
        competition_id=job["competition_id"],
        content_hash=revision["content_hash"],
        notebook_sha256=notebook.raw_sha256,
        provider=active["provider"],
        host=endpoint.host,
        model=model,
        max_notebook_chars=settings.ai_review_max_notebook_chars,
    )

    cached = None
    if not job.get("bypass_cache"):
        cached = await find_cached_review(db, job["competition_id"], key)
    if cached is not None:
        review = await insert_review(
            db,
            _base_document(job, now=now, snapshot=snapshot)
            | {
                "status": constants.REVIEW_STATUS_COMPLETED,
                "verdict": cached["verdict"],
                "model_verdict": cached.get("model_verdict"),
                "summary": cached["summary"],
                "findings": cached.get("findings") or [],
                "notebook_stats": snapshot_stats(notebook),
                "provider": cached.get("provider"),
                "provider_host": cached.get("provider_host"),
                "model": cached.get("model"),
                "cache_key": key,
                "source": constants.SOURCE_CACHE,
                "reused_from_review_id": cached["_id"],
                "bypass_cache": False,
                "downgrade_codes": cached.get("downgrade_codes") or [],
                "started_at": now,
                "completed_at": now,
                "duration_ms": 0,
            },
        )
        return await _settle(db, job, review, now=now, outcome=OUTCOME_COMPLETED)

    account = await db[ACCOUNTS_COLLECTION].find_one({"_id": job["account_id"]})
    context = prompt.PromptContext(
        competition_name=competition.get("name") or "",
        team_name=(account or {}).get("name") or "",
        team_code=(account or {}).get("slug"),
        submission_no=submission.get("submission_no"),
        submitted_at=iso_z(submission["created_at"]),
    )

    try:
        result = await chat_completions(
            client,
            endpoint=endpoint,
            policy=policy,
            api_key=api_key,
            model=model,
            messages=prompt.build_messages(revision, notebook, context),
            max_tokens=settings.ai_review_max_output_tokens,
            settings=settings,
        )
        output = ModelReviewOutput.model_validate_json(result.text)
        final_verdict, verified, downgrades = verdict_module.verify_review(
            output, pages=revision["pages"], notebook=notebook
        )
    except ProviderError as exc:
        if exc.retryable:
            return await _retry_or_fail(
                db, job, now=now, code=exc.code, message=exc.message, snapshot=snapshot
            )
        return await _finish_error(
            db, job, now=now, code=exc.code, message=exc.message, snapshot=snapshot
        )
    except Exception as exc:
        # Pydantic ValidationError, `ResponseInvalid`, hoặc JSON hỏng nằm ngoài `ProviderError`.
        # Chỉ ghi loại lỗi: message của Pydantic có thể chứa nguyên văn output của model.
        logger.warning("AI output không dùng được: %s", type(exc).__name__)
        return await _finish_error(
            db, job, now=now, code=constants.AI_RESPONSE_INVALID,
            message="Output model không dùng được.", snapshot=snapshot,
        )

    review = await insert_review(
        db,
        _base_document(job, now=now, snapshot=snapshot)
        | {
            "status": constants.REVIEW_STATUS_COMPLETED,
            "verdict": final_verdict,
            "model_verdict": output.verdict,
            "summary": output.summary,
            "findings": [asdict(finding) for finding in verified],
            "notebook_stats": snapshot_stats(notebook),
            "provider": active["provider"],
            "provider_host": endpoint.host,
            "model": model,
            "cache_key": key,
            "source": constants.SOURCE_PROVIDER,
            "reused_from_review_id": None,
            "bypass_cache": bool(job.get("bypass_cache")),
            "downgrade_codes": downgrades,
            "usage": result.usage,
            "latency_ms": result.latency_ms,
            "started_at": job.get("started_at") or now,
            "completed_at": now,
            "duration_ms": result.latency_ms,
        },
    )
    return await _settle(db, job, review, now=now, outcome=OUTCOME_COMPLETED)


async def find_cached_review(db, competition_id, key: str) -> dict | None:
    """Review đã COMPLETED cùng khoá cache; verdict ERROR không bao giờ được tái sử dụng."""
    return await db[REVIEWS_COLLECTION].find_one(
        {
            "competition_id": competition_id,
            "cache_key": key,
            "status": constants.REVIEW_STATUS_COMPLETED,
            "verdict": {"$in": list(constants.CACHEABLE_VERDICTS)},
        },
        sort=[("created_at", -1)],
    )


async def insert_review(db, document: dict) -> dict:
    """Ghi audit row; va chạm unique nghĩa là lượt chạy này đã có kết quả, không phải lỗi."""
    try:
        await db[REVIEWS_COLLECTION].insert_one(document)
        return document
    except DuplicateKeyError:
        existing = await db[REVIEWS_COLLECTION].find_one(
            {
                "submission_id": document["submission_id"],
                "generation": document["generation"],
            }
        )
        if existing is None:
            raise
        return existing


async def apply_projection(db, *, submission_id, generation: int, run_id: str, review: dict,
                           now: datetime) -> bool:
    """Ghi projection, chỉ khi submission vẫn đang ở đúng generation/run_id."""
    result = await db[SUBMISSIONS_COLLECTION].update_one(
        {
            "_id": submission_id,
            "ai_review.generation": generation,
            "ai_review.run_id": run_id,
        },
        {
            "$set": {
                "ai_review.state": (
                    constants.AI_STATE_COMPLETED
                    if review["status"] == constants.REVIEW_STATUS_COMPLETED
                    else constants.AI_STATE_ERROR
                ),
                "ai_review.verdict": review["verdict"],
                "ai_review.summary": review["summary"],
                "ai_review.latest_review_id": review["_id"],
                "ai_review.updated_at": now,
            }
        },
    )
    return result.modified_count == 1


async def recover_expired(db, *, now: datetime) -> int:
    """Job RUNNING hết lease: trả về hàng đợi nếu còn lượt, chốt FAILED kèm audit row nếu hết."""
    recovered = 0
    for job in await queue.expired_jobs(db, now=now):
        if job["attempts"] >= job["max_attempts"]:
            await _finish_error(
                db, job, now=now, code=constants.AI_CONNECTION_FAILED,
                message="Worker không hoàn tất job trong số lượt cho phép.", snapshot=None,
            )
        elif await queue.requeue(
            db, job, now=now, error=_error(constants.AI_CONNECTION_FAILED, "Lease hết hạn.", now)
        ):
            recovered += 1
    return recovered


async def reconcile(db, *, settings, now: datetime, limit: int) -> dict:
    """Vá ba khoảng trống mà vòng lặp thường không tự thấy: job mất, job kẹt, projection chưa gắn."""
    stats = {"enqueued": 0, "attached": 0, "audited": 0}

    # (1) Submission đang chờ nhưng không còn job, hoặc job đứng ở generation cũ.
    pending = [
        submission
        async for submission in db[SUBMISSIONS_COLLECTION]
        .find({"ai_review.state": {"$in": list(constants.AI_PENDING_STATES)}})
        .limit(limit)
    ]
    for submission in pending:
        job = await db[queue.JOBS_COLLECTION].find_one({"submission_id": submission["_id"]})
        if job is not None and job.get("generation") == submission["ai_review"].get("generation"):
            continue
        await ensure_job(
            db, submission, source=constants.JOB_SOURCE_AUTO, now=now,
            bypass_cache=bool(job and job.get("bypass_cache")),
            max_attempts=settings.ai_review_max_attempts,
        )
        stats["enqueued"] += 1

    # (2) Crash giữa bước ghi audit row và bước chốt job: review đã có, việc còn lại chỉ là gắn vào.
    queued = [
        job
        async for job in db[queue.JOBS_COLLECTION]
        .find({"status": constants.JOB_QUEUED})
        .limit(limit)
    ]
    for job in queued:
        review = await db[REVIEWS_COLLECTION].find_one(
            {"submission_id": job["submission_id"], "generation": job["generation"]}
        )
        if review is None:
            continue
        await apply_projection(
            db,
            submission_id=job["submission_id"],
            generation=job["generation"],
            run_id=job["run_id"],
            review=review,
            now=now,
        )
        await queue.force_complete(db, job, review_id=review["_id"], now=now)
        stats["attached"] += 1

    # (3) Lỗi pipeline ở submit path để lại desired state ERROR nhưng chưa có audit row nào.
    unaudited = [
        submission
        async for submission in db[SUBMISSIONS_COLLECTION]
        .find({"ai_review.state": constants.AI_STATE_ERROR, "ai_review.latest_review_id": None})
        .limit(limit)
    ]
    for submission in unaudited:
        projection = submission["ai_review"]
        snapshot = submission.get("content_snapshot") or {}
        review = await insert_review(
            db,
            _base_document(
                {
                    "submission_id": submission["_id"],
                    "competition_id": submission["competition_id"],
                    "account_id": submission["account_id"],
                    "generation": projection["generation"],
                    "run_id": projection["run_id"],
                    "source": constants.SOURCE_PIPELINE,
                },
                now=now,
                snapshot=snapshot,
            )
            | {
                "status": constants.REVIEW_STATUS_FAILED,
                "verdict": constants.VERDICT_ERROR,
                "summary": constants.PARTICIPANT_ERROR_SUMMARY,
                "error": _error(
                    snapshot.get("error_code") or constants.AI_CONTENT_SNAPSHOT_UNAVAILABLE,
                    "Pipeline dừng trước khi gọi provider.",
                    now,
                ),
                "started_at": now,
                "completed_at": now,
                "duration_ms": 0,
            },
        )
        await apply_projection(
            db,
            submission_id=submission["_id"],
            generation=projection["generation"],
            run_id=projection["run_id"],
            review=review,
            now=now,
        )
        stats["audited"] += 1
    return stats


async def request_manual_review(db, submission: dict, *, competition: dict, settings,
                                requested_by, now: datetime) -> dict:
    """Khởi tạo một lượt AI mới trên ĐÚNG revision nội dung đã chốt lúc nộp.

    Không chụp lại nội dung hiện tại: thể lệ có thể đã được sửa sau khi bài nộp, và lượt chạy mới
    phải trả lời câu hỏi "bài này có tuân thủ văn bản mà thí sinh đã đọc hay không".

    Raise `ReviewRequestInvalid` (422) khi bài chưa đủ điều kiện và `ReviewInProgress` (409) khi
    đã có một lượt đang chờ hoặc đang chạy. Không xoá audit row cũ: lịch sử chỉ được thêm.
    """
    if submission.get("status") != "completed":
        raise ReviewRequestInvalid(
            constants.AI_REVIEW_NOT_AVAILABLE, "Chỉ chạy lại được bài đã chấm điểm."
        )
    entry = (submission.get("artifacts") or {}).get(NOTEBOOK_ARTIFACT) or {}
    if not entry.get("object_key"):
        raise ReviewRequestInvalid(constants.AI_NOTEBOOK_MISSING, "Bài nộp không có notebook.")
    snapshot = submission.get("content_snapshot") or {}
    if snapshot.get("state") != constants.SNAPSHOT_CAPTURED or not snapshot.get("revision_id"):
        raise ReviewRequestInvalid(
            constants.AI_CONTENT_SNAPSHOT_UNAVAILABLE,
            "Bài nộp không có ảnh chụp nội dung cuộc thi để đối chiếu.",
        )
    try:
        config.resolve_target(competition, policy=url_policy.policy_from_settings(settings))
    except (config.SettingsError, url_policy.UrlPolicyError) as exc:
        raise ReviewRequestInvalid(exc.code, exc.message)

    current = (submission.get("ai_review") or {}).get("generation")
    await _reject_if_in_flight(db, submission["_id"], current, now)
    guard = {"ai_review.generation": current} if current else {"ai_review": {"$exists": False}}
    updated = await db[SUBMISSIONS_COLLECTION].find_one_and_update(
        {"_id": submission["_id"], "status": "completed", **guard},
        {
            "$set": {
                "ai_review.state": constants.AI_STATE_QUEUED,
                "ai_review.verdict": None,
                "ai_review.summary": None,
                "ai_review.latest_review_id": None,
                "ai_review.generation": (current or 0) + 1,
                "ai_review.run_id": uuid4().hex,
                "ai_review.requested_at": now,
                "ai_review.updated_at": now,
            }
        },
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        # Generation đổi giữa hai bước: một lượt khác vừa được khởi tạo song song.
        raise ReviewInProgress(
            constants.AI_REVIEW_IN_PROGRESS, "Một lượt kiểm tra khác vừa được khởi tạo."
        )
    await ensure_job(
        db,
        updated,
        source=constants.JOB_SOURCE_MANUAL,
        now=now,
        requested_by=requested_by,
        bypass_cache=True,
        max_attempts=settings.ai_review_max_attempts,
    )
    return updated


async def review_history(db, submission_id, *, limit: int) -> list[dict]:
    """Audit row của một bài nộp, mới nhất trước; mỗi dòng đã được che bớt ở `serializers`."""
    cursor = (
        db[REVIEWS_COLLECTION]
        .find({"submission_id": submission_id})
        .sort([("created_at", -1), ("_id", -1)])
        .limit(limit)
    )
    return [serializers.review_detail(review) async for review in cursor]


async def _reject_if_in_flight(db, submission_id, generation, now: datetime) -> None:
    """Job QUEUED, hoặc RUNNING còn lease, nghĩa là đã có một lượt chiếm chỗ của desired state này."""
    job = await db[queue.JOBS_COLLECTION].find_one({"submission_id": submission_id})
    if job is None or job.get("generation") != generation:
        return
    lease = job.get("lease_expires_at")
    running = job["status"] == constants.JOB_RUNNING and lease is not None and as_utc(lease) > now
    if job["status"] == constants.JOB_QUEUED or running:
        raise ReviewInProgress(
            constants.AI_REVIEW_IN_PROGRESS, "Bài nộp đang có một lượt kiểm tra chạy dở."
        )


class ReviewRequestInvalid(Exception):
    """Yêu cầu chạy lại không hợp lệ ở thời điểm hiện tại (HTTP 422)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ReviewInProgress(Exception):
    """Đã có một lượt kiểm tra đang chờ hoặc đang chạy cho bài nộp này (HTTP 409)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def _settle(db, job: dict, review: dict, *, now: datetime, outcome: str) -> str:
    """Gắn projection rồi chốt job; projection hụt nghĩa là generation đã đổi, job này phải bỏ."""
    applied = await apply_projection(
        db,
        submission_id=job["submission_id"],
        generation=job["generation"],
        run_id=job["run_id"],
        review=review,
        now=now,
    )
    if not applied:
        await queue.mark_failed(
            db, job, now=now, review_id=review["_id"],
            error=_error(_SUPERSEDED, "Lượt chạy đã bị thay thế.", now),
        )
        return OUTCOME_FAILED
    if outcome == OUTCOME_COMPLETED:
        if not await queue.mark_completed(db, job, review_id=review["_id"], now=now):
            # Fence hụt: lease đã thuộc worker khác, job không còn là của lượt chạy này. Audit row
            # vẫn nằm lại như lịch sử của generation, nhưng kết quả không được tính là hoàn tất.
            return OUTCOME_FAILED
    else:
        await queue.mark_failed(
            db, job, now=now, review_id=review["_id"],
            error=review.get("error") or _error(review["verdict"], review["summary"], now),
        )
    return outcome


async def _retry_or_fail(db, job, *, now, code, message, snapshot) -> str:
    error = _error(code, message, now)
    if job["attempts"] < job["max_attempts"]:
        if await queue.requeue(db, job, now=now, error=error):
            return OUTCOME_RETRY
        return OUTCOME_FAILED
    return await _finish_error(
        db, job, now=now, code=code, message=message, snapshot=snapshot, error=error
    )


async def _finish_error(db, job, *, now, code, message, snapshot, error=None) -> str:
    """Sinh audit row ERROR rồi gắn projection: submission không bao giờ kẹt ở RUNNING."""
    review = await insert_review(
        db,
        _base_document(job, now=now, snapshot=snapshot or {})
        | {
            "status": constants.REVIEW_STATUS_FAILED,
            "verdict": constants.VERDICT_ERROR,
            "summary": constants.PARTICIPANT_ERROR_SUMMARY,
            "error": error or _error(code, message, now),
            "started_at": job.get("started_at") or now,
            "completed_at": now,
            "duration_ms": 0,
        },
    )
    return await _settle(db, job, review, now=now, outcome=OUTCOME_FAILED)


async def _load_notebook(submission: dict, settings) -> bytes:
    """Đọc artifact đã lưu và xác minh hash; raise `NotebookUnavailable` cho mọi nhánh hỏng."""
    entry = (submission.get("artifacts") or {}).get(NOTEBOOK_ARTIFACT) or {}
    object_key = entry.get("object_key")
    if not object_key:
        raise NotebookUnavailable(
            constants.AI_NOTEBOOK_MISSING, "Submission không có notebook.", retryable=False
        )
    try:
        raw = await artifact_storage.get_bytes(object_key, settings.ai_review_max_snapshot_bytes)
    except artifact_storage.ArtifactNotFound:
        raise NotebookUnavailable(
            constants.AI_NOTEBOOK_MISSING, "Object notebook không còn tồn tại.", retryable=False
        )
    except artifact_storage.ArtifactStorageUnavailable:
        # Hạ tầng mạng, không phải dữ liệu sai: thử lại được.
        raise NotebookUnavailable(
            constants.AI_CONNECTION_FAILED, "Kho artifact không sẵn sàng.", retryable=True
        )
    # Không ghép lại key từ slug: key đã lưu là nguồn duy nhất. Hash phải khớp lúc nộp (ADR-028),
    # lệch nghĩa là artifact đã bị thay ngoài luồng - dừng pipeline chứ không kiểm tra nhầm nội dung.
    expected = entry.get("sha256")
    if not expected or notebook_sha256(raw) != expected:
        raise NotebookUnavailable(
            constants.AI_NOTEBOOK_MISSING, "Hash notebook không khớp metadata.", retryable=False
        )
    return raw


def _base_document(job: dict, *, now: datetime, snapshot: dict) -> dict:
    return {
        "submission_id": job["submission_id"],
        "competition_id": job["competition_id"],
        "account_id": job["account_id"],
        "generation": job["generation"],
        "run_id": job["run_id"],
        "content_revision_id": snapshot.get("revision_id"),
        "content_hash": snapshot.get("content_hash"),
        "notebook_sha256": snapshot.get("notebook_sha256"),
        "notebook_normalized_sha256": snapshot.get("notebook_normalized_sha256"),
        "prompt_version": constants.PROMPT_VERSION,
        "normalization_version": constants.NORMALIZATION_VERSION,
        "context_policy_version": constants.CONTEXT_POLICY_VERSION,
        "source": job.get("source"),
        "manual": job.get("source") == constants.JOB_SOURCE_MANUAL,
        "attempts": job.get("attempts"),
        "created_at": now,
        "updated_at": now,
    }


def _error(code: str, message: str, now: datetime) -> dict:
    return {"code": code, "message": message, "occurred_at": now}
