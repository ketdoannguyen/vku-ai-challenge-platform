"""Chạy đúng một lượt chấm bên trong container cách ly.

File này nằm trong image runtime nên KHÔNG import được `app`: nó chỉ có stdlib và các thư viện khoa
học đã cài. Hợp đồng với runner nằm ở hai đầu của stdio:

- stdin nhận JSON `{"source_code", "ground_truth_csv", "submission_csv"}`.
- stdout chỉ chứa đúng một dòng kết quả giữa `<<<VKU_RESULT>>>` và `<<<VKU_END>>>`
  (`app/evaluator_runner/sandbox.py` giữ bản sao của hai dấu mốc này: đổi một nơi phải đổi cả hai).
- Mọi thứ code chấm in ra bị đẩy sang stderr, nên `print()` của admin không phá kênh kết quả.
- `VKU_DEADLINE_SECONDS` (env, do runner đặt) là hạn chạy của tiến trình này, dài hơn timeout của
  runner một khoảng ân hạn. Bình thường runner là bên cắt lượt chấm và báo lỗi; đồng hồ ở đây tồn tại
  cho trường hợp runner chết giữa lượt - khi đó container phải tự kết thúc, vì không còn ai
  `docker kill` nó nữa.

Code chấm do admin cung cấp chạy trong tiến trình này; biên an toàn là container, không phải file này.
"""

import inspect
import json
import os
import signal
import sys
import traceback
import types

MARKER = "<<<VKU_RESULT>>>"
END = "<<<VKU_END>>>"
MAX_RESULT_BYTES = 64 * 1024
MAX_DETAIL_CHARS = 4_000
ENTRYPOINT = "evaluate"
GROUND_TRUTH_PATH = "/tmp/ground_truth.csv"
SUBMISSION_PATH = "/tmp/submission.csv"
DEADLINE_ENV = "VKU_DEADLINE_SECONDS"
SUBMISSION_RULE_MESSAGE = (
    "CSV không đáp ứng quy tắc nộp bài của cuộc thi. "
    "Hãy đối chiếu với yêu cầu về file nộp và dữ liệu trong đề bài rồi nộp lại."
)


class SubmissionRuleError(Exception):
    """Bộ chấm chủ động báo bài nộp vi phạm một quy tắc đã công khai."""


class InvalidClassIdError(Exception):
    """Mã lớp trong bài nộp nằm ngoài tập mã đã công khai của cuộc thi."""

    def __init__(self, class_id: int, allowed_class_ids: list[int]):
        if (
            type(class_id) is not int
            or abs(class_id) > 1_000_000_000
            or not isinstance(allowed_class_ids, (list, tuple))
            or not 1 <= len(allowed_class_ids) <= 32
            or any(
                type(value) is not int or abs(value) > 1_000_000_000
                for value in allowed_class_ids
            )
            or len(set(allowed_class_ids)) != len(allowed_class_ids)
            or class_id in allowed_class_ids
        ):
            raise ValueError("Invalid class ID error metadata")
        self.class_info = {"class_id": class_id, "allowed_class_ids": list(allowed_class_ids)}
        super().__init__("Invalid class ID in submission")


def _emit(channel: int, payload: dict) -> None:
    blob = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(blob) > MAX_RESULT_BYTES:
        blob = json.dumps(
            {
                "status": "failed",
                "code": "EVALUATOR_OUTPUT_MISMATCH",
                "message": f"Kết quả chấm vượt quá {MAX_RESULT_BYTES // 1024} KiB.",
            },
            separators=(",", ":"),
        ).encode("utf-8")
    data = memoryview(b"\n" + MARKER.encode() + blob + END.encode() + b"\n")
    # Ghi thẳng vào fd đã giữ riêng; vòng lặp vì os.write trên pipe có thể ghi thiếu.
    while data:
        data = data[os.write(channel, data) :]


def _failure(code: str, message: str, detail: str | None = None) -> dict:
    payload = {"status": "failed", "code": code, "message": message}
    if detail:
        payload["detail"] = detail[-MAX_DETAIL_CHARS:]
    return payload


def _deadline_seconds(raw: str | None) -> float | None:
    """Đọc hạn chạy từ biến môi trường; thiếu hoặc vô lý thì không đặt đồng hồ nào."""
    try:
        seconds = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return seconds if seconds > 0 else None


def _arm_deadline(channel: int, seconds: float) -> None:
    """Đặt đồng hồ tự kết thúc cho cả tiến trình.

    `os._exit` trong handler, không phải raise: code chấm hoàn toàn có thể bắt `BaseException` rồi
    chạy tiếp, và một vòng lặp nằm trong C thì mãi không quay lại bytecode để ném. Ghi kết quả trước
    rồi thoát thẳng là cách duy nhất không phụ thuộc vào thiện chí của code chấm - tiến trình này
    sống đúng một lượt chấm nên không có gì phía sau cần được dọn.
    """

    def expire(signum, frame):  # noqa: ANN001, ARG001 - chữ ký của signal handler
        _emit(channel, _failure("EVALUATOR_TIMEOUT", f"Bộ chấm chạy quá {seconds:g} giây."))
        os._exit(0)

    signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, seconds)


def _load_entrypoint(source_code: str):
    """Nạp source thành module và kiểm tra chữ ký.

    Kiểm tra ở đây là để admin nhận thông báo rõ ràng, KHÔNG phải biện pháp an toàn: biên an toàn là
    chính container này, còn source đã được API kiểm tra cú pháp từ lúc lưu.
    """
    module = types.ModuleType("evaluator")
    module.__dict__["SubmissionRuleError"] = SubmissionRuleError
    module.__dict__["InvalidClassIdError"] = InvalidClassIdError
    exec(compile(source_code, "<evaluator>", "exec"), module.__dict__)  # noqa: S102 - mục đích của file
    function = getattr(module, ENTRYPOINT, None)
    if not callable(function):
        raise ValueError(f"Không tìm thấy hàm {ENTRYPOINT}.")
    if inspect.iscoroutinefunction(function):
        raise ValueError(f"Hàm {ENTRYPOINT} phải là hàm đồng bộ, không phải async.")
    parameters = [
        parameter
        for parameter in inspect.signature(function).parameters.values()
        if parameter.kind in (parameter.POSITIONAL_ONLY, parameter.POSITIONAL_OR_KEYWORD)
    ]
    if len(parameters) != 2:
        raise ValueError(
            f"Hàm {ENTRYPOINT} phải nhận đúng hai đối số (ground_truth_path, submission_path)."
        )
    return function


def main() -> int:
    # Giữ kênh kết quả riêng TRƯỚC khi code chấm có cơ hội ghi vào stdout, rồi trỏ fd 1 sang stderr.
    channel = os.dup(1)
    os.dup2(2, 1)
    deadline = _deadline_seconds(os.environ.get(DEADLINE_ENV))
    if deadline is not None:
        # Đặt trước khi đọc stdin: chờ dữ liệu cũng là thời gian của lượt chấm.
        _arm_deadline(channel, deadline)
    try:
        payload = json.load(sys.stdin)
        with open(GROUND_TRUTH_PATH, "w", encoding="utf-8", newline="") as handle:
            handle.write(payload["ground_truth_csv"])
        with open(SUBMISSION_PATH, "w", encoding="utf-8", newline="") as handle:
            handle.write(payload["submission_csv"])
        function = _load_entrypoint(payload["source_code"])
        try:
            result = function(GROUND_TRUTH_PATH, SUBMISSION_PATH)
        except InvalidClassIdError as error:
            failure = _failure(
                "SUBMISSION_CLASS_ID_INVALID",
                SUBMISSION_RULE_MESSAGE,
                traceback.format_exc(),
            )
            failure["class_info"] = error.class_info
            _emit(channel, failure)
            return 0
        except SubmissionRuleError:
            _emit(
                channel,
                _failure(
                    "SUBMISSION_RULE_VIOLATION",
                    SUBMISSION_RULE_MESSAGE,
                    traceback.format_exc(),
                ),
            )
            return 0
    except BaseException:  # noqa: BLE001 - xem chú thích bên dưới
        # Bắt cả BaseException: code chấm gọi sys.exit() cũng phải trả về một lỗi có mã, và tiến trình
        # này sống đúng một lượt chấm nên không có gì phía sau cần được bảo vệ.
        _emit(channel, _failure("EVALUATOR_FAILED", "Bộ chấm báo lỗi khi chạy.", traceback.format_exc()))
        return 0

    try:
        # Chuyển qua lại JSON tại đây để kiểu dữ liệu không phụ thuộc vào lượt chấm chạy ở đâu; runner
        # vẫn là nơi kiểm tra hợp đồng metric (số hữu hạn, đúng tập khóa).
        metrics = json.loads(json.dumps(result, allow_nan=False))
    except (TypeError, ValueError) as error:
        _emit(
            channel,
            _failure(
                "EVALUATOR_OUTPUT_MISMATCH",
                "Kết quả chấm phải là dictionary các số JSON thuần "
                "(dùng float(...)/int(...) cho giá trị NumPy).",
                str(error),
            ),
        )
        return 0

    _emit(channel, {"status": "passed", "metrics": metrics})
    return 0


if __name__ == "__main__":
    sys.exit(main())
