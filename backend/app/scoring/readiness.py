"""Trạng thái sẵn sàng chấm điểm — một nguồn sự thật cho publish và cho UI admin.

Publish, banner ở trang admin và endpoint scoring đều đi qua đây. Readiness phải đọc và
parse lại ground truth thật (không chỉ `is_file()`), vì một file hỏng vẫn làm mọi bài
nộp 422 sau khi cuộc thi đã publish.
"""

from dataclasses import dataclass

from app.scoring import service as scoring_service
from app.scoring import storage as scoring_storage


@dataclass(frozen=True)
class Readiness:
    ready: bool
    code: str | None = None
    message: str | None = None


def check_readiness(competition: dict) -> Readiness:
    """Trả lý do chặn đầu tiên theo thứ tự: cấu hình chấm điểm → ground truth."""
    try:
        config = scoring_service.config_from_competition(competition)
    except Exception:
        config = None
    if config is None:
        return Readiness(
            False, "SCORING_CONFIG_REQUIRED", "Cần cấu hình chấm điểm trước khi publish cuộc thi."
        )
    try:
        scoring_service.validate_config(config)
    except scoring_service.ScoringValidationError as exc:
        return Readiness(False, exc.code, exc.message)

    if not competition.get("ground_truth"):
        return Readiness(
            False, "GROUND_TRUTH_REQUIRED", "Cần tải lên ground truth trước khi publish cuộc thi."
        )
    try:
        data = scoring_storage.read_ground_truth(competition)
    except (KeyError, OSError, ValueError):
        return Readiness(False, "GROUND_TRUTH_INVALID", "Ground truth hiện tại không đọc được.")
    try:
        scoring_service.load_ground_truth(data, config)
    except scoring_service.ScoringValidationError as exc:
        return Readiness(False, exc.code, exc.message)
    return Readiness(True)


def blocked_reason(readiness: Readiness) -> dict | None:
    """Dạng lỗi cho UI: `{"code", "message"}`, hoặc None khi đã sẵn sàng."""
    if readiness.ready:
        return None
    return {"code": readiness.code, "message": readiness.message}
