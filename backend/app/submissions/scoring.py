"""Chấm một bài nộp: bộ chấm cố định v1 (backend tự tính) và bộ chấm Python v2 (admin cấp).

Tách khỏi router vì hai đường dùng chung: API chấm v1 ngay trong request, worker hàng đợi chấm v2
sau khi bài đã vào hàng. Dùng chung một hàm nghĩa là cùng phép kiểm CSV, cùng dấu vân tay.
"""

import logging
from dataclasses import dataclass

from app.competitions import tracks as competition_tracks
from app.core.errors import api_error
from app.scoring import csv_validation, execution, models, output_validation, revisions
from app.scoring import service as scoring_service
from app.scoring import storage as scoring_storage
from app.scoring.errors import ScoringValidationError

logger = logging.getLogger(__name__)

SCORING_NOT_READY_MESSAGE = "Cuộc thi chưa sẵn sàng chấm điểm."
# Lỗi thuộc về file thí sinh: giữ mã riêng để em biết phải sửa gì. Mọi lỗi còn lại - ground truth
# hỏng, hợp đồng metric lệch, bộ chấm lỗi, runner bận - là lỗi hệ thống mà thí sinh không sửa được.
STUDENT_ERROR_CODES = frozenset(
    {
        csv_validation.SCHEMA_INVALID,
        csv_validation.VALUE_INVALID,
        csv_validation.DUPLICATE_IDS,
        csv_validation.ID_MISMATCH,
    }
)


@dataclass(frozen=True)
class Scored:
    metrics: dict[str, float]
    primary_score: float
    # Dấu vết của lượt chấm v2; v1 để None vì bộ chấm và công thức là cố định trong mã nguồn.
    scoring_ref: dict | None = None


def score_v1(
    competition: dict, config: scoring_service.ScoringConfig, data: bytes, *, track: str | None = None
) -> Scored:
    """Bộ chấm cố định của v1: backend tự tính f1/precision/recall từ cột prediction."""
    ground_truth_data = read_ground_truth(competition, track)
    ground_truth = scoring_service.load_ground_truth(ground_truth_data, config)
    result = scoring_service.score_submission(
        data, ground_truth, config, competition["primary_metric"]
    )
    return Scored(metrics=result.metrics, primary_score=result.primary_score)


async def score_v2(
    competition: dict,
    config: models.ScoringConfigV2,
    data: bytes,
    *,
    track: str | None = None,
    client_timeout: float | None = None,
) -> Scored:
    """Bộ chấm Python của admin: backend kiểm dữ liệu, gọi runner rồi đối chiếu hợp đồng metric.

    `track` chọn đúng ground truth của nhánh đang chấm; bộ chấm dùng chung nên dấu vết phải ghi
    cả nhánh để hậu kiểm biết điểm sinh từ GT nào. `client_timeout` cho worker hàng đợi cắt lượt
    gọi theo thời gian còn lại của hạn 60 giây; API chấm v1 và lượt chạy thử của admin không
    truyền nên dùng trần mặc định.
    """
    source = read_evaluator_source(competition, config)
    ground_truth_data = read_ground_truth(competition, track)
    evaluation = await execution.evaluate(
        config,
        source=source,
        ground_truth_data=ground_truth_data,
        submission_data=data,
        client_timeout=client_timeout,
    )
    if config.output_contract is None:
        raise ScoringValidationError("SCORING_TEST_REQUIRED", "Cuộc thi chưa khai báo metric.")
    scoring_ref = {
        "version": 2,
        "revision": config.revision,
        "config_fingerprint": evaluation.config_fingerprint,
        "source_sha256": config.evaluator.source_sha256,
        "ground_truth_sha256": revisions.sha256_bytes(ground_truth_data),
        "submission_sha256": revisions.sha256_bytes(data),
        "runtime_id": evaluation.runtime_id,
    }
    if track is not None:
        # Single giữ nguyên hình dạng vết cũ; dual ghim thêm nhánh để biết điểm sinh từ GT nào.
        scoring_ref["track"] = track
    return Scored(
        metrics=evaluation.metrics,
        primary_score=output_validation.primary_score(
            evaluation.metrics, config.output_contract
        ),
        scoring_ref=scoring_ref,
    )


def validate_submission_csv(
    competition: dict, config: models.ScoringConfigV2, data: bytes, *, track: str | None = None
) -> None:
    """Kiểm file thí sinh ngay tại API, trước khi lượt vào hàng đợi.

    File sai là lỗi thí sinh sửa được, nên phải trả lời ngay chứ không bắt em chờ hết hàng đợi mới
    biết; đổi lại lượt không chiếm chỗ chờ và không giữ suất quota nào. Worker vẫn kiểm lại lần nữa
    bằng chính hàm này trước khi chấm; `track` chọn đúng schema/GT của nhánh.
    """
    truth = csv_validation.load_ground_truth(
        read_ground_truth(competition, track), config.input_schema.ground_truth
    )
    csv_validation.prepare_submission(data, config.input_schema.submission, truth)


def read_evaluator_source(competition: dict, config: models.ScoringConfigV2) -> str:
    """Source đã xác minh lúc publish phải đúng là source đang chạy."""
    try:
        raw = scoring_storage.read_evaluator_source(config.evaluator)
        source = raw.decode("utf-8")
    except (KeyError, OSError, ValueError, UnicodeDecodeError):
        logger.error("Evaluator source unreadable competition=%s", competition["_id"])
        raise scoring_not_ready()
    if revisions.sha256_bytes(raw) != config.evaluator.source_sha256:
        logger.error("Evaluator source changed competition=%s", competition["_id"])
        raise scoring_not_ready()
    return source


def read_ground_truth(competition: dict, track: str | None = None) -> bytes:
    """Ground truth đang dùng của đúng nhánh; khác bản đã xác minh cũng là cuộc thi không sẵn sàng."""
    try:
        data = scoring_storage.read_ground_truth(competition, track)
    except (KeyError, OSError, ValueError):
        raise scoring_not_ready()
    stored_sha = (competition_tracks.track_ground_truth(competition, track) or {}).get("sha256")
    if stored_sha and stored_sha != revisions.sha256_bytes(data):
        logger.error(
            "Ground truth changed competition=%s track=%s", competition["_id"], track
        )
        raise scoring_not_ready()
    return data


def scoring_not_ready():
    return api_error(422, "SCORING_NOT_READY", SCORING_NOT_READY_MESSAGE)
