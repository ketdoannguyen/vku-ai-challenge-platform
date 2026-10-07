"""Bảng xếp hạng tổng hợp: ghép điểm chính của nhiều cuộc thi nguồn theo trọng số.

Collection chỉ lưu **cấu hình** (nguồn, trọng số, chế độ quyền); điểm luôn được
tính lại tại thời điểm đọc từ bảng xếp hạng hiện có của từng nguồn - không snapshot, không lịch
sử, không cache riêng. Cấu hình hợp lệ khác với điểm đã được xem: một nguồn còn nháp/chưa mở/
chưa công bố vẫn ghép được, nhưng cả view phải ở trạng thái chờ thay vì dựng bảng một phần.

`Tổng = Σ(trọng số × điểm nguồn)`. Nguồn bật chuẩn hóa đóng góp norm hiện tại (0-100); nguồn
không chuẩn hóa đóng góp nguyên metric chính, không đổi thang hay đảo dấu. Thí sinh thiếu kết
quả ở một nguồn đóng góp 0 với mẫu số cố định - trọng số không được chia lại.
"""

import math
from dataclasses import dataclass
from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from pydantic import BaseModel, ValidationError, field_validator

from app.competitions import tracks as competition_tracks
from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.datetimes import iso_z
from app.core.slugs import is_valid_slug, slugify
from app.leaderboard import service as leaderboard_service
from app.memberships.service import memberships_by_competition
from app.scoring import contracts, normalization

AGGREGATES_COLLECTION = "aggregate_leaderboards"

MIN_SOURCES = 2
NAME_MAX = 120
# Dung sai kỹ thuật cho tổng trọng số; không âm thầm cân lại hay phân bổ phần dư.
WEIGHT_TOLERANCE = 1e-6

VIS_MEMBERS_ANY = "members_any"
VIS_MEMBERS_ALL = "members_all"
VIS_AUTHENTICATED = "authenticated"
VISIBILITIES = (VIS_MEMBERS_ANY, VIS_MEMBERS_ALL, VIS_AUTHENTICATED)
VISIBILITY_DEFAULT = VIS_MEMBERS_ANY

VIEW_PUBLIC = "public"
VIEW_PRIVATE = "private"
VIEWS = (VIEW_PUBLIC, VIEW_PRIVATE)

SCORE_KIND_NORMALIZED = "normalized"
SCORE_KIND_PRIMARY = "primary"
# Nhãn cột của nguồn chuẩn hóa: thang 0-100 chung, không phải metric gốc của cuộc thi.
NORM_LABEL = "Norm"

STATUS_READY = "ready"
STATUS_WAITING = "waiting"

# Lý do nguồn chưa sẵn sàng hiển thị; cùng hợp đồng ổn định với frontend như `tracks`.
REASON_SOURCE_MISSING = "source_missing"
REASON_SOURCE_DRAFT = "source_draft"
REASON_SOURCE_INVALID = "source_invalid"

class AggregateError(Exception):
    """Vi phạm cấu hình/quyền của bảng tổng hợp; router dịch sang HTTP với `code` giữ nguyên."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class AggregateSourceIn(BaseModel):
    """Một nguồn trong cấu hình gửi lên: cuộc thi (ObjectId dạng chuỗi) + trọng số."""

    competition_id: str
    weight: float

    @field_validator("weight", mode="before")
    @classmethod
    def _reject_bool(cls, value):
        # Pydantic lax ép `true` thành 1.0, biến boolean thành trọng số trông như thật.
        if isinstance(value, bool):
            raise ValueError("Trọng số phải là số, không phải boolean.")
        return value


class AggregateCreate(BaseModel):
    """POST chỉ lưu cấu hình đầy đủ; "nháp" nghĩa là chưa công bố, không phải cấu hình dở dang."""

    name: str
    sources: list[AggregateSourceIn]
    visibility: str = VISIBILITY_DEFAULT


class AggregateUpdate(BaseModel):
    """Sửa cấu hình: ghép field gửi lên với bản đang lưu rồi validate toàn bộ; không sửa slug/published."""

    name: str | None = None
    sources: list[AggregateSourceIn] | None = None
    visibility: str | None = None


def clean_name(value) -> str:
    text = (value or "").strip()
    if not text:
        raise AggregateError("VALIDATION_ERROR", "Tên bảng tổng hợp không được để trống.")
    if len(text) > NAME_MAX:
        raise AggregateError("VALIDATION_ERROR", f"Tên bảng tổng hợp tối đa {NAME_MAX} ký tự.")
    return text


def clean_visibility(value) -> str:
    if value not in VISIBILITIES:
        raise AggregateError(
            "VALIDATION_ERROR",
            "Chế độ xem phải là members_any, members_all hoặc authenticated.",
        )
    return value


def clean_view(value) -> str:
    if value not in VIEWS:
        raise AggregateError("INVALID_VIEW", "Tham số view chỉ nhận public hoặc private.")
    return value


def clean_slug(name: str) -> str:
    slug = slugify(name)
    if not is_valid_slug(slug):
        raise AggregateError(
            "VALIDATION_ERROR", "Tên bảng tổng hợp cần chữ cái hoặc chữ số để tạo đường dẫn."
        )
    return slug


def stored_sources(sources: list[AggregateSourceIn]) -> list[dict]:
    """Dạng lưu của danh sách nguồn; raise khi thiếu nguồn, trùng nguồn hay trọng số vô lý."""
    if len(sources) < MIN_SOURCES:
        raise AggregateError(
            "AGGREGATE_SOURCES_INVALID", "Bảng tổng hợp cần ít nhất 2 cuộc thi nguồn."
        )
    stored: list[dict] = []
    seen: set[ObjectId] = set()
    for source in sources:
        try:
            competition_id = ObjectId(source.competition_id)
        except (InvalidId, TypeError):
            raise AggregateError("AGGREGATE_SOURCES_INVALID", "Mã cuộc thi nguồn không hợp lệ.")
        if competition_id in seen:
            raise AggregateError(
                "AGGREGATE_SOURCES_INVALID",
                "Mỗi cuộc thi chỉ được xuất hiện một lần trong danh sách nguồn.",
            )
        seen.add(competition_id)
        weight = source.weight
        if not math.isfinite(weight) or not 0 < weight <= 1:
            raise AggregateError(
                "AGGREGATE_WEIGHT_INVALID", "Trọng số phải là số lớn hơn 0 và không vượt quá 1."
            )
        stored.append({"competition_id": competition_id, "weight": float(weight)})
    total = math.fsum(source["weight"] for source in stored)
    if abs(total - 1.0) > WEIGHT_TOLERANCE:
        raise AggregateError("AGGREGATE_WEIGHT_INVALID", "Tổng trọng số của các nguồn phải bằng 1.")
    return stored


def stored_as_requests(sources: list[dict]) -> list[AggregateSourceIn]:
    """Bản đã lưu về lại dạng request để validate trọn cấu hình sau khi ghép field."""
    try:
        return [
            AggregateSourceIn(
                competition_id=str(source["competition_id"]),
                weight=source["weight"],
            )
            for source in sources
        ]
    except (KeyError, TypeError, ValidationError):
        raise AggregateError("VALIDATION_ERROR", "Danh sách nguồn đã lưu không đọc được.")


async def load_source_documents(db, sources: list[dict]) -> dict:
    """Metadata các cuộc thi nguồn theo một lượt đọc; nguồn đã bị xoá vắng mặt trong kết quả."""
    ids = list({source["competition_id"] for source in sources})
    if not ids:
        return {}
    return {
        document["_id"]: document
        async for document in db[COMPETITIONS_COLLECTION].find({"_id": {"$in": ids}})
    }


def source_calculation(competition: dict) -> tuple[normalization.Rule | None, bool]:
    """`(luật norm, chiều cao-là-tốt)` đang áp dụng cho nguồn; raise khi cách tính không dùng được.

    Nguồn thấp-là-tốt chưa bật norm bị chặn: thiếu kết quả (=0) sẽ hóa "tốt" một cách vô nghĩa.
    """
    name = competition.get("name") or competition.get("slug") or "?"
    if competition_tracks.mode_of(competition) not in competition_tracks.MODES:
        raise AggregateError(
            "AGGREGATE_UNSUPPORTED_SOURCE", f"Chế độ của cuộc thi “{name}” không đọc được."
        )
    ranking = contracts.ranking(competition)
    if ranking is None:
        raise AggregateError(
            "AGGREGATE_UNSUPPORTED_SOURCE", f"Cuộc thi “{name}” chưa có metric chính nên không ghép được."
        )
    _, higher_is_better = ranking
    try:
        rule = normalization.active_rule(competition)
    except normalization.NormalizationError:
        raise AggregateError(
            "AGGREGATE_UNSUPPORTED_SOURCE",
            f"Cấu hình chuẩn hóa của cuộc thi “{name}” không đọc được.",
        )
    if rule is None and not higher_is_better:
        raise AggregateError(
            "AGGREGATE_UNSUPPORTED_SOURCE",
            f"Cuộc thi “{name}” xếp theo chiều thấp-là-tốt nhưng chưa bật chuẩn hóa; "
            "bật chuẩn hóa trước khi ghép.",
        )
    return rule, higher_is_better


async def ensure_sources_usable(db, sources: list[dict]) -> None:
    """Kiểm nguồn tồn tại và cách tính còn dùng được; nguồn nháp/chưa mở vẫn hợp lệ ở bước này."""
    documents = await load_source_documents(db, sources)
    for source in sources:
        competition = documents.get(source["competition_id"])
        if competition is None:
            raise AggregateError(
                "AGGREGATE_SOURCES_INVALID",
                f"Không tìm thấy cuộc thi nguồn {source['competition_id']}. "
                "Tải lại danh sách cuộc thi rồi kiểm tra lại.",
            )
        source_calculation(competition)


async def validated_config(
    db, *, name, sources: list[AggregateSourceIn], visibility
) -> tuple[str, list[dict], str]:
    """Validate toàn bộ cấu hình và trả dạng chuẩn để lưu; dùng chung cho tạo, sửa và publish."""
    cleaned = clean_name(name)
    checked_visibility = clean_visibility(visibility)
    stored = stored_sources(sources)
    await ensure_sources_usable(db, stored)
    return cleaned, stored, checked_visibility


async def find_aggregate(db, slug: str) -> dict | None:
    return await db[AGGREGATES_COLLECTION].find_one({"_id": slug})


async def insert_aggregate(
    db, *, name: str, sources: list[dict], visibility: str, created_by: str
) -> dict:
    """Lưu bản nháp đầy đủ cấu hình; slug sinh từ tên và bất biến sau đó."""
    now = datetime.now(timezone.utc)
    document = {
        "_id": clean_slug(name),
        "name": name,
        "sources": sources,
        "visibility": visibility,
        "published": False,
        "created_by": created_by,
        "created_at": now,
        "updated_at": now,
    }
    await db[AGGREGATES_COLLECTION].insert_one(document)
    return document


def merged_config(aggregate: dict, body: AggregateUpdate) -> dict:
    """Ghép các field gửi lên với cấu hình hiện có; field null là lỗi thay vì xoá mơ hồ."""
    merged = {
        "name": aggregate["name"],
        "sources": stored_as_requests(aggregate.get("sources") or []),
        "visibility": aggregate.get("visibility", VISIBILITY_DEFAULT),
    }
    for field in body.model_fields_set:
        value = getattr(body, field)
        if value is None:
            raise AggregateError("VALIDATION_ERROR", f"Trường {field} không nhận giá trị null.")
        merged[field] = value
    return merged


async def referencing_aggregates(db, competition_id) -> list[dict]:
    """Các bảng tổng hợp (kể cả nháp) đang dùng cuộc thi này - chốt xoá cuộc thi nguồn."""
    return [
        {"slug": aggregate["_id"], "name": aggregate.get("name") or aggregate["_id"]}
        async for aggregate in db[AGGREGATES_COLLECTION].find(
            {"sources.competition_id": competition_id}
        )
    ]


async def ensure_indexes(db) -> None:
    # Phục vụ chốt xoá cuộc thi: tìm bảng theo từng nguồn trong mảng `sources`.
    await db[AGGREGATES_COLLECTION].create_index("sources.competition_id")


# --- Quyền xem -----------------------------------------------------------------------------------


async def _active_source_memberships(db, source_ids: list, account_id) -> set:
    """Các nguồn mà người xem có membership đang hoạt động; membership thiếu `active` coi như bật."""
    memberships = await memberships_by_competition(db, source_ids, account_id)
    return {
        competition_id
        for competition_id, membership in memberships.items()
        if membership.get("active", True)
    }


def _visibility_covers(visibility: str, source_ids: list, active: set) -> bool:
    """Chế độ quyền của bảng phủ người xem dựa trên tập nguồn đã có membership hoạt động.

    Giá trị lạ trong bản ghi hỏng bị xử như `members_any` (kín hơn mở) - không bao giờ mở rộng
    quyền vì một field không đọc được.
    """
    if visibility == VIS_AUTHENTICATED:
        return True
    if visibility == VIS_MEMBERS_ALL:
        return all(competition_id in active for competition_id in source_ids)
    return any(competition_id in active for competition_id in source_ids)


async def can_view(db, aggregate: dict, account: dict) -> bool:
    """Admin miễn điều kiện membership; chế độ `authenticated` chỉ cần đăng nhập (caller đã đảm bảo).

    Membership kiểm trên danh sách ObjectId đã lưu trong cấu hình, kể cả khi document nguồn
    đã bị xoá - nguồn mất không trở thành đường miễn kiểm quyền.
    """
    if account.get("role") == "admin":
        return True
    visibility = aggregate.get("visibility", VISIBILITY_DEFAULT)
    if visibility == VIS_AUTHENTICATED:
        return True
    source_ids = [source["competition_id"] for source in aggregate.get("sources") or []]
    active = await _active_source_memberships(db, source_ids, account["_id"])
    return _visibility_covers(visibility, source_ids, active)


async def list_visible(db, aggregates: list[dict], account: dict) -> list[dict]:
    """Lọc danh sách bảng theo quyền từng người; một lượt đọc membership cho mọi nguồn của mọi bảng."""
    if account.get("role") == "admin":
        return list(aggregates)
    source_ids = [
        source["competition_id"]
        for aggregate in aggregates
        for source in aggregate.get("sources") or []
    ]
    active = await _active_source_memberships(db, source_ids, account["_id"])
    allowed = []
    for aggregate in aggregates:
        ids = [source["competition_id"] for source in aggregate.get("sources") or []]
        if _visibility_covers(aggregate.get("visibility", VISIBILITY_DEFAULT), ids, active):
            allowed.append(aggregate)
    return allowed


# --- Điều kiện nguồn và dựng bảng ----------------------------------------------------------------


@dataclass
class SourceState:
    """Trạng thái một nguồn trong một view tại một mốc thời gian: đủ điều kiện hiển thị hay chưa.

    `reason` là lý do chưa sẵn sàng đầu tiên theo thứ tự §4.2; `None` nghĩa là sẵn sàng.
    """

    source: dict
    competition: dict | None = None
    track: str | None = None
    rule: normalization.Rule | None = None
    reason: str | None = None

    @property
    def ready(self) -> bool:
        return self.reason is None


class SourceInvalid(Exception):
    """Điểm của một bài đại diện không dùng được cho phép ghép; `index` là nguồn chứa nó."""

    def __init__(self, index: int) -> None:
        super().__init__(f"aggregate source {index} scored an unusable value")
        self.index = index


def _gate_reason(competition: dict, track: str | None, now: datetime) -> str | None:
    """Lý do hiển thị của một nguồn đã qua bước cấu hình; dữ liệu lịch hỏng coi như không hợp lệ."""
    try:
        if competition_tracks.track_locked(competition, track, now):
            return competition_tracks.REASON_TRACK_NOT_OPEN
        if not competition_tracks.results_visible(competition, track):
            return competition_tracks.REASON_PRIVATE_UNPUBLISHED
    except (KeyError, TypeError, AttributeError):
        return REASON_SOURCE_INVALID
    if not competition.get("leaderboard_visible", False):
        return competition_tracks.REASON_LEADERBOARD_HIDDEN
    if contracts.participant_contract(competition).primary_metric is None:
        return competition_tracks.REASON_SOURCE_METRIC_HIDDEN
    return None


async def source_states(
    db, sources: list[dict], *, view: str, now: datetime
) -> list[SourceState]:
    """Đánh giá từng nguồn cho đúng view và mốc thời gian của request, theo thứ tự §4.2.

    Đây là điều kiện của nguồn/view, không kiểm membership của người xem tại từng nguồn.
    """
    documents = await load_source_documents(db, sources)
    states: list[SourceState] = []
    for source in sources:
        state = SourceState(source=source)
        states.append(state)
        competition = documents.get(source["competition_id"])
        if competition is None:
            state.reason = REASON_SOURCE_MISSING
            continue
        state.competition = competition
        status = competition.get("status")
        if status == "draft":
            state.reason = REASON_SOURCE_DRAFT
            continue
        if status not in ("published", "closed"):
            state.reason = REASON_SOURCE_INVALID
            continue
        try:
            state.rule, _ = source_calculation(competition)
            state.track = view if competition_tracks.is_dual(competition) else None
            if state.track is not None and competition_tracks.track_config(competition, state.track) is None:
                raise KeyError(state.track)
        except (AggregateError, KeyError):
            state.rule = None
            state.track = None
            state.reason = REASON_SOURCE_INVALID
            continue
        state.reason = _gate_reason(competition, state.track, now)
    return states


def _score_of(state: SourceState, entry: dict):
    if state.rule is not None:
        return entry.get("normalized_score")
    return entry.get("primary_score")


def aggregate_rows(states: list[SourceState], boards: list) -> list[dict]:
    """Ghép điểm theo account rồi xếp hạng trên tổng chưa làm tròn.

    Tập thí sinh là hợp các account có entry tại ít nhất một nguồn. Điểm đại diện hỏng raise
    `SourceInvalid` - view chuyển sang chờ, không tự biến thành 0 hay coi như chưa nộp.
    """
    accounts: dict[str, dict] = {}
    for index, (state, board) in enumerate(zip(states, boards)):
        for entry in board.entries:
            value = _score_of(state, entry)
            if not normalization.is_valid_score(value):
                raise SourceInvalid(index)
            account_id = entry["account_id"]
            row = accounts.get(account_id)
            if row is None:
                # Tên hiển thị đọc sống từ account ở mỗi board; nguồn nào có account trước thì lấy.
                row = accounts[account_id] = {
                    "account_id": account_id,
                    "display_name": entry["display_name"],
                    "components": [None] * len(states),
                }
            row["components"][index] = float(value)

    weights = [state.source["weight"] for state in states]
    rows: list[dict] = []
    for row in accounts.values():
        contributions = [
            weight * value
            for weight, value in zip(weights, row["components"])
            if value is not None
        ]
        total = math.fsum(contributions)
        if not math.isfinite(total):
            # Chỉ còn chạm được khi tổng tràn double dù mọi tích đều hữu hạn; gán nguồn đầu để
            # view dừng hẳn thay vì trả Infinity cho người xem.
            raise SourceInvalid(0)
        row["total_score"] = total
        rows.append(row)

    # Hòa thật (bằng nhau tuyệt đối) mới đồng hạng kiểu 1, 2, 2, 4; account_id chỉ giữ thứ tự
    # dòng ổn định trong nhóm hòa. Số hiển thị làm tròn không bao giờ tham gia xếp hạng.
    rows.sort(key=lambda row: (-row["total_score"], row["account_id"]))
    rank = 0
    previous = None
    for position, row in enumerate(rows, start=1):
        if previous is None or row["total_score"] != previous:
            rank = position
        row["rank"] = rank
        previous = row["total_score"]
    return rows


def _metric_label(competition: dict) -> str | None:
    """Nhãn metric chính theo hợp đồng thí sinh; hợp đồng hỏng thì lùi về chính mã metric."""
    contract = contracts.participant_contract(competition)
    if contract.primary_metric is None:
        return None
    for metric in contract.metrics:
        if metric.key == contract.primary_metric:
            return metric.label
    return contract.primary_metric


def _source_view(state: SourceState) -> dict:
    """Nguồn trong header: đủ để UI dựng cột và giải thích vì sao bảng đang chờ.

    Nhãn metric chỉ xuất hiện khi nguồn sẵn sàng - nguồn đang chờ vì metric bị ẩn thì không
    được lộ tên metric qua chính lời giải thích chờ.
    """
    competition = state.competition
    score_kind = None
    metric_label = None
    if state.ready and competition is not None:
        if state.rule is not None:
            score_kind = SCORE_KIND_NORMALIZED
            metric_label = NORM_LABEL
        else:
            score_kind = SCORE_KIND_PRIMARY
            metric_label = _metric_label(competition)
    return {
        "competition_id": str(state.source["competition_id"]),
        "slug": competition.get("slug") if competition else None,
        "name": competition.get("name") if competition else None,
        "weight": state.source["weight"],
        "score_kind": score_kind,
        "metric_label": metric_label,
        "ready": state.ready,
        "reason": state.reason,
    }


def _header(aggregate: dict, states: list[SourceState], view: str) -> dict:
    return {
        "slug": aggregate["_id"],
        "name": aggregate["name"],
        "view": view,
        "has_private": any(
            state.competition is not None and competition_tracks.is_dual(state.competition)
            for state in states
        ),
        "updated_at": iso_z(aggregate["updated_at"]),
        "sources": [_source_view(state) for state in states],
    }


def _entry_view(row: dict, current_account_id, states: list[SourceState]) -> dict:
    """Một dòng bảng tổng hợp; không lộ account_id hay submission ID trên API thí sinh.

    `components` luôn đủ nguồn và đúng thứ tự cấu hình; `null` là nguồn chưa có kết quả, khác
    hẳn điểm 0 thật.
    """
    return {
        "rank": row["rank"],
        "display_name": row["display_name"],
        "is_current_user": row["account_id"] == str(current_account_id),
        "total_score": row["total_score"],
        "components": [
            {"competition_id": str(state.source["competition_id"]), "score": component}
            for state, component in zip(states, row["components"])
        ],
    }


def waiting_response(
    aggregate: dict,
    states: list[SourceState],
    view: str,
    *,
    limit: int,
    offset: int,
) -> dict:
    """View chờ công bố: không rò rows, `me`, số đếm hay điểm của các nguồn đã sẵn sàng."""
    return {
        **_header(aggregate, states, view),
        "status": STATUS_WAITING,
        "entries": [],
        "total": None,
        "limit": limit,
        "offset": offset,
        "has_more": False,
        "me": None,
    }


def ready_response(
    aggregate: dict,
    states: list[SourceState],
    rows: list[dict],
    view: str,
    *,
    current_account_id,
    limit: int,
    offset: int,
) -> dict:
    page = rows[offset : offset + limit]
    me = next(
        (row for row in rows if row["account_id"] == str(current_account_id)),
        None,
    )
    return {
        **_header(aggregate, states, view),
        "status": STATUS_READY,
        "entries": [_entry_view(row, current_account_id, states) for row in page],
        "total": len(rows),
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(page) < len(rows),
        "me": _entry_view(me, current_account_id, states) if me else None,
    }


async def leaderboard_view(
    db, aggregate: dict, *, view, limit: int, offset: int, account: dict
) -> dict:
    """Payload bảng tổng hợp cho một view; caller đã kiểm công bố và quyền xem.

    Nguồn chưa đạt một trong các điều kiện §4.2 làm cả view chờ; tất cả nguồn đạt nhưng chưa
    có bài hợp lệ là bảng ready rỗng - hai trạng thái khác nhau và không được lẫn.
    """
    checked_view = clean_view(view)
    now = datetime.now(timezone.utc)
    states = await source_states(db, aggregate["sources"], view=checked_view, now=now)
    if any(not state.ready for state in states):
        return waiting_response(aggregate, states, checked_view, limit=limit, offset=offset)
    boards = [
        await leaderboard_service.cached_ranked_board(db, state.competition, track=state.track)
        for state in states
    ]
    try:
        rows = aggregate_rows(states, boards)
    except SourceInvalid as exc:
        states[exc.index].reason = REASON_SOURCE_INVALID
        return waiting_response(aggregate, states, checked_view, limit=limit, offset=offset)
    return ready_response(
        aggregate,
        states,
        rows,
        checked_view,
        current_account_id=account["_id"],
        limit=limit,
        offset=offset,
    )


def list_item(aggregate: dict, documents: dict) -> dict:
    """Dòng danh sách cho cả trang thí sinh lẫn trang admin."""
    sources = []
    for source in aggregate.get("sources") or []:
        competition = documents.get(source["competition_id"])
        sources.append(
            {
                "competition_id": str(source["competition_id"]),
                "slug": competition.get("slug") if competition else None,
                "name": competition.get("name") if competition else None,
                "weight": source["weight"],
            }
        )
    return {
        "slug": aggregate["_id"],
        "name": aggregate["name"],
        "visibility": aggregate.get("visibility", VISIBILITY_DEFAULT),
        "sources": sources,
        "updated_at": iso_z(aggregate["updated_at"]),
    }


def admin_detail(aggregate: dict, documents: dict) -> dict:
    return {
        **list_item(aggregate, documents),
        "published": aggregate.get("published", False),
        "created_at": iso_z(aggregate["created_at"]),
        "created_by": aggregate.get("created_by"),
    }
