"""Mô hình cấu hình chấm điểm v2: schema CSV, evaluator do admin cung cấp, output contract.

Cấu hình v1 (`scoring_config` không có `version`) vẫn nằm ở `service.py`; file này chỉ mô tả và kiểm
tra v2, cùng phép kiểm tra tĩnh không cần chạy code.
"""

import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.scoring.errors import ScoringValidationError

ID_COLUMN_TYPES = ("string", "integer")
PREPROCESSING_VERSION = 1
DEFAULT_ENTRYPOINT = "evaluate"
# Phiên bản giao thức giữa API và runner; đổi cách gọi evaluate phải tăng số này.
RUNNER_PROTOCOL_VERSION = 1

METRIC_KEY_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
MAX_METRICS = 20
MAX_SOURCE_BYTES = 256 * 1024
MIN_DECIMALS = 0
MAX_DECIMALS = 8

ColumnType = Literal["string", "integer", "number"]
AllowedValue = str | int | float


class ColumnSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    type: ColumnType
    nullable: bool = False
    # `None` = không kiểm tra enum. Mảng rỗng là cấu hình sai, không phải "không giới hạn".
    allowed_values: list[AllowedValue] | None = None


class FileSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id_column: str
    allow_extra_columns: bool = False
    columns: list[ColumnSpec]


class InputSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ground_truth: FileSchema
    submission: FileSchema
    id_matching: Literal["exact"] = "exact"
    row_alignment: Literal["ground_truth_order"] = "ground_truth_order"
    preprocessing_version: int = PREPROCESSING_VERSION


class EvaluatorConfig(BaseModel):
    """Metadata bộ chấm đã lưu. Source nằm ở file riêng tư, không nằm trong document."""

    model_config = ConfigDict(extra="forbid")

    name: str
    entrypoint: str = DEFAULT_ENTRYPOINT
    source_path: str | None = None
    source_sha256: str | None = None
    runtime_id: str | None = None


class MetricDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str
    label: str
    decimals: int = 4


class OutputContract(BaseModel):
    model_config = ConfigDict(extra="forbid")

    metrics: list[MetricDefinition]
    primary_metric: str | None = None
    higher_is_better: bool = True


class Verification(BaseModel):
    """Bằng chứng của lượt chạy thử đã xác minh cấu hình hiện tại."""

    model_config = ConfigDict(extra="forbid")

    state: Literal["passed"] | None = None
    execution_fingerprint: str | None = None
    config_fingerprint: str | None = None
    observed_keys: list[str] = []
    tested_submission_sha256: str | None = None
    tested_at: datetime | None = None
    tested_by: str | None = None


class ScoringConfigV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[2] = 2
    revision: int = 0
    input_schema: InputSchema
    evaluator: EvaluatorConfig
    output_contract: OutputContract | None = None
    verification: Verification | None = None


class EvaluatorRequest(BaseModel):
    """Phần evaluator mà client được gửi lên. Hash, đường dẫn và runtime do backend tạo."""

    model_config = ConfigDict(extra="forbid")

    name: str = ""
    source_code: str | None = None


class ScoringConfigRequest(BaseModel):
    """Body của `PUT /scoring`. Có `version` để phân biệt với body v1 trên cùng một endpoint."""

    model_config = ConfigDict(extra="forbid")

    version: Literal[2] = 2
    expected_revision: int
    input_schema: InputSchema
    evaluator: EvaluatorRequest
    output_contract: OutputContract | None = None


def stored_config(competition: dict) -> ScoringConfigV2 | None:
    """Cấu hình v2 đã lưu, hoặc None khi cuộc thi chưa cấu hình hay đang chạy bộ chấm v1."""
    raw = competition.get("scoring_config")
    if not raw or raw.get("version") != 2:
        return None
    return ScoringConfigV2(**raw)


def stored_config_or_none(competition: dict) -> ScoringConfigV2 | None:
    """Cấu hình v2 nếu đọc được; document hỏng trả None để đường hiển thị không vỡ.

    Readiness và lượt lưu dùng `stored_config` trực tiếp để còn phát hiện bản hỏng.
    """
    try:
        return stored_config(competition)
    except Exception:
        return None


def is_v2(competition: dict) -> bool:
    raw = competition.get("scoring_config")
    return bool(raw) and raw.get("version") == 2


def _check_no_space(value: str, *, field: str, code: str) -> str:
    if not value or value != value.strip():
        raise ScoringValidationError(code, f"{field} không được để trống hoặc có khoảng trắng thừa.")
    return value


def _check_allowed_values(column: ColumnSpec, code: str) -> None:
    values = column.allowed_values
    if values is None:
        return
    if not values:
        raise ScoringValidationError(
            code, f"Cột {column.name}: danh sách giá trị cho phép không được để rỗng."
        )
    if len(values) != len(set(values)):
        raise ScoringValidationError(
            code, f"Cột {column.name}: danh sách giá trị cho phép bị trùng."
        )
    for value in values:
        if isinstance(value, bool):
            raise ScoringValidationError(
                code, f"Cột {column.name}: giá trị cho phép phải là chuỗi hoặc số, không phải boolean."
            )
        if column.type == "string" and not isinstance(value, str):
            raise ScoringValidationError(
                code, f"Cột {column.name}: cột kiểu string chỉ nhận giá trị cho phép dạng chuỗi."
            )
        if column.type == "integer" and not isinstance(value, int):
            raise ScoringValidationError(
                code, f"Cột {column.name}: cột kiểu integer chỉ nhận giá trị cho phép dạng số nguyên."
            )
        # Chuỗi trên cột số không so sánh được với ô đã parse thành số, nên phải chặn ở đây thay vì
        # để `_in_allowed` ném ValueError giữa lúc chấm.
        if column.type == "number" and not isinstance(value, (int, float)):
            raise ScoringValidationError(
                code, f"Cột {column.name}: cột kiểu number chỉ nhận giá trị cho phép dạng số."
            )


def _check_file_schema(schema: FileSchema, *, kind: str, code: str) -> None:
    _check_no_space(schema.id_column, field=f"{kind}: cột ID", code=code)
    if not schema.columns:
        raise ScoringValidationError(code, f"{kind}: cần khai báo ít nhất một cột.")
    names = [column.name for column in schema.columns]
    for name in names:
        _check_no_space(name, field=f"{kind}: tên cột", code=code)
    if len(names) != len(set(names)):
        raise ScoringValidationError(code, f"{kind}: tên cột phải duy nhất.")
    if schema.id_column not in names:
        raise ScoringValidationError(
            code, f"{kind}: cột ID '{schema.id_column}' phải nằm trong danh sách cột khai báo."
        )
    for column in schema.columns:
        _check_allowed_values(column, code)
    id_column = next(column for column in schema.columns if column.name == schema.id_column)
    if id_column.type not in ID_COLUMN_TYPES:
        raise ScoringValidationError(code, f"{kind}: cột ID chỉ nhận kiểu string hoặc integer.")
    if id_column.nullable:
        raise ScoringValidationError(code, f"{kind}: cột ID không được phép để trống.")


def validate_input_schema(schema: InputSchema, *, code: str = "SCORING_CONFIG_INVALID") -> None:
    _check_file_schema(schema.ground_truth, kind="Ground truth", code=code)
    _check_file_schema(schema.submission, kind="Submission", code=code)
    if schema.preprocessing_version != PREPROCESSING_VERSION:
        raise ScoringValidationError(
            code, f"Phiên bản chuẩn bị dữ liệu phải là {PREPROCESSING_VERSION}."
        )
    truth_id = _id_column_type(schema.ground_truth)
    submission_id = _id_column_type(schema.submission)
    if truth_id != submission_id:
        raise ScoringValidationError(
            code, "Cột ID của ground truth và submission phải cùng kiểu (string hoặc integer)."
        )


def _id_column_type(schema: FileSchema) -> str:
    return next(
        column.type for column in schema.columns if column.name == schema.id_column
    )


def validate_output_contract(
    contract: OutputContract, *, code: str = "SCORING_CONFIG_INVALID"
) -> None:
    if not contract.metrics:
        raise ScoringValidationError(code, "Cần khai báo ít nhất một metric.")
    if len(contract.metrics) > MAX_METRICS:
        raise ScoringValidationError(code, f"Tối đa {MAX_METRICS} metric mỗi cuộc thi.")
    keys = [metric.key for metric in contract.metrics]
    for key in keys:
        if not METRIC_KEY_RE.fullmatch(key):
            raise ScoringValidationError(
                code,
                f"Khóa metric '{key}' không hợp lệ: chỉ gồm chữ, số và dấu gạch dưới, bắt đầu bằng chữ.",
            )
    if len(keys) != len(set(keys)):
        raise ScoringValidationError(code, "Khóa metric phải duy nhất.")
    for metric in contract.metrics:
        if not metric.label.strip():
            raise ScoringValidationError(code, f"Metric '{metric.key}' thiếu tên hiển thị.")
        if not MIN_DECIMALS <= metric.decimals <= MAX_DECIMALS:
            raise ScoringValidationError(
                code, f"Metric '{metric.key}': số chữ số thập phân phải từ {MIN_DECIMALS} đến {MAX_DECIMALS}."
            )
    if contract.primary_metric is not None and contract.primary_metric not in keys:
        raise ScoringValidationError(
            code, "Metric chính phải nằm trong danh sách metric đã khai báo."
        )


def validate_evaluator_config(evaluator: EvaluatorConfig, *, code: str = "SCORING_CONFIG_INVALID") -> None:
    if not evaluator.name.strip():
        raise ScoringValidationError(code, "Bộ chấm cần có tên để hiển thị và đối chiếu.")
    if evaluator.entrypoint != DEFAULT_ENTRYPOINT:
        raise ScoringValidationError(code, f"Điểm vào của bộ chấm phải là {DEFAULT_ENTRYPOINT}.")
