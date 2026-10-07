"""API chỉ nhận các mã lỗi runner đã khai báo, không tự tin lời văn công khai của nó."""

import httpx
import pytest

from app.scoring.evaluator_client import _parse
from app.scoring.errors import EvaluatorError


def test_client_preserves_intentional_rule_violation_for_worker():
    response = httpx.Response(
        422,
        json={
            "code": "SUBMISSION_RULE_VIOLATION",
            "message": "private reason",
            "detail": "private traceback",
        },
    )
    with pytest.raises(EvaluatorError) as error:
        _parse(response)
    assert error.value.code == "SUBMISSION_RULE_VIOLATION"
    assert error.value.detail == "private traceback"


def test_client_checks_class_info_again_after_runner():
    info = {"class_id": 6, "allowed_class_ids": [0, 1, 2, 3, 4, 5]}
    response = httpx.Response(
        422,
        json={"code": "SUBMISSION_CLASS_ID_INVALID", "message": "SECRET", "class_info": info},
    )
    with pytest.raises(EvaluatorError) as error:
        _parse(response)
    assert error.value.code == "SUBMISSION_CLASS_ID_INVALID"
    assert error.value.class_info == info

    with pytest.raises(EvaluatorError) as rejected:
        _parse(httpx.Response(
            422,
            json={
                "code": "SUBMISSION_CLASS_ID_INVALID",
                "class_info": {"class_id": 6, "allowed_class_ids": [False]},
            },
        ))
    assert rejected.value.code == "EVALUATOR_FAILED"
    assert rejected.value.class_info is None


def test_client_rejects_unknown_error_code():
    with pytest.raises(EvaluatorError) as error:
        _parse(httpx.Response(422, json={"code": "PRIVATE_ANSWER", "message": "secret"}))
    assert error.value.code == "EVALUATOR_UNAVAILABLE"
