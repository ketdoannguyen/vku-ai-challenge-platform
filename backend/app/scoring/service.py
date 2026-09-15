"""Pure CSV validation and synchronous classification scoring."""

import csv
import io
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict
from sklearn.metrics import f1_score, precision_score, recall_score

AVERAGES = ("binary", "macro", "weighted")
PRIMARY_METRICS = ("f1", "precision", "recall")
MAX_CSV_ROWS = 1_000_000


class ScoringConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id_column: str
    prediction_column: str
    label_column: str
    average: str
    pos_label: str | None = None
    higher_is_better: bool = True


@dataclass(frozen=True)
class GroundTruth:
    ids: tuple[str, ...]
    label_by_id: dict[str, str]
    labels: frozenset[str]
    columns: tuple[str, ...]

    @property
    def row_count(self) -> int:
        return len(self.ids)


@dataclass(frozen=True)
class ScoreResult:
    metrics: dict[str, float]
    primary_score: float


class ScoringValidationError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def validate_config(config: ScoringConfig) -> None:
    columns = (config.id_column, config.prediction_column, config.label_column)
    if any(not column.strip() or column != column.strip() for column in columns):
        raise ScoringValidationError(
            "SCORING_CONFIG_INVALID", "Tên cột không được để trống hoặc có khoảng trắng thừa."
        )
    if config.id_column in (config.prediction_column, config.label_column):
        raise ScoringValidationError(
            "SCORING_CONFIG_INVALID", "Cột ID phải khác cột prediction và label."
        )
    if config.average not in AVERAGES:
        raise ScoringValidationError(
            "SCORING_CONFIG_INVALID", "Average phải là binary, macro hoặc weighted."
        )
    if config.average == "binary" and not (config.pos_label or "").strip():
        raise ScoringValidationError(
            "SCORING_CONFIG_INVALID", "Binary scoring cần cấu hình positive label."
        )
    if config.average != "binary" and config.pos_label is not None:
        raise ScoringValidationError(
            "SCORING_CONFIG_INVALID", "Positive label chỉ dùng với binary scoring."
        )
    if not config.higher_is_better:
        raise ScoringValidationError(
            "SCORING_CONFIG_INVALID", "MVP chỉ hỗ trợ higher_is_better=true."
        )


def load_ground_truth(data: bytes, config: ScoringConfig) -> GroundTruth:
    validate_config(config)
    columns, rows = _read_required_rows(
        data,
        (config.id_column, config.label_column),
        kind="ground_truth",
    )
    label_by_id = {row[config.id_column]: row[config.label_column] for row in rows}
    labels = frozenset(label_by_id.values())
    if config.average == "binary":
        if len(labels) != 2 or config.pos_label not in labels:
            raise ScoringValidationError(
                "GROUND_TRUTH_INVALID",
                "Ground truth binary phải có đúng hai nhãn và chứa positive label.",
            )
    return GroundTruth(
        ids=tuple(label_by_id),
        label_by_id=label_by_id,
        labels=labels,
        columns=tuple(columns),
    )


def score_submission(
    data: bytes,
    ground_truth: GroundTruth,
    config: ScoringConfig,
    primary_metric: str,
) -> ScoreResult:
    validate_config(config)
    if primary_metric not in PRIMARY_METRICS:
        raise ScoringValidationError("SCORING_CONFIG_INVALID", "Primary metric không hợp lệ.")

    _, rows = _read_required_rows(
        data,
        (config.id_column, config.prediction_column),
        kind="submission",
    )
    prediction_by_id = {
        row[config.id_column]: row[config.prediction_column] for row in rows
    }
    expected_ids = set(ground_truth.ids)
    submitted_ids = set(prediction_by_id)
    if submitted_ids != expected_ids:
        missing = len(expected_ids - submitted_ids)
        extra = len(submitted_ids - expected_ids)
        raise ScoringValidationError(
            "SUBMISSION_ID_MISMATCH",
            f"Tập ID không khớp ground truth (thiếu {missing}, thừa {extra}).",
        )

    invalid_predictions = set(prediction_by_id.values()) - set(ground_truth.labels)
    if invalid_predictions:
        raise ScoringValidationError(
            "SUBMISSION_VALUE_INVALID", "Prediction chứa giá trị không thuộc tập nhãn hợp lệ."
        )

    y_true = [ground_truth.label_by_id[row_id] for row_id in ground_truth.ids]
    y_pred = [prediction_by_id[row_id] for row_id in ground_truth.ids]
    metric_args: dict[str, object] = {
        "average": config.average,
        "zero_division": 0,
    }
    if config.average == "binary":
        metric_args["pos_label"] = config.pos_label

    metrics = {
        "f1": float(f1_score(y_true, y_pred, **metric_args)),
        "precision": float(precision_score(y_true, y_pred, **metric_args)),
        "recall": float(recall_score(y_true, y_pred, **metric_args)),
    }
    return ScoreResult(metrics=metrics, primary_score=metrics[primary_metric])


def _read_required_rows(
    data: bytes,
    required_columns: tuple[str, ...],
    *,
    kind: str,
) -> tuple[list[str], list[dict[str, str]]]:
    error_code = "GROUND_TRUTH_INVALID" if kind == "ground_truth" else "SUBMISSION_SCHEMA_INVALID"
    if not data:
        raise ScoringValidationError(error_code, "File CSV rỗng.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ScoringValidationError(error_code, "File CSV phải dùng UTF-8.") from exc
    if "\x00" in text:
        raise ScoringValidationError(error_code, "File CSV không đọc được.")

    try:
        reader = csv.DictReader(io.StringIO(text, newline=""), strict=True)
        columns = reader.fieldnames
        if not columns or any(not column for column in columns) or len(columns) != len(set(columns)):
            raise ScoringValidationError(error_code, "Header CSV không hợp lệ.")
        missing_columns = [column for column in required_columns if column not in columns]
        if missing_columns:
            raise ScoringValidationError(
                error_code,
                f"File CSV thiếu cột bắt buộc: {', '.join(missing_columns)}.",
            )

        rows: list[dict[str, str]] = []
        seen_ids: set[str] = set()
        id_column = required_columns[0]
        for raw_row in reader:
            if len(rows) >= MAX_CSV_ROWS:
                raise ScoringValidationError(error_code, f"File CSV vượt quá {MAX_CSV_ROWS} dòng.")
            if None in raw_row:
                raise ScoringValidationError(error_code, "Một dòng CSV có số cột không hợp lệ.")
            row: dict[str, str] = {}
            for column in required_columns:
                value = raw_row.get(column)
                if value is None or not value.strip():
                    value_code = (
                        "GROUND_TRUTH_INVALID"
                        if kind == "ground_truth"
                        else "SUBMISSION_VALUE_INVALID"
                    )
                    raise ScoringValidationError(
                        value_code, f"Cột {column} chứa giá trị rỗng."
                    )
                row[column] = value.strip()
            row_id = row[id_column]
            if row_id in seen_ids:
                duplicate_code = (
                    "GROUND_TRUTH_INVALID"
                    if kind == "ground_truth"
                    else "SUBMISSION_DUPLICATE_IDS"
                )
                raise ScoringValidationError(duplicate_code, "File CSV chứa ID trùng lặp.")
            seen_ids.add(row_id)
            rows.append(row)
    except csv.Error as exc:
        raise ScoringValidationError(error_code, "File CSV không đọc được.") from exc

    if not rows:
        raise ScoringValidationError(error_code, "File CSV không có dòng dữ liệu.")
    return columns, rows


def config_from_competition(competition: dict) -> ScoringConfig | None:
    raw = competition.get("scoring_config")
    return ScoringConfig(**raw) if raw else None
