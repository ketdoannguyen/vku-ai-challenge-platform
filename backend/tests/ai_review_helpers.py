"""Scaffolding dùng chung cho test AI review: dựng dữ liệu, gọi pipeline, và transport giả.

Mọi test AI review đều cần đúng một thứ: một cuộc thi đã bật AI, một revision nội dung bất biến, một
notebook nằm trong object storage giả, và một submission trỏ tới cả ba. Gom vào đây để test chỉ còn
nói về hành vi mà nó kiểm.
"""

import hashlib
import json
from datetime import datetime, timezone

import httpx
import pytest
from bson import ObjectId
from cryptography.fernet import Fernet

from app.accounts.service import ACCOUNTS_COLLECTION
from app.ai_review import constants, content_snapshot, crypto, queue, service, url_policy
from app.ai_review.rule_refs import build_rule_index
from app.ai_review.rule_text import canonicalize_rule_text
from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.config import get_settings
from app.submission_artifacts import storage
from app.submissions.service import SUBMISSIONS_COLLECTION
from tests.helpers import notebook_bytes

HOST = "api.example.com"
API_KEY = "sk-live-do-not-leak-me"
MODEL = "gpt-oss-120b"

MARKDOWN = "## Thể lệ\n\nKhông được dùng dữ liệu ngoài cuộc thi.\n"
RULE = "Không được dùng dữ liệu ngoài cuộc thi."

NOTEBOOK_OBJECT_KEY = (
    "competitions/ai-cup/accounts/doi-alpha/submissions/submission-0001/notebook.ipynb"
)

CLEAR_OUTPUT = {"verdict": "CLEAR", "summary": "Không thấy vi phạm.", "findings": []}

# Gợi ý thí sinh đọc được, do model soạn nháp. Chỉ có ở FLAGGED_OUTPUT: nhờ vậy mọi test dùng
# CLEAR_OUTPUT tự nhiên đi qua nhánh "model không đưa gợi ý" mà không cần một bản sao riêng.
FLAGGED_HINT = "Dùng dữ liệu ngoài cuộc thi; chỉ dùng dữ liệu ban tổ chức cấp."


@pytest.fixture()
def ai_env(monkeypatch):
    monkeypatch.setenv("LLM_CONFIG_ENCRYPTION_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.setenv("AI_REVIEW_ALLOWED_PORTS", "443")
    # Ghim số job song song về 1: mọi test hiện có mô tả luồng TUẦN TỰ, và một biến môi trường lọt
    # vào từ máy chạy test không được phép đổi nghĩa của chúng. Test nào muốn song song thì tự đặt.
    monkeypatch.setenv("AI_REVIEW_CONCURRENCY", "1")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    """Không test nào được phép phân giải DNS thật, kể cả khi nó chỉ hỏi."""
    monkeypatch.setattr(url_policy, "resolve_host", lambda host: ["93.184.216.34"])


@pytest.fixture(autouse=True)
async def ai_indexes(mock_db):
    """Index thật của tính năng: unique (submission_id, generation) là thứ duy nhất chặn hai audit
    row cho cùng một lượt chạy, nên test phải chịu đúng ràng buộc đó."""
    await service.ensure_indexes(mock_db)


def code_notebook(*lines) -> bytes:
    """Notebook hợp lệ với đúng một cell code chứa các dòng đã cho."""
    return notebook_bytes(
        cells=[{"cell_type": "code", "source": [f"{line}\n" for line in lines]}]
    )


def default_notebook() -> bytes:
    """Notebook hai cell code - mặc định của `seed`, để test đếm cell có ý nghĩa."""
    return notebook_bytes(
        cells=[
            {"cell_type": "code", "source": ["import pandas as pd\n"]},
            {"cell_type": "code", "source": ["df = pd.read_csv('train.csv')\n"]},
        ]
    )


def revision_pages(markdown: str = MARKDOWN) -> list[dict]:
    """Trang nội dung tối thiểu mà `build_rule_index` cần; `seed` bổ sung các field lưu trữ."""
    return [{"slug": "rules", "title": "Thể lệ", "order": 1, "markdown": markdown}]


def rule_ref(markdown: str = MARKDOWN, text: str = RULE) -> str:
    """Ref thật của `text` trong `markdown`, tính bằng chính thuật toán production.

    Test không hard-code digest: đổi `RULE_REF_VERSION` hay canonicalizer thì ref ở đây đổi theo,
    đúng như nó đổi trong prompt thật.
    """
    wanted = canonicalize_rule_text(text)
    for block in build_rule_index(revision_pages(markdown)).blocks:
        if block.canonical_text == wanted:
            return block.ref
    raise AssertionError(f"Không có block nào khớp: {text!r}")


def finding(*, ref=None, quote=RULE, status="VIOLATION", evidence=((1, 1, 1),)) -> dict:
    return {
        "rule_ref": rule_ref() if ref is None else ref,
        "rule_quote": quote,
        "checkability": "CHECKABLE_FROM_NOTEBOOK",
        "status": status,
        "reason": "vì sao",
        "evidence": [
            {"cell": cell, "start_line": start, "end_line": end} for cell, start, end in evidence
        ],
    }


FLAGGED_OUTPUT = {
    "verdict": "FLAGGED",
    "summary": "Dùng dữ liệu ngoài cuộc thi.",
    "participant_summary": FLAGGED_HINT,
    "findings": [finding()],
}


def handler(payload, calls: list | None = None):
    """Transport trả về một output model; `calls` ghi lại nguyên văn body của từng request."""

    def handle(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(json.loads(request.content))
        body = payload(request) if callable(payload) else payload
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(body)}}]})

    return handle


def failing(exc: Exception, calls: list | None = None):
    def handle(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(request)
        raise exc

    return handle


async def seed(db, *, markdown=MARKDOWN, content_hash="content-1", slug="ai-cup",
               competition_id=None, account_id=None, notebook=None, raw_notebook=None,
               sha256=None, generation=1, run_id="run-1", enabled=True, bypass_cache=False,
               snapshot_state=constants.SNAPSHOT_CAPTURED, revision=True, run_after=None):
    """Dựng đủ dữ liệu cho một lượt chạy và trả submission vừa tạo."""
    competition_id = competition_id or ObjectId()
    if await db[COMPETITIONS_COLLECTION].find_one({"_id": competition_id}) is None:
        await db[COMPETITIONS_COLLECTION].insert_one(
            {
                "_id": competition_id,
                "slug": slug,
                "name": "AI Cup",
                "ai_review_config": {
                    "enabled": enabled,
                    "auto_review": True,
                    "participant_visible": True,
                    "provider": constants.PROVIDER_OPENAI_COMPATIBLE,
                    "base_url": f"https://{HOST}/v1",
                    "model": MODEL,
                    "api_key_ciphertext": crypto.encrypt_secret(API_KEY),
                },
            }
        )

    revision_id = None
    if revision:
        # Cùng `(competition_id, content_hash)` là cùng một revision - đúng như `capture_revision`
        # của production, và cũng đúng với unique index mà tính năng tạo ra.
        existing_revision = await db[content_snapshot.REVISIONS_COLLECTION].find_one(
            {"competition_id": competition_id, "content_hash": content_hash}
        )
        if existing_revision is not None:
            revision_id = existing_revision["_id"]
        else:
            revision_id = ObjectId()
            encoded = markdown.encode("utf-8")
            await db[content_snapshot.REVISIONS_COLLECTION].insert_one(
                {
                    "_id": revision_id,
                    "competition_id": competition_id,
                    "content_hash": content_hash,
                    "page_count": 1,
                    "total_bytes": len(encoded),
                    "pages": [
                        {
                            **revision_pages(markdown)[0],
                            "content_id": ObjectId(),
                            "visibility": "public",
                            "markdown_sha256": hashlib.sha256(encoded).hexdigest(),
                            "size_bytes": len(encoded),
                        }
                    ],
                    "created_at": datetime.now(timezone.utc),
                }
            )

    account_id = account_id or ObjectId()
    if await db[ACCOUNTS_COLLECTION].find_one({"_id": account_id}) is None:
        await db[ACCOUNTS_COLLECTION].insert_one(
            {"_id": account_id, "name": "Đội Alpha", "slug": "doi-alpha", "email": "a@vku.vn"}
        )

    raw = notebook or raw_notebook or default_notebook()
    await storage.put_bytes(NOTEBOOK_OBJECT_KEY, raw, "application/x-ipynb+json")

    now = datetime.now(timezone.utc)
    submission = {
        "_id": ObjectId(),
        "competition_id": competition_id,
        "account_id": account_id,
        "submission_no": 1,
        "status": "completed",
        "review": {"status": "pending"},
        "primary_score": 0.9,
        "created_at": now,
        "artifacts": {
            "notebook": {
                "object_key": NOTEBOOK_OBJECT_KEY,
                "original_filename": "notebook.ipynb",
                "size_bytes": len(raw),
                "sha256": sha256 or hashlib.sha256(raw).hexdigest(),
            }
        },
        "content_snapshot": {
            "state": snapshot_state,
            "revision_id": revision_id,
            "content_hash": content_hash,
        },
        "ai_review": {
            "state": constants.AI_STATE_QUEUED,
            "generation": generation,
            "run_id": run_id,
            "verdict": None,
            "summary": None,
            "participant_summary": None,
            "latest_review_id": None,
            "requested_at": now,
            "updated_at": now,
        },
    }
    await db[SUBMISSIONS_COLLECTION].insert_one(submission)
    await queue.ensure_job(
        db,
        submission,
        source=constants.JOB_SOURCE_AUTO,
        now=run_after or now,
        bypass_cache=bypass_cache,
    )
    return submission


async def claim(db, *, worker_id="w1", now=None):
    settings = get_settings()
    return await queue.claim_next(
        db,
        worker_id=worker_id,
        now=now or datetime.now(timezone.utc),
        lease_seconds=settings.ai_review_lease_seconds,
    )


async def run(db, transport_handler, *, now=None):
    """Claim đúng một job rồi chạy nó qua transport giả; trả `(job, outcome)`."""
    settings = get_settings()
    job = await claim(db, now=now)
    assert job is not None
    moment = now or datetime.now(timezone.utc)
    async with httpx.AsyncClient(transport=httpx.MockTransport(transport_handler)) as client:
        outcome = await service.process_job(db, job, client=client, settings=settings, now=moment)
    return job, outcome


async def submission_of(db, submission_id):
    return await db[SUBMISSIONS_COLLECTION].find_one({"_id": submission_id})


async def reviews(db) -> list[dict]:
    return [review async for review in db[service.REVIEWS_COLLECTION].find({})]


async def job_of(db, submission_id):
    return await db[queue.JOBS_COLLECTION].find_one({"submission_id": submission_id})
