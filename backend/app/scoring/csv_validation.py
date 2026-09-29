"""Đọc, kiểm tra và căn dòng CSV theo schema do admin khai báo.

Đây là chỗ duy nhất quyết định dữ liệu nào được đưa cho code chấm. Backend không tự chọn lớp, không
đổi tên cột và không tính lại điểm: sau khi kiểm tra xong, submission được sắp theo thứ tự ID của
ground truth rồi viết lại nguyên văn (giữ cả cột phụ nếu schema cho phép).
"""

import csv
import io
import math
import re
from dataclasses import dataclass

from app.scoring.errors import ScoringValidationError
from app.scoring.models import ColumnSpec, FileSchema

MAX_CSV_ROWS = 1_000_000
# Số nguyên "chuẩn": không dấu +, không số 0 thừa, không dạng 1.0. ID số 0 đầu phải khai kiểu string.
_INTEGER_RE = re.compile(r"-?(?:0|[1-9][0-9]*)")

GROUND_TRUTH_INVALID = "GROUND_TRUTH_INVALID"
SCHEMA_INVALID = "SUBMISSION_SCHEMA_INVALID"
VALUE_INVALID = "SUBMISSION_VALUE_INVALID"
DUPLICATE_IDS = "SUBMISSION_DUPLICATE_IDS"
ID_MISMATCH = "SUBMISSION_ID_MISMATCH"


@dataclass(frozen=True)
class GroundTruth:
    """Chỉ giữ thứ tự ID: nội dung ground truth đi nguyên văn cho code chấm, backend không đọc nhãn."""

    ids: tuple[str, ...]

    @property
    def row_count(self) -> int:
        return len(self.ids)


def load_ground_truth(data: bytes, schema: FileSchema) -> GroundTruth:
    """Kiểm tra ground truth theo schema và ghi nhớ thứ tự ID - mốc căn dòng cho mọi submission."""
    _, rows = _parse(data, schema, code=GROUND_TRUTH_INVALID)
    return GroundTruth(ids=tuple(row[schema.id_column] for row in rows))


def prepare_submission(
    data: bytes,
    schema: FileSchema,
    ground_truth: GroundTruth,
) -> bytes:
    """Kiểm tra submission và trả bản CSV đã sắp theo ID của ground truth.

    Không đổi tên cột và không bỏ cột phụ: code chấm nhận đúng những cột admin đã cho phép, chỉ khác
    thứ tự dòng. Nhờ vậy kết quả không phụ thuộc thứ tự sinh viên nộp.
    """
    columns, rows = _parse(data, schema, code=SCHEMA_INVALID)
    values_by_id = {row[schema.id_column]: row for row in rows}

    expected = set(ground_truth.ids)
    submitted = set(values_by_id)
    if submitted != expected:
        raise ScoringValidationError(
            ID_MISMATCH,
            f"Tập ID không khớp ground truth (thiếu {len(expected - submitted)}, "
            f"thừa {len(submitted - expected)}).",
        )

    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow(columns)
    for row_id in ground_truth.ids:
        writer.writerow([values_by_id[row_id][column] for column in columns])
    return buffer.getvalue().encode("utf-8")


def _parse(
    data: bytes, schema: FileSchema, *, code: str
) -> tuple[list[str], list[dict[str, str]]]:
    if not data:
        raise ScoringValidationError(code, "File CSV rỗng.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ScoringValidationError(code, "File CSV phải dùng UTF-8.") from exc
    if "\x00" in text:
        raise ScoringValidationError(code, "File CSV không đọc được.")

    declared = [column.name for column in schema.columns]
    # Lỗi cấu trúc (thiếu/thừa cột, header sai) là lỗi schema; lỗi ở từng ô là lỗi giá trị - hai mã
    # khác nhau vì thí sinh sửa được cái này và không sửa được cái kia.
    value_code = VALUE_INVALID if code == SCHEMA_INVALID else GROUND_TRUTH_INVALID
    try:
        reader = csv.DictReader(io.StringIO(text, newline=""), strict=True)
        columns = reader.fieldnames
        if (
            not columns
            or any(not column for column in columns)
            or any(column != column.strip() for column in columns)
            or len(columns) != len(set(columns))
        ):
            raise ScoringValidationError(code, "Header CSV không hợp lệ.")
        missing = [column for column in declared if column not in columns]
        if missing:
            raise ScoringValidationError(
                code, f"Thiếu cột bắt buộc: {', '.join(missing)}."
            )
        if not schema.allow_extra_columns:
            extra = [column for column in columns if column not in declared]
            if extra:
                raise ScoringValidationError(
                    code, f"Thừa cột không được khai báo: {', '.join(extra)}."
                )

        rows: list[dict[str, str]] = []
        seen_ids: set[str] = set()
        specs = {column.name: column for column in schema.columns}
        for index, raw_row in enumerate(reader):
            if index >= MAX_CSV_ROWS:
                raise ScoringValidationError(code, f"File CSV vượt quá {MAX_CSV_ROWS} dòng.")
            line = index + 2
            if None in raw_row:
                raise ScoringValidationError(code, f"Dòng {line} có số cột không hợp lệ.")
            row: dict[str, str] = {}
            for column in columns:
                value = raw_row.get(column)
                if value is None:
                    raise ScoringValidationError(code, f"Dòng {line} có số cột không hợp lệ.")
                spec = specs.get(column)
                if spec is not None:
                    _check_value(
                        spec,
                        value,
                        line=line,
                        code=value_code,
                        is_id=column == schema.id_column,
                    )
                row[column] = value
            row_id = row[schema.id_column]
            if row_id in seen_ids:
                duplicate_code = DUPLICATE_IDS if code == SCHEMA_INVALID else code
                raise ScoringValidationError(
                    duplicate_code, f"Cột {schema.id_column} chứa ID trùng lặp."
                )
            seen_ids.add(row_id)
            rows.append(row)
    except csv.Error as exc:
        raise ScoringValidationError(code, "File CSV không đọc được.") from exc

    if not rows:
        raise ScoringValidationError(code, "File CSV không có dòng dữ liệu.")
    return columns, rows


def _check_value(
    spec: ColumnSpec, value: str, *, line: int, code: str, is_id: bool = False
) -> None:
    if not value.strip():
        if spec.nullable:
            return
        raise ScoringValidationError(
            code, f"Cột {spec.name} tại dòng {line} không được để trống."
        )
    # ID dính khoảng trắng sẽ khớp "gần đúng" với một ID khác - từ chối thay vì đoán ý người nộp.
    if is_id and value != value.strip():
        raise ScoringValidationError(
            code, f"Cột {spec.name} tại dòng {line} có khoảng trắng thừa ở đầu hoặc cuối."
        )
    if spec.type in ("integer", "number"):
        _check_numeric(spec, value, line=line, code=code)
    if spec.allowed_values is not None and not _in_allowed(spec, value):
        raise ScoringValidationError(
            code, f"Cột {spec.name} tại dòng {line} có giá trị ngoài danh sách cho phép."
        )


def _check_numeric(spec: ColumnSpec, value: str, *, line: int, code: str) -> None:
    if spec.type == "integer":
        if not _INTEGER_RE.fullmatch(value):
            raise ScoringValidationError(
                code, f"Cột {spec.name} tại dòng {line} phải là số nguyên."
            )
        return
    try:
        parsed = float(value)
    except ValueError:
        raise ScoringValidationError(
            code, f"Cột {spec.name} tại dòng {line} phải là số."
        ) from None
    if not math.isfinite(parsed):
        raise ScoringValidationError(
            code, f"Cột {spec.name} tại dòng {line} phải là số hữu hạn."
        )


def _in_allowed(spec: ColumnSpec, value: str) -> bool:
    allowed = spec.allowed_values or []
    if spec.type == "string":
        return value in allowed
    if spec.type == "integer":
        return int(value) in allowed
    parsed = float(value)
    return any(float(candidate) == parsed for candidate in allowed)
