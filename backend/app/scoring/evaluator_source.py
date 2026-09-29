"""Kiểm tra tĩnh source bộ chấm trước khi lưu.

Đây là phản hồi sớm cho admin, KHÔNG phải biện pháp an toàn: source chưa từng được chạy ở đây (chỉ
parse), và biên an toàn thật là container ở runner. Nhờ vậy một bộ chấm sai cú pháp bị chặn ngay lúc
lưu thay vì đợi tới lượt chạy thử.
"""

import ast

from app.scoring.errors import ScoringValidationError
from app.scoring.models import DEFAULT_ENTRYPOINT, MAX_SOURCE_BYTES

INVALID = "EVALUATOR_INVALID"


def check_source(source: str) -> None:
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise ScoringValidationError(
            INVALID, f"Source bộ chấm vượt quá {MAX_SOURCE_BYTES // 1024} KiB."
        )
    if "\x00" in source:
        raise ScoringValidationError(INVALID, "Source bộ chấm chứa ký tự không hợp lệ.")
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError) as error:
        detail = getattr(error, "msg", str(error))
        raise ScoringValidationError(INVALID, f"Source bộ chấm sai cú pháp: {detail}.") from error

    function = next(
        (
            node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == DEFAULT_ENTRYPOINT
        ),
        None,
    )
    if function is None:
        raise ScoringValidationError(
            INVALID, f"Source phải định nghĩa hàm {DEFAULT_ENTRYPOINT} ở cấp cao nhất."
        )
    if isinstance(function, ast.AsyncFunctionDef):
        raise ScoringValidationError(
            INVALID, f"Hàm {DEFAULT_ENTRYPOINT} phải là hàm đồng bộ, không phải async."
        )
    parameters = [*function.args.posonlyargs, *function.args.args]
    if len(parameters) != 2:
        raise ScoringValidationError(
            INVALID,
            f"Hàm {DEFAULT_ENTRYPOINT} phải nhận đúng hai đối số (ground_truth_path, submission_path).",
        )
