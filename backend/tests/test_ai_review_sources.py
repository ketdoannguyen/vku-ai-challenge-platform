"""Hậu kiểm đánh giá nguồn và dữ kiện phụ quét tài nguyên BTC - không gọi mạng.

Model trả MỘT `source_assessment` cho cả notebook; ở đây khoá lại phần backend chắc được: vị trí
trích dẫn có thật trong CODE cell, snippet dựng lại từ notebook, vị trí bị loại giữ kèm mã lý do, và
bảng hạ trạng thái. URL Drive chỉ quyết định "có tài nguyên BTC để đối chiếu hay không"; riêng
`find_resource_mentions` là dữ kiện phụ cho admin, không bao giờ quyết định trạng thái nguồn.
"""

import pytest

from app.ai_review import constants
from app.ai_review.models import ModelEvidence, ModelSourceAssessment
from app.ai_review.notebook import normalize_notebook
from app.ai_review.sources import (
    ResourceMention,
    drive_identity,
    find_resource_mentions,
    verify_source_assessment,
)
from tests.helpers import notebook_bytes

RESOURCE = {"label": "Dataset BTC", "url": "https://drive.google.com/file/d/GOOD1234567890abcdef/view"}
DEFAULT_CELLS = (("code", ["import pandas as pd", "df = pd.read_csv('train.csv')"]),)
# Cell 1 vừa ngân sách, cell 2 dài hơn phần còn lại: normalize cắt từ cell 2 trở đi.
TRUNCATED_CELLS = (("code", ["import pandas as pd"]), ("code", ["x = " + "1" * 500]))


def normalized(cells=DEFAULT_CELLS, *, max_chars=100_000):
    return normalize_notebook(
        notebook_bytes(cells=[
            {"cell_type": kind, "source": [f"{line}\n" for line in lines]}
            for kind, lines in cells
        ]),
        max_chars=max_chars,
    )


def assess(status, evidence=(), reason="Đề xuất của model."):
    return ModelSourceAssessment(
        status=status,
        reason=reason,
        evidence=[ModelEvidence(cell=c, start_line=s, end_line=e) for c, s, e in evidence],
    )


def verify(assessment, *, cells=DEFAULT_CELLS, resources=(RESOURCE,), max_chars=100_000):
    return verify_source_assessment(
        assessment, notebook=normalized(cells, max_chars=max_chars), resources=list(resources)
    )


@pytest.mark.parametrize("url", [
    "https://drive.google.com/file/d/FILE123/view",
    "http://drive.google.com/uc?export=download&id=FILE123",
    "https://drive.google.com/open?id=FILE123",
    "https://docs.google.com/spreadsheets/d/FILE123/edit",
])
def test_same_file_has_same_identity(url):
    assert drive_identity(url) == ("file", "FILE123")


def test_forms_and_multi_account_links_keep_their_real_ids():
    assert drive_identity("https://docs.google.com/forms/d/e/FORM_A/viewform") == ("file", "FORM_A")
    assert drive_identity("https://docs.google.com/forms/d/e/FORM_B/viewform") == ("file", "FORM_B")
    assert drive_identity("https://docs.google.com/spreadsheets/u/0/d/FILE123/edit") == ("file", "FILE123")
    assert drive_identity("https://drive.google.com/file/u/0/d/FILE123/view") == ("file", "FILE123")


def test_a_missing_assessment_is_not_evaluated_with_its_own_code():
    result = verify(None)

    assert result.status == constants.SOURCE_STATUS_NOT_EVALUATED
    assert result.model_status is None
    assert result.reason == ""
    assert result.evidence == []
    assert result.rejected_evidence == []
    assert result.validation_codes == [constants.SOURCE_ASSESSMENT_MISSING]


@pytest.mark.parametrize("resources", [
    [],
    [{"label": "Web", "url": "https://example.org/dataset.zip"}],
    # Drive link không có ID hợp lệ: không phải tài nguyên đối chiếu được.
    [{"label": "Drive cá nhân", "url": "https://drive.google.com/file/d/"}],
])
def test_without_a_usable_btc_resource_the_proposal_is_not_evaluated(resources):
    result = verify(assess("ALIGNED", [(1, 1, 1)]), resources=resources)

    # Đề xuất gốc còn nguyên trong dấu vết; thứ bị hạ là kết luận.
    assert result.model_status == "ALIGNED"
    assert result.status == constants.SOURCE_STATUS_NOT_EVALUATED
    assert result.reason == "Đề xuất của model."
    assert result.validation_codes == [constants.SOURCE_RESOURCES_MISSING]
    # Không có gì để đối chiếu thì cũng không kiểm trích dẫn: vị trí đúng cũng không được ghi nhận.
    assert result.evidence == []


def test_the_snippet_is_rebuilt_from_the_notebook_not_taken_from_the_model():
    lying = ModelSourceAssessment(
        status="ALIGNED",
        reason="Pipeline lấy dữ liệu từ nguồn BTC.",
        evidence=[ModelEvidence(cell=1, start_line=1, end_line=2, snippet="BỊA RA")],
    )

    result = verify(lying)

    assert result.status == constants.SOURCE_STATUS_ALIGNED
    assert result.validation_codes == []
    [evidence] = result.evidence
    assert (evidence["cell"], evidence["start_line"], evidence["end_line"]) == (1, 1, 2)
    assert "BỊA RA" not in evidence["snippet"]
    assert "import pandas as pd" in evidence["snippet"]
    assert "df = pd.read_csv('train.csv')" in evidence["snippet"]


def test_external_with_a_real_position_stays_external():
    result = verify(assess("EXTERNAL", [(1, 1, 2)]))

    assert result.status == constants.SOURCE_STATUS_EXTERNAL
    assert result.model_status == "EXTERNAL"
    assert result.validation_codes == []


def test_unclear_may_cite_nothing_and_stays_unclear():
    result = verify(assess("UNCLEAR"))

    assert result.status == constants.SOURCE_STATUS_UNCLEAR
    assert result.evidence == []
    assert result.rejected_evidence == []
    assert result.validation_codes == []


def test_a_citation_to_a_missing_cell_is_kept_as_evidence_of_the_rejection():
    result = verify(assess("ALIGNED", [(7, 1, 1)]))

    assert result.status == constants.SOURCE_STATUS_UNCLEAR
    assert result.model_status == "ALIGNED"
    assert result.evidence == []
    assert result.rejected_evidence == [
        {"cell": 7, "start_line": 1, "end_line": 1,
         "code": constants.SOURCE_EVIDENCE_CELL_NOT_FOUND}
    ]
    assert result.validation_codes == [constants.SOURCE_EVIDENCE_INVALID]


def test_cell_existence_is_checked_before_the_range():
    """Cell 7 không tồn tại: mã phải là CELL_NOT_FOUND, không phải RANGE_INVALID - backend không được
    đọc dòng của cell không có trong notebook đã gửi."""
    result = verify(assess("EXTERNAL", [(7, 99, 99)]))

    assert result.rejected_evidence[0]["code"] == constants.SOURCE_EVIDENCE_CELL_NOT_FOUND


def test_a_citation_to_a_markdown_cell_is_not_code():
    cells = (("markdown", ["Ghi chú kèm link"]), ("code", ["print(1)"]))
    result = verify(assess("ALIGNED", [(1, 1, 1)]), cells=cells)

    assert result.rejected_evidence == [
        {"cell": 1, "start_line": 1, "end_line": 1,
         "code": constants.SOURCE_EVIDENCE_CELL_NOT_CODE}
    ]


@pytest.mark.parametrize(("start_line", "end_line"), [(3, 2), (1, 9)])
def test_out_of_bounds_ranges_are_rejected_with_the_range_code(start_line, end_line):
    # Notebook mặc định: cell 1 có đúng 2 dòng.
    result = verify(assess("EXTERNAL", [(1, start_line, end_line)]))

    assert result.rejected_evidence == [
        {"cell": 1, "start_line": start_line, "end_line": end_line,
         "code": constants.SOURCE_EVIDENCE_RANGE_INVALID}
    ]
    assert result.status == constants.SOURCE_STATUS_UNCLEAR
    assert result.validation_codes == [constants.SOURCE_EVIDENCE_INVALID]


def test_mixed_evidence_keeps_the_valid_positions_and_names_the_rejected_ones():
    result = verify(assess("ALIGNED", [(1, 1, 1), (7, 1, 1)]))

    assert result.status == constants.SOURCE_STATUS_UNCLEAR
    assert result.model_status == "ALIGNED"
    assert [item["cell"] for item in result.evidence] == [1]
    assert [item["cell"] for item in result.rejected_evidence] == [7]
    assert result.validation_codes == [constants.SOURCE_EVIDENCE_PARTIALLY_INVALID]


def test_external_survives_partial_rejection_with_a_warning():
    """Một dấu hiệu dùng nguồn ngoài có thật là đủ cho EXTERNAL; trích dẫn sai chỉ còn là cảnh báo
    để BTC đọc, không tự nâng kết luận lên chắc hơn."""
    result = verify(assess("EXTERNAL", [(1, 1, 1), (7, 1, 1)]))

    assert result.status == constants.SOURCE_STATUS_EXTERNAL
    assert result.validation_codes == [constants.SOURCE_EVIDENCE_PARTIALLY_INVALID]


def test_aligned_without_any_citation_is_downgraded_to_unclear():
    result = verify(assess("ALIGNED"))

    assert result.status == constants.SOURCE_STATUS_UNCLEAR
    assert result.model_status == "ALIGNED"
    assert result.validation_codes == [constants.SOURCE_EVIDENCE_MISSING]


def test_all_rejected_evidence_is_not_reported_as_missing_evidence():
    result = verify(assess("ALIGNED", [(7, 1, 1), (1, 5, 6)]))

    assert result.status == constants.SOURCE_STATUS_UNCLEAR
    assert result.evidence == []
    assert len(result.rejected_evidence) == 2
    assert result.validation_codes == [constants.SOURCE_EVIDENCE_INVALID]


def test_a_truncated_notebook_downgrades_aligned_but_keeps_external_as_a_warning():
    aligned = verify(assess("ALIGNED", [(1, 1, 1)]), cells=TRUNCATED_CELLS, max_chars=200)
    assert aligned.status == constants.SOURCE_STATUS_UNCLEAR
    assert aligned.validation_codes == [constants.SOURCE_NOTEBOOK_TRUNCATED]

    external = verify(assess("EXTERNAL", [(1, 1, 1)]), cells=TRUNCATED_CELLS, max_chars=200)
    assert external.status == constants.SOURCE_STATUS_EXTERNAL
    assert external.validation_codes == [constants.SOURCE_NOTEBOOK_TRUNCATED]


def test_a_citation_into_the_omitted_part_is_cell_not_found():
    result = verify(assess("EXTERNAL", [(2, 1, 1)]), cells=TRUNCATED_CELLS, max_chars=200)

    assert result.rejected_evidence[0]["code"] == constants.SOURCE_EVIDENCE_CELL_NOT_FOUND
    assert constants.SOURCE_NOTEBOOK_TRUNCATED in result.validation_codes


def scan(cells, resources):
    return find_resource_mentions(normalized(cells), list(resources))


OFFICIAL_FILE = {"label": "Dataset BTC", "url": "https://drive.google.com/file/d/FILE1234567890abcdefghij/view"}


def test_resource_scan_matches_url_variants_and_bare_id_of_configured_resources():
    mentions = scan(
        [
            ("markdown", ["Tài nguyên: https://drive.google.com/file/d/FILE1234567890abcdefghij/view"]),
            ("code", ["df = pd.read_csv('https://drive.google.com/uc?id=FILE1234567890abcdefghij')"]),
            ("markdown", ["ghi chú"]),
            ("code", ["!gdown --id FILE1234567890abcdefghij"]),
        ],
        [OFFICIAL_FILE],
    )
    assert mentions == [ResourceMention(label="Dataset BTC", cells=[2, 4])]


def test_resource_scan_skips_markdown_cells_and_unconfigured_drive_links():
    mentions = scan(
        [
            ("markdown", ["https://drive.google.com/file/d/FILE1234567890abcdefghij/view"]),
            ("code", ["df = pd.read_csv('https://drive.google.com/uc?id=OTHER1234567890abcdefghij')"]),
        ],
        [OFFICIAL_FILE],
    )
    assert mentions == []


def test_resource_scan_returns_empty_when_no_code_cell_mentions_a_resource():
    assert scan([("code", ["print('hi')"])], [OFFICIAL_FILE]) == []


def test_resource_scan_ignores_short_bare_id_substrings():
    short = {"label": "Ngắn", "url": "https://drive.google.com/file/d/SHORTID/view"}
    mentions = scan(
        [
            ("code", ["x = 'https://drive.google.com/file/d/SHORTID/view'"]),
            ("code", ["print('SHORTID')"]),
        ],
        [short],
    )
    assert mentions == [ResourceMention(label="Ngắn", cells=[1])]
