"""Sandbox của runner: lệnh `docker run`, cách đọc hai luồng ra và cách đọc kết quả.

Không test nào ở đây chạy Docker - chúng khẳng định những thứ phải đúng **trước** khi Docker vào cuộc:
cờ cách ly, trần bộ nhớ của lượt đọc, và cách lấy kết quả ra khỏi stdout.
"""

import asyncio
import json

import pytest

from app.evaluator_runner.sandbox import (
    MAX_RESULT_BYTES,
    RESULT_END,
    RESULT_MARKER,
    Sandbox,
    Slots,
    _parse,
    _read_bounded,
)
from app.scoring.errors import EvaluatorError


class FakeStream:
    """Luồng ra giả: trả từng khối theo yêu cầu đọc và đếm số lần bị đọc."""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = list(chunks)
        self.reads = 0

    async def read(self, size: int) -> bytes:
        assert size > 0
        self.reads += 1
        return self._chunks.pop(0) if self._chunks else b""


def _passed(metrics: dict) -> bytes:
    return _line({"status": "passed", "metrics": metrics})


def _failed(code: str, message: str) -> bytes:
    return _line({"status": "failed", "code": code, "message": message})


def _line(payload: dict) -> bytes:
    return f"log\n{RESULT_MARKER}{json.dumps(payload)}{RESULT_END}\n".encode()


def test_docker_command_keeps_the_isolation_flags():
    """Các cờ này là biên cách ly duy nhất của code chấm; mất một cờ là mất cả biên."""
    command = Sandbox(image="vku-evaluator-runtime:1", timeout_seconds=30).command("vku-test")
    assert command[:3] == ["docker", "run", "--rm"]
    for flag, value in [
        ("--network", "none"),
        ("--memory", "1g"),
        ("--cpus", "1"),
        ("--pids-limit", "128"),
        ("--user", "65534:65534"),
        ("--cap-drop", "ALL"),
        ("--security-opt", "no-new-privileges"),
        ("--ulimit", "nofile=256:256"),
        ("--stop-timeout", "0"),
    ]:
        assert flag in command and command[command.index(flag) + 1] == value
    assert "--read-only" in command
    assert any(part.startswith("/tmp:") and "noexec" in part for part in command)
    # Image là cấu hình của runner, không bao giờ đến từ nội dung request.
    assert command[-1] == "vku-evaluator-runtime:1"


def test_parse_reads_the_last_marker_only():
    """Code chấm in ra một dấu mốc giả không được thắng kết quả thật ghi sau đó."""
    forged = _passed({"f1": 1.0})
    assert _parse(forged + _passed({"loss": 0.5}), b"") == {"loss": 0.5}


def test_parse_maps_entrypoint_failures_and_rejects_unknown_codes():
    with pytest.raises(EvaluatorError) as known:
        _parse(_failed("EVALUATOR_INVALID", "Source sai."), b"")
    assert known.value.code == "EVALUATOR_INVALID"
    assert known.value.message == "Source sai."

    with pytest.raises(EvaluatorError) as unknown:
        _parse(_failed("EVALUATOR_TU_NGHI", "Lạ."), b"")
    assert unknown.value.code == "EVALUATOR_FAILED"


def test_parse_rejects_missing_broken_or_oversized_results():
    with pytest.raises(EvaluatorError, match="không trả về kết quả"):
        _parse(b"khong co dau moc", b"traceback")

    with pytest.raises(EvaluatorError) as broken:
        _parse(f"{RESULT_MARKER}khong-phai-json{RESULT_END}".encode(), b"")
    assert broken.value.code == "EVALUATOR_FAILED"

    huge = f"{RESULT_MARKER}{'x' * (MAX_RESULT_BYTES + 1)}{RESULT_END}"
    with pytest.raises(EvaluatorError) as oversized:
        _parse(huge.encode(), b"")
    assert oversized.value.code == "EVALUATOR_OUTPUT_MISMATCH"


def test_parse_keeps_the_metric_error_code():
    """Kết quả đúng định dạng nhưng metric sai hợp đồng vẫn là lỗi của phía kiểm tra metric."""
    with pytest.raises(EvaluatorError) as bad_metrics:
        _parse(_passed({"f1": "1.0"}), b"")
    assert bad_metrics.value.code == "EVALUATOR_OUTPUT_MISMATCH"


def test_read_bounded_caps_memory_but_drains_to_eof():
    """Hết chỗ vẫn phải đọc tiếp, nếu không container bị chặn ở lần ghi sau và treo tới hết timeout."""
    stream = FakeStream([b"a" * 10, b"b" * 10, b"c" * 10, b""])
    data, truncated = asyncio.run(_read_bounded(stream, limit=25))
    assert data == b"a" * 10 + b"b" * 10 + b"c" * 5
    assert truncated is True
    assert stream.reads == 4

    data, truncated = asyncio.run(_read_bounded(FakeStream([b"a" * 10, b""]), limit=25))
    assert data == b"a" * 10
    assert truncated is False


def test_slots_reject_instead_of_queueing():
    async def scenario() -> tuple[bool, bool, bool]:
        slots = Slots(1)
        first = await slots.take()
        refused = await slots.take()
        await slots.release()
        return first, refused, await slots.take()

    assert asyncio.run(scenario()) == (True, False, True)
