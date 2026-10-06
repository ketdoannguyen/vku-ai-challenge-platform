"""Nhánh Public/Private trong cùng một cuộc thi (ADR-064).

Cuộc thi `single` (document cũ không có `mode`) giữ nguyên mọi hành vi. Cuộc thi
`public_private` có đúng hai nhánh trong `tracks`: lịch, quota, tài nguyên và ground truth
riêng; bộ chấm, schema, metric và luật chuẩn hóa dùng chung.

Module này là nguồn sự thật duy nhất cho các câu hỏi "cuộc thi đang ở chế độ nào", "nhánh
này đang trong cửa sổ nào", "kết quả nhánh này đã được công bố chưa" - backend và frontend
phải trả lời giống nhau, nên mọi caller đi qua đây thay vì tự đọc `tracks` bằng tay.
"""

from datetime import datetime

from app.core.datetimes import as_utc, iso_z
from app.scoring import contracts, normalization

MODE_SINGLE = "single"
MODE_DUAL = "public_private"
MODES = (MODE_SINGLE, MODE_DUAL)

PUBLIC = "public"
PRIVATE = "private"
TRACKS = (PUBLIC, PRIVATE)

WINDOW_SCHEDULED = "scheduled"
WINDOW_OPEN = "open"
WINDOW_CLOSED = "closed"

RESULT_POLICY_IMMEDIATE = "immediate"
RESULT_POLICY_MANUAL = "manual"
RESULT_POLICIES = (RESULT_POLICY_IMMEDIATE, RESULT_POLICY_MANUAL)
# Mặc định: admin tự quyết định thời điểm công bố - không phải quy tắc bắt buộc đợi đóng.
RESULT_POLICY_DEFAULT = RESULT_POLICY_MANUAL

PUBLISH_ADMIN_DECIDES = "admin_decides"
PUBLISH_AFTER_CLOSED_AND_SCORED = "after_closed_and_scored"
PUBLISH_CONDITIONS = (PUBLISH_ADMIN_DECIDES, PUBLISH_AFTER_CLOSED_AND_SCORED)
PUBLISH_CONDITION_DEFAULT = PUBLISH_ADMIN_DECIDES

# Lý do kết quả bị che với người xem; đủ ổn định để frontend đối chiếu.
REASON_PRIVATE_UNPUBLISHED = "private_unpublished"

# Lý do dữ liệu chuẩn hóa chưa được xem; cùng hợp đồng ổn định với frontend.
REASON_NORMALIZATION_DISABLED = "normalization_disabled"
REASON_LEADERBOARD_HIDDEN = "leaderboard_hidden"
REASON_SOURCE_METRIC_HIDDEN = "source_metric_hidden"


def mode_of(competition: dict) -> str:
    """`mode` vắng trên bản ghi cũ nghĩa là single - không cần migration."""
    return competition.get("mode") or MODE_SINGLE


def is_dual(competition: dict) -> bool:
    return mode_of(competition) == MODE_DUAL


def opposite(track: str) -> str:
    return PRIVATE if track == PUBLIC else PUBLIC


def track_config(competition: dict, track: str) -> dict | None:
    if not is_dual(competition):
        return None
    return (competition.get("tracks") or {}).get(track)


def track_schedule(competition: dict, track: str) -> tuple[datetime, datetime]:
    """Lịch nhánh dưới dạng aware UTC; thiếu nhánh là dữ liệu hỏng, caller tự quyết cách từ chối."""
    config = track_config(competition, track)
    if config is None:
        raise KeyError(track)
    return as_utc(config["start_at"]), as_utc(config["end_at"])


def track_quota(competition: dict, track: str | None) -> int:
    """Quota ngày của nhánh; `track=None` là cuộc thi single với quota cấp cuộc thi."""
    if track is None:
        return competition["quota_per_day"]
    return int((track_config(competition, track) or {})["quota_per_day"])


def track_resources(competition: dict, track: str) -> list[dict]:
    """Tài nguyên riêng của nhánh; danh sách chung vẫn nằm ở `resources` cấp cuộc thi."""
    return list((track_config(competition, track) or {}).get("resources") or [])


def track_ground_truth(competition: dict, track: str | None) -> dict | None:
    """Metadata ground truth của đúng nhánh đang đọc; single dùng field cấp cuộc thi."""
    if track is None:
        return competition.get("ground_truth")
    return (track_config(competition, track) or {}).get("ground_truth")


def window_state(competition: dict, track: str, now: datetime) -> str:
    """Trạng thái cửa sổ nhận bài suy từ thời gian server: `scheduled`/`open`/`closed`."""
    start, end = track_schedule(competition, track)
    if now < start:
        return WINDOW_SCHEDULED
    if now < end:
        return WINDOW_OPEN
    return WINDOW_CLOSED


def results_policy(competition: dict) -> str:
    config = track_config(competition, PRIVATE) or {}
    return config.get("result_policy") or RESULT_POLICY_DEFAULT


def publish_condition(competition: dict) -> str:
    config = track_config(competition, PRIVATE) or {}
    return config.get("publish_condition") or PUBLISH_CONDITION_DEFAULT


def results_released(competition: dict, track: str) -> bool:
    """Kết quả nhánh đã hiện với thí sinh chưa.

    Public luôn hiện; Private hiện khi có dấu mốc công bố. Dấu mốc được ghi trong cùng thao
    tác atomic với publish (chế độ `immediate`) hoặc với lần công bố thủ công đầu tiên.
    """
    if track == PUBLIC:
        return True
    config = track_config(competition, PRIVATE) or {}
    return config.get("results_published_at") is not None


def results_visible(competition: dict, track: str | None) -> bool:
    """Quyền xem điểm/BXH đã suy ra của một nhánh; single luôn hiện theo luật cũ."""
    if track is None:
        return True
    return results_released(competition, track)


def envelope(schedules: dict[str, tuple[datetime, datetime]]) -> tuple[datetime, datetime]:
    """Khoảng tổng của cuộc thi dual: sớm nhất trong các giờ mở, muộn nhất trong các giờ đóng.

    Chỉ dùng cho summary/join cho nhất quán; việc cấp quyền nộp vào một nhánh luôn căn theo
    lịch của chính nhánh đó.
    """
    starts = [start for start, _ in schedules.values()]
    ends = [end for _, end in schedules.values()]
    return min(starts), max(ends)


def track_view(competition: dict, track: str, *, now: datetime) -> dict:
    """Trạng thái một nhánh mà mọi actor đều được thấy: lịch, quota, cửa sổ, kết quả.

    Không chứa ground truth, điểm hay tài nguyên - những thứ đó chỉ vào payload đã qua kiểm
    quyền đọc; đây là phần của thẻ giới thiệu dùng chung.
    """
    start, end = track_schedule(competition, track)
    view = {
        "start_at": iso_z(start),
        "end_at": iso_z(end),
        "quota_per_day": track_quota(competition, track),
        "window_state": window_state(competition, track, now),
        "results_released": results_released(competition, track),
    }
    if track == PRIVATE:
        # Thông báo "chờ công bố" của thí sinh phụ thuộc cấu hình, nên cấu hình này phải hiện.
        view["result_policy"] = results_policy(competition)
        view["publish_condition"] = publish_condition(competition)
        config = track_config(competition, PRIVATE) or {}
        published_at = config.get("results_published_at")
        view["results_published_at"] = iso_z(published_at) if published_at else None
    return view


def tracks_view(competition: dict, *, now: datetime) -> dict | None:
    if not is_dual(competition):
        return None
    return {track: track_view(competition, track, now=now) for track in TRACKS}


def can_submit(competition: dict, track: str, *, status_ok: bool, membership_ok: bool, now: datetime) -> tuple[bool, str | None]:
    """Quyền nộp một nhánh do backend quyết; frontend không tự suy từ đồng hồ máy khách."""
    if not status_ok:
        return False, "competition_closed"
    if not membership_ok:
        return False, "membership_required"
    state = window_state(competition, track, now)
    if state == WINDOW_SCHEDULED:
        return False, "not_open"
    if state == WINDOW_CLOSED:
        return False, "deadline_passed"
    return True, None


class TrackError(Exception):
    """Vi phạm hợp đồng track; router dịch sang 422 với `code` giữ nguyên."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def can_view_norm(competition: dict, track: str | None) -> tuple[bool, str | None]:
    """Quyền xem mọi dữ liệu chuẩn hóa (norm, snapshot, metadata BXH) của một nhánh đã resolve.

    Một câu trả lời duy nhất cho cả bốn cửa, xét theo thứ tự: cuộc thi bật chuẩn hóa, nhánh đã
    công bố kết quả, BXH không bị ẩn, metric nguồn không bị ẩn. Lý do trả về là trạng thái hiển
    thị cho DTO - không phải lỗi HTTP; `track=None` là cuộc thi single.

    Đọc cấu hình khoan dung qua `config_view`: một bản ghi norm hỏng vẫn không được làm sập trang
    thí sinh, trong khi mọi đường quyết định thứ hạng vẫn raise qua `active_rule`.
    """
    if not normalization.config_view(competition)["enabled"]:
        return False, REASON_NORMALIZATION_DISABLED
    if not results_visible(competition, track):
        return False, REASON_PRIVATE_UNPUBLISHED
    if not competition.get("leaderboard_visible", False):
        return False, REASON_LEADERBOARD_HIDDEN
    if contracts.participant_contract(competition).primary_metric is None:
        return False, REASON_SOURCE_METRIC_HIDDEN
    return True, None


def resolve_track(competition: dict, track: str | None) -> str | None:
    """Chuẩn hoá tham số track của endpoint cần một nhánh.

    Dual bắt buộc chỉ rõ nhánh và chỉ nhận `public`/`private`; single từ chối track để client cũ
    không âm thầm nộp nhầm nhánh.
    """
    if is_dual(competition):
        if not track:
            raise TrackError(
                "TRACK_REQUIRED", "Cuộc thi hai nhánh cần chỉ rõ nhánh public hoặc private."
            )
        if track not in TRACKS:
            raise TrackError("INVALID_TRACK", "Nhánh không hợp lệ; chỉ có public hoặc private.")
        return track
    if track:
        raise TrackError("INVALID_TRACK", "Cuộc thi thông thường không có nhánh public/private.")
    return None
