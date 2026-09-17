"""Admin competition API: list (kể cả draft), create, detail, edit, publish, close, clone."""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from bson import ObjectId
from bson.errors import InvalidId

from app.auth.dependencies import AdminAccount
from app.competitions import service
from app.core.errors import api_error

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/competitions")


async def _get_competition_or_404(db, competition_id: str) -> dict:
    try:
        oid = ObjectId(competition_id)
    except InvalidId:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    competition = await db[service.COMPETITIONS_COLLECTION].find_one({"_id": oid})
    if competition is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    return competition


@router.get("")
async def list_competitions(request: Request, admin: AdminAccount) -> dict:
    db = request.app.state.mongo.db
    cursor = db[service.COMPETITIONS_COLLECTION].find().sort("name", 1)
    documents = [competition async for competition in cursor]
    # Chỉ bảng admin cần số thành viên/bài nộp — endpoint public giữ nguyên payload.
    counts = await service.activity_counts(db, [document["_id"] for document in documents])
    return {
        "competitions": [
            {**service.public_competition(document), **counts[document["_id"]]}
            for document in documents
        ]
    }


@router.post("", status_code=201)
async def create_competition(body: service.CompetitionCreate, request: Request, admin: AdminAccount) -> dict:
    try:
        service.validate_create(body)
    except ValueError as exc:
        raise api_error(422, "VALIDATION_ERROR", str(exc))
    db = request.app.state.mongo.db
    if await service.find_competition_by_slug(db, body.slug) is not None:
        raise api_error(409, "SLUG_EXISTS", "Slug này đã có cuộc thi khác dùng.")
    competition = await service.insert_competition(db, body, created_by=admin["email"])
    logger.info("Admin %s created competition slug=%s", admin["email"], competition["slug"])
    return service.public_competition(competition)


@router.get("/{competition_id}")
async def get_competition(competition_id: str, request: Request, admin: AdminAccount) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    return service.public_competition(competition)


@router.patch("/{competition_id}")
async def edit_competition(
    competition_id: str, body: service.CompetitionUpdate, request: Request, admin: AdminAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    # slug/status/created_by không nhận từ body — model không có field đó nên bỏ qua an toàn
    try:
        updates = service.validate_update(competition, body.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise api_error(422, "VALIDATION_ERROR", str(exc))
    if not updates:
        return service.public_competition(competition)
    await db[service.COMPETITIONS_COLLECTION].update_one(
        {"_id": competition["_id"]},
        {"$set": {**updates, "updated_at": datetime.now(timezone.utc)}},
    )
    logger.info("Admin %s edited competition %s fields=%s", admin["email"], competition["slug"], sorted(updates))
    return service.public_competition(await _get_competition_or_404(db, competition_id))


@router.post("/{competition_id}/publish")
async def publish_competition(competition_id: str, request: Request, admin: AdminAccount) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    if competition["join_mode"] == "code" and not competition.get("join_code_hash"):
        raise api_error(
            422,
            "JOIN_CODE_REQUIRED",
            "Cần cấu hình mã tham gia trước khi publish cuộc thi.",
        )
    return await _transition(request, admin, competition_id, "draft", "published", "publish")


@router.post("/{competition_id}/close")
async def close_competition(competition_id: str, request: Request, admin: AdminAccount) -> dict:
    return await _transition(request, admin, competition_id, "published", "closed", "close")


async def _transition(request: Request, admin: AdminAccount, competition_id: str, expected: str, target: str, action: str) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    if competition["status"] != expected:
        raise api_error(
            422,
            "INVALID_TRANSITION",
            f"Không thể {action} cuộc thi đang ở trạng thái {competition['status']}.",
        )
    await db[service.COMPETITIONS_COLLECTION].update_one(
        {"_id": competition["_id"]},
        {"$set": {"status": target, "updated_at": datetime.now(timezone.utc)}},
    )
    logger.info("Admin %s %sd competition %s", admin["email"], action, competition["slug"])
    return service.public_competition(await _get_competition_or_404(db, competition_id))


@router.post("/{competition_id}/clone", status_code=201)
async def clone_competition(competition_id: str, request: Request, admin: AdminAccount) -> dict:
    """Clone config baseline thành draft mới. KHÔNG copy status/dates/submissions/memberships (ADR-009)."""
    db = request.app.state.mongo.db
    source = await _get_competition_or_404(db, competition_id)
    slug = await _next_clone_slug(db, source["slug"])
    data = service.CompetitionCreate(
        slug=slug,
        name=f"{source['name']} (bản sao)",
        short_description=source.get("short_description", ""),
        start_at=datetime.now(timezone.utc),
        end_at=datetime.now(timezone.utc).replace(year=datetime.now(timezone.utc).year + 1),
        join_mode=source["join_mode"],
        primary_metric=source["primary_metric"],
        quota_per_day=source["quota_per_day"],
        leaderboard_visible=source["leaderboard_visible"],
    )
    clone = await service.insert_competition(db, data, created_by=admin["email"])
    logger.info("Admin %s cloned competition %s -> %s", admin["email"], source["slug"], slug)
    return service.public_competition(clone)


async def _next_clone_slug(db, base_slug: str) -> str:
    suffix = "-copy"
    slug = f"{base_slug}{suffix}"
    n = 2
    while await service.find_competition_by_slug(db, slug) is not None:
        slug = f"{base_slug}{suffix}{n}"
        n += 1
    return slug[: service._SLUG_MAX]
