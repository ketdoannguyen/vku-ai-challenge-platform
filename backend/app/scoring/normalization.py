"""Điểm chuẩn hóa tùy chọn 0-100 theo mặt bằng kết quả thực tế của từng cuộc thi.

Cuộc thi bật `normalization` có baseline do admin nhập (chỉ khi còn nháp). Điểm norm hiện tại trên
bảng xếp hạng là `100 * (s - baseline) / (B - baseline)`: `s` là điểm gốc của bài, `B` là điểm gốc
tốt nhất trong toàn bộ bài hợp lệ của cuộc thi (higher-is-better; lower-is-better đảo chiều).
Không vượt baseline - kể cả bằng - là 0, và điểm gốc không bao giờ bị ghi đè.

Module thuần đọc cấu hình, tính toán và projection: không truy cập DB, không import
`competitions.service`/`submissions.service` (tránh vòng lặp import). Query dữ liệu nằm ở
`submissions.service`, xếp hạng nằm ở `leaderboard.service`.
"""

import math
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, localcontext

from pydantic import BaseModel, field_validator

from app.core.datetimes import iso_z
from app.scoring import contracts

CONFIG_FIELD = "normalization"
SNAPSHOT_FIELD = "normalization_snapshot"
VERSION = 1
MAX_SCORE = 100
DECIMALS = 2


class NormalizationError(ValueError):
    """Cấu hình chuẩn hóa không dùng được; không quay về xếp hạng raw để tránh sai hạng âm thầm."""


class NormalizationRequest(BaseModel):
    """Phần cấu hình admin được gửi lên; cap 100 và version do backend ấn định."""

    enabled: bool = False
    baseline: float | None = None

    @field_validator("baseline", mode="before")
    @classmethod
    def _reject_bool(cls, value):
        # Pydantic lax ép `true` thành 1.0, biến boolean thành một baseline trông như thật.
        if isinstance(value, bool):
            raise ValueError("baseline phải là số, không phải boolean.")
        return value


@dataclass(frozen=True)
class Config:
    enabled: bool
    baseline: float | None
    version: int


@dataclass(frozen=True)
class Rule:
    """Cấu hình đang áp dụng kèm metric nguồn và chiều xếp hạng của hợp đồng kết quả."""

    baseline: float
    source_metric: str
    higher_is_better: bool
    version: int = VERSION


def config_payload(value: NormalizationRequest | dict | None) -> dict:
    """Chuẩn hóa cấu hình nhận từ request thành dạng lưu; raise ValueError với message tiếng Việt.

    Tắt chuẩn hóa luôn lưu `{enabled: false, baseline: null}` để không còn baseline mồ côi.
    """
    if value is not None and not isinstance(value, NormalizationRequest):
        value = NormalizationRequest(**value)
    if value is None or not value.enabled:
        return {"enabled": False, "baseline": None, "version": VERSION}
    baseline = _as_finite(value.baseline)
    if baseline is None:
        raise ValueError("Bật chuẩn hóa cần baseline là số hữu hạn.")
    return {"enabled": True, "baseline": baseline, "version": VERSION}


def stored_config(competition: dict) -> Config:
    """Cấu hình norm đã lưu; field vắng nghĩa là tắt (không backfill).

    Bản ghi bật chuẩn hóa nhưng hỏng raise NormalizationError: xếp hạng theo luật cũ trong khi
    admin tưởng đang chạy norm là sai nghiêm trọng hơn một lỗi cấu hình rõ ràng.
    """
    raw = competition.get(CONFIG_FIELD)
    if raw is None:
        return Config(enabled=False, baseline=None, version=VERSION)
    if not isinstance(raw, dict):
        raise NormalizationError("Cấu hình chuẩn hóa đã lưu không đọc được.")
    if not raw.get("enabled"):
        return Config(enabled=False, baseline=None, version=VERSION)
    baseline = _as_finite(raw.get("baseline"))
    if baseline is None:
        raise NormalizationError("Cuộc thi đang bật chuẩn hóa nhưng baseline đã lưu không hợp lệ.")
    version = raw.get("version", VERSION)
    if not isinstance(version, int) or isinstance(version, bool):
        raise NormalizationError("Cấu hình chuẩn hóa đã lưu có version không đọc được.")
    return Config(enabled=True, baseline=baseline, version=version)


def config_view(competition: dict) -> dict:
    """Cấu hình norm cho DTO hiển thị: chỉ luật, không kèm dữ liệu bài nộp của ai.

    Đọc khoan dung: bản ghi hỏng vẫn hiện nguyên trạng (bật, baseline trống) để admin còn thấy
    đường sửa, thay vì một cuộc thi hỏng làm sập cả danh sách. Đường xếp hạng vẫn raise qua
    `active_rule` - DTO này không quyết định thứ hạng.
    """
    raw = competition.get(CONFIG_FIELD)
    if not isinstance(raw, dict) or not raw.get("enabled"):
        return {"enabled": False, "baseline": None, "version": VERSION}
    version = raw.get("version", VERSION)
    if not isinstance(version, int) or isinstance(version, bool):
        version = VERSION
    return {"enabled": True, "baseline": _as_finite(raw.get("baseline")), "version": version}


def request_of(competition: dict) -> NormalizationRequest:
    """Cấu hình đang lưu ở dạng request để clone giữ nguyên; bản ghi hỏng raise NormalizationError."""
    config = stored_config(competition)
    return NormalizationRequest(enabled=config.enabled, baseline=config.baseline)


def active_rule(competition: dict) -> Rule | None:
    """Luật chuẩn hóa đang áp dụng, `None` khi tắt; raise khi bật mà thiếu nguồn điểm."""
    config = stored_config(competition)
    if not config.enabled:
        return None
    ranking = contracts.ranking(competition)
    if ranking is None:
        raise NormalizationError(
            "Cuộc thi đang bật chuẩn hóa nhưng chưa có metric chính để lấy điểm nguồn."
        )
    metric, higher_is_better = ranking
    return Rule(
        baseline=config.baseline,
        source_metric=metric,
        higher_is_better=higher_is_better,
        version=config.version,
    )


def ensure_usable(competition: dict) -> None:
    """Raise NormalizationError khi norm đang bật mà cấu hình không dùng được."""
    active_rule(competition)


def config_guard(competition: dict) -> dict:
    """Điều kiện Mongo khẳng định cấu hình norm vẫn đúng như lúc đọc.

    Không so nguyên subdocument: Mongo so cả field lẫn thứ tự, còn bản lưu có thể ở dạng cũ
    (thiếu field) hoặc ghép từ nhiều lần ghi. Vì vậy pin từng subfield đã quan sát, và trường
    hợp field vắng phải đòi đúng trạng thái vắng mặt - `$exists: false` - thay vì so với bản
    canonicalize rồi báo conflict giả.
    """
    if CONFIG_FIELD not in competition:
        return {CONFIG_FIELD: {"$exists": False}}
    stored = competition[CONFIG_FIELD]
    if not isinstance(stored, dict):
        return {CONFIG_FIELD: stored}
    guard: dict = {}
    for key in ("enabled", "baseline", "version"):
        if key in stored:
            guard[f"{CONFIG_FIELD}.{key}"] = stored[key]
        else:
            guard[f"{CONFIG_FIELD}.{key}"] = {"$exists": False}
    return guard


def is_valid_score(value) -> bool:
    """Điểm gốc dùng được cho chuẩn hóa: số hữu hạn, boolean không phải là điểm."""
    return _as_finite(value) is not None


def score(raw, *, baseline: float, reference: float, higher_is_better: bool) -> float:
    """Điểm norm 0-100 của `raw` khi `reference` là điểm gốc tốt nhất hiện có.

    Không vượt baseline (kể cả bằng) trả 0. Không làm tròn tại đây: giá trị thô dùng để xếp hạng,
    chỉ lúc hiển thị mới cắt 2 chữ số - đổi chỗ hai bước đó có thể đảo thứ tự của các bài hòa.
    """
    raw_gap = _gap_above(raw, baseline, higher_is_better)
    best_gap = _gap_above(reference, baseline, higher_is_better)
    if raw_gap is None or best_gap is None:
        return 0.0
    if math.isfinite(raw_gap) and math.isfinite(best_gap):
        value = MAX_SCORE * (raw_gap / best_gap)
    else:
        # Hiệu hai số hữu hạn cực lớn có thể tràn double; Decimal giữ đúng tỷ lệ thay vì để
        # NaN/Infinity lọt vào bảng xếp hạng.
        value = _wide_ratio(
            raw, baseline=baseline, reference=reference, higher_is_better=higher_is_better
        )
    if math.isnan(value):
        return 0.0
    # Clamp chỉ bảo vệ sai số số học, không che một cấu hình sai.
    return min(float(MAX_SCORE), max(0.0, value))


def reference_best(values: Iterable[float], higher_is_better: bool) -> float | None:
    """Điểm gốc tốt nhất (max/min theo chiều xếp hạng) trong tập hợp lệ; None khi tập rỗng."""
    best = None
    for value in values:
        if best is None or (value > best if higher_is_better else value < best):
            best = value
    return best


def snapshot_payload(rule: Rule, *, raw: float, reference: float, calculated_at: datetime) -> dict:
    """Snapshot tạm ghi MỘT LẦN cùng submission; không bao giờ được viết lại sau đó."""
    return {
        "version": rule.version,
        "source_metric": rule.source_metric,
        "higher_is_better": rule.higher_is_better,
        "baseline": rule.baseline,
        "reference_best": reference,
        "score": score(
            raw, baseline=rule.baseline, reference=reference, higher_is_better=rule.higher_is_better
        ),
        "calculated_at": calculated_at,
    }


def participant_snapshot(snapshot: dict | None) -> dict | None:
    """Dạng snapshot cho thí sinh: chỉ điểm tạm và thời điểm, không lộ mặt bằng điểm người khác."""
    if not snapshot:
        return None
    return {"score": snapshot.get("score"), "calculated_at": iso_z(snapshot["calculated_at"])}


def admin_snapshot(snapshot: dict | None) -> dict | None:
    """Dạng đầy đủ cho admin: đủ baseline/reference/version để đối chiếu khi hậu kiểm."""
    if not snapshot:
        return None
    return {**snapshot, "calculated_at": iso_z(snapshot["calculated_at"])}


def board_metadata(rule: Rule, *, reference: float | None, calculated_at: datetime) -> dict:
    """Metadata BXH, dựng trong cùng lần build với các entry - không query lại điểm tốt nhất."""
    return {
        "version": rule.version,
        "source_metric": rule.source_metric,
        "higher_is_better": rule.higher_is_better,
        "baseline": rule.baseline,
        "max_score": MAX_SCORE,
        "decimals": DECIMALS,
        "reference_best": reference,
        "calculated_at": iso_z(calculated_at),
    }


def cache_identity(competition: dict) -> tuple:
    """Thành phần key cache BXH theo cấu hình norm; đổi baseline/phiên bản phải làm cache cũ vô hiệu."""
    rule = active_rule(competition)
    if rule is None:
        return ("off",)
    return ("on", rule.version, rule.baseline, rule.source_metric, rule.higher_is_better)


def _as_finite(value) -> float | None:
    """`float` hữu hạn của int/float hợp lệ, `None` cho bool, kiểu khác, NaN/Infinity."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def _gap_above(value: float, baseline: float, higher_is_better: bool) -> float | None:
    """Khoảng cách đã vượt baseline theo chiều tốt hơn; None khi chưa vượt (kể cả bằng)."""
    if higher_is_better:
        return value - baseline if value > baseline else None
    return baseline - value if value < baseline else None


def _wide_ratio(raw, *, baseline: float, reference: float, higher_is_better: bool) -> float:
    """Tỷ lệ tính bằng Decimal cho miền hữu hạn vượt tầm double (hiệu hai đầu tràn thành inf)."""
    with localcontext() as context:
        context.prec = 60
        sign = Decimal(1 if higher_is_better else -1)
        raw_gap = (Decimal(raw) - Decimal(baseline)) * sign
        best_gap = (Decimal(reference) - Decimal(baseline)) * sign
        if raw_gap <= 0 or best_gap <= 0:
            return 0.0
        return float(Decimal(MAX_SCORE) * raw_gap / best_gap)
