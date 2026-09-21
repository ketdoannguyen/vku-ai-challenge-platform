"""Revision nội dung cuộc thi bất biến - policy mà AI đối chiếu notebook, chốt tại thời điểm nộp.

Vì sao phải là revision chứ không đọc file "hiện tại" lúc chấm: BTC có thể sửa thể lệ sau khi bài đã
nộp, và khi đó kết luận phải vẫn dựa trên đúng văn bản mà thí sinh đã đọc. Revision dùng chung theo
`(competition_id, content_hash)` nên sửa rồi sửa lại về nội dung cũ không tạo rác.

Capture là optimistic: đọc metadata, đọc bytes, rồi đọc lại metadata. Nếu metadata đổi giữa hai lần
đọc thì nội dung vừa chụp không còn tương ứng với một thời điểm nào cả, nên phải làm lại từ đầu thay
vì lưu một ảnh chụp lai.
"""

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone

from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from app.ai_review import constants
from app.content import storage as content_storage
from app.content.service import CONTENTS_COLLECTION

REVISIONS_COLLECTION = "competition_content_revisions"
MAX_CAPTURE_ATTEMPTS = 3

# Chỉ những field này tham gia so sánh hai lần đọc metadata; `markdown_path`/`size_bytes` quyết định
# page có được đọc hay không nên chúng cũng phải nằm trong phép so sánh.
_METADATA_FIELDS = ("title", "slug", "order", "visibility", "markdown_path", "size_bytes", "updated_at")


class SnapshotError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class PageSnapshot:
    content_id: ObjectId
    title: str
    slug: str
    order: int
    visibility: str
    markdown: str
    markdown_sha256: str
    size_bytes: int


@dataclass(frozen=True)
class CapturedRevision:
    revision_id: ObjectId
    content_hash: str
    page_count: int
    total_bytes: int
    pages: list[PageSnapshot]
    # Page bị bỏ qua vì chưa có Markdown; settings UI dùng để giải thích vì sao page không được kiểm.
    excluded: list[dict]
    # True khi revision đã tồn tại với đúng hash này - không phải tạo mới.
    reused: bool


async def ensure_indexes(db) -> None:
    collection = db[REVISIONS_COLLECTION]
    await collection.create_index([("competition_id", 1), ("content_hash", 1)], unique=True)
    await collection.create_index([("competition_id", 1), ("created_at", -1)])


async def read_content_metadata(db, competition_id) -> list[dict]:
    """Metadata content theo đúng thứ tự hiển thị `(order, _id)`; không đọc file."""
    return [
        content
        async for content in db[CONTENTS_COLLECTION]
        .find({"competition_id": competition_id})
        .sort([("order", 1), ("_id", 1)])
    ]


async def content_source_view(db, competition_id, *, settings) -> dict:
    """Page nào sẽ nằm trong revision kế tiếp, và page nào bị loại vì lý do gì - để admin biết trước."""
    pages = []
    total_bytes = 0
    for content in await read_content_metadata(db, competition_id):
        if content.get("size_bytes") is None:
            reason = "NO_MARKDOWN"
        else:
            try:
                markdown = content_storage.read_markdown(
                    settings.data_dir, content["markdown_path"]
                )
            except content_storage.ContentFileMissing:
                reason = "UNREADABLE"
            else:
                reason = "OK"
                total_bytes += len(markdown.encode("utf-8"))
        pages.append(
            {
                "content_id": str(content["_id"]),
                "title": content["title"],
                "slug": content["slug"],
                "order": content["order"],
                "visibility": content["visibility"],
                "included": reason == "OK",
                "reason": reason,
            }
        )
    included = sum(1 for page in pages if page["included"])
    return {
        "included_count": included,
        "excluded_count": len(pages) - included,
        "total_bytes": total_bytes,
        "pages": pages,
    }


async def capture_revision(db, competition_id, *, settings) -> CapturedRevision:
    """Chụp revision bất biến; raise `SnapshotError` với mã lỗi ổn định khi không chụp được."""
    for _ in range(MAX_CAPTURE_ATTEMPTS):
        before = await read_content_metadata(db, competition_id)
        captured = _capture_pages(before, settings)
        after = await read_content_metadata(db, competition_id)
        if _metadata_signature(before) == _metadata_signature(after):
            return await _persist(db, competition_id, captured)
    raise SnapshotError(
        constants.SNAPSHOT_CONTENT_CHANGED,
        "Nội dung cuộc thi đang được sửa trong lúc chụp snapshot.",
    )


async def get_revision(db, competition_id, revision_id) -> dict | None:
    return await db[REVISIONS_COLLECTION].find_one(
        {"_id": revision_id, "competition_id": competition_id}
    )


async def delete_revisions(db, competition_id) -> None:
    """Dọn khi xóa cuộc thi; gọi sau khi submission/review đã bị xóa vì chúng tham chiếu revision."""
    await db[REVISIONS_COLLECTION].delete_many({"competition_id": competition_id})


@dataclass(frozen=True)
class _CapturedPages:
    pages: list[PageSnapshot]
    excluded: list[dict]
    total_bytes: int


def _capture_pages(contents: list[dict], settings) -> _CapturedPages:
    pages: list[PageSnapshot] = []
    excluded: list[dict] = []
    total_bytes = 0
    for content in contents:
        if content.get("size_bytes") is None:
            # Metadata nói chưa có Markdown: page chưa được publish nên không tham gia policy.
            excluded.append(_excluded_view(content, "NO_MARKDOWN"))
            continue
        try:
            markdown = content_storage.read_markdown(settings.data_dir, content["markdown_path"])
        except content_storage.ContentFileMissing as exc:
            # Metadata khẳng định có file mà file lại không đọc được: snapshot sai sự thật, hỏng cả lượt.
            raise SnapshotError(
                constants.SNAPSHOT_CONTENT_UNREADABLE,
                f"Không đọc được Markdown của nội dung '{content.get('title')}'.",
            ) from exc
        data = markdown.encode("utf-8")
        total_bytes += len(data)
        if total_bytes > settings.ai_review_max_snapshot_bytes:
            raise SnapshotError(
                constants.SNAPSHOT_CONTENT_TOO_LARGE,
                "Tổng nội dung cuộc thi vượt giới hạn snapshot.",
            )
        pages.append(
            PageSnapshot(
                content_id=content["_id"],
                title=content["title"],
                slug=content["slug"],
                order=content["order"],
                visibility=content["visibility"],
                markdown=markdown,
                markdown_sha256=hashlib.sha256(data).hexdigest(),
                size_bytes=len(data),
            )
        )
    if not pages:
        raise SnapshotError(
            constants.SNAPSHOT_CONTENT_EMPTY, "Cuộc thi chưa có nội dung Markdown nào."
        )
    return _CapturedPages(pages=pages, excluded=excluded, total_bytes=total_bytes)


def _metadata_signature(contents: list[dict]) -> list[tuple]:
    return [
        (content["_id"], *(content.get(field) for field in _METADATA_FIELDS))
        for content in contents
    ]


def _excluded_view(content: dict, reason: str) -> dict:
    return {
        "content_id": content["_id"],
        "title": content["title"],
        "slug": content["slug"],
        "reason": reason,
    }


def canonical_content_hash(pages: list[PageSnapshot]) -> str:
    """Hash nội dung policy: JSON UTF-8, khoá và thứ tự cố định, không chứa timestamp."""
    payload = [
        {
            "content_id": str(page.content_id),
            "title": page.title,
            "slug": page.slug,
            "order": page.order,
            "visibility": page.visibility,
            "markdown_sha256": page.markdown_sha256,
            "markdown": page.markdown,
        }
        for page in pages
    ]
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


async def _persist(db, competition_id, captured: _CapturedPages) -> CapturedRevision:
    content_hash = canonical_content_hash(captured.pages)
    collection = db[REVISIONS_COLLECTION]
    existing = await collection.find_one(
        {"competition_id": competition_id, "content_hash": content_hash}
    )
    if existing is not None:
        return _result(existing, captured, reused=True)

    document = {
        "_id": ObjectId(),
        "competition_id": competition_id,
        "content_hash": content_hash,
        "pages": [_page_document(page) for page in captured.pages],
        "page_count": len(captured.pages),
        "total_bytes": captured.total_bytes,
        "created_at": datetime.now(timezone.utc),
    }
    try:
        await collection.insert_one(document)
    except DuplicateKeyError:
        # Một lượt nộp khác vừa tạo đúng revision này: đó là cache hit, không phải lỗi.
        existing = await collection.find_one(
            {"competition_id": competition_id, "content_hash": content_hash}
        )
        if existing is None:
            raise
        return _result(existing, captured, reused=True)
    return _result(document, captured, reused=False)


def _page_document(page: PageSnapshot) -> dict:
    return {
        "content_id": page.content_id,
        "title": page.title,
        "slug": page.slug,
        "order": page.order,
        "visibility": page.visibility,
        "markdown": page.markdown,
        "markdown_sha256": page.markdown_sha256,
        "size_bytes": page.size_bytes,
    }


def _result(document: dict, captured: _CapturedPages, *, reused: bool) -> CapturedRevision:
    return CapturedRevision(
        revision_id=document["_id"],
        content_hash=document["content_hash"],
        page_count=document["page_count"],
        total_bytes=document["total_bytes"],
        pages=[
            PageSnapshot(
                content_id=page["content_id"],
                title=page["title"],
                slug=page["slug"],
                order=page["order"],
                visibility=page["visibility"],
                markdown=page["markdown"],
                markdown_sha256=page["markdown_sha256"],
                size_bytes=page["size_bytes"],
            )
            for page in document["pages"]
        ],
        excluded=captured.excluded,
        reused=reused,
    )
