"""Kiểm chứng output model: chỉ verdict được GIẢM độ chắc chắn, và snippet luôn do backend dựng lại."""

import json

import pytest
from pydantic import ValidationError

from app.ai_review import constants
from app.ai_review.models import ModelReviewOutput
from app.ai_review.notebook import normalize_notebook
from app.ai_review.verdict import (
    DOWNGRADE_EVIDENCE_INVALID,
    DOWNGRADE_NOTEBOOK_TRUNCATED,
    DOWNGRADE_NO_VERIFIED_VIOLATION,
    DOWNGRADE_RULE_NOT_FOUND,
    ResponseInvalid,
    verify_review,
)

RULE = "Thí sinh phải ghi rõ mô hình sử dụng trong notebook."
PAGE = {"slug": "the-le", "title": "Thể lệ", "markdown": f"## Quy định\n\n{RULE}\n"}
PAGES = [PAGE]
MAX = 100_000


def _notebook(*cells, max_chars=MAX):
    payload = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {"cell_type": "code", "source": [f"{line}\n" for line in cell]} for cell in cells
        ],
    }
    return normalize_notebook(json.dumps(payload).encode(), max_chars=max_chars)


def _finding(
    *,
    status=constants.FINDING_VIOLATION,
    checkability=constants.CHECKABLE,
    rule_text=RULE,
    slug="the-le",
    evidence=None,
    reason="Notebook không nêu tên mô hình.",
):
    return {
        "source_content_title": "Thể lệ",
        "source_content_slug": slug,
        "rule_text": rule_text,
        "checkability": checkability,
        "status": status,
        "reason": reason,
        "evidence": evidence if evidence is not None else [],
    }


def _output(verdict, findings=(), summary="Kết luận của model.", participant_summary=None):
    payload = {"verdict": verdict, "summary": summary, "findings": list(findings)}
    if participant_summary is not None:
        payload["participant_summary"] = participant_summary
    return ModelReviewOutput.model_validate(payload)


def _evidence(cell=1, start_line=1, end_line=1, snippet="do model tu nghi ra"):
    return {
        "cell": cell,
        "start_line": start_line,
        "end_line": end_line,
        "snippet": snippet,
    }


def test_verified_violation_keeps_the_flagged_verdict():
    notebook = _notebook(["import os", "print(1)"])
    verdict, findings, downgrades = verify_review(
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=[_evidence(1, 1, 2)])]),
        pages=PAGES,
        notebook=notebook,
    )
    assert verdict == constants.VERDICT_FLAGGED
    assert downgrades == []
    assert findings[0].verified is True


def test_flagged_without_verified_violation_is_downgraded_to_inconclusive():
    # VIOLATION cho một quy định không kiểm chứng được từ notebook: không đủ căn cứ để buộc tội.
    notebook = _notebook(["import os"])
    verdict, _, downgrades = verify_review(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(checkability=constants.NOT_CHECKABLE, evidence=[_evidence(1, 1, 1)])],
        ),
        pages=PAGES,
        notebook=notebook,
    )
    assert verdict == constants.VERDICT_INCONCLUSIVE
    assert DOWNGRADE_NO_VERIFIED_VIOLATION in downgrades


def test_flagged_without_any_evidence_is_downgraded_to_inconclusive():
    verdict, _, downgrades = verify_review(
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=[])]),
        pages=PAGES,
        notebook=_notebook(["import os"]),
    )
    assert verdict == constants.VERDICT_INCONCLUSIVE
    assert downgrades == [DOWNGRADE_NO_VERIFIED_VIOLATION]


def test_rule_absent_from_the_cited_page_is_downgraded_and_flagged():
    notebook = _notebook(["import os"])
    verdict, findings, downgrades = verify_review(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(rule_text="Quy định do model bịa ra", evidence=[_evidence(1, 1, 1)])],
        ),
        pages=PAGES,
        notebook=notebook,
    )
    assert verdict == constants.VERDICT_INCONCLUSIVE
    assert DOWNGRADE_RULE_NOT_FOUND in downgrades
    assert findings[0].verified is False
    assert findings[0].evidence == []


def test_unknown_page_slug_is_downgraded_and_flagged():
    verdict, findings, downgrades = verify_review(
        _output(constants.VERDICT_FLAGGED, [_finding(slug="trang-khong-ton-tai")]),
        pages=PAGES,
        notebook=_notebook(["import os"]),
    )
    assert verdict == constants.VERDICT_INCONCLUSIVE
    assert findings[0].verified is False
    assert DOWNGRADE_RULE_NOT_FOUND not in downgrades


def test_evidence_outside_the_known_lines_is_dropped_and_marked_invalid():
    notebook = _notebook(["import os", "print(1)"])
    verdict, findings, downgrades = verify_review(
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=[_evidence(1, 1, 99)])]),
        pages=PAGES,
        notebook=notebook,
    )
    assert findings[0].evidence == []
    assert DOWNGRADE_EVIDENCE_INVALID in downgrades
    assert verdict == constants.VERDICT_INCONCLUSIVE


def test_evidence_pointing_to_a_missing_cell_is_dropped():
    notebook = _notebook(["import os"])
    _, findings, downgrades = verify_review(
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=[_evidence(7, 1, 1)])]),
        pages=PAGES,
        notebook=notebook,
    )
    assert findings[0].evidence == []
    assert DOWNGRADE_EVIDENCE_INVALID in downgrades


def test_snippet_is_rebuilt_from_the_notebook_and_never_taken_from_the_model():
    notebook = _notebook(["a = 1", "b = 2", "c = 3"])
    _, findings, _ = verify_review(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(evidence=[_evidence(1, 2, 2, snippet="NỘI DUNG GIẢ DO MODEL GỬI")])],
        ),
        pages=PAGES,
        notebook=notebook,
    )
    snippet = findings[0].evidence[0]["snippet"]
    assert "NỘI DUNG GIẢ DO MODEL GỬI" not in snippet
    assert snippet.startswith("1 a = 1")
    assert "2 b = 2" in snippet


def test_snippet_is_capped_in_lines_and_characters():
    long_cell = ["x" * 200 for _ in range(40)]
    _, findings, _ = verify_review(
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=[_evidence(1, 10, 12)])]),
        pages=PAGES,
        notebook=_notebook(long_cell),
    )
    snippet = findings[0].evidence[0]["snippet"]
    assert snippet.count("\n") + 1 <= constants.MAX_SNIPPET_LINES
    assert len(snippet) <= constants.MAX_SNIPPET_CHARS


def test_a_single_over_long_line_is_still_cut_to_the_character_cap():
    # Một dòng dài hơn cả trần: trần ký tự phải đúng với cả dòng đầu tiên, không chỉ từ dòng thứ hai.
    _, findings, _ = verify_review(
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=[_evidence(1, 1, 1)])]),
        pages=PAGES,
        notebook=_notebook(["x" * (constants.MAX_SNIPPET_CHARS * 3)]),
    )
    snippet = findings[0].evidence[0]["snippet"]
    assert len(snippet) <= constants.MAX_SNIPPET_CHARS


def test_clear_with_a_violation_finding_is_invalid_not_guessed():
    with pytest.raises(ResponseInvalid):
        verify_review(
            _output(
                constants.VERDICT_CLEAR,
                [_finding(evidence=[_evidence(1, 1, 1)])],
            ),
            pages=PAGES,
            notebook=_notebook(["import os"]),
        )


def test_clear_on_a_truncated_notebook_is_downgraded_to_inconclusive():
    notebook = _notebook(["y" * 300], ["z" * 300], max_chars=500)
    assert notebook.truncated is True
    verdict, _, downgrades = verify_review(
        _output(constants.VERDICT_CLEAR),
        pages=PAGES,
        notebook=notebook,
    )
    assert verdict == constants.VERDICT_INCONCLUSIVE
    assert downgrades == [DOWNGRADE_NOTEBOOK_TRUNCATED]


def test_clear_on_a_complete_notebook_stays_clear():
    verdict, findings, downgrades = verify_review(
        _output(constants.VERDICT_CLEAR),
        pages=PAGES,
        notebook=_notebook(["import os"]),
    )
    assert verdict == constants.VERDICT_CLEAR
    assert findings == []
    assert downgrades == []


def test_inconclusive_is_never_escalated_to_flagged():
    notebook = _notebook(["import os"])
    verdict, _, downgrades = verify_review(
        _output(
            constants.VERDICT_INCONCLUSIVE,
            [_finding(evidence=[_evidence(1, 1, 1)])],
        ),
        pages=PAGES,
        notebook=notebook,
    )
    assert verdict == constants.VERDICT_INCONCLUSIVE
    assert DOWNGRADE_NO_VERIFIED_VIOLATION not in downgrades


def test_compliant_finding_is_verified_without_flagging():
    notebook = _notebook(["model = 'PhoBERT'"])
    verdict, findings, _ = verify_review(
        _output(
            constants.VERDICT_CLEAR,
            [_finding(status=constants.FINDING_COMPLIANT, evidence=[_evidence(1, 1, 1)])],
        ),
        pages=PAGES,
        notebook=notebook,
    )
    assert verdict == constants.VERDICT_CLEAR
    assert findings[0].verified is True


def test_rule_matching_collapses_whitespace_because_markdown_wraps_lines():
    pages = [{"slug": "the-le", "title": "Thể lệ", "markdown": f"## A\n\n{RULE}\n"}]
    verdict, findings, _ = verify_review(
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=[_evidence(1, 1, 1)])]),
        pages=pages,
        notebook=_notebook(["import os"]),
    )
    assert findings[0].verified is True
    assert verdict == constants.VERDICT_FLAGGED


def test_downgrade_codes_are_sorted_and_deduplicated():
    notebook = _notebook(["import os"])
    _, _, downgrades = verify_review(
        _output(
            constants.VERDICT_FLAGGED,
            [
                _finding(rule_text="bịa một", evidence=[_evidence(1, 1, 1)]),
                _finding(rule_text="bịa hai", evidence=[_evidence(1, 1, 1)]),
            ],
        ),
        pages=PAGES,
        notebook=notebook,
    )
    assert downgrades == sorted(set(downgrades))
    assert downgrades == [DOWNGRADE_NO_VERIFIED_VIOLATION, DOWNGRADE_RULE_NOT_FOUND]


def test_model_output_rejects_unknown_fields():
    with pytest.raises(ValidationError):
        ModelReviewOutput.model_validate(
            {"verdict": "CLEAR", "summary": "ổn", "confidence": 0.9, "findings": []}
        )


def test_model_output_rejects_the_pipeline_only_error_verdict():
    with pytest.raises(ValidationError):
        _output(constants.VERDICT_ERROR)


def test_model_output_rejects_more_evidence_than_the_cap():
    too_many = [_evidence(1, 1, 1) for _ in range(constants.MAX_EVIDENCE_PER_FINDING + 1)]
    with pytest.raises(ValidationError):
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=too_many)])


def test_model_output_rejects_more_findings_than_the_cap():
    too_many = [_finding() for _ in range(constants.MAX_FINDINGS + 1)]
    with pytest.raises(ValidationError):
        _output(constants.VERDICT_FLAGGED, too_many)


def test_a_model_that_omits_the_participant_summary_is_still_valid():
    """Gợi ý cho thí sinh là phần thưởng thêm, không phải điều kiện để một lượt review dùng được."""
    output = ModelReviewOutput.model_validate(
        {"verdict": "CLEAR", "summary": "Không thấy vi phạm.", "findings": []}
    )
    assert output.participant_summary == ""


def test_a_blank_participant_summary_is_emptied_not_rejected():
    # "Không có gì để nói" là câu trả lời hợp lệ: chuỗi khoảng trắng phải thành rỗng, không phải lỗi.
    assert _output(constants.VERDICT_CLEAR, participant_summary="   \n ").participant_summary == ""


def test_the_participant_summary_is_stripped():
    output = _output(constants.VERDICT_FLAGGED, participant_summary="  Thiếu tên mô hình.  ")
    assert output.participant_summary == "Thiếu tên mô hình."


def test_a_participant_summary_beyond_the_cap_is_invalid():
    too_long = "x" * (constants.MAX_PARTICIPANT_SUMMARY_CHARS + 1)
    with pytest.raises(ValidationError):
        _output(constants.VERDICT_FLAGGED, participant_summary=too_long)
