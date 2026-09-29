"""Chạy code chấm của admin trong một container dùng một lần.

Container là biên cách ly thật: không mạng, filesystem chỉ đọc, trần CPU/RAM/PID, user không phải
root. Đề bài và bài nộp đi vào bằng stdin, kết quả đi ra bằng stdout dưới dạng JSON, nên runner
không mount gì của máy chủ vào container và code chấm không có đường nào chạm tới đĩa, mạng hay
credential của hệ thống.
"""

import asyncio
import json
import logging
import shutil
import time
import uuid

from app.scoring.errors import EvaluatorError, ScoringValidationError
from app.scoring.models import MAX_SOURCE_BYTES
from app.scoring.output_validation import validate_metrics

logger = logging.getLogger(__name__)

DOCKER_BIN = "docker"
# Kết quả nằm giữa hai dấu mốc này trên stdout của container. `evaluator-runtime/entrypoint.py` giữ bản
# sao của chúng (nó chạy trong image riêng, không import được `app`): đổi ở đây phải đổi cả ở đó.
RESULT_MARKER = "<<<VKU_RESULT>>>"
RESULT_END = "<<<VKU_END>>>"
MAX_RESULT_BYTES = 64 * 1024
# Trần đọc hai luồng ra của MỘT lượt chấm. Container bị giới hạn 1 GiB, nhưng bytes nó in ra nằm
# trong bộ nhớ của runner - một `print()` trong vòng lặp cũng đủ làm OOM cả tiến trình giữ docker
# socket. stdout chỉ cần đủ chỗ cho kết quả (trần 64 KiB ở trên); stderr là kênh chẩn đoán dự phòng.
MAX_STDOUT_BYTES = 4 * 1024 * 1024
MAX_STDERR_BYTES = 64 * 1024
READ_CHUNK_BYTES = 64 * 1024
# Mã lỗi mà entrypoint được phép gửi về; mã lạ bị quy về EVALUATOR_FAILED để hợp đồng lỗi không mở rộng
# theo ý của code chấm.
ENTRYPOINT_CODES = frozenset(
    {"EVALUATOR_INVALID", "EVALUATOR_FAILED", "EVALUATOR_OUTPUT_MISMATCH"}
)
MAX_DETAIL_CHARS = 4_000
KILL_TIMEOUT_SECONDS = 10

# Giới hạn tài nguyên của MỘT lượt chấm (kế hoạch mục 10.4). Cố ý là hằng số chứ không phải biến môi
# trường: nới trần của sandbox là thay đổi phải qua review, không phải một dòng .env.
MEMORY_LIMIT = "1g"
CPU_LIMIT = "1"
PIDS_LIMIT = 128
TMPFS_LIMIT = "64m"


class Slots:
    """Trần số lượt chấm chạy cùng lúc.

    Runner là một process duy nhất nên bộ đếm này là giới hạn chung cho mọi API worker, không phải
    giới hạn riêng của một tiến trình. Hết chỗ thì từ chối ngay: API đang giữ request của thí sinh,
    xếp hàng sau một job 30 giây sẽ biến "đang bận" thành "treo", còn từ chối thì thí sinh chỉ việc
    nộp lại và không mất lượt nào.
    """

    def __init__(self, size: int) -> None:
        self._size = size
        self._busy = 0
        self._lock = asyncio.Lock()

    async def take(self) -> bool:
        async with self._lock:
            if self._busy >= self._size:
                return False
            self._busy += 1
            return True

    async def release(self) -> None:
        async with self._lock:
            self._busy -= 1


def _detail(raw: bytes | str) -> str | None:
    text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
    text = text.replace("\x00", "").strip()
    return text[-MAX_DETAIL_CHARS:] or None


async def _docker_kill(name: str) -> None:
    """Diệt container theo tên: kill tiến trình client không kéo theo container đang chạy."""
    process = await asyncio.create_subprocess_exec(
        DOCKER_BIN,
        "kill",
        name,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        await asyncio.wait_for(process.wait(), timeout=KILL_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:  # pragma: no cover - chỉ xảy ra khi docker treo hẳn
        logger.warning("docker kill %s không trả về trong %ss", name, KILL_TIMEOUT_SECONDS)
        process.kill()


class Sandbox:
    def __init__(self, *, image: str, timeout_seconds: int) -> None:
        self.image = image
        self._timeout_seconds = timeout_seconds

    @property
    def available(self) -> bool:
        return shutil.which(DOCKER_BIN) is not None

    def command(self, name: str) -> list[str]:
        """Lệnh docker cố định; image lấy từ cấu hình của runner, không bao giờ từ nội dung request."""
        return [
            DOCKER_BIN,
            "run",
            "--rm",
            "--interactive",
            "--name",
            name,
            "--network",
            "none",
            "--read-only",
            "--tmpfs",
            f"/tmp:rw,noexec,nosuid,size={TMPFS_LIMIT}",
            "--memory",
            MEMORY_LIMIT,
            "--memory-swap",
            MEMORY_LIMIT,
            "--cpus",
            CPU_LIMIT,
            "--pids-limit",
            str(PIDS_LIMIT),
            "--user",
            "65534:65534",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--ulimit",
            "nofile=256:256",
            "--stop-timeout",
            "0",
            "--env",
            "HOME=/tmp",
            self.image,
        ]

    async def run(
        self, *, source_code: str, ground_truth_csv: str, submission_csv: str
    ) -> tuple[dict[str, float], int]:
        """Trả `(metrics, duration_ms)`; mọi thất bại đều là `EvaluatorError` với mã ổn định."""
        if not self.available:
            raise EvaluatorError("EVALUATOR_UNAVAILABLE", "Máy chấm chưa sẵn sàng.")
        if len(source_code.encode("utf-8")) > MAX_SOURCE_BYTES:
            raise EvaluatorError(
                "EVALUATOR_INVALID",
                f"Source bộ chấm vượt quá {MAX_SOURCE_BYTES // 1024} KiB.",
            )

        payload = json.dumps(
            {
                "source_code": source_code,
                "ground_truth_csv": ground_truth_csv,
                "submission_csv": submission_csv,
            },
            separators=(",", ":"),
        ).encode("utf-8")

        name = f"vku-evaluator-{uuid.uuid4().hex[:12]}"
        started = time.monotonic()
        process = await asyncio.create_subprocess_exec(
            *self.command(name),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, (stdout, truncated), (stderr, _) = await asyncio.wait_for(
                asyncio.gather(
                    _feed(process, payload),
                    _read_bounded(process.stdout, MAX_STDOUT_BYTES),
                    _read_bounded(process.stderr, MAX_STDERR_BYTES),
                ),
                timeout=self._timeout_seconds,
            )
        except asyncio.TimeoutError as exc:
            await self._terminate(name, process)
            raise EvaluatorError(
                "EVALUATOR_TIMEOUT", f"Bộ chấm chạy quá {self._timeout_seconds} giây."
            ) from exc
        except OSError as exc:  # container chết trước khi đọc hết stdin
            await self._terminate(name, process)
            raise EvaluatorError(
                "EVALUATOR_FAILED", "Bộ chấm dừng bất thường.", detail=_detail(str(exc))
            ) from exc

        if process.returncode not in (0, None):
            logger.warning("docker run %s thoát với mã %s", name, process.returncode)
        # Kết quả được entrypoint ghi ra cuối cùng, nên stdout bị cắt nghĩa là kết quả đã mất.
        if truncated:
            raise EvaluatorError(
                "EVALUATOR_OUTPUT_MISMATCH",
                f"Bộ chấm in ra quá {MAX_STDOUT_BYTES // (1024 * 1024)} MiB trên stdout.",
                detail=_detail(stderr),
            )
        return _parse(stdout, stderr), int((time.monotonic() - started) * 1000)

    async def _terminate(self, name: str, process: asyncio.subprocess.Process) -> None:
        await _docker_kill(name)
        try:
            await asyncio.wait_for(process.wait(), timeout=KILL_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:  # pragma: no cover - chỉ xảy ra khi docker treo hẳn
            process.kill()


async def _feed(process: asyncio.subprocess.Process, payload: bytes) -> None:
    """Ghi stdin rồi đóng lại; container chết trước khi đọc hết không phải lỗi của lượt chấm."""
    try:
        process.stdin.write(payload)
        await process.stdin.drain()
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        process.stdin.close()


async def _read_bounded(stream: asyncio.StreamReader, limit: int) -> tuple[bytes, bool]:
    """Đọc một luồng ra cho tới hết nhưng chỉ giữ `limit` byte đầu.

    Vẫn phải đọc tới EOF: ngừng đọc thì container bị chặn ở lần ghi tiếp theo và không bao giờ thoát.
    """
    kept = bytearray()
    truncated = False
    while True:
        chunk = await stream.read(READ_CHUNK_BYTES)
        if not chunk:
            return bytes(kept), truncated
        room = limit - len(kept)
        if len(chunk) > room:
            truncated = True
            chunk = chunk[:room]
        kept += chunk


def _parse(stdout: bytes, stderr: bytes) -> dict[str, float]:
    text = stdout.decode("utf-8", errors="replace")
    # Dấu mốc CUỐI là kết quả thật: entrypoint ghi nó sau khi code chấm đã chạy xong, nên một dấu mốc
    # do code chấm in ra (fd 1 bị trỏ sang stderr, nhưng `sys.__stdout__` thì không) không thắng được.
    marker = text.rfind(RESULT_MARKER)
    if marker < 0:
        raise EvaluatorError(
            "EVALUATOR_FAILED", "Bộ chấm không trả về kết quả.", detail=_detail(stderr)
        )

    blob = text[marker + len(RESULT_MARKER) :].split(RESULT_END, 1)[0]
    if len(blob.encode("utf-8")) > MAX_RESULT_BYTES:
        raise EvaluatorError(
            "EVALUATOR_OUTPUT_MISMATCH",
            f"Kết quả chấm vượt quá {MAX_RESULT_BYTES // 1024} KiB.",
        )
    try:
        payload = json.loads(blob)
    except json.JSONDecodeError as exc:
        raise EvaluatorError(
            "EVALUATOR_FAILED", "Không đọc được kết quả chấm.", detail=_detail(str(exc))
        ) from exc

    status = payload.get("status") if isinstance(payload, dict) else None
    if status == "failed":
        code = payload.get("code")
        if code not in ENTRYPOINT_CODES:
            code = "EVALUATOR_FAILED"
        raise EvaluatorError(
            code,
            str(payload.get("message") or "Bộ chấm báo lỗi."),
            detail=_detail(str(payload.get("detail"))) if payload.get("detail") else _detail(stderr),
        )
    if status != "passed":
        raise EvaluatorError(
            "EVALUATOR_FAILED", "Kết quả chấm sai định dạng.", detail=_detail(blob)
        )

    try:
        return validate_metrics(payload.get("metrics"))
    except ScoringValidationError as exc:
        raise EvaluatorError(exc.code, exc.message, detail=_detail(stderr)) from exc
