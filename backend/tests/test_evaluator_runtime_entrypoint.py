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


def test_rule_violation_preserves_admin_message_and_private_detail():
    result, _ = _run(
        "def evaluate(truth_path, submission_path):\n"
        "    raise SubmissionRuleError('Câu trả lời phải nằm trong đoạn văn.')\n"
    )
    payload = _result(result)
    assert result.returncode == 0
    assert payload["code"] == "SUBMISSION_RULE_VIOLATION"
    assert payload["message"] == "Câu trả lời phải nằm trong đoạn văn."
    assert "SubmissionRuleError" in payload["detail"]


def test_rule_violation_without_valid_message_uses_fallback():
    for argument in ("", "'   '", "42", "'a', 'b'", "'x' * 301", "chr(0) + 'secret'", "chr(127) + 'secret'", "chr(0x202e) + 'secret'"):
        result, _ = _run(
            "def evaluate(truth_path, submission_path):\n"
            f"    raise SubmissionRuleError({argument})\n"
        )
        payload = _result(result)
        assert payload["code"] == "SUBMISSION_RULE_VIOLATION"
        assert "CSV không đáp ứng quy tắc" in payload["message"]


def test_rule_violation_accepts_300_char_message():
    result, _ = _run(
        "def evaluate(truth_path, submission_path):\n"
        "    raise SubmissionRuleError('x' * 300)\n"
    )
    assert _result(result)["message"] == "x" * 300


def test_rule_violation_collapses_whitespace_before_publication():
    result, _ = _run(
        "def evaluate(truth_path, submission_path):\n"
        "    raise SubmissionRuleError('  Câu 3:  sai nhãn.\\n Hãy sửa lại.  ')\n"
    )
    assert _result(result)["message"] == "Câu 3: sai nhãn. Hãy sửa lại."


def test_invalid_class_id_has_structured_numbers_and_private_traceback():
    result, _ = _run(
        "def evaluate(truth_path, submission_path):\n"
        "    raise InvalidClassIdError(6, [0, 1, 2, 3, 4, 5])\n"
    )
    payload = _result(result)
    assert payload["code"] == "SUBMISSION_CLASS_ID_INVALID"
    assert payload["class_info"] == {"class_id": 6, "allowed_class_ids": [0, 1, 2, 3, 4, 5]}
    assert "6" not in payload["message"]
    assert "InvalidClassIdError" in payload["detail"]


def test_invalid_class_id_metadata_cannot_turn_evaluator_fault_into_student_fault():
    for args in ("True, [0, 1]", "6, [0, 1, 1]", "6, []", "6, [0, 'SECRET']", "1, [0, 1]"):
        result, _ = _run(
            "def evaluate(truth_path, submission_path):\n"
            f"    raise InvalidClassIdError({args})\n"
        )
        payload = _result(result)
        assert payload["code"] == "EVALUATOR_FAILED"
        assert "class_info" not in payload
        assert "SECRET" not in payload["message"]


def test_other_errors_are_not_misclassified_as_submission_rules():
    for source in (
        "def evaluate(truth_path, submission_path):\n    raise ValueError('bad code')\n",
        "raise ValueError('bad load')\n"
        "def evaluate(truth_path, submission_path):\n    return {'accuracy': 1.0}\n",
        "raise SubmissionRuleError('bad load')\n"
        "def evaluate(truth_path, submission_path):\n    return {'accuracy': 1.0}\n",
    ):
        result, _ = _run(source)
        assert result.returncode == 0
        assert _result(result)["code"] == "EVALUATOR_FAILED"


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
