"""Competition service: validation, tạo/tra cứu, public representation.

Lifecycle (ADR-009, ADR-027): create -> draft; draft -> published; published -> closed;
closed -> published (reopen). Xoá được ở draft và closed, không xoá được published.
"""

import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.competitions import tracks as competition_tracks
from app.competitions.tracks import (
    MODE_DUAL,
    MODE_SINGLE,
    PRIVATE,
    PUBLIC,
    TRACKS,
)
from app.content import storage
from app.core.config import get_settings
from app.core.datetimes import as_utc, iso_z
from app.core.slugs import SLUG_MAX, is_valid_slug
from app.scoring import normalization
from app.scoring.normalization import NormalizationRequest

logger = logging.getLogger(__name__)

COMPETITIONS_COLLECTION = "competitions"

STATUSES = ("draft", "published", "closed")
JOIN_MODES = ("open", "code", "invite_only")
METRICS = ("f1", "precision", "recall")

_SLUG_MAX = SLUG_MAX
_QUOTA_MAX = 1000

# Tài nguyên cuộc thi chỉ là link ngoài (Drive, S3 hay nguồn khác) - nền tảng không host dataset/binary.
RESOURCES_MAX = 10
_RESOURCE_LABEL_MAX = 120
_RESOURCE_URL_MAX = 2048

# Edit rule theo status (ADR-009): draft sửa mọi field config;
# published không đổi primary_metric (ảnh hưởng leaderboard đã có); closed read-only.
_LOCKED_WHEN_PUBLISHED = ("primary_metric",)
_EDITABLE_NEVER = ("slug", "status", "created_by")


class CompetitionResource(BaseModel):
    label: str
    url: str


class CompetitionTrackCreate(BaseModel):
    """Cấu hình riêng của một nhánh lúc tạo cuộc thi; phần chung vẫn ở `CompetitionCreate`."""

    start_at: datetime
    end_at: datetime
    quota_per_day: int = 5
    resources: list[CompetitionResource] = Field(default_factory=list)
    result_policy: str = competition_tracks.RESULT_POLICY_DEFAULT
    publish_condition: str = competition_tracks.PUBLISH_CONDITION_DEFAULT


class CompetitionCreate(BaseModel):
    slug: str
    name: str
    short_description: str = ""
    # `mode` vắng nghĩa là single; dual dùng lịch của từng nhánh nên bỏ trống start/end cấp cuộc thi.
    mode: str = MODE_SINGLE
    start_at: datetime | None = None
    end_at: datetime | None = None
    join_mode: str = "open"
    primary_metric: str = "f1"
    quota_per_day: int = 5
    leaderboard_visible: bool = True
    resources: list[CompetitionResource] = Field(default_factory=list)
    normalization: NormalizationRequest | None = None
    public_track: CompetitionTrackCreate | None = None
    private_track: CompetitionTrackCreate | None = None


class CompetitionUpdate(BaseModel):
    name: str | None = None
    short_description: str | None = None
    start_at: datetime | None = None
    end_at: datetime | None = None
    join_mode: str | None = None
    primary_metric: str | None = None
    quota_per_day: int | None = None
    leaderboard_visible: bool | None = None
    resources: list[CompetitionResource] | None = None
    normalization: NormalizationRequest | None = None


class TrackScheduleIn(BaseModel):
    """Lịch mới của một nhánh; quota bỏ trống nghĩa là giữ nguyên."""

    start_at: datetime
    end_at: datetime
    quota_per_day: int | None = None


class TrackScheduleRequest(TrackScheduleIn):
    """Gia hạn/chỉnh lịch một nhánh. `expected_revision` chặn hai admin ghi đè nhau."""

    expected_revision: int
    reason: str


class PrivatePolicyRequest(BaseModel):
    """Chính sách công bố kết quả Private trước lần công bố đầu tiên."""

    result_policy: str | None = None
    publish_condition: str | None = None
    expected_revision: int
    reason: str
    # Chuyển sang "hiện ngay" là mở kết quả vĩnh viễn: phải xác nhận tường minh, không suy ra từ lựa chọn khác.
    confirm_reveal: bool = False


class PublishResultsRequest(BaseModel):
    """Công bố kết quả Private; idempotent nên lặp lại sau khi đã công bố vẫn thành công."""

    expected_revision: int
    reason: str | None = None


class ReopenTrackSchedules(BaseModel):
    public: TrackScheduleIn | None = None
    private: TrackScheduleIn | None = None


class ReopenRequest(BaseModel):
    """Mở lại competition; dual nhận lịch nhánh mới tùy chọn trong cùng transition."""

    expected_revision: int | None = None
    reason: str | None = None
    tracks: ReopenTrackSchedules | None = None


def validate_track_schedule(label: str, data: TrackScheduleIn) -> None:
    if as_utc(data.start_at) >= as_utc(data.end_at):
        raise ValueError(f"Nhánh {label}: thời gian bắt đầu phải trước thời gian kết thúc.")
    if data.quota_per_day is not None and not 0 <= data.quota_per_day <= _QUOTA_MAX:
        raise ValueError(f"Nhánh {label}: quota mỗi ngày phải từ 0 đến {_QUOTA_MAX}.")


def change_record(admin_email: str, *, action: str, reason: str | None, revision: int) -> dict:
    """Vết thay đổi quản trị ghi cùng state update; không phải audit ledger bất biến."""
    return {
        "by": admin_email,
        "at": datetime.now(timezone.utc),
        "action": action,
        "reason": reason,
        "revision": revision,
    }


def schedule_sets(competition: dict, track: str, data: TrackScheduleIn) -> dict:
    """Các field $set của một lượt đổi lịch nhánh, kèm khoảng tổng cập nhật atomic.

    Envelope nằm cùng lượt ghi để mọi bản đọc thấy lịch cấp cuộc thi và lịch nhánh luôn khớp nhau.
    """
    updates: dict = {
        f"tracks.{track}.start_at": data.start_at,
        f"tracks.{track}.end_at": data.end_at,
    }
    if data.quota_per_day is not None:
        updates[f"tracks.{track}.quota_per_day"] = data.quota_per_day
    schedules = {}
    for candidate in TRACKS:
        if candidate == track:
            schedules[candidate] = (data.start_at, data.end_at)
        else:
            schedules[candidate] = competition_tracks.track_schedule(competition, candidate)
    start, end = competition_tracks.envelope(schedules)
    updates["start_at"] = start
    updates["end_at"] = end
    return updates


def normalize_resources(resources: list) -> list[dict]:
    """Chuẩn hoá + kiểm tra link tài nguyên. Raise ValueError với message tiếng Việt."""
    items = [item.model_dump() if isinstance(item, BaseModel) else dict(item) for item in resources]
    if len(items) > RESOURCES_MAX:
        raise ValueError(f"Mỗi cuộc thi tối đa {RESOURCES_MAX} tài nguyên.")
    normalized = []
    for item in items:
        label = _as_text(item.get("label"))
        url = _as_text(item.get("url"))
        if not label:
            raise ValueError("Tên tài nguyên không được để trống.")
        if len(label) > _RESOURCE_LABEL_MAX:
            raise ValueError(f"Tên tài nguyên tối đa {_RESOURCE_LABEL_MAX} ký tự.")
        normalized.append({"label": label, "url": _validate_resource_url(url)})
    return normalized


def _as_text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _validate_resource_url(url: str) -> str:
    if not url:
        raise ValueError("Link tài nguyên không được để trống.")
    if len(url) > _RESOURCE_URL_MAX:
        raise ValueError(f"Link tài nguyên tối đa {_RESOURCE_URL_MAX} ký tự.")
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
    except ValueError:
        # urlparse ném ValueError cho URL dị dạng (IPv6 hỏng, port ngoài dải...): 422 chứ không 500.
        raise ValueError("Link tài nguyên không hợp lệ.") from None
    if parsed.scheme != "https" or not hostname:
        raise ValueError("Link tài nguyên phải bắt đầu bằng https://.")
    if parsed.username or parsed.password:
        raise ValueError("Link tài nguyên không được chứa thông tin đăng nhập.")
    return url


def public_resources(competition: dict) -> list[dict]:
    """Document cũ chưa có field resources trả [] - không cần migration Mongo."""
    return competition.get("resources") or []


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COMPETITIONS_COLLECTION].create_index("slug", unique=True)


async def find_competition_by_slug(db: AsyncIOMotorDatabase, slug: str) -> dict | None:
    return await db[COMPETITIONS_COLLECTION].find_one({"slug": slug})


def _track_document(track: CompetitionTrackCreate, *, private: bool) -> dict:
    document = {
        "start_at": track.start_at,
        "end_at": track.end_at,
        "quota_per_day": track.quota_per_day,
        "resources": normalize_resources(track.resources),
        "ground_truth": None,
        # Bằng chứng chạy thử tách theo nhánh: GT của nhánh là một phần dấu vân tay của nhánh đó.
        "verification": None,
        "admission_seq": 0,
    }
    if private:
        document["result_policy"] = track.result_policy
        document["publish_condition"] = track.publish_condition
        document["results_published_at"] = None
        document["results_published_by"] = None
    return document


def _dual_document(data: CompetitionCreate) -> dict:
    """Khoảng tổng của cuộc thi suy từ hai lịch nhánh, không nhận lịch cấp cuộc thi."""
    schedules = {
        PUBLIC: (data.public_track.start_at, data.public_track.end_at),
        PRIVATE: (data.private_track.start_at, data.private_track.end_at),
    }
    start, end = competition_tracks.envelope(schedules)
    return {
        "mode": MODE_DUAL,
        "start_at": start,
        "end_at": end,
        # Quota cấp cuộc thi không tồn tại ở dual: mỗi nhánh giữ bucket riêng.
        "control_revision": 1,
        "stop_generation": 0,
        "tracks": {
            PUBLIC: _track_document(data.public_track, private=False),
            PRIVATE: _track_document(data.private_track, private=True),
        },
    }


async def insert_competition(db: AsyncIOMotorDatabase, data: CompetitionCreate, created_by: str) -> dict:
    now = datetime.now(timezone.utc)
    document = {
        "slug": data.slug,
        "name": data.name.strip(),
        "short_description": data.short_description.strip(),
        "status": "draft",
        "join_mode": data.join_mode,
        "join_code_hash": None,
        "primary_metric": data.primary_metric,
        "leaderboard_visible": data.leaderboard_visible,
        "resources": normalize_resources(data.resources),
        "normalization": normalization.config_payload(data.normalization),
        "created_by": created_by,
        "created_at": now,
        "updated_at": now,
    }
    if data.mode == MODE_DUAL:
        document.update(_dual_document(data))
    else:
        # Single giữ nguyên hình dạng document cũ: không `mode`, quota và lịch ở cấp cuộc thi.
        document["start_at"] = data.start_at
        document["end_at"] = data.end_at
        document["quota_per_day"] = data.quota_per_day
    result = await db[COMPETITIONS_COLLECTION].insert_one(document)
    return await db[COMPETITIONS_COLLECTION].find_one({"_id": result.inserted_id})


def _validate_track(label: str, track: CompetitionTrackCreate, *, private: bool) -> None:
    if as_utc(track.start_at) >= as_utc(track.end_at):
        raise ValueError(f"Nhánh {label}: thời gian bắt đầu phải trước thời gian kết thúc.")
    if not 0 <= track.quota_per_day <= _QUOTA_MAX:
        raise ValueError(f"Nhánh {label}: quota mỗi ngày phải từ 0 đến {_QUOTA_MAX}.")
    normalize_resources(track.resources)
    if private:
        if track.result_policy not in competition_tracks.RESULT_POLICIES:
            raise ValueError("Chính sách công bố phải là immediate hoặc manual.")
        if track.publish_condition not in competition_tracks.PUBLISH_CONDITIONS:
            raise ValueError(
                "Điều kiện công bố phải là admin_decides hoặc after_closed_and_scored."
            )


def validate_create(data: CompetitionCreate) -> None:
    """Raise ValueError với message tiếng Việt nếu dữ liệu tạo competition không hợp lệ."""
    if not is_valid_slug(data.slug):
        raise ValueError(f"Slug chỉ gồm a-z, 0-9 và dấu gạch ngang (tối đa {_SLUG_MAX} ký tự).")
    if not data.name.strip():
        raise ValueError("Tên cuộc thi không được để trống.")
    if data.mode not in competition_tracks.MODES:
        raise ValueError("Chế độ cuộc thi phải là single hoặc public_private.")
    if data.join_mode not in JOIN_MODES:
        raise ValueError("Join mode phải là open, code hoặc invite_only.")
    if data.primary_metric not in METRICS:
        raise ValueError("Primary metric phải là f1, precision hoặc recall.")
    if data.mode == MODE_DUAL:
        if data.start_at is not None or data.end_at is not None:
            raise ValueError(
                "Cuộc thi hai nhánh dùng lịch của từng nhánh; không nhận lịch cấp cuộc thi."
            )
        if data.public_track is None or data.private_track is None:
            raise ValueError("Cuộc thi hai nhánh cần lịch và quota cho cả nhánh Public lẫn Private.")
        _validate_track("Public", data.public_track, private=False)
        _validate_track("Private", data.private_track, private=True)
    else:
        if data.public_track is not None or data.private_track is not None:
            raise ValueError("Cuộc thi thông thường không nhận cấu hình nhánh Public/Private.")
        if data.start_at is None or data.end_at is None:
            raise ValueError("Cần thời gian bắt đầu và kết thúc của cuộc thi.")
        if as_utc(data.start_at) >= as_utc(data.end_at):
            raise ValueError("Thời gian bắt đầu phải trước thời gian kết thúc.")
        if not 0 <= data.quota_per_day <= _QUOTA_MAX:
            raise ValueError(f"Quota mỗi ngày phải từ 0 đến {_QUOTA_MAX}.")
    normalize_resources(data.resources)
    normalization.config_payload(data.normalization)


def validate_update(competition: dict, changes: dict) -> dict:
    """Validate + lọc field được phép sửa theo status. Trả về dict $set-ready."""
    status = competition["status"]
    if status == "closed":
        raise ValueError("Cuộc thi đã kết thúc, không thể chỉnh sửa.")
    for field in _EDITABLE_NEVER:
        if field in changes:
            raise ValueError("Không thể thay đổi slug/status/created_by.")
    # `null` sẽ là đường ghi mơ hồ thứ hai; dạng chuẩn đã công bố để tắt là {enabled: false, baseline: null}.
    if "normalization" in changes and changes["normalization"] is None:
        raise ValueError(
            'Không gửi normalization: null; dùng {"enabled": false, "baseline": null} để tắt chuẩn hóa.'
        )

    updates = {k: v for k, v in changes.items() if v is not None}
    if competition_tracks.is_dual(competition):
        # Lịch và quota của dual thuộc từng nhánh; sửa qua endpoint lịch nhánh để luôn có
        # revision check, lý do và envelope cập nhật trong cùng một lượt ghi.
        for field, endpoint in (
            ("start_at", "lịch nhánh"),
            ("end_at", "lịch nhánh"),
            ("quota_per_day", "lịch nhánh"),
        ):
            if field in updates:
                raise ValueError(
                    f"Cuộc thi hai nhánh không sửa {field} ở cấp cuộc thi; dùng cấu hình {endpoint}."
                )
    if status == "published":
        locked = [f for f in _LOCKED_WHEN_PUBLISHED if f in updates]
        if locked:
            raise ValueError("Cuộc thi đã xuất bản, không thể đổi primary_metric.")
        if "normalization" in updates:
            raise ValueError("Cuộc thi đã xuất bản, không thể đổi cấu hình chuẩn hóa.")

    if "name" in updates and not updates["name"].strip():
        raise ValueError("Tên cuộc thi không được để trống.")
    if "join_mode" in updates and updates["join_mode"] not in JOIN_MODES:
        raise ValueError("Join mode phải là open, code hoặc invite_only.")
    if "primary_metric" in updates and updates["primary_metric"] not in METRICS:
        raise ValueError("Primary metric phải là f1, precision hoặc recall.")
    if "quota_per_day" in updates and not 0 <= updates["quota_per_day"] <= _QUOTA_MAX:
        raise ValueError(f"Quota mỗi ngày phải từ 0 đến {_QUOTA_MAX}.")
    # Danh sách rỗng là hợp lệ và có nghĩa "xóa hết tài nguyên".
    if "resources" in updates:
        updates["resources"] = normalize_resources(updates["resources"])
    if "normalization" in updates:
        updates["normalization"] = normalization.config_payload(updates["normalization"])
    # Metric nguồn của norm phải còn dùng được sau lượt sửa, kể cả khi đổi primary_metric (v1).
    if "normalization" in updates or "primary_metric" in updates:
        normalization.ensure_usable({**competition, **updates})

    # Body là aware còn giá trị lưu trong Mongo là naive - bắt buộc chuẩn hoá trước khi so.
    start = as_utc(updates.get("start_at", competition["start_at"]))
    end = as_utc(updates.get("end_at", competition["end_at"]))
    if start >= end:
        raise ValueError("Thời gian bắt đầu phải trước thời gian kết thúc.")
    return updates


def competition_summary(competition: dict, membership: dict | None, account: dict | None) -> dict:
    """Representation giới thiệu cho list và landing detail: thông tin thẻ + trạng thái quyền đọc.

    Không chứa resources/submission_config - nội dung bên trong chỉ nằm ở `public_competition`
    khi quyền đọc được cấp. Không bao giờ lộ join_code_hash, created_by.
    """
    from app.competitions.access import read_access
    from app.memberships.service import public_membership

    return {
        **_competition_landing(competition),
        "primary_metric_label": _primary_metric_label(competition),
        "membership": public_membership(membership),
        "access": read_access(membership, account),
    }


def public_competition(
    competition: dict, membership: dict | None, account: dict | None, *, now: datetime | None = None
) -> dict:
    """Representation cho participant: summary + nội dung bên trong khi quyền đọc được cấp."""
    payload = competition_summary(competition, membership, account)
    if payload["access"]["allowed"]:
        payload["resources"] = public_resources(competition)
        payload["submission_config"] = _submission_config(competition, participant=True)
        if competition_tracks.is_dual(competition):
            payload["tracks"] = _participant_tracks(
                competition, membership=membership, now=now or datetime.now(timezone.utc)
            )
    return payload


def admin_competition(competition: dict, *, now: datetime | None = None) -> dict:
    """Representation cho admin: thêm created_by, cấu hình nhánh và luôn đủ submission_config."""
    from app.memberships.service import public_membership

    payload = {
        **_competition_landing(competition),
        "resources": public_resources(competition),
        "created_by": competition["created_by"],
        "membership": public_membership(None),
        "submission_config": _submission_config(competition, participant=False),
    }
    if competition_tracks.is_dual(competition):
        now = now or datetime.now(timezone.utc)
        payload.update(
            {
                "control_revision": int(competition.get("control_revision", 1)),
                "stop_generation": int(competition.get("stop_generation", 0)),
                "scoring_locked": competition.get("scoring_locked_at") is not None,
                "last_change": _last_change_view(competition),
                "tracks": {
                    track: admin_track_view(competition, track, now=now) for track in TRACKS
                },
            }
        )
    return payload


def _last_change_view(competition: dict) -> dict | None:
    change = competition.get("last_change")
    if not change:
        return None
    return {
        "by": change.get("by"),
        "at": iso_z(change["at"]) if change.get("at") else None,
        "reason": change.get("reason"),
        "action": change.get("action"),
        "revision": change.get("revision"),
    }


def admin_track_view(competition: dict, track: str, *, now: datetime) -> dict:
    """Cấu hình nhánh cho trang quản trị: lịch, quota, tài nguyên, GT, readiness và công bố.

    Readiness đi qua đúng hàm của cổng publish để banner admin và endpoint publish không lệch.
    """
    from app.scoring.readiness import blocked_reason, check_readiness

    config = competition_tracks.track_config(competition, track) or {}
    readiness = check_readiness(competition, track=track)
    view = {
        **competition_tracks.track_view(competition, track, now=now),
        "resources": competition_tracks.track_resources(competition, track),
        "ground_truth": _ground_truth_view(config.get("ground_truth")),
        "verified": _track_verified(competition, track),
        "ready": readiness.ready,
        "not_ready_reason": blocked_reason(readiness),
        "admission_seq": int(config.get("admission_seq", 0)),
    }
    if track == PRIVATE:
        view["results_published_by"] = config.get("results_published_by")
    return view


def _ground_truth_view(metadata: dict | None) -> dict | None:
    if metadata is None:
        return None
    return {
        "row_count": metadata.get("row_count"),
        "columns": metadata.get("columns"),
        "sha256": metadata.get("sha256"),
        "uploaded_at": iso_z(metadata["uploaded_at"]) if metadata.get("uploaded_at") else None,
    }


def _track_verified(competition: dict, track: str) -> bool:
    from app.scoring import models as scoring_models
    from app.scoring.readiness import verified

    config = scoring_models.stored_config_or_none(competition)
    if config is None:
        return False
    return verified(competition, config, track=track)


def _participant_tracks(competition: dict, *, membership: dict | None, now: datetime) -> dict:
    """Hai nhánh dưới mắt thí sinh: lịch, quota, cửa sổ, quyền nộp, kết quả và quyền xem norm.

    Tài nguyên riêng của nhánh chỉ rời backend từ giờ mở của chính nhánh đó; trước đó chỉ có
    lịch và placeholder, không có URL nằm chờ trong payload.
    """
    view = competition_tracks.tracks_view(competition, now=now) or {}
    membership_ok = bool(membership and membership.get("active", True))
    status_ok = competition["status"] == "published"
    for track, entry in view.items():
        start, _ = competition_tracks.track_schedule(competition, track)
        if now >= start:
            entry["resources"] = competition_tracks.track_resources(competition, track)
        else:
            entry["resources"] = []
        allowed, reason = competition_tracks.can_submit(
            competition,
            track,
            status_ok=status_ok,
            membership_ok=membership_ok,
            now=now,
        )
        entry["can_submit"] = allowed
        entry["blocked_reason"] = reason
        entry["submission_ready"] = _submission_config(
            competition, participant=True, track=track
        )["ready"]
        # Capability chuẩn hóa của nhánh: frontend không tự suy từ đồng hồ hay cờ cấp cuộc thi.
        # Đây là trạng thái hiển thị, không phải lỗi HTTP - hàm này chỉ chạy khi đã có quyền đọc.
        norm_visible, norm_hidden_reason = competition_tracks.can_view_norm(
            competition, track, now=now
        )
        entry["normalization_visible"] = norm_visible
        entry["normalization_hidden_reason"] = norm_hidden_reason
    return view


def _competition_landing(competition: dict) -> dict:
    return {
        "id": str(competition["_id"]),
        "slug": competition["slug"],
        "name": competition["name"],
        "short_description": competition.get("short_description", ""),
        "status": competition["status"],
        # Dual suy khoảng tổng từ hai nhánh; single giữ nguyên lịch cấp cuộc thi.
        "mode": competition_tracks.mode_of(competition),
        "start_at": iso_z(competition["start_at"]),
        "end_at": iso_z(competition["end_at"]),
        "join_mode": competition["join_mode"],
        "primary_metric": competition["primary_metric"],
        # Quota cấp cuộc thi chỉ tồn tại ở single; dual trả quota theo từng nhánh.
        "quota_per_day": competition.get("quota_per_day"),
        "leaderboard_visible": competition["leaderboard_visible"],
        "join_code_configured": bool(competition.get("join_code_hash")),
        "normalization": normalization.config_view(competition),
        "tracks": competition_tracks.tracks_view(
            competition, now=datetime.now(timezone.utc)
        ),
    }


def _primary_metric_label(competition: dict) -> str | None:
    """Nhãn metric chính theo hợp đồng thí sinh cho thẻ tóm tắt.

    None khi chưa cấu hình hoặc metric chính bị admin ẩn - không rơi về `primary_metric` của
    document v2 vì field đó là di sản v1, không phải metric đang được chấm.
    """
    from app.scoring import contracts

    contract = contracts.participant_contract(competition)
    key = contract.primary_metric
    if not key:
        return None
    for metric in contract.metrics:
        if metric.key == key:
            return metric.label
    return key


def _submission_config(competition: dict, *, participant: bool, track: str | None = None) -> dict:
    """Dạng bài nộp và metric mà UI cần, đọc theo đúng đời cấu hình của cuộc thi.

    Chỉ được gọi từ payload đã qua kiểm quyền đọc (thành viên đang hoạt động hoặc admin) nên
    `pos_label` - nhãn dương thật của ground truth - luôn được phép trả. `participant` chọn hợp
    đồng thí sinh: metric admin ẩn không rời khỏi backend. Cuộc thi v1 giữ nguyên hình dạng cũ;
    v2 trả schema submission để sinh hướng dẫn/CSV mẫu. `track` chọn đúng ground truth của nhánh
    khi xét `ready`; dual không truyền track nghĩa là ready chỉ khi cả hai nhánh đã sẵn sàng.
    """
    from app.core.config import get_settings
    from app.scoring import contracts, models
    from app.scoring.storage import ground_truth_available

    is_v2 = models.is_v2(competition)
    config = None if is_v2 else competition.get("scoring_config")
    config_v2 = models.stored_config_or_none(competition)
    contract = (
        contracts.participant_contract(competition)
        if participant
        else contracts.result_contract(competition)
    )
    if track is None:
        tracks_with_gt = None if not competition_tracks.is_dual(competition) else list(TRACKS)
    else:
        tracks_with_gt = [track]
    ground_truth_ready = (
        all(ground_truth_available(competition, t) for t in tracks_with_gt)
        if tracks_with_gt is not None
        else ground_truth_available(competition)
    )
    payload = {
        "ready": bool((config or config_v2) and ground_truth_ready),
        "version": 2 if is_v2 else 1,
        "max_upload_mb": get_settings().max_upload_mb,
        "max_notebook_mb": get_settings().max_notebook_mb,
        "primary_metric": contract.primary_metric,
        "higher_is_better": contract.higher_is_better if contract.primary_metric else None,
        "result_contract": contract.model_dump(mode="json"),
    }
    if is_v2:
        # Cấu hình v2 hỏng đọc ra None: coi như chưa cấu hình để trang hiển thị đúng trạng thái chờ,
        # thay vì lộ một schema sai. Readiness đã chặn publish và nộp bài cho bản hỏng từ trước.
        schema = config_v2.input_schema.submission if config_v2 else None
        return {
            **payload,
            "ready": payload["ready"] and schema is not None,
            "id_column": schema.id_column if schema else None,
            "columns": [column.model_dump() for column in schema.columns] if schema else [],
        }
    payload["id_column"] = config["id_column"] if config else None
    payload["prediction_column"] = config["prediction_column"] if config else None
    payload["average"] = config["average"] if config else None
    payload["pos_label"] = config.get("pos_label") if config else None
    return payload


async def submission_counts(db, competition_ids: list, *, excluded_tracks: dict | None = None) -> dict:
    """Đếm mọi submission đã persist theo competition, không phụ thuộc status.

    `excluded_tracks` là `{competition_id: {track khóa}}`: payload thí sinh và danh sách công
    khai không nhận con số có đóng góp từ nhánh chưa tới giờ mở. Đường admin không truyền tham
    số này nên số liệu quản trị luôn đủ.
    """
    from app.submissions.service import SUBMISSIONS_COLLECTION

    counts = {competition_id: 0 for competition_id in competition_ids}
    if not counts:
        return counts
    if excluded_tracks:
        match = {
            "$or": [
                competition_tracks.visible_track_filter(
                    competition_id, excluded_tracks.get(competition_id) or set()
                )
                for competition_id in competition_ids
            ]
        }
    else:
        match = {"competition_id": {"$in": competition_ids}}
    cursor = db[SUBMISSIONS_COLLECTION].aggregate(
        [
            {"$match": match},
            {"$group": {"_id": "$competition_id", "total": {"$sum": 1}}},
        ]
    )
    async for row in cursor:
        counts[row["_id"]] = row["total"]
    return counts


async def activity_counts(db, competition_ids: list) -> dict:
    """member_count là thành viên ĐANG hoạt động; người đã rời/bị vô hiệu hóa đếm riêng."""
    from app.memberships.service import MEMBERSHIPS_COLLECTION

    counts = {
        competition_id: {
            "member_count": 0,
            "inactive_member_count": 0,
            "submission_count": 0,
        }
        for competition_id in competition_ids
    }
    if not counts:
        return counts
    cursor = db[MEMBERSHIPS_COLLECTION].aggregate(
        [
            {"$match": {"competition_id": {"$in": competition_ids}}},
            {
                "$group": {
                    "_id": {
                        "competition_id": "$competition_id",
                        # Membership cũ thiếu field `active` được coi là đang hoạt động.
                        "active": {"$ifNull": ["$active", True]},
                    },
                    "total": {"$sum": 1},
                }
            },
        ]
    )
    async for row in cursor:
        field = "member_count" if row["_id"]["active"] else "inactive_member_count"
        counts[row["_id"]["competition_id"]][field] = row["total"]
    submissions = await submission_counts(db, competition_ids)
    for competition_id, total in submissions.items():
        counts[competition_id]["submission_count"] = total
    return counts


async def delete_competition_cascade(db, competition: dict) -> None:
    """Xoá document con trước, competition sau cùng.

    Mongo standalone không có transaction: nếu một bước lỗi giữa đường thì cuộc thi vẫn còn
    và lệnh gọi lại chạy tiếp được, thay vì để lại dữ liệu con mồ côi không ai xoá.
    """
    from app.ai_review import queue as ai_queue
    from app.ai_review import service as ai_service
    from app.ai_review.content_snapshot import delete_revisions
    from app.content.service import CONTENTS_COLLECTION
    from app.memberships.service import MEMBERSHIPS_COLLECTION
    from app.scoring_attempts.store import ATTEMPTS_COLLECTION
    from app.submissions.service import SUBMISSIONS_COLLECTION

    competition_id = competition["_id"]
    # Job và audit row AI đứng trước submission: cả hai tham chiếu tới nó, xoá ngược thứ tự sẽ để
    # lại job trỏ vào một bài không còn tồn tại.
    await db[ai_queue.JOBS_COLLECTION].delete_many({"competition_id": competition_id})
    await db[ai_service.REVIEWS_COLLECTION].delete_many({"competition_id": competition_id})
    await db[SUBMISSIONS_COLLECTION].delete_many({"competition_id": competition_id})
    # Lượt còn chờ chấm cũng thuộc cuộc thi: bỏ luôn để worker không còn gì để claim.
    await db[ATTEMPTS_COLLECTION].delete_many({"competition_id": competition_id})
    await db[MEMBERSHIPS_COLLECTION].delete_many({"competition_id": competition_id})
    await db[CONTENTS_COLLECTION].delete_many({"competition_id": competition_id})
    # Revision đứng sau submission/review vì chúng tham chiếu tới nó.
    await delete_revisions(db, competition_id)
    await db[COMPETITIONS_COLLECTION].delete_one({"_id": competition_id})


def competition_file_roots(competition_id) -> list[Path]:
    """Hai thư mục của một cuộc thi: nội dung/ảnh và bài nộp đã lưu."""
    root = Path(get_settings().data_dir)
    return [
        storage.ensure_within(root, Path("competitions", str(competition_id))),
        storage.ensure_within(root, Path("submissions", str(competition_id))),
    ]


async def remove_competition_files(competition_id, competition_slug: str) -> bool:
    """Dọn file sau khi DB đã xoá xong; lỗi chỉ được log và báo partial, không phục hồi DB.

    Gồm cả thư mục local cũ (submission CSV legacy, content, assets) và prefix artifact trên MinIO.
    Artifact nằm ở HAI prefix: theo slug cho bài nộp từ ADR-033 trở đi, theo ObjectId cho bài cũ.
    """
    from app.submission_artifacts import storage as artifact_storage

    cleaned = True
    for path in competition_file_roots(competition_id):
        try:
            shutil.rmtree(path)
        except FileNotFoundError:
            continue
        except OSError:
            logger.warning("Cannot remove competition files at %s", path, exc_info=True)
            cleaned = False
    for prefix in (
        artifact_storage.competition_prefix(competition_slug),
        artifact_storage.competition_prefix(competition_id),
    ):
        if not await artifact_storage.remove_prefix(prefix):
            cleaned = False
    return cleaned
