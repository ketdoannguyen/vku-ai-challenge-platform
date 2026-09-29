"""Entrypoint của image runtime: hợp đồng stdio và đồng hồ tự kết thúc.

Không test nào ở đây cần Docker: chúng chạy thẳng `evaluator-runtime/entrypoint.py` bằng chính
interpreter này - đúng cách image chạy nó, chỉ thiếu container ở giữa. Đây là chỗ duy nhất phủ file
nằm ngoài package `backend`, mà lại là file mọi lượt chấm v2 đều đi qua.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ENTRYPOINT = Path(__file__).resolve().parents[2] / "evaluator-runtime" / "entrypoint.py"
DEADLINE_ENV = "VKU_DEADLINE_SECONDS"
MARKER = "<<<VKU_RESULT>>>"
END = "<<<VKU_END>>>"
# Trần chờ của chính test: đồng hồ trong entrypoint hỏng thì phải đỏ ở đây, không được treo cả suite.
SUBPROCESS_TIMEOUT_SECONDS = 20


def _run(source_code: str, *, deadline: str | None = None) -> tuple[subprocess.CompletedProcess, float]:
    payload = {
        "source_code": source_code,
        "ground_truth_csv": "id,label\n1,a\n2,b\n",
        "submission_csv": "id,prediction\n1,a\n2,b\n",
    }
    env = {"PATH": os.environ.get("PATH", ""), "HOME": "/tmp"}
    if deadline is not None:
        env[DEADLINE_ENV] = deadline
    started = time.monotonic()
    result = subprocess.run(  # noqa: S603 - chạy chính file trong repo bằng interpreter hiện tại
        [sys.executable, str(ENTRYPOINT)],
        input=json.dumps(payload).encode("utf-8"),
        capture_output=True,
        env=env,
        timeout=SUBPROCESS_TIMEOUT_SECONDS,
    )
    return result, time.monotonic() - started


def _result(result: subprocess.CompletedProcess) -> dict:
    stdout = result.stdout.decode("utf-8")
    assert MARKER in stdout and END in stdout, stdout
    blob = stdout.split(MARKER, 1)[1].split(END, 1)[0]
    return json.loads(blob)


def test_entrypoint_tra_ket_qua_that_ra_khoi_stdout():
    """Không có `VKU_DEADLINE_SECONDS` (runner cũ) vẫn phải chạy trọn một lượt chấm bình thường."""
    result, _ = _run(
        "def evaluate(truth_path, submission_path):\n"
        "    return {'accuracy': 1.0, 'n_items': 2.0}\n"
    )
    assert result.returncode == 0
    assert _result(result) == {"status": "passed", "metrics": {"accuracy": 1.0, "n_items": 2.0}}


def test_code_cham_in_ra_khong_lam_hong_kenh_ket_qua():
    """`print()` của admin đi sang stderr; kênh kết quả chỉ có đúng dòng của entrypoint."""
    result, _ = _run(
        "def evaluate(truth_path, submission_path):\n"
        "    import sys\n"
        "    print('nhieu chan doan')\n"
        "    print('gia mao', file=sys.__stdout__)\n"
        "    return {'accuracy': 0.5}\n"
    )
    assert result.returncode == 0
    assert _result(result) == {"status": "passed", "metrics": {"accuracy": 0.5}}
    assert "nhieu chan doan" in result.stderr.decode("utf-8")


def test_dong_ho_tu_ket_thuc_khi_khong_con_ai_cat_luot_cham():
    """Runner chết giữa lượt thì container phải tự thoát, không chạy mãi trên VPS 2 lõi.

    Đây là lưới an toàn thật của lượt chấm: nếu runner còn sống, chính nó đã `docker kill` container
    ở mốc timeout ngắn hơn (xem `Sandbox.deadline_seconds`). Test này mô phỏng đúng trường hợp xấu
    nhất - không có runner nào ở giữa để cắt - nên chỉ còn đồng hồ trong tiến trình.
    """
    result, elapsed = _run(
        "def evaluate(truth_path, submission_path):\n    while True:\n        pass\n",
        deadline="0.5",
    )
    assert result.returncode == 0
    assert _result(result)["code"] == "EVALUATOR_TIMEOUT"
    assert elapsed < SUBPROCESS_TIMEOUT_SECONDS / 2
