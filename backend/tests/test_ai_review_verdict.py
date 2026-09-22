"""Hậu kiểm output model: rule phải resolve được, evidence phải có thật, và verdict chỉ được GIẢM."""

import json

import pytest
from pydantic import ValidationError

from app.ai_review import constants
from app.ai_review.models import ModelReviewOutput
from app.ai_review.notebook import normalize_notebook
from app.ai_review.rule_refs import build_rule_index
from app.ai_review.rule_text import canonicalize_rule_text
from app.ai_review.verdict import (
    DOWNGRADE_EVIDENCE_INVALID,
    DOWNGRADE_NOTEBOOK_TRUNCATED,
    DOWNGRADE_NO_VERIFIED_VIOLATION,
    DOWNGRADE_RULE_NOT_FOUND,
    ResponseInvalid,
    verify_review,
)

RULE = "Thí sinh phải ghi rõ mô hình sử dụng trong notebook."
PAGES = [{"slug": "the-le", "title": "Thể lệ", "order": 1, "markdown": f"## Quy định\n\n{RULE}\n"}]
MAX = 100_000
UNKNOWN_REF = "the-le#000000000000000000000000"


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


def _ref(text=RULE, pages=PAGES):
    """Ref thật, tính bằng chính thuật toán production - không hard-code digest vào test."""
    wanted = canonicalize_rule_text(text)
    for block in build_rule_index(pages).blocks:
        if block.canonical_text == wanted:
            return block.ref
    raise AssertionError(f"Không có block nào khớp: {text!r}")


def _finding(
    *,
    ref=None,
    quote=RULE,
    status=constants.FINDING_VIOLATION,
    checkability=constants.CHECKABLE,
    evidence=None,
    reason="Notebook không nêu tên mô hình.",
):
    return {
        "rule_ref": _ref() if ref is None else ref,
        "rule_quote": quote,
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


def _verify(output, *, pages=PAGES, notebook=None):
    return verify_review(
        output,
        index=build_rule_index(pages),
        notebook=notebook if notebook is not None else _notebook(["import os"]),
    )


# --- Đường resolve và provenance -----------------------------------------------------------------


def test_verified_violation_keeps_the_flagged_verdict():
    verdict, findings, downgrades = _verify(
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=[_evidence(1, 1, 1)])])
    )
    assert verdict == constants.VERDICT_FLAGGED
    assert downgrades == []
    assert findings[0].verified is True
    assert findings[0].traceable is True


def test_matching_ref_fills_provenance_from_the_revision_not_from_the_model():
    # Model gửi kèm một quote sai lệch hoàn toàn; ref đúng vẫn thắng, và thứ được lưu là văn bản luật.
    _, findings, _ = _verify(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(quote="Đội phải nộp trước 23h59.", evidence=[_evidence(1, 1, 1)])],
        )
    )
    assert findings[0].source_content_slug == "the-le"
    assert findings[0].source_content_title == "Thể lệ"
    assert findings[0].rule_text == RULE
    assert findings[0].rule_ref == _ref()
    assert findings[0].rule_resolution == constants.RULE_RESOLUTION_REFERENCE
    assert findings[0].verification_codes == []


def test_ref_resolves_to_the_right_page_when_two_pages_share_the_same_wording():
    # Cùng một câu ở hai trang khác nhau là hai quy định khác nhau: ref mới phân biệt được chúng,
    # còn slug do model đoán thì không.
    pages = [
        {
            "slug": "vong-1",
            "title": "Vòng 1",
            "order": 1,
            "markdown": f"## Quy định\n\n{RULE}\n",
        },
        {
            "slug": "vong-2",
            "title": "Vòng 2",
            "order": 2,
            "markdown": f"## Quy định\n\n{RULE}\n",
        },
    ]
    refs = {block.page_slug: block.ref for block in build_rule_index(pages).blocks}
    _, findings, _ = _verify(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(ref=refs["vong-2"], quote="", evidence=[_evidence(1, 1, 1)])],
        ),
        pages=pages,
    )
    assert findings[0].source_content_slug == "vong-2"
    assert findings[0].source_content_title == "Vòng 2"


def test_unknown_ref_without_a_quote_is_unresolved_and_keeps_no_provenance():
    verdict, findings, downgrades = _verify(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(ref=UNKNOWN_REF, quote="", evidence=[_evidence(1, 1, 1)])],
        )
    )
    assert verdict == constants.VERDICT_INCONCLUSIVE
    assert DOWNGRADE_RULE_NOT_FOUND in downgrades
    assert findings[0].rule_resolution == constants.RULE_RESOLUTION_UNRESOLVED
    assert findings[0].rule_text == ""
    assert findings[0].rule_ref is None
    assert findings[0].rule_verified is False
    assert findings[0].verification_codes == [constants.VERIFY_RULE_REF_UNKNOWN]


def test_unknown_ref_falls_back_to_a_unique_canonical_quote():
    # Đường dự phòng: ref hỏng nhưng quote canonical khớp đúng một block - quy định vẫn resolve được
    # và rule text lưu vào vẫn lấy từ revision.
    _, findings, _ = _verify(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(ref=UNKNOWN_REF, quote=RULE, evidence=[_evidence(1, 1, 1)])],
        )
    )
    assert findings[0].rule_resolution == constants.RULE_RESOLUTION_CANONICAL_QUOTE
    assert findings[0].rule_ref == _ref()
    assert findings[0].rule_text == RULE
    assert findings[0].rule_verified is True
    assert findings[0].verification_codes == [constants.VERIFY_RULE_REF_UNKNOWN]


def test_fallback_accepts_a_quote_that_lost_its_markdown_formatting():
    # Model hay bỏ bold/backtick khi chép lại; canonical hoá làm hai cách trình bày hội tụ.
    pages = [
        {
            "slug": "the-le",
            "title": "Thể lệ",
            "order": 1,
            "markdown": "## Quy định\n\n- **Không được** dùng cột `device_id`.\n",
        }
    ]
    _, findings, _ = _verify(
        _output(
            constants.VERDICT_FLAGGED,
            [
                _finding(
                    ref=UNKNOWN_REF,
                    quote="Không được dùng cột device_id.",
                    evidence=[_evidence(1, 1, 1)],
                )
            ],
        ),
        pages=pages,
    )
    assert findings[0].rule_resolution == constants.RULE_RESOLUTION_CANONICAL_QUOTE
    assert findings[0].rule_verified is True


def test_fallback_rejects_a_quote_that_matches_no_rule():
    _, findings, _ = _verify(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(ref=UNKNOWN_REF, quote="Quy định do model bịa ra", evidence=[_evidence(1, 1, 1)])],
        )
    )
    assert findings[0].rule_resolution == constants.RULE_RESOLUTION_UNRESOLVED
    assert findings[0].rule_verified is False
    assert findings[0].verification_codes == [
        constants.VERIFY_RULE_QUOTE_UNMATCHED,
        constants.VERIFY_RULE_REF_UNKNOWN,
    ]


def test_fallback_rejects_a_quote_that_matches_several_rules():
    # Hai block canonical giống hệt nhau: chọn cái nào cũng là đoán, nên không chọn.
    pages = [
        {
            "slug": "the-le",
            "title": "Thể lệ",
            "order": 1,
            "markdown": f"## Quy định\n\n{RULE}\n\n## Nhắc lại\n\n{RULE}\n",
        }
    ]
    _, findings, _ = _verify(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(ref=UNKNOWN_REF, quote=RULE, evidence=[_evidence(1, 1, 1)])],
        ),
        pages=pages,
    )
    assert findings[0].rule_resolution == constants.RULE_RESOLUTION_UNRESOLVED
    assert findings[0].rule_verified is False
    assert constants.VERIFY_RULE_QUOTE_AMBIGUOUS in findings[0].verification_codes


def test_a_quote_alone_never_becomes_the_stored_rule_text():
    # Ngay cả khi fallback thành công, thứ lưu lại là văn bản trong revision, không phải quote model.
    _, findings, _ = _verify(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(ref=UNKNOWN_REF, quote=f"  {RULE}  ", evidence=[_evidence(1, 1, 1)])],
        )
    )
    assert findings[0].rule_text == RULE


# --- Bằng chứng được kiểm tra độc lập với rule ----------------------------------------------------


def test_evidence_is_validated_even_when_the_rule_does_not_resolve():
    notebook = _notebook(["import os", "print(1)"])
    _, findings, _ = _verify(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(ref=UNKNOWN_REF, quote="", evidence=[_evidence(1, 1, 2)])],
        ),
        notebook=notebook,
    )
    assert findings[0].rule_verified is False
    assert findings[0].evidence_verified is True
    assert findings[0].evidence_count == 1
    assert findings[0].valid_evidence_count == 1
    assert findings[0].verified is False
    assert findings[0].evidence[0]["snippet"].startswith("1 import os")


def test_a_violation_without_evidence_is_marked_missing():
    verdict, findings, downgrades = _verify(
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=[])])
    )
    assert findings[0].verification_codes == [constants.VERIFY_EVIDENCE_MISSING]
    assert verdict == constants.VERDICT_INCONCLUSIVE
    assert downgrades == [DOWNGRADE_NO_VERIFIED_VIOLATION]


def test_a_compliant_finding_needs_no_evidence():
    # Thiếu bằng chứng chỉ là khuyết điểm khi finding CÁO BUỘC ai đó làm sai.
    verdict, findings, downgrades = _verify(
        _output(constants.VERDICT_CLEAR, [_finding(status=constants.FINDING_COMPLIANT, evidence=[])])
    )
    assert verdict == constants.VERDICT_CLEAR
    assert findings[0].verification_codes == []
    assert findings[0].verified is False
    assert downgrades == []


def test_out_of_range_evidence_is_dropped_and_marked_invalid():
    notebook = _notebook(["import os", "print(1)"])
    verdict, findings, downgrades = _verify(
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=[_evidence(1, 1, 99)])]),
        notebook=notebook,
    )
    assert findings[0].evidence == []
    assert findings[0].verification_codes == [constants.VERIFY_EVIDENCE_INVALID]
    assert DOWNGRADE_EVIDENCE_INVALID in downgrades
    assert verdict == constants.VERDICT_INCONCLUSIVE


def test_evidence_pointing_to_a_missing_cell_is_dropped():
    _, findings, downgrades = _verify(
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=[_evidence(7, 1, 1)])])
    )
    assert findings[0].evidence == []
    assert findings[0].verification_codes == [constants.VERIFY_EVIDENCE_INVALID]
    assert DOWNGRADE_EVIDENCE_INVALID in downgrades


def test_one_valid_range_among_invalid_ones_keeps_the_finding_traceable_but_flagged_partial():
    notebook = _notebook(["import os", "print(1)"])
    verdict, findings, _ = _verify(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(evidence=[_evidence(1, 1, 2), _evidence(9, 1, 1)])],
        ),
        notebook=notebook,
    )
    assert verdict == constants.VERDICT_FLAGGED
    assert findings[0].evidence_count == 2
    assert findings[0].valid_evidence_count == 1
    assert findings[0].traceable is True
    assert findings[0].verification_codes == [constants.VERIFY_EVIDENCE_PARTIALLY_INVALID]


def test_snippet_is_rebuilt_from_the_notebook_and_never_taken_from_the_model():
    notebook = _notebook(["a = 1", "b = 2", "c = 3"])
    _, findings, _ = _verify(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(evidence=[_evidence(1, 2, 2, snippet="NỘI DUNG GIẢ DO MODEL GỬI")])],
        ),
        notebook=notebook,
    )
    snippet = findings[0].evidence[0]["snippet"]
    assert "NỘI DUNG GIẢ DO MODEL GỬI" not in snippet
    assert snippet.startswith("1 a = 1")
    assert "2 b = 2" in snippet


def test_snippet_is_capped_in_lines_and_characters():
    long_cell = ["x" * 200 for _ in range(40)]
    _, findings, _ = _verify(
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=[_evidence(1, 10, 12)])]),
        notebook=_notebook(long_cell),
    )
    snippet = findings[0].evidence[0]["snippet"]
    assert snippet.count("\n") + 1 <= constants.MAX_SNIPPET_LINES
    assert len(snippet) <= constants.MAX_SNIPPET_CHARS


def test_a_single_over_long_line_is_still_cut_to_the_character_cap():
    # Một dòng dài hơn cả trần: trần ký tự phải đúng với cả dòng đầu tiên, không chỉ từ dòng thứ hai.
    _, findings, _ = _verify(
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=[_evidence(1, 1, 1)])]),
        notebook=_notebook(["x" * (constants.MAX_SNIPPET_CHARS * 3)]),
    )
    assert len(findings[0].evidence[0]["snippet"]) <= constants.MAX_SNIPPET_CHARS


# --- Verdict chỉ được giảm ------------------------------------------------------------------------


def test_flagged_without_verified_violation_is_downgraded_to_inconclusive():
    # VIOLATION cho một quy định không kiểm chứng được từ notebook: không đủ căn cứ để buộc tội.
    verdict, _, downgrades = _verify(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(checkability=constants.NOT_CHECKABLE, evidence=[_evidence(1, 1, 1)])],
        )
    )
    assert verdict == constants.VERDICT_INCONCLUSIVE
    assert DOWNGRADE_NO_VERIFIED_VIOLATION in downgrades


def test_a_not_checkable_violation_is_never_traceable():
    _, findings, _ = _verify(
        _output(
            constants.VERDICT_FLAGGED,
            [_finding(checkability=constants.NOT_CHECKABLE, evidence=[_evidence(1, 1, 1)])],
        )
    )
    assert findings[0].verified is True
    assert findings[0].traceable is False


def test_clear_with_a_violation_finding_is_invalid_not_guessed():
    with pytest.raises(ResponseInvalid):
        _verify(_output(constants.VERDICT_CLEAR, [_finding(evidence=[_evidence(1, 1, 1)])]))


def test_clear_on_a_truncated_notebook_is_downgraded_to_inconclusive():
    notebook = _notebook(["y" * 300], ["z" * 300], max_chars=500)
    assert notebook.truncated is True
    verdict, _, downgrades = _verify(_output(constants.VERDICT_CLEAR), notebook=notebook)
    assert verdict == constants.VERDICT_INCONCLUSIVE
    assert downgrades == [DOWNGRADE_NOTEBOOK_TRUNCATED]


def test_clear_on_a_complete_notebook_stays_clear():
    verdict, findings, downgrades = _verify(_output(constants.VERDICT_CLEAR))
    assert verdict == constants.VERDICT_CLEAR
    assert findings == []
    assert downgrades == []


def test_inconclusive_is_never_escalated_to_flagged():
    verdict, _, downgrades = _verify(
        _output(constants.VERDICT_INCONCLUSIVE, [_finding(evidence=[_evidence(1, 1, 1)])])
    )
    assert verdict == constants.VERDICT_INCONCLUSIVE
    assert DOWNGRADE_NO_VERIFIED_VIOLATION not in downgrades


def test_compliant_finding_does_not_flag_a_clear_review():
    verdict, findings, _ = _verify(
        _output(
            constants.VERDICT_CLEAR,
            [_finding(status=constants.FINDING_COMPLIANT, evidence=[_evidence(1, 1, 1)])],
        )
    )
    assert verdict == constants.VERDICT_CLEAR
    assert findings[0].verified is True
    assert findings[0].traceable is False


def test_downgrade_codes_are_sorted_and_deduplicated():
    _, _, downgrades = _verify(
        _output(
            constants.VERDICT_FLAGGED,
            [
                _finding(ref=UNKNOWN_REF, quote="", evidence=[_evidence(1, 1, 1)]),
                _finding(ref="the-le#ffffffffffffffffffffffff", quote="", evidence=[_evidence(1, 1, 1)]),
            ],
        )
    )
    assert downgrades == sorted(set(downgrades))
    assert downgrades == [DOWNGRADE_NO_VERIFIED_VIOLATION, DOWNGRADE_RULE_NOT_FOUND]


# --- Hợp đồng schema ------------------------------------------------------------------------------


def test_model_output_rejects_unknown_fields():
    with pytest.raises(ValidationError):
        ModelReviewOutput.model_validate(
            {"verdict": "CLEAR", "summary": "ổn", "confidence": 0.9, "findings": []}
        )


def test_model_output_rejects_the_legacy_prose_fields():
    # Model không còn được tự khai title/slug/rule text: chúng đến từ revision, không từ prose.
    with pytest.raises(ValidationError):
        ModelReviewOutput.model_validate(
            {
                "verdict": "FLAGGED",
                "summary": "x",
                "findings": [
                    {
                        "source_content_title": "Thể lệ",
                        "source_content_slug": "the-le",
                        "rule_text": RULE,
                        "checkability": "CHECKABLE_FROM_NOTEBOOK",
                        "status": "VIOLATION",
                        "reason": "y",
                        "evidence": [],
                    }
                ],
            }
        )


def test_model_output_requires_a_rule_ref():
    with pytest.raises(ValidationError):
        ModelReviewOutput.model_validate(
            {
                "verdict": "CLEAR",
                "summary": "x",
                "findings": [
                    {
                        "rule_quote": RULE,
                        "checkability": "CHECKABLE_FROM_NOTEBOOK",
                        "status": "COMPLIANT",
                        "reason": "y",
                        "evidence": [],
                    }
                ],
            }
        )


def test_a_finding_without_a_rule_quote_is_still_valid():
    output = ModelReviewOutput.model_validate(
        {
            "verdict": "CLEAR",
            "summary": "x",
            "findings": [
                {
                    "rule_ref": "the-le#abc",
                    "checkability": "CHECKABLE_FROM_NOTEBOOK",
                    "status": "COMPLIANT",
                    "reason": "y",
                    "evidence": [],
                }
            ],
        }
    )
    assert output.findings[0].rule_quote == ""


def test_model_output_rejects_an_over_long_rule_ref():
    with pytest.raises(ValidationError):
        _output(
            constants.VERDICT_CLEAR,
            [_finding(ref="x" * (constants.MAX_RULE_REF_CHARS + 1), status=constants.FINDING_COMPLIANT)],
        )


def test_model_output_rejects_the_pipeline_only_error_verdict():
    with pytest.raises(ValidationError):
        _output(constants.VERDICT_ERROR)


def test_model_output_rejects_more_evidence_than_the_cap():
    too_many = [_evidence(1, 1, 1) for _ in range(constants.MAX_EVIDENCE_PER_FINDING + 1)]
    with pytest.raises(ValidationError):
        _output(constants.VERDICT_FLAGGED, [_finding(evidence=too_many)])


def test_model_output_rejects_more_findings_than_the_cap():
    with pytest.raises(ValidationError):
        _output(constants.VERDICT_FLAGGED, [_finding() for _ in range(constants.MAX_FINDINGS + 1)])


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
