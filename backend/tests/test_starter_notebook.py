"""Notebook khung dùng chung: tải công khai, đúng header và là notebook v4 hợp lệ."""

import io
import json
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.competitions.starter_notebook import STARTER_NOTEBOOK_FILENAME
from app.submission_artifacts.validation import validate_notebook

URL = "/api/starter-notebook"


def test_anonymous_visitor_can_download(client):
    response = client.get(URL)

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/x-ipynb+json"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "public, max-age=3600"
    assert response.headers["content-length"] == str(len(response.content))
    disposition = response.headers["content-disposition"]
    assert disposition.startswith('attachment; filename="starter-notebook.ipynb"')
    assert STARTER_NOTEBOOK_FILENAME in disposition
    # Tên tải xuống không bao giờ chứa dấu phân cách đôi.
    assert "__" not in disposition


def _code_of(notebook: dict) -> str:
    return "\n".join(
        "".join(cell["source"])
        for cell in notebook["cells"]
        if cell["cell_type"] == "code"
    )


def test_body_is_a_valid_v4_scaffold_with_imports_seed_and_student_todo_steps(client):
    body = client.get(URL).content
    assert b"\x00" not in body

    notebook = json.loads(body.decode("utf-8"))
    # Cùng validator dùng cho notebook sinh viên nộp - khung này phải qua được chính cửa đó.
    validate_notebook(body)
    assert notebook["nbformat"] == 4

    code = _code_of(notebook)
    # Bước khai báo thư viện phải có sẵn, không để thí sinh tự đoán.
    assert "import numpy as np" in code
    assert "import pandas as pd" in code
    assert "SEED = 42" in code
    assert "random.seed(SEED)" in code
    assert "np.random.seed(SEED)" in code
    # URL BTC do thí sinh dán, notebook thực sự tải và đọc file trong folder vừa tải.
    assert 'DATASET_URL = ""' in code
    assert "gdown.download_folder(DATASET_URL" in code
    assert "gdown.download(DATASET_URL" in code
    assert "fuzzy=True" not in code
    assert "resume=True" not in code  # Tránh đọc lại dữ liệu cũ khi link BTC thay đổi.
    assert "pd.read_csv(test_path)" in code
    assert "ID_COLUMN" in code and "PREDICTION_COLUMNS" in code
    assert "to_csv(OUTPUT_FILE, index=False)" in code
    assert "predictions = [0] * len(test)" not in code
    assert "model is None" not in code
    # Hai bước của thí sinh nằm đúng chỗ và được đánh dấu TODO.
    assert "# 5. TIỀN XỬ LÝ DỮ LIỆU" in code
    assert "# 6. HUẤN LUYỆN MÔ HÌNH" in code
    assert "TODO" in code
    # Không phải file stub rỗng: có cả markdown hướng dẫn lẫn cell code.
    assert any(cell["cell_type"] == "markdown" for cell in notebook["cells"])


def test_code_cells_compile_and_do_not_fill_in_student_todos(client):
    notebook = client.get(URL).json()
    cells = [cell for cell in notebook["cells"] if cell["cell_type"] == "code"]
    for cell in cells:
        code = "".join(cell["source"])
        code = "\n".join(line for line in code.splitlines() if not line.startswith("%pip "))
        compile(code, cell["id"], "exec")
    for cell in cells[4:6]:
        code = "".join(cell["source"])
        assert all(not line.strip() or line.lstrip().startswith("#") for line in code.splitlines())


@pytest.mark.parametrize(
    ("url", "download_method"),
    [
        ("https://drive.google.com/drive/folders/BTCdataset?usp=sharing", "download_folder"),
        ("https://drive.google.com/drive/u/0/folders/BTCdataset", "download_folder"),
        ("https://drive.google.com/file/d/BTCdataset/view", "download"),
    ],
)
def test_download_cell_reads_only_fresh_drive_file(client, tmp_path, monkeypatch, url, download_method):
    monkeypatch.chdir(tmp_path)
    notebook = client.get(URL).json()
    code = "".join(notebook["cells"][3]["source"])
    calls = []
    test_path = Path("dataset_btc") / "data" / "test.csv"

    def download(*args, **kwargs):
        calls.append((download_method, args, kwargs))
        test_path.parent.mkdir(parents=True, exist_ok=True)
        test_path.write_text("id,feature\n1,2\n")
        return [str(test_path)] if download_method == "download_folder" else str(test_path)

    def wrong_method(*args, **kwargs):
        pytest.fail("Notebook dùng sai phương thức tải Drive.")

    def wrong_retrieve(*args, **kwargs):
        pytest.fail("Link Google Drive phải đi qua gdown, không dùng urlretrieve.")

    class PandasStub:
        @staticmethod
        def read_csv(path):
            assert Path(path) == test_path
            assert calls  # Không thể đọc CSV cục bộ nếu chưa tải từ link BTC.
            return SimpleNamespace(shape=(1, 2), head=lambda: None)

    gdown = SimpleNamespace(download_folder=wrong_method, download=wrong_method)
    setattr(gdown, download_method, download)
    namespace = {
        "DATASET_URL": url,
        "TEST_FILE": "test.csv",
        "Path": Path,
        "gdown": gdown,
        "urlretrieve": wrong_retrieve,
        "pd": PandasStub,
    }
    exec(code, namespace)
    assert len(calls) == 1
    assert calls[0][1] == (url,)
    assert calls[0][2]["output"].startswith("dataset_btc")
    assert calls[0][0] == download_method


def _download_namespace(url, *, pd, urlretrieve, **extra):
    return {
        "DATASET_URL": url,
        "TEST_FILE": "test.csv",
        "Path": Path,
        "urlretrieve": urlretrieve,
        "pd": pd,
        **extra,
    }


def test_download_cell_fetches_a_plain_link_and_reads_the_fresh_file(client, tmp_path, monkeypatch):
    """Link ngoài Drive (S3, máy chủ riêng): tải trực tiếp bằng urlretrieve, không cần gdown."""
    monkeypatch.chdir(tmp_path)
    code = "".join(client.get(URL).json()["cells"][3]["source"])
    url = "https://bucket.s3.amazonaws.com/btc/test.csv?X-Amz-Signature=abc"
    calls = []
    test_path = Path("dataset_btc") / "test.csv"

    def urlretrieve(link, filename):
        calls.append((link, filename))
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        Path(filename).write_text("id,feature\n1,2\n")

    class PandasStub:
        @staticmethod
        def read_csv(path):
            assert Path(path) == test_path
            assert calls  # Không thể đọc CSV cục bộ nếu chưa tải từ link BTC.
            return SimpleNamespace(shape=(1, 2), head=lambda: None)

    exec(code, _download_namespace(url, pd=PandasStub, urlretrieve=urlretrieve))
    assert calls == [(url, str(test_path))]


def test_download_cell_extracts_a_zip_and_finds_the_test_file_inside(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    code = "".join(client.get(URL).json()["cells"][3]["source"])
    archive_bytes = io.BytesIO()
    with zipfile.ZipFile(archive_bytes, "w") as archive:
        archive.writestr("btc/sub/test.csv", "id,feature\n1,2\n")
        archive.writestr("btc/train.csv", "id,feature\n9,9\n")
    payload = archive_bytes.getvalue()
    test_path = Path("dataset_btc") / "btc" / "sub" / "test.csv"

    def urlretrieve(link, filename):
        Path(filename).write_bytes(payload)

    class PandasStub:
        @staticmethod
        def read_csv(path):
            assert Path(path) == test_path
            return SimpleNamespace(shape=(1, 2), head=lambda: None)

    exec(
        code,
        _download_namespace(
            "https://bucket.s3.amazonaws.com/btc/dataset.zip?X-Amz-Signature=abc",
            pd=PandasStub,
            urlretrieve=urlretrieve,
            zipfile=zipfile,
        ),
    )
    assert test_path.exists()
    assert not (Path("dataset_btc") / "dataset.zip").exists()  # Archive bị xoá sau khi giải nén.


def test_download_cell_requires_the_test_file_name_from_a_plain_link(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    code = "".join(client.get(URL).json()["cells"][3]["source"])

    def urlretrieve(link, filename):
        Path(filename).write_text("id,feature\n1,2\n")

    with pytest.raises(AssertionError, match="cần đúng một tệp test.csv"):
        exec(
            code,
            _download_namespace(
                "https://bucket.s3.amazonaws.com/btc/khac.csv",
                pd=SimpleNamespace(read_csv=lambda path: None),
                urlretrieve=urlretrieve,
            ),
        )


def test_scaffold_drops_reproducibility_checklist_and_error_table(client):
    """Hai phần này đã bị bỏ: nền tảng không kiểm chứng được nên không hứa trong khung."""
    text = json.dumps(
        json.loads(client.get(URL).content.decode("utf-8")), ensure_ascii=False
    )
    assert "Checklist tái lập kết quả" not in text
    assert "Lỗi thường gặp" not in text
    assert "PYTHONHASHSEED" not in text
    assert "pip freeze" not in text


def test_asset_lives_inside_the_package(client, monkeypatch, tmp_path):
    """Asset phải nằm trong `app/competitions/` để Dockerfile `COPY app ./app` mang theo."""
    from app.competitions import starter_notebook

    assert starter_notebook._NOTEBOOK_PATH.parent == Path(starter_notebook.__file__).parent
    assert starter_notebook._NOTEBOOK_PATH.name == "starter_notebook.ipynb"

    # Thiếu asset lúc deploy phải là lỗi rõ ràng, không phải 404 HTML của router khác.
    monkeypatch.setattr(starter_notebook, "_NOTEBOOK_PATH", tmp_path / "khong-ton-tai.ipynb")
    starter_notebook._notebook_bytes.cache_clear()
    try:
        response = client.get(URL)
    finally:
        starter_notebook._notebook_bytes.cache_clear()
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "STARTER_NOTEBOOK_MISSING"
