"""Competition content metadata and serialization."""

from datetime import datetime, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel

from app.core.datetimes import iso_z
from app.core.slugs import is_valid_slug

CONTENTS_COLLECTION = "competition_contents"
VISIBILITIES = ("public", "members")


class ContentCreate(BaseModel):
    title: str
    slug: str
    order: int | None = None
    visibility: str = "public"


class ContentUpdate(BaseModel):
    title: str | None = None
    slug: str | None = None
    order: int | None = None
    visibility: str | None = None


class ReorderItem(BaseModel):
    id: str
    order: int


class ReorderBody(BaseModel):
    items: list[ReorderItem]


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    collection = db[CONTENTS_COLLECTION]
    await collection.create_index([("competition_id", 1), ("slug", 1)], unique=True)
    await collection.create_index([("competition_id", 1), ("order", 1)])


async def list_contents(db, competition_id) -> list[dict]:
    return [
        content
        async for content in db[CONTENTS_COLLECTION]
        .find({"competition_id": competition_id})
        .sort([("order", 1), ("_id", 1)])
    ]


async def get_content(db, competition_id, content_id: str) -> dict | None:
    try:
        oid = ObjectId(content_id)
    except Exception:
        return None
    return await db[CONTENTS_COLLECTION].find_one(
        {"_id": oid, "competition_id": competition_id}
    )


async def insert_content(db, competition_id, data: ContentCreate) -> dict:
    order = data.order
    if order is None:
        last = await db[CONTENTS_COLLECTION].find_one(
            {"competition_id": competition_id}, sort=[("order", -1)]
        )
        order = (last["order"] if last else 0) + 10
    now = datetime.now(timezone.utc)
    oid = ObjectId()
    document = {
        "_id": oid,
        "competition_id": competition_id,
        "title": data.title.strip(),
        "slug": data.slug,
        "order": order,
        "visibility": data.visibility,
        "markdown_path": f"competitions/{competition_id}/content/{oid}.md",
        "size_bytes": None,
        "created_at": now,
        "updated_at": now,
    }
    await db[CONTENTS_COLLECTION].insert_one(document)
    return document


def validate_values(title=None, slug=None, order=None, visibility=None) -> None:
    if title is not None and not title.strip():
        raise ValueError("Tiêu đề nội dung không được để trống.")
    if slug is not None and not is_valid_slug(slug):
        raise ValueError("Slug nội dung chỉ gồm a-z, 0-9 và dấu gạch ngang.")
    if order is not None and not 0 <= order <= 9999:
        raise ValueError("Thứ tự phải từ 0 đến 9999.")
    if visibility is not None and visibility not in VISIBILITIES:
        raise ValueError("Visibility phải là public hoặc members.")


def public_content(content: dict, include_markdown: str | None = None) -> dict:
    result = {
        "id": str(content["_id"]),
        "slug": content["slug"],
        "title": content["title"],
        "order": content["order"],
        "visibility": content["visibility"],
        "size_bytes": content.get("size_bytes"),
        "updated_at": iso_z(content["updated_at"]),
    }
    if include_markdown is not None:
        result["markdown"] = include_markdown
    return result


