"""Admin competition API: list (kể cả draft), create, detail, edit, publish, close, reopen, clone, delete."""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Query, Request
from bson import ObjectId
from bson.errors import InvalidId
from pymongo.errors import DuplicateKeyError

from app.auth.dependencies import AdminAccount
from app.competitions import service
from app.core.config import get_settings
from app.core.errors import api_error
from app.core.slugs import is_valid_slug
from app.scoring.readiness import blocked_reason, check_readiness

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/competitions")

_SLUG_EXISTS_MESSAGE = "Slug này đã có cuộc thi khác dùng."
_JOIN_CODE_REQUIRED_MESSAGE = "Cần cấu hình mã tham gia trước khi publish cuộc thi."
# Số ứng viên tối đa cho slug clone trước khi bỏ cuộc - chặn vòng lặp vô hạn khi slug gốc quá dài.
_CLONE_SUFFIX = "-copy"
_CLONE_SLUG_ATTEMPTS = 5
# Log của _transition cần thì quá khứ; ghép `f"{action}d"` cho ra "reopend" nên phải khai tường minh.
_TRANSITION_PAST = {"publish": "published", "close": "closed", "reopen": "reopened"}


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
    # Chỉ bảng admin cần số thành viên/bài nộp - endpoint public giữ nguyên payload.
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
        raise api_error(409, "SLUG_EXISTS", _SLUG_EXISTS_MESSAGE)
    try:
        competition = await service.insert_competition(db, body, created_by=admin["email"])
    except DuplicateKeyError:
        # Hai request cùng slug có thể cùng vượt bước kiểm tra trên; index unique là chốt cuối.
        raise api_error(409, "SLUG_EXISTS", _SLUG_EXISTS_MESSAGE)
    logger.info("Admin %s created competition slug=%s", admin["email"], competition["slug"])
    return _admin_detail(competition)


@router.get("/{competition_id}")
async def get_competition(competition_id: str, request: Request, admin: AdminAccount) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    return _admin_detail(competition)


def _publish_blocked_reason(competition: dict) -> dict | None:
    """Cổng publish thật, theo đúng thứ tự ADR-017: mã tham gia trước, rồi readiness chấm điểm.

    Publish và banner admin phải đi qua **cùng** hàm này, nếu không banner sẽ báo "sẵn sàng"
    trong khi endpoint vẫn 422 - đúng lỗi đã xảy ra với `JOIN_CODE_REQUIRED`.
    """
    if competition["join_mode"] == "code" and not competition.get("join_code_hash"):
        return {"code": "JOIN_CODE_REQUIRED", "message": _JOIN_CODE_REQUIRED_MESSAGE}
    return blocked_reason(check_readiness(competition))


def _admin_detail(competition: dict) -> dict:
    """Detail kèm trạng thái publish-readiness - dùng cho detail VÀ mọi response mutate.

    UI sửa/clone/publish xong ghi thẳng response vào state, nên response mutate thiếu readiness
    sẽ làm banner publish biến mất sai. List cố ý không gọi hàm này: readiness phải đọc file
    ground truth nên không được chạy cho từng dòng của bảng admin.
    """
    blocked = _publish_blocked_reason(competition)
    settings = get_settings()
    return {
        **service.admin_competition(competition),
        "publish_ready": blocked is None,
        "publish_blocked_reason": blocked,
        # Trần upload là cấu hình môi trường, không lưu theo cuộc thi (ADR-011);
        # đọc tại thời điểm request để UI hiển thị đúng giá trị đang áp dụng.
        "upload_limits": {
            "submission_mb": settings.max_upload_mb,
            "notebook_mb": settings.max_notebook_mb,
            "content_mb": settings.max_content_mb,
            "asset_mb": settings.max_asset_mb,
        },
    }


@router.patch("/{competition_id}")
async def edit_competition(
    competition_id: str, body: service.CompetitionUpdate, request: Request, admin: AdminAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    # slug/status/created_by không nhận từ body - model không có field đó nên bỏ qua an toàn
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
    """Xoá cuộc thi kèm toàn bộ dữ liệu con.

    `draft` và `closed` xoá được; `published` phải Kết thúc trước - cuộc thi đang chạy không
    bị xoá nhầm, và trạng thái closed là bước xác nhận có chủ đích trước khi mất lịch sử thi.
    `confirm_slug` buộc admin gõ đúng slug - thao tác này không hoàn tác được.
    """
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    if competition["status"] == "published":
        raise api_error(
            409,
            "COMPETITION_NOT_DELETABLE",
            "Cuộc thi đang chạy phải Kết thúc trước khi xoá.",
        )
    if confirm_slug != competition["slug"]:
        raise api_error(422, "CONFIRM_SLUG_MISMATCH", "Slug xác nhận không khớp với cuộc thi cần xoá.")

    await service.delete_competition_cascade(db, competition)
    files_removed = await service.remove_competition_files(
        competition["_id"], competition["slug"]
    )
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
    blocked = _publish_blocked_reason(competition)
    if blocked:
        raise api_error(422, blocked["code"], blocked["message"])
    return await _transition(request, admin, competition_id, "draft", "published", "publish")


@router.post("/{competition_id}/close")
async def close_competition(competition_id: str, request: Request, admin: AdminAccount) -> dict:
    return await _transition(request, admin, competition_id, "published", "closed", "close")


@router.post("/{competition_id}/reopen")
async def reopen_competition(competition_id: str, request: Request, admin: AdminAccount) -> dict:
    """closed -> published. Chỉ đảo status, không kiểm tra lại readiness.

    Cuộc thi đã từng qua cổng publish nên đây là hoàn tác, không phải publish mới. `end_at`
    đã qua vẫn chặn join/nộp bài (độc lập với status) - admin dời ngày ở PATCH sau khi mở lại.
    """
    return await _transition(request, admin, competition_id, "closed", "published", "reopen")


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
    logger.info("Admin %s %s competition %s", admin["email"], _TRANSITION_PAST[action], competition["slug"])
    return _admin_detail(await _get_competition_or_404(db, competition_id))


@router.post("/{competition_id}/clone", status_code=201)
async def clone_competition(competition_id: str, request: Request, admin: AdminAccount) -> dict:
    """Clone config baseline thành draft mới. KHÔNG copy status/dates/submissions/memberships (ADR-009)."""
    db = request.app.state.mongo.db
    source = await _get_competition_or_404(db, competition_id)
    for attempt in range(1, _CLONE_SLUG_ATTEMPTS + 1):
        # Ứng viên phải hợp lệ và nằm trong giới hạn trước khi tra DB; slug gốc dài có thể cắt cụt.
        slug = _clone_slug_candidate(source["slug"], attempt)
        if not is_valid_slug(slug) or await service.find_competition_by_slug(db, slug) is not None:
            continue
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
        try:
            clone = await service.insert_competition(db, data, created_by=admin["email"])
        except DuplicateKeyError:
            continue  # Request khác vừa chiếm slug - thử ứng viên kế tiếp.
        logger.info("Admin %s cloned competition %s -> %s", admin["email"], source["slug"], slug)
        return _admin_detail(clone)
    raise api_error(409, "SLUG_EXISTS", _SLUG_EXISTS_MESSAGE)


def _clone_slug_candidate(base_slug: str, attempt: int) -> str:
    """Slug clone cho lần thử thứ `attempt` (từ 1): base + '-copy', các lần sau thêm số.

    Cắt base để tổng không vượt SLUG_MAX rồi bỏ gạch ngang cuối - nếu không, base dài sát
    giới hạn sẽ tạo ra slug kết thúc bằng '-' (không hợp lệ).
    """
    suffix = _CLONE_SUFFIX if attempt == 1 else f"{_CLONE_SUFFIX}{attempt}"
    stem = base_slug[: service._SLUG_MAX - len(suffix)].rstrip("-")
    return f"{stem}{suffix}"
