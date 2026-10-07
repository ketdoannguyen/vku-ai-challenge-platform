"""Sandbox của runner: lệnh `docker run`, cách đọc hai luồng ra và cách đọc kết quả.

Không test nào ở đây chạy Docker - chúng khẳng định những thứ phải đúng **trước** khi Docker vào cuộc:
cờ cách ly, trần bộ nhớ của lượt đọc, và cách lấy kết quả ra khỏi stdout.
"""

import asyncio
import json

import pytest

from app.evaluator_runner import sandbox as sandbox_module
from app.evaluator_runner.sandbox import (
    DEADLINE_ENV,
    DEADLINE_GRACE_SECONDS,
    MAX_RESULT_BYTES,
    RESULT_END,
    RESULT_MARKER,
    Sandbox,
    Slots,
    _digest,
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


def _values(command: list[str], flag: str) -> list[str]:
    """Mọi giá trị đi kèm một cờ - `--ulimit` xuất hiện hai lần nên `index()` không đủ."""
    return [command[index + 1] for index, part in enumerate(command) if part == flag]


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
        ("--stop-timeout", "0"),
    ]:
        assert flag in command and command[command.index(flag) + 1] == value
    assert "--read-only" in command
    assert any(part.startswith("/tmp:") and "noexec" in part for part in command)
    # Image là cấu hình của runner, không bao giờ đến từ nội dung request.
    assert command[-1] == "vku-evaluator-runtime:1"
    # Trần CPU của kernel là đường chết dự phòng: một vòng lặp nằm trong C (regex, numpy) không nhận
    # được SIGALRM của entrypoint cho tới khi quay lại bytecode, còn RLIMIT_CPU thì không cần hợp tác.
    assert _values(command, "--ulimit") == ["nofile=256:256", "cpu=35:35"]
    assert f"{DEADLINE_ENV}=35" in command


def test_dong_ho_trong_container_dai_hon_timeout_cua_runner():
    """Runner phải là bên cắt lượt chấm trước; đồng hồ trong container chỉ là lưới an toàn."""
    for timeout in (5, 30, 120):
        sandbox = Sandbox(image="vku-evaluator-runtime:1", timeout_seconds=timeout)
        assert sandbox.deadline_seconds == timeout + DEADLINE_GRACE_SECONDS
        command = sandbox.command("vku-test")
        assert f"cpu={sandbox.deadline_seconds}:{sandbox.deadline_seconds}" in _values(
            command, "--ulimit"
        )
        assert f"{DEADLINE_ENV}={sandbox.deadline_seconds}" in command


def test_runner_tu_choi_cham_khi_chua_ghim_duoc_runtime(monkeypatch):
    """Image chưa phân giải được thì không lượt chấm nào chạy: môi trường phải định danh được."""
    monkeypatch.setattr(sandbox_module.shutil, "which", lambda _: "/usr/bin/docker")
    sandbox = Sandbox(image="vku-evaluator-runtime:1", timeout_seconds=30)
    assert sandbox.runtime_id is None
    assert sandbox.ready is False

    async def no_image(_image: str) -> str | None:
        return None

    monkeypatch.setattr(sandbox_module, "_image_id", no_image)
    assert asyncio.run(sandbox.load()) is False
    assert sandbox.ready is False
    with pytest.raises(EvaluatorError) as error:
        asyncio.run(
            sandbox.run(
                source_code="def evaluate(truth, submission):\n    return {}",
                ground_truth_csv="id,label\n1,a\n",
                submission_csv="id,prediction\n1,a\n",
            )
        )
    assert error.value.code == "EVALUATOR_UNAVAILABLE"


def test_load_ghim_runtime_ve_id_noi_dung(monkeypatch):
    """`runtime_id` là ID nội dung của image, không phải tag có thể bị build đè."""
    digest = "sha256:" + "a" * 64

    async def fixed(_image: str) -> str | None:
        return digest

    monkeypatch.setattr(sandbox_module, "_image_id", fixed)
    sandbox = Sandbox(image="vku-evaluator-runtime:1", timeout_seconds=30)
    assert asyncio.run(sandbox.load()) is True
    assert sandbox.runtime_id == digest
    assert sandbox.ready is True


def test_digest_tu_choi_moi_gia_tri_khong_phai_id_noi_dung():
    """Tag, digest cắt ngắn hay chuỗi rỗng đều không được lọt vào bằng chứng như một định danh."""
    assert _digest("sha256:" + "f" * 64) == "sha256:" + "f" * 64
    assert _digest(f"sha256:{'f' * 64}\n") == "sha256:" + "f" * 64
    for rejected in ("vku-evaluator-runtime:1", "sha256:abc", "", "sha256:" + "f" * 63):
        assert _digest(rejected) is None


def test_parse_reads_the_last_marker_only():
    """Code chấm in ra một dấu mốc giả không được thắng kết quả thật ghi sau đó."""
    forged = _passed({"f1": 1.0})
    assert _parse(forged + _passed({"loss": 0.5}), b"") == {"loss": 0.5}


def test_parse_maps_entrypoint_failures_and_rejects_unknown_codes():
    with pytest.raises(EvaluatorError) as known:
        _parse(_failed("EVALUATOR_INVALID", "Source sai."), b"")
    assert known.value.code == "EVALUATOR_INVALID"
    assert known.value.message == "Source sai."

    with pytest.raises(EvaluatorError) as rule:
        _parse(_failed("SUBMISSION_RULE_VIOLATION", "CSV sai quy tắc."), b"")
    assert rule.value.code == "SUBMISSION_RULE_VIOLATION"

    with pytest.raises(EvaluatorError) as unknown:
        _parse(_failed("EVALUATOR_TU_NGHI", "Lạ."), b"")
    assert unknown.value.code == "EVALUATOR_FAILED"


def test_parse_checks_class_info_before_reporting_student_error():
    info = {"class_id": 6, "allowed_class_ids": list(range(6))}
    payload = {
        "status": "failed", "code": "SUBMISSION_CLASS_ID_INVALID",
        "message": "SECRET", "class_info": info,
    }
    with pytest.raises(EvaluatorError) as error:
        _parse(_line(payload), b"")
    assert error.value.code == "SUBMISSION_CLASS_ID_INVALID"
    assert error.value.class_info == info

    for bad in (
        {"class_id": True, "allowed_class_ids": [0]},
        {"class_id": 6, "allowed_class_ids": []},
        None,
    ):
        with pytest.raises(EvaluatorError) as rejected:
            _parse(_line({**payload, "class_info": bad}), b"")
        assert rejected.value.code == "EVALUATOR_FAILED"
        assert rejected.value.class_info is None


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
