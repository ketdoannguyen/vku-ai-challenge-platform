"""Chạy bộ chấm v2 trên đúng một bài nộp.

Lượt chạy thử của admin và lượt chấm bài thật đi chung một đường: kiểm tra CSV theo schema, căn dòng
theo ground truth, gọi runner rồi đối chiếu output contract. Hai đường lệch nhau thì một cấu hình
qua được bước chạy thử vẫn có thể làm hỏng cả cuộc thi.
"""

from dataclasses import dataclass

from app.core.config import get_settings
from app.scoring import csv_validation, evaluator_client, models, revisions
from app.scoring.output_validation import check_contract


@dataclass(frozen=True)
class Evaluation:
    """Kết quả một lượt chấm, kèm dấu vân tay của đúng những gì đã chạy để truy vết."""

    metrics: dict[str, float]
    runtime_id: str
    duration_ms: int
    execution_fingerprint: str
    config_fingerprint: str


async def evaluate(
    config: models.ScoringConfigV2,
    *,
    source: str,
    ground_truth_data: bytes,
    submission_data: bytes,
) -> Evaluation:
    """Chấm một bài nộp; lỗi cấu hình và lỗi bộ chấm được ném nguyên dạng cho người gọi.

    Hợp đồng chưa khai báo metric (bản nháp) thì không đối chiếu gì: lượt chạy thử lúc đó là để dò
    tập khóa bộ chấm trả về.
    """
    truth = csv_validation.load_ground_truth(
        ground_truth_data, config.input_schema.ground_truth
    )
    prepared = csv_validation.prepare_submission(
        submission_data, config.input_schema.submission, truth
    )
    result = await evaluator_client.EvaluatorClient(get_settings()).evaluate(
        source_code=source,
        ground_truth_csv=ground_truth_data.decode("utf-8-sig"),
        submission_csv=prepared.decode("utf-8-sig"),
    )
    if config.output_contract is not None and config.output_contract.metrics:
        check_contract(result.metrics, config.output_contract)

    # Vân tay dùng runtime thực tế đã chạy, không phải runtime đã lưu: bản ghi phải nói đúng thứ sinh
    # ra điểm, kể cả khi ảnh runtime bị đổi sau lượt chạy thử.
    execution = revisions.execution_fingerprint(
        input_schema=config.input_schema,
        source_sha256=config.evaluator.source_sha256,
        ground_truth_sha256=revisions.sha256_bytes(ground_truth_data),
        runtime_id=result.runtime_id,
    )
    return Evaluation(
        metrics=result.metrics,
        runtime_id=result.runtime_id,
        duration_ms=result.duration_ms,
        execution_fingerprint=execution,
        config_fingerprint=revisions.config_fingerprint(execution, config.output_contract),
    )
