"""Gọi runner chấm điểm qua kênh nội bộ.

API chỉ biết một endpoint và một tập mã lỗi; docker, container và tài nguyên nằm sau runner. Mọi
trục trặc hạ tầng đều quy về `EVALUATOR_UNAVAILABLE`: thí sinh phải nhận một câu "hệ thống chấm đang
bận", không bao giờ là chi tiết nội bộ.
"""

import logging
from typing import NamedTuple

import httpx

from app.core.config import Settings
from app.scoring.errors import CLASS_ID_INVALID, EvaluatorError, ScoringValidationError, valid_class_info
from app.scoring.output_validation import validate_metrics

logger = logging.getLogger(__name__)

UNAVAILABLE = "EVALUATOR_UNAVAILABLE"
# Mã lỗi runner được phép trả về. Mã lạ bị quy về EVALUATOR_UNAVAILABLE vì hợp đồng lỗi là thứ API
# công bố, không phải thứ dịch vụ bên kia tự mở rộng.
REPORTED_CODES = frozenset(
    {
        "EVALUATOR_INVALID",
        "EVALUATOR_TIMEOUT",
        "EVALUATOR_FAILED",
        "EVALUATOR_OUTPUT_MISMATCH",
        "SUBMISSION_RULE_VIOLATION",
        CLASS_ID_INVALID,
        UNAVAILABLE,
    }
)


class EvaluatorResult(NamedTuple):
    metrics: dict[str, float]
    runtime_id: str
    duration_ms: int


class EvaluatorClient:
    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float | None = None,
    ) -> None:
        self._base_url = settings.evaluator_runner_url.rstrip("/")
        # `timeout` là trần riêng của lượt gọi này (worker hàng đợi cắt theo hạn 60 giây của bài);
        # không truyền thì dùng trần chung của hệ thống.
        self._timeout = timeout if timeout is not None else settings.evaluator_client_timeout_seconds
        self._transport = transport

    async def evaluate(
        self, *, source_code: str, ground_truth_csv: str, submission_csv: str
    ) -> EvaluatorResult:
        payload = {
            "source_code": source_code,
            "ground_truth_csv": ground_truth_csv,
            "submission_csv": submission_csv,
        }
        try:
            # `trust_env=False`: proxy trong môi trường không được chen vào kênh nội bộ này.
            async with httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout,
                trust_env=False,
                transport=self._transport,
            ) as client:
                response = await client.post("/evaluate", json=payload)
        except httpx.HTTPError as error:
            logger.warning("Không gọi được runner chấm điểm: %s", error)
            raise EvaluatorError(UNAVAILABLE, "Máy chấm đang không sẵn sàng.") from error

        return _parse(response)


def _parse(response: httpx.Response) -> EvaluatorResult:
    body = _json_body(response)
    if response.status_code == 200:
        if body.get("status") != "passed":
            raise EvaluatorError(UNAVAILABLE, "Máy chấm trả về kết quả không hợp lệ.")
        try:
            # Runner đã kiểm tra một lần; đây là chốt thứ hai ở đúng ranh giới ghi vào database.
            metrics = validate_metrics(body.get("metrics"))
        except ScoringValidationError as error:
            raise EvaluatorError(error.code, error.message) from error
        return EvaluatorResult(
            metrics=metrics,
            runtime_id=str(body.get("runtime_id") or ""),
            duration_ms=int(body.get("duration_ms") or 0),
        )

    code = body.get("code")
    if code in REPORTED_CODES:
        class_info = valid_class_info(body.get("class_info")) if code == CLASS_ID_INVALID else None
        if code == CLASS_ID_INVALID and class_info is None:
            raise EvaluatorError("EVALUATOR_FAILED", "Bộ chấm trả về mã lớp không hợp lệ.")
        raise EvaluatorError(
            code,
            str(body.get("message") or "Bộ chấm không chạy được."),
            detail=body.get("detail") or None,
            class_info=class_info,
        )
    logger.warning("Runner trả về %s với nội dung không nhận ra: %s", response.status_code, body)
    raise EvaluatorError(UNAVAILABLE, "Máy chấm đang không sẵn sàng.")


def _json_body(response: httpx.Response) -> dict:
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}
