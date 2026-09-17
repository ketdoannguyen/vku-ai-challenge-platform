"""Admin competition API: list (kể cả draft), create, detail, edit, publish, close, clone."""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Query, Request
from bson import ObjectId
from bson.errors import InvalidId

from app.auth.dependencies import AdminAccount
from app.competitions import service
from app.core.errors import api_error
from app.scoring.readiness import blocked_reason, check_readiness

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
            {**service.admin_competition(document), **counts[document["_id"]]}
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
    return _admin_detail(competition)


@router.get("/{competition_id}")
async def get_competition(competition_id: str, request: Request, admin: AdminAccount) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    return _admin_detail(competition)


def _admin_detail(competition: dict) -> dict:
    """Detail kèm trạng thái publish-readiness — dùng cho detail VÀ mọi response mutate.

    UI sửa/clone/publish xong ghi thẳng response vào state, nên response mutate thiếu readiness
    sẽ làm banner publish biến mất sai. List cố ý không gọi hàm này: readiness phải đọc file
    ground truth nên không được chạy cho từng dòng của bảng admin.
    """
    readiness = check_readiness(competition)
    return {
        **service.admin_competition(competition),
        "publish_ready": readiness.ready,
        "publish_blocked_reason": blocked_reason(readiness),
    }


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
        return _admin_detail(competition)
    await db[service.COMPETITIONS_COLLECTION].update_one(
        {"_id": competition["_id"]},
        {"$set": {**updates, "updated_at": datetime.now(timezone.utc)}},
    )
    logger.info("Admin %s edited competition %s fields=%s", admin["email"], competition["slug"], sorted(updates))
    return _admin_detail(await _get_competition_or_404(db, competition_id))


@router.delete("/{competition_id}")
async def delete_competition(
    competition_id: str,
    request: Request,
    admin: AdminAccount,
    confirm_slug: str = Query(...),
) -> dict:
    """Xoá cuộc thi nháp kèm toàn bộ dữ liệu con.

    Chỉ draft: published/closed phải giữ lịch sử thi, muốn kết thúc thì Đóng cuộc thi.
    `confirm_slug` buộc admin gõ đúng slug — thao tác này không hoàn tác được.
    """
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    if competition["status"] != "draft":
        raise api_error(
            409,
            "COMPETITION_NOT_DELETABLE",
            "Chỉ xoá được cuộc thi ở trạng thái Nháp. Hãy Đóng cuộc thi để giữ lịch sử.",
        )
    if confirm_slug != competition["slug"]:
        raise api_error(422, "CONFIRM_SLUG_MISMATCH", "Slug xác nhận không khớp với cuộc thi cần xoá.")

    await service.delete_competition_cascade(db, competition)
    files_removed = service.remove_competition_files(competition["_id"])
    logger.info(
        "Admin %s deleted competition %s (files_removed=%s)", admin["email"], competition["slug"], files_removed
    )
    return {
        "deleted": True,
        "competition_id": str(competition["_id"]),
        "slug": competition["slug"],
        # False = DB đã xoá nhưng còn file không dọn được; UI báo partial thay vì im lặng.
        "files_removed": files_removed,
    }


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
    readiness = check_readiness(competition)
    if not readiness.ready:
        raise api_error(422, readiness.code, readiness.message)
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
    return _admin_detail(await _get_competition_or_404(db, competition_id))


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
        resources=service.public_resources(source),
    )
    clone = await service.insert_competition(db, data, created_by=admin["email"])
    logger.info("Admin %s cloned competition %s -> %s", admin["email"], source["slug"], slug)
    return _admin_detail(clone)


async def _next_clone_slug(db, base_slug: str) -> str:
    suffix = "-copy"
    slug = f"{base_slug}{suffix}"
    n = 2
    while await service.find_competition_by_slug(db, slug) is not None:
        slug = f"{base_slug}{suffix}{n}"
        n += 1
    return slug[: service._SLUG_MAX]
