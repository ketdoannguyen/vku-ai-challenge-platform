"""Đối chiếu URL notebook không được coi host Drive bất kỳ là tài nguyên BTC."""

import pytest

from app.ai_review.models import ModelSourceSignal
from app.ai_review.notebook import normalize_notebook
from app.ai_review.sources import ResourceMention, drive_identity, find_resource_mentions, verify_source_signals
from tests.helpers import notebook_bytes


def review(code, resources=(), *, cell=1, start_line=1, end_line=1):
    notebook = normalize_notebook(notebook_bytes(cells=[
        {"cell_type": "code", "source": [f"{line}\n" for line in code]}
    ]), max_chars=100_000)
    signal = ModelSourceSignal(cell=cell, start_line=start_line, end_line=end_line, reason="Có lệnh tải dataset")
    return verify_source_signals([signal], notebook=notebook, resources=list(resources))


def scan(cells, resources):
    notebook = normalize_notebook(notebook_bytes(cells=[
        {"cell_type": kind, "source": [f"{line}\n" for line in lines]}
        for kind, lines in cells
    ]), max_chars=100_000)
    return find_resource_mentions(notebook, list(resources))


@pytest.mark.parametrize("url", [
    "https://drive.google.com/file/d/FILE123/view",
    "https://drive.google.com/uc?export=download&id=FILE123",
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


def test_http_link_with_the_same_drive_id_is_recognized():
    signal = review(["gdown.download('http://drive.google.com/uc?id=FILE123')"], [
        {"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}
    ])[0]
    assert signal.match == "MATCHED_RESOURCE"
    assert signal.warning is False


def test_exact_file_is_not_warned():
    signals = review(["df = pd.read_csv('https://drive.google.com/uc?id=FILE123')"], [
        {"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}
    ])
    assert signals[0].match == "MATCHED_RESOURCE"
    assert signals[0].warning is False
    assert signals[0].urls[0]["resource_label"] == "Dataset"


def test_other_drive_file_is_not_automatically_official():
    signals = review(["gdown.download('https://drive.google.com/file/d/OTHER/view')"], [
        {"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}
    ])
    assert signals[0].match == "EXTERNAL_SOURCE"
    assert signals[0].warning is True


def test_shared_folder_cannot_prove_membership_of_file():
    resource = [{"label": "Folder", "url": "https://drive.google.com/drive/folders/ROOT123"}]
    assert review(["gdown.download_folder('https://drive.google.com/drive/folders/ROOT123')"], resource)[0].warning is False
    signal = review(["gdown.download('https://drive.google.com/file/d/FILE123/view')"], resource)[0]
    assert signal.match == "FOLDER_MEMBERSHIP_UNVERIFIED"
    assert signal.warning is True


def test_gdown_id_matches_official_file():
    signal = review(["gdown.download(id='FILE123')"], [
        {"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}
    ])[0]
    assert signal.warning is False


def test_gdown_folder_id_matches_official_folder():
    signal = review(["gdown.download_folder(id='ROOT123')"], [
        {"label": "Folder", "url": "https://drive.google.com/drive/folders/ROOT123"}
    ])[0]
    assert signal.match == "MATCHED_RESOURCE"
    assert signal.urls[0]["resource_label"] == "Folder"
    assert signal.warning is False


def test_local_read_and_repeated_official_url_do_not_add_warning():
    resource = [{"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}]
    code = [
        "local = pd.read_csv('train.csv')",
        "train = pd.read_csv('https://drive.google.com/uc?id=FILE123')",
        "test = pd.read_csv('https://drive.google.com/uc?id=FILE123')",
    ]
    signal = review(code, resource, end_line=len(code))[0]
    assert signal.match == "MATCHED_RESOURCE"
    assert signal.warning is False


def test_unrelated_static_api_call_does_not_downgrade_official_dataset():
    resource = [{"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}]
    code = [
        "requests.get('https://api.example.org/inference')",
        "gdown.download(id='FILE123')",
    ]
    signal = review(code, resource, end_line=len(code))[0]
    assert signal.match == "MATCHED_RESOURCE"
    assert signal.warning is False


def test_multiple_calls_do_not_hide_unverified_sources():
    signals = review([
        "gdown.download('https://drive.google.com/file/d/FILE123/view'); gdown.download(other_id)"
    ], [{"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}])
    assert signals[0].match == "UNVERIFIED_SOURCE"
    assert signals[0].warning is True


def test_non_drive_host_and_absent_resources_are_warned():
    signal = review(["df = pd.read_csv('https://data.example.org/train.csv')"])[0]
    assert signal.match == "EXTERNAL_SOURCE"
    assert signal.warning is True


def test_fake_drive_hostname_is_not_treated_as_official():
    resource = [{"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}]
    signal = review(["gdown.download('https://drive.google.com.evil.org/file/d/FILE123/view')"], resource)[0]
    assert signal.match == "EXTERNAL_SOURCE"


def test_dynamic_url_is_unverified_but_local_read_is_not_flagged():
    assert review(["df = pd.read_csv('/data/train.csv')"]) == []
    signal = review(["requests.get(dataset_url)"])[0]
    assert signal.match == "UNVERIFIED_SOURCE"
    assert signal.warning is True
    assert review(["df = pd.read_csv(dataset_url)"])[0].match == "UNVERIFIED_SOURCE"


def test_dynamic_inference_api_and_model_archive_are_not_dataset_signals():
    assert review(["requests.get(inference_api_url)"]) == []
    assert review(["requests.get('https://example.org/models/checkpoint.zip')"]) == []
    assert review(["requests.get('https://example.org/models/checkpoint.bin')"]) == []


def test_incomplete_range_does_not_include_inline_comment_url():
    resources = [{"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}]
    code = [
        "requests.get('https://drive.google.com/uc?id=FILE123', headers={  # https://outside.example/train.csv",
        "    'Authorization': token,",
        "})",
    ]
    signal = review(code, resources)[0]
    assert signal.match == "MATCHED_RESOURCE"
    assert signal.warning is False


def test_text_describing_a_download_is_not_an_id_argument():
    resources = [{"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}]
    code = [
        'notes = "example: gdown.download(id=\'OTHER\')"',
        "gdown.download(id='FILE123')",
    ]
    signal = review(code, resources, end_line=len(code))[0]
    assert signal.match == "MATCHED_RESOURCE"
    assert signal.warning is False


def test_id_text_in_another_argument_is_not_a_dataset_id():
    resource = [{"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}]
    signal = review(["gdown.download(id='FILE123', quiet='note: id=\"OTHER\"')"], resource)[0]
    assert signal.match == "MATCHED_RESOURCE"
    assert signal.warning is False


def test_gdown_cli_url_matches_official_resource():
    resource = [{"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}]
    signal = review(["!gdown https://drive.google.com/uc?id=FILE123"], resource)[0]
    assert signal.match == "MATCHED_RESOURCE"
    assert signal.warning is False


def test_gdown_cli_id_outside_resources_warns():
    signal = review(["!gdown --id OTHER123"])[0]
    assert signal.match == "EXTERNAL_SOURCE"


def test_gdown_bare_file_id_matches_official_file():
    resource = [{"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}]
    assert review(["!gdown FILE123"], resource)[0].match == "MATCHED_RESOURCE"
    assert review(["gdown.download('FILE123')"], resource)[0].match == "MATCHED_RESOURCE"


def test_gdown_cli_folder_id_matches_official_folder():
    resource = [{"label": "Folder", "url": "https://drive.google.com/drive/folders/ROOT123"}]
    assert review(["!gdown --folder --id ROOT123"], resource)[0].match == "MATCHED_RESOURCE"
    assert review(["!gdown --folder ROOT123"], resource)[0].match == "MATCHED_RESOURCE"


def test_remote_object_store_dataset_read_is_not_local():
    for code in ["pd.read_csv('s3://bucket/train.csv')", "pd.read_parquet('gs://bucket/train.parquet')",
                 "pd.read_csv('ftp://data.example.org/train.csv')"]:
        signal = review([code])[0]
        assert signal.match == "EXTERNAL_SOURCE"
        assert signal.warning is True


def test_fstring_description_does_not_count_as_download():
    assert review(['notes = f"try gdown.download(id=\'OTHER\')"']) == []
    resource = [{"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}]
    signal = review(["gdown.download(id='FILE123', note=f\"id='OTHER'\")"], resource)[0]
    assert signal.match == "MATCHED_RESOURCE"


def test_dynamic_fstring_dataset_link_is_not_silently_dropped():
    signal = review(["requests.get(f'https://data.example.org/{name}/train.csv')"])[0]
    assert signal.match == "UNVERIFIED_SOURCE"


def test_dataset_url_in_request_header_is_not_treated_as_source():
    assert review(["requests.get('https://api.example.org/inference', headers={'X-Ref': 'https://data.example.org/train.csv'})"]) == []
    signal = review(["requests.get(dataset_url, proxies={'https': 'http://127.0.0.1:8080'})"])[0]
    assert signal.match == "UNVERIFIED_SOURCE"


def test_shell_continuation_with_official_link_matches():
    resource = [{"label": "Dataset", "url": "https://drive.google.com/file/d/FILE123/view"}]
    code = ["!wget \\", "    https://drive.google.com/uc?id=FILE123"]
    signal = review(code, resource, end_line=len(code))[0]
    assert signal.match == "MATCHED_RESOURCE"


def test_local_path_argument_does_not_override_external_url_in_adjacent_call():
    code = ["pd.read_csv('/data/train.csv')", "pd.read_csv('https://data.example.org/train.csv')"]
    signal = review(code, end_line=len(code))[0]
    assert signal.match == "EXTERNAL_SOURCE"


def test_limit_and_deduplicate_id_entries():
    code = [f"gdown.download(id='OTHER{i}')" for i in range(8)]
    signal = review(code, end_line=len(code))[0]
    assert len(signal.urls) == 5


def test_markdown_comments_and_invalid_ranges_do_not_generate_warnings():
    assert review(["# wget https://outside.example/data.csv"]) == []
    assert review(["x = 1  # wget https://outside.example/data.csv"]) == []
    assert review(["df = pd.read_csv('train.csv')  # https://outside.example/data.csv"]) == []
    assert review(["!pip install gdown"]) == []
    assert review(["requests.get('https://outside.example/data.csv')"], cell=2) == []
    assert review(["requests.get('https://outside.example/data.csv')"], start_line=2) == []


def test_no_model_supplied_url_is_trusted():
    signal = review(["requests.get('https://outside.example/data.csv')"])[0]
    assert signal.urls[0]["url"] == "https://outside.example/data.csv"
    assert "requests.get" in signal.snippet


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


def test_mounted_drive_literal_path_is_flagged_not_dropped():
    code = [
        "from google.colab import drive",
        "drive.mount('/content/drive')",
        "df = pd.read_csv('/content/drive/MyDrive/Fashion/train.csv')",
    ]
    signal = review(code, end_line=len(code))[0]
    assert signal.match == "UNVERIFIED_SOURCE"
    assert signal.warning is True
