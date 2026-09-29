"""Hợp đồng kết quả dùng chung cho cả hai đời cấu hình chấm.

UI, API lịch sử, leaderboard và Excel đều đọc cột metric từ đây. Với cuộc thi v1, hợp đồng được mô
tả lại thành đúng ba metric cũ để không màn hình nào phải biết mình đang đọc bản ghi đời nào.
"""

from app.scoring import models
from app.scoring.models import MetricDefinition, OutputContract

LEGACY_METRICS = (
    MetricDefinition(key="f1", label="F1", decimals=4),
    MetricDefinition(key="precision", label="Precision", decimals=4),
    MetricDefinition(key="recall", label="Recall", decimals=4),
)


def result_contract(competition: dict) -> OutputContract:
    """Bộ chấm v1 luôn có đủ ba metric cố định; bản nháp v2 có thể chưa khai báo gì.

    Document v2 hỏng cũng coi như chưa khai báo: readiness dùng `models.stored_config` trực tiếp
    nên vẫn phát hiện được bản hỏng, còn màn hình và bảng xếp hạng không vỡ vì một bản ghi lỗi.
    """
    config = models.stored_config_or_none(competition)
    if config is not None:
        if config.output_contract is not None:
            return config.output_contract
        return OutputContract(metrics=[], primary_metric=None)
    if models.is_v2(competition):
        return OutputContract(metrics=[], primary_metric=None)
    return OutputContract(
        metrics=list(LEGACY_METRICS),
        primary_metric=competition.get("primary_metric"),
        higher_is_better=True,
    )


def contract_payload(competition: dict) -> dict:
    return result_contract(competition).model_dump(mode="json")


def ranking(competition: dict) -> tuple[str, bool] | None:
    """`(metric chính, chiều xếp hạng)` khi đã cấu hình xong, `None` khi bản nháp còn thiếu."""
    contract = result_contract(competition)
    if contract.primary_metric is None:
        return None
    return contract.primary_metric, contract.higher_is_better
