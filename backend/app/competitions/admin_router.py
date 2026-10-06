"""Admin competition API: list (kể cả draft), create, detail, edit, publish, close, reopen, clone, delete."""

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Query, Request
from bson import ObjectId
from bson.errors import InvalidId
from pymongo.errors import DuplicateKeyError

from app.auth.dependencies import AdminAccount
from app.competitions import clone as clone_service, service
from app.competitions import tracks as competition_tracks
from app.competitions.tracks import TRACKS
from app.core.config import get_settings
from app.core.datetimes import as_utc, iso_z
from app.core.errors import api_error
from app.core.slugs import is_valid_slug
from app.scoring import normalization
from app.scoring.readiness import blocked_reason, check_readiness
from app.scoring_attempts import store as attempts_store

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/competitions")

_SLUG_EXISTS_MESSAGE = "Slug này đã có cuộc thi khác dùng."
_JOIN_CODE_REQUIRED_MESSAGE = "Cần cấu hình mã tham gia trước khi publish cuộc thi."
# Số ứng viên tối đa cho slug clone trước khi bỏ cuộc - chặn vòng lặp vô hạn khi slug gốc quá dài.
_CLONE_SUFFIX = "-copy"
_CLONE_SLUG_ATTEMPTS = 5
# Log của _transition cần thì quá khứ; ghép `f"{action}d"` cho ra "reopend" nên phải khai tường minh.
_TRANSITION_PAST = {"publish": "published", "close": "closed", "reopen": "reopened"}
_TRACK_LABELS = {competition_tracks.PUBLIC: "Public", competition_tracks.PRIVATE: "Private"}


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
    query: dict = {"_id": competition["_id"]}
    if "normalization" in updates:
        # Cấu hình chuẩn hóa chỉ ghi khi cuộc thi còn nguyên trạng thái đã đọc: một lượt publish
        # xen giữa phải làm lượt ghi trượt (409) thay vì đổi luật của cuộc thi đã publish.
        query["status"] = "draft"
        query.update(normalization.config_guard(competition))
    result = await db[service.COMPETITIONS_COLLECTION].update_one(
        query, {"$set": {**updates, "updated_at": datetime.now(timezone.utc)}}
    )
    if result.matched_count == 0:
        raise api_error(
            409,
            "COMPETITION_CHANGED",
            "Cuộc thi vừa được thay đổi ở nơi khác, tải lại trang rồi thử lại.",
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
    extra_sets = {}
    if _is_dual(competition):
        # Khóa cấu hình chấm/GT ngay tại lượt publish (dual), giữ nguyên nếu đã set từ trước:
        # không cho chạy Public trước rồi nạp GT Private trong lúc cuộc thi đã chạy.
        now = datetime.now(timezone.utc)
        extra = {
            "scoring_locked_at": competition.get("scoring_locked_at") or now,
        }
        if competition_tracks.results_policy(competition) == competition_tracks.RESULT_POLICY_IMMEDIATE:
            # Chế độ hiện ngay: dấu mốc công bố được ghi ngay trong lượt publish.
            extra["tracks.private.results_published_at"] = now
            extra["tracks.private.results_published_by"] = admin["email"]
        extra_sets = _dual_control_sets(
            admin["email"],
            competition,
            action="publish",
            reason=None,
            extra=extra,
        )
    return await _transition(
        request,
        admin,
        competition_id,
        "draft",
        "published",
        "publish",
        guard={**_verified_config(competition), **normalization.config_guard(competition)},
        extra_sets=extra_sets,
    )


def _verified_config(competition: dict) -> dict:
    """Điều kiện ghi status: đúng bản cấu hình vừa qua cổng readiness.

    Không có điều kiện này thì một lần lưu cấu hình chen giữa lượt kiểm tra và lượt ghi sẽ publish
    một bộ chấm chưa xác minh. Cuộc thi v1 không có revision nên chỉ cần cấu hình chưa bị đổi sang v2.
    Publish còn ghép thêm guard chuẩn hóa (pin từng subfield vì field có thể vắng ở bản cũ) để
    baseline đã qua readiness là baseline được publish. Dual pin thêm bằng chứng chạy thử của từng
    nhánh: đó là thứ readiness vừa kiểm cho từng GT.
    """
    config = competition.get("scoring_config") or {}
    if config.get("version") == 2:
        guard = {"scoring_config.revision": config.get("revision")}
        if _is_dual(competition):
            for track in TRACKS:
                verification = (competition.get("tracks", {}).get(track) or {}).get("verification")
                if verification:
                    guard[f"tracks.{track}.verification.execution_fingerprint"] = verification.get(
                        "execution_fingerprint"
                    )
        return guard
    return {"scoring_config.version": {"$ne": 2}}


def _is_dual(competition: dict) -> bool:
    return competition_tracks.is_dual(competition)


def _dual_control_sets(
    admin_email: str, competition: dict, *, action: str, reason: str | None, extra: dict | None = None
) -> dict:
    """Vết thay đổi + revision của cuộc thi dual trong cùng lượt ghi với state mới."""
    revision = int(competition.get("control_revision", 1)) + 1
    return {
        "control_revision": revision,
        "last_change": service.change_record(admin_email, action=action, reason=reason, revision=revision),
        **(extra or {}),
    }


@router.post("/{competition_id}/close")
async def close_competition(competition_id: str, request: Request, admin: AdminAccount) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    extra_sets = {}
    if _is_dual(competition):
        # Lệnh dừng quản trị: lượt đã admission theo generation cũ không sống lại khi mở lại.
        extra_sets = _dual_control_sets(
            admin["email"],
            competition,
            action="close",
            reason=None,
            extra={"stop_generation": int(competition.get("stop_generation", 0)) + 1},
        )
    return await _transition(
        request, admin, competition_id, "published", "closed", "close", extra_sets=extra_sets
    )


@router.post("/{competition_id}/reopen")
async def reopen_competition(
    competition_id: str, request: Request, admin: AdminAccount, body: service.ReopenRequest | None = None
) -> dict:
    """closed -> published. Chỉ đảo status, không kiểm tra lại readiness.

    Cuộc thi đã từng qua cổng publish nên đây là hoàn tác, không phải publish mới. `end_at`
    đã qua vẫn chặn join/nộp bài (độc lập với status) - admin dời ngày ở PATCH sau khi mở lại.
    Dual nhận lịch nhánh mới ngay trong transition này để khoảng mở lại là một lượt ghi atomic.
    """
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    body = body or service.ReopenRequest()
    if body.tracks is not None and not _is_dual(competition):
        raise api_error(422, "INVALID_TRACK", "Cuộc thi thông thường không có nhánh để đổi lịch.")
    if body.tracks is not None:
        _require_control_revision(competition, body.expected_revision, "mở lại")
        if not (body.reason or "").strip():
            raise api_error(422, "VALIDATION_ERROR", "Cần ghi lý do mở lại kèm lịch nhánh mới.")

    extra_sets = {}
    if _is_dual(competition):
        schedule_updates: dict = {}
        for track in TRACKS:
            data = getattr(body.tracks, track) if body.tracks else None
            if data is None:
                continue
            try:
                service.validate_track_schedule(_TRACK_LABELS[track], data)
            except ValueError as exc:
                raise api_error(422, "VALIDATION_ERROR", str(exc))
            schedule_updates.update(service.schedule_sets(competition, track, data))
        extra_sets = _dual_control_sets(
            admin["email"], competition, action="reopen", reason=body.reason, extra=schedule_updates
        )
        if schedule_updates:
            _log_schedule_change(admin, competition, body)
    return await _transition(
        request, admin, competition_id, "closed", "published", "reopen", extra_sets=extra_sets
    )


@router.patch("/{competition_id}/tracks/{track}/schedule")
async def update_track_schedule(
    competition_id: str,
    track: str,
    body: service.TrackScheduleRequest,
    request: Request,
    admin: AdminAccount,
) -> dict:
    """Gia hạn/chỉnh lịch một nhánh; khoảng tổng cập nhật trong cùng lượt ghi.

    Gia hạn và đổi lịch được cả khi Private đã công bố: công bố không đóng cửa nộp và không làm
    lượt công bố trước đó sai.
    """
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    _require_track(competition, track)
    if not body.reason.strip():
        raise api_error(422, "VALIDATION_ERROR", "Cần ghi lý do đổi lịch nhánh.")
    try:
        service.validate_track_schedule(_TRACK_LABELS[track], body)
    except ValueError as exc:
        raise api_error(422, "VALIDATION_ERROR", str(exc))
    _require_control_revision(competition, body.expected_revision, "đổi lịch")

    before = _track_schedule_view(competition, track)
    updates = service.schedule_sets(competition, track, body)
    revision = body.expected_revision + 1
    result = await db[service.COMPETITIONS_COLLECTION].update_one(
        {
            "_id": competition["_id"],
            "mode": competition_tracks.MODE_DUAL,
            "control_revision": body.expected_revision,
        },
        {
            "$set": {
                **updates,
                "control_revision": revision,
                "last_change": service.change_record(
                    admin["email"], action="track_schedule", reason=body.reason, revision=revision
                ),
                "updated_at": datetime.now(timezone.utc),
            }
        },
    )
    if result.matched_count == 0:
        raise api_error(
            409,
            "COMPETITION_REVISION_CONFLICT",
            "Cấu hình cuộc thi vừa thay đổi ở nơi khác, tải lại trang rồi thử lại.",
        )
    logger.info(
        "Admin %s changed track schedule competition=%s track=%s before=%s after=%s reason=%s",
        admin["email"],
        competition["slug"],
        track,
        before,
        _track_schedule_view_updates(updates, track),
        body.reason,
    )
    return _admin_detail(await _get_competition_or_404(db, competition_id))


@router.patch("/{competition_id}/tracks/private/policy")
async def update_private_policy(
    competition_id: str, body: service.PrivatePolicyRequest, request: Request, admin: AdminAccount
) -> dict:
    """Chính sách công bố Private trước lần công bố đầu tiên.

    Kết quả đã công bố không thể trở lại bí mật: đổi chính sách sau release bị từ chối thay vì
    ghi một cấu hình không còn tác dụng.
    """
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    _require_track(competition, competition_tracks.PRIVATE)
    released = competition_tracks.results_released(competition, competition_tracks.PRIVATE)
    if not body.reason.strip():
        raise api_error(422, "VALIDATION_ERROR", "Cần ghi lý do đổi chính sách công bố.")
    changes: dict = {}
    if body.result_policy is not None:
        if body.result_policy not in competition_tracks.RESULT_POLICIES:
            raise api_error(422, "VALIDATION_ERROR", "Chính sách công bố phải là immediate hoặc manual.")
        if released and body.result_policy != competition_tracks.results_policy(competition):
            raise api_error(
                409,
                "RESULTS_ALREADY_RELEASED",
                "Kết quả Private đã công bố, không thể trở lại bí mật.",
            )
        changes["tracks.private.result_policy"] = body.result_policy
    if body.publish_condition is not None:
        if body.publish_condition not in competition_tracks.PUBLISH_CONDITIONS:
            raise api_error(
                422,
                "VALIDATION_ERROR",
                "Điều kiện công bố phải là admin_decides hoặc after_closed_and_scored.",
            )
        changes["tracks.private.publish_condition"] = body.publish_condition
    _require_control_revision(competition, body.expected_revision, "đổi chính sách công bố")

    now = datetime.now(timezone.utc)
    reveal = (
        body.result_policy == competition_tracks.RESULT_POLICY_IMMEDIATE and not released
    )
    if reveal and not body.confirm_reveal:
        raise api_error(
            422,
            "VALIDATION_ERROR",
            "Chuyển sang hiện điểm ngay sẽ công bố kết quả Private vĩnh viễn; cần xác nhận reveal.",
        )
    if reveal and competition["status"] != "draft":
        # Bật hiện ngay trong cuộc thi đang chạy: dấu mốc công bố ghi ngay tại xác nhận.
        changes["tracks.private.results_published_at"] = now
        changes["tracks.private.results_published_by"] = admin["email"]

    revision = body.expected_revision + 1
    result = await db[service.COMPETITIONS_COLLECTION].update_one(
        {
            "_id": competition["_id"],
            "mode": competition_tracks.MODE_DUAL,
            "control_revision": body.expected_revision,
        },
        {
            "$set": {
                **changes,
                "control_revision": revision,
                "last_change": service.change_record(
                    admin["email"], action="private_policy", reason=body.reason, revision=revision
                ),
                "updated_at": now,
            }
        },
    )
    if result.matched_count == 0:
        raise api_error(
            409,
            "COMPETITION_REVISION_CONFLICT",
            "Cấu hình cuộc thi vừa thay đổi ở nơi khác, tải lại trang rồi thử lại.",
        )
    logger.info(
        "Admin %s updated private policy competition=%s policy=%s condition=%s revealed=%s reason=%s",
        admin["email"],
        competition["slug"],
        competition_tracks.results_policy(competition),
        competition_tracks.publish_condition(competition),
        reveal,
        body.reason,
    )
    return _admin_detail(await _get_competition_or_404(db, competition_id))


@router.post("/{competition_id}/tracks/private/publish-results")
async def publish_private_results(
    competition_id: str, body: service.PublishResultsRequest, request: Request, admin: AdminAccount
) -> dict:
    """Công bố kết quả Private (set-once, idempotent).

    Đã công bố rồi thì trả thành công với dấu mốc cũ - không kiểm lại deadline/điều kiện và không
    đổi actor/time, kể cả khi request đến sau một lần reopen. Chưa công bố thì điều kiện chặt được
    chứng minh tại thời điểm công bố và ghim vào CAS: cửa Private đã đóng, không còn intent/attempt
    Private chưa kết thúc, revision và admission sequence còn đúng bản đã đọc.
    """
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    _require_track(competition, competition_tracks.PRIVATE)
    if competition_tracks.results_released(competition, competition_tracks.PRIVATE):
        return _admin_detail(competition)
    if competition["status"] == "draft":
        raise api_error(422, "VALIDATION_ERROR", "Cần publish cuộc thi trước khi công bố kết quả Private.")

    now = datetime.now(timezone.utc)
    guard = {
        "mode": competition_tracks.MODE_DUAL,
        "control_revision": body.expected_revision,
        "tracks.private.results_published_at": None,
    }
    if competition_tracks.publish_condition(competition) == competition_tracks.PUBLISH_AFTER_CLOSED_AND_SCORED:
        _, end = competition_tracks.track_schedule(competition, competition_tracks.PRIVATE)
        if as_utc(now) < as_utc(end):
            raise api_error(
                409,
                "RELEASE_CONDITION_NOT_MET",
                "Private vẫn đang trong thời gian nhận bài; chưa công bố được.",
                detail={"reason": "open"},
            )
        active = await db[attempts_store.ATTEMPTS_COLLECTION].count_documents(
            {
                "competition_id": competition["_id"],
                "track": competition_tracks.PRIVATE,
                "status": {"$in": list(attempts_store.ACTIVE_STATUSES)},
            }
        )
        if active:
            raise api_error(
                409,
                "RELEASE_CONDITION_NOT_MET",
                "Private còn bài đã nhận đang xử lý; chưa công bố được.",
                detail={"reason": "processing", "active_attempts": active},
            )
        # Điều kiện đã chứng minh dưới cấu hình này: CAS phải ghim lại đúng cấu hình và sequence
        # đã đọc, nếu không một lượt admission/reopen xen giữa sẽ bị bỏ qua.
        guard["tracks.private.publish_condition"] = competition_tracks.PUBLISH_AFTER_CLOSED_AND_SCORED
        guard["tracks.private.admission_seq"] = int(
            (competition.get("tracks", {}).get(competition_tracks.PRIVATE) or {}).get("admission_seq", 0)
        )

    revision = body.expected_revision + 1
    result = await db[service.COMPETITIONS_COLLECTION].update_one(
        {"_id": competition["_id"], **guard},
        {
            "$set": {
                "tracks.private.results_published_at": now,
                "tracks.private.results_published_by": admin["email"],
                "control_revision": revision,
                "last_change": service.change_record(
                    admin["email"], action="publish_results", reason=body.reason, revision=revision
                ),
                "updated_at": now,
            }
        },
    )
    if result.matched_count == 0:
        current = await _get_competition_or_404(db, competition_id)
        if competition_tracks.results_released(current, competition_tracks.PRIVATE):
            # Một request công bố khác đã thắng: cùng quy tắc idempotent, giữ marker của họ.
            return _admin_detail(current)
        raise api_error(
            409,
            "COMPETITION_REVISION_CONFLICT",
            "Cấu hình cuộc thi vừa thay đổi ở nơi khác, tải lại trang rồi thử lại.",
        )
    logger.info(
        "Admin %s published private results competition=%s condition=%s",
        admin["email"],
        competition["slug"],
        competition_tracks.publish_condition(competition),
    )
    return _admin_detail(await _get_competition_or_404(db, competition_id))


def _require_track(competition: dict, track: str) -> None:
    if not _is_dual(competition):
        raise api_error(422, "INVALID_TRACK", "Cuộc thi thông thường không có nhánh Public/Private.")
    if track not in _TRACK_LABELS:
        raise api_error(422, "INVALID_TRACK", "Nhánh không hợp lệ; chỉ có public hoặc private.")


def _track_schedule_view(competition: dict, track: str) -> dict:
    start, end = competition_tracks.track_schedule(competition, track)
    config = competition_tracks.track_config(competition, track) or {}
    return {
        "start_at": iso_z(start),
        "end_at": iso_z(end),
        "quota_per_day": config.get("quota_per_day"),
    }


def _track_schedule_view_updates(updates: dict, track: str) -> dict:
    return {
        "start_at": iso_z(updates[f"tracks.{track}.start_at"]),
        "end_at": iso_z(updates[f"tracks.{track}.end_at"]),
    }


def _require_control_revision(competition: dict, expected_revision: int | None, action: str) -> None:
    current = int(competition.get("control_revision", 1))
    if expected_revision is None or expected_revision != current:
        raise api_error(
            409,
            "COMPETITION_REVISION_CONFLICT",
            f"Cấu hình cuộc thi đã thay đổi ở nơi khác, tải lại trang rồi {action} lại.",
            detail={"control_revision": current},
        )


def _log_schedule_change(admin, competition: dict, body: service.ReopenRequest) -> None:
    """Log cấu trúc before/after của lịch, không chứa GT hay secret."""
    before = {
        track: {
            "start_at": iso_z(competition_tracks.track_schedule(competition, track)[0]),
            "end_at": iso_z(competition_tracks.track_schedule(competition, track)[1]),
        }
        for track in TRACKS
    }
    after = {}
    for track in TRACKS:
        data = getattr(body.tracks, track) if body.tracks else None
        if data is None:
            after[track] = before[track]
        else:
            after[track] = {"start_at": iso_z(data.start_at), "end_at": iso_z(data.end_at)}
    logger.info(
        "Admin %s changed track schedules competition=%s before=%s after=%s reason=%s",
        admin["email"],
        competition["slug"],
        before,
        after,
        body.reason,
    )


async def _transition(
    request: Request,
    admin: AdminAccount,
    competition_id: str,
    expected: str,
    target: str,
    action: str,
    *,
    guard: dict | None = None,
    extra_sets: dict | None = None,
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    if competition["status"] != expected:
        raise api_error(
            422,
            "INVALID_TRANSITION",
            f"Không thể {action} cuộc thi đang ở trạng thái {competition['status']}.",
        )
    # Trạng thái đã đọc được ghim ngay trong filter: một lượt close/reopen/publish khác xen giữa
    # phải làm lượt ghi trượt thay vì áp thao tác dựa trên trạng thái cũ.
    query = {"_id": competition["_id"], "status": expected, **(guard or {})}
    result = await db[service.COMPETITIONS_COLLECTION].update_one(
        query,
        {
            "$set": {
                "status": target,
                "updated_at": datetime.now(timezone.utc),
                **(extra_sets or {}),
            }
        },
    )
    if result.matched_count == 0:
        current = await _get_competition_or_404(db, competition_id)
        if current["status"] != expected:
            raise api_error(
                422,
                "INVALID_TRANSITION",
                f"Trạng thái cuộc thi vừa thay đổi, tải lại trang rồi {action} lại.",
            )
        raise api_error(
            409,
            "SCORING_REVISION_CONFLICT",
            "Cấu hình chấm điểm vừa thay đổi, tải lại trang rồi publish lại.",
        )
    logger.info("Admin %s %s competition %s", admin["email"], _TRANSITION_PAST[action], competition["slug"])
    return _admin_detail(await _get_competition_or_404(db, competition_id))


@router.post("/{competition_id}/clone", status_code=201)
async def clone_competition(competition_id: str, request: Request, admin: AdminAccount) -> dict:
    """Clone đề, bộ chấm và AI key thành draft riêng; không mang lịch sử hay mã tham gia."""
    db = request.app.state.mongo.db
    source = await _get_competition_or_404(db, competition_id)
    data_snapshot = await clone_service.snapshot(db, source, admin_id=admin["_id"])
    for attempt in range(1, _CLONE_SLUG_ATTEMPTS + 1):
        # Ứng viên phải hợp lệ và nằm trong giới hạn trước khi tra DB; slug gốc dài có thể cắt cụt.
        slug = _clone_slug_candidate(source["slug"], attempt)
        if not is_valid_slug(slug) or await service.find_competition_by_slug(db, slug) is not None:
            continue
        now = datetime.now(timezone.utc)
        common = {
            "slug": slug,
            "name": f"{source['name']} (bản sao)",
            "short_description": source.get("short_description", ""),
            "join_mode": source["join_mode"],
            "primary_metric": source["primary_metric"],
            "leaderboard_visible": source["leaderboard_visible"],
            "resources": service.public_resources(source),
            "normalization": data_snapshot.normalization,
        }
        if competition_tracks.is_dual(source):
            # Dịch cả hai cửa sổ theo cùng độ lệch để cửa sổ sớm nhất mở tại `now`, giữ nguyên
            # thời lượng và quan hệ overlap/gap; admin chỉnh tiếp ở draft.
            starts = [competition_tracks.track_schedule(source, track)[0] for track in TRACKS]
            offset = now - min(starts)
            data = service.CompetitionCreate(
                **common,
                mode=competition_tracks.MODE_DUAL,
                public_track=_clone_track(source, competition_tracks.PUBLIC, offset),
                private_track=_clone_track(source, competition_tracks.PRIVATE, offset),
            )
        else:
            data = service.CompetitionCreate(
                **common,
                start_at=now,
                end_at=now + timedelta(days=365),
                quota_per_day=source["quota_per_day"],
            )
        try:
            clone = await service.insert_competition(db, data, created_by=admin["email"])
        except DuplicateKeyError:
            continue  # Request khác vừa chiếm slug - thử ứng viên kế tiếp.
        clone = await clone_service.populate(db, clone, data_snapshot)
        logger.info("Admin %s cloned competition %s -> %s", admin["email"], source["slug"], slug)
        return _admin_detail(clone)
    raise api_error(409, "SLUG_EXISTS", _SLUG_EXISTS_MESSAGE)


def _clone_track(source: dict, track: str, offset: timedelta) -> service.CompetitionTrackCreate:
    """Nhánh của bản sao: quota, tài nguyên và chính sách giữ nguyên, lịch dịch theo `offset`."""
    start, end = competition_tracks.track_schedule(source, track)
    track_data: dict = {
        "start_at": start + offset,
        "end_at": end + offset,
        "quota_per_day": competition_tracks.track_quota(source, track),
        "resources": competition_tracks.track_resources(source, track),
    }
    if track == competition_tracks.PRIVATE:
        track_data["result_policy"] = competition_tracks.results_policy(source)
        track_data["publish_condition"] = competition_tracks.publish_condition(source)
    return service.CompetitionTrackCreate(**track_data)


def _clone_slug_candidate(base_slug: str, attempt: int) -> str:
    """Slug clone cho lần thử thứ `attempt` (từ 1): base + '-copy', các lần sau thêm số.

    Cắt base để tổng không vượt SLUG_MAX rồi bỏ gạch ngang cuối - nếu không, base dài sát
    giới hạn sẽ tạo ra slug kết thúc bằng '-' (không hợp lệ).
    """
    suffix = _CLONE_SUFFIX if attempt == 1 else f"{_CLONE_SUFFIX}{attempt}"
    stem = base_slug[: service._SLUG_MAX - len(suffix)].rstrip("-")
    return f"{stem}{suffix}"
