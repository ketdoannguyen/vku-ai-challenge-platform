"""Notebook khung dùng chung: tải công khai, đúng header và là notebook v4 hợp lệ."""

import io
import json
import shutil
import zipfile
from pathlib import Path
from types import SimpleNamespace
from urllib.request import Request

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
    # Seed thêm cho thư viện hay dùng; thiếu thư viện thì bỏ qua, không chặn notebook.
    assert "torch.manual_seed(SEED)" in code
    assert "torch.cuda.manual_seed_all(SEED)" in code
    assert "tf.keras.utils.set_random_seed(SEED)" in code
    assert "except ImportError" in code
    # URL BTC do thí sinh dán, notebook thực sự tải và đọc file trong folder vừa tải.
    assert 'DATASET_URL = ""' in code
    assert "gdown" not in code  # Link BTC luôn tải trực tiếp, không còn nhánh Google Drive.
    assert "pd.read_csv(test_path)" in code
    assert "ID_COLUMN" in code and "PREDICTION_COLUMNS" in code
    assert "to_csv(OUTPUT_FILE, index=False)" in code
    assert "predictions = [0] * len(test)" not in code
    assert "model is None" not in code
    # Link ngoài Drive tải trực tiếp; nhiều host chặn UA mặc định của Python bằng 403.
    assert "from urllib.request import Request, urlopen" in code
    assert 'headers={"User-Agent": "Mozilla/5.0"}' in code
    # Tệp .zip nhận diện bằng đuôi hoặc bằng nội dung; tệp tải về đổi tên kèm đuôi trước khi
    # giải nén để không trùng thư mục/tệp gốc bên trong zip.
    assert "zipfile.is_zipfile(archive)" in code
    assert 'archive.rename(archive.with_name(archive.name + ".zip"))' in code
    # Đọc thử tệp Train trong chính bộ dữ liệu vừa tải; thiếu thì in nhắc, không chặn.
    assert 'TRAIN_FILE = "train.csv"' in code
    assert "train = pd.read_csv(train_files[0])" in code
    assert "bỏ qua đọc Train" in code
    # Kích thước mô hình: một hàm dùng chung hai nhánh PyTorch/TensorFlow, lời gọi để comment.
    assert "# 7. KÍCH THƯỚC MÔ HÌNH" in code
    assert "p.numel() for p in model.parameters()" in code
    assert "count_params()" in code
    assert "# model_size(model)" in code
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


def _download_namespace(url, *, pd, urlopen, **extra):
    return {
        "DATASET_URL": url,
        "TEST_FILE": "test.csv",
        "TRAIN_FILE": "train.csv",
        "Path": Path,
        "Request": Request,
        "shutil": shutil,
        "urlopen": urlopen,
        "zipfile": zipfile,
        "pd": pd,
        **extra,
    }


def test_download_cell_fetches_a_plain_link_and_reads_the_fresh_file(client, tmp_path, monkeypatch):
    """Link ngoài Drive (S3, máy chủ riêng): tải trực tiếp, không cần gdown."""
    monkeypatch.chdir(tmp_path)
    code = "".join(client.get(URL).json()["cells"][3]["source"])
    url = "https://bucket.s3.amazonaws.com/btc/test.csv?X-Amz-Signature=abc"
    calls = []
    test_path = Path("dataset_btc") / "test.csv"

    def urlopen(request, timeout=None):
        calls.append((request, timeout))
        return io.BytesIO(b"id,feature\n1,2\n")

    class PandasStub:
        @staticmethod
        def read_csv(path):
            assert Path(path) == test_path
            assert calls  # Không thể đọc CSV cục bộ nếu chưa tải từ link BTC.
            return SimpleNamespace(shape=(1, 2), head=lambda: None)

    exec(code, _download_namespace(url, pd=PandasStub, urlopen=urlopen))
    assert test_path.read_text() == "id,feature\n1,2\n"
    [(request, timeout)] = calls
    assert request.full_url == url
    assert timeout == 120
    # Host kiểu Cloudflare chặn UA mặc định của Python (403) nên notebook phải gửi UA trình duyệt.
    assert request.get_header("User-agent") == "Mozilla/5.0"


def test_download_cell_extracts_a_zip_and_reads_both_test_and_train(client, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    code = "".join(client.get(URL).json()["cells"][3]["source"])
    archive_bytes = io.BytesIO()
    with zipfile.ZipFile(archive_bytes, "w") as archive:
        archive.writestr("btc/sub/test.csv", "id,feature\n1,2\n")
        archive.writestr("btc/train.csv", "id,feature,label\n9,9,y\n")
    payload = archive_bytes.getvalue()
    test_path = Path("dataset_btc") / "btc" / "sub" / "test.csv"
    train_path = Path("dataset_btc") / "btc" / "train.csv"
    shapes = {test_path: (1, 2), train_path: (1, 3)}

    def urlopen(request, timeout=None):
        return io.BytesIO(payload)

    class PandasStub:
        @staticmethod
        def read_csv(path):
            assert Path(path) in shapes, path
            return SimpleNamespace(shape=shapes[Path(path)], head=lambda: None)

    exec(code, _download_namespace("https://bucket.s3.amazonaws.com/btc/dataset.zip", pd=PandasStub, urlopen=urlopen))
    assert test_path.exists() and train_path.exists()
    assert not (Path("dataset_btc") / "dataset.zip").exists()  # Archive bị xoá sau khi giải nén.
    captured = capsys.readouterr().out
    assert "Đã giải nén 2 tệp vào dataset_btc/" in captured
    assert "Kích thước Test: (1, 2)" in captured
    assert "Kích thước Train: (1, 3)" in captured


def test_download_cell_detects_zip_by_content_even_when_name_collides_with_archive(
    client, tmp_path, monkeypatch
):
    """Link không đuôi `.zip` vẫn giải nén được; zip thật hay có thư mục gốc trùng tên tệp tải về."""
    monkeypatch.chdir(tmp_path)
    code = "".join(client.get(URL).json()["cells"][3]["source"])
    archive_bytes = io.BytesIO()
    with zipfile.ZipFile(archive_bytes, "w") as archive:
        archive.writestr("dataset/test.csv", "id,feature\n1,2\n")
        archive.writestr("dataset/train.csv", "id,feature,label\n9,9,y\n")
        archive.writestr("dataset/images/1.png", b"\x89PNG")
    payload = archive_bytes.getvalue()
    shapes = {
        Path("dataset_btc") / "dataset" / "test.csv": (1, 2),
        Path("dataset_btc") / "dataset" / "train.csv": (1, 3),
    }

    def urlopen(request, timeout=None):
        return io.BytesIO(payload)

    class PandasStub:
        @staticmethod
        def read_csv(path):
            assert Path(path) in shapes, path
            return SimpleNamespace(shape=shapes[Path(path)], head=lambda: None)

    exec(
        code,
        _download_namespace("https://storage.example.com/files/dataset", pd=PandasStub, urlopen=urlopen),
    )
    assert (Path("dataset_btc") / "dataset" / "images" / "1.png").exists()
    # Tệp tải về (mọi tên) đều bị xoá sau khi giải nén, không đè lên thư mục vừa giải nén.
    assert not (Path("dataset_btc") / "dataset").is_file()
    assert not (Path("dataset_btc") / "dataset.zip").exists()


def test_download_cell_requires_the_test_file_name_from_a_plain_link(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    code = "".join(client.get(URL).json()["cells"][3]["source"])

    def urlopen(request, timeout=None):
        return io.BytesIO(b"id,feature\n1,2\n")

    with pytest.raises(AssertionError, match="cần đúng một tệp test.csv"):
        exec(
            code,
            _download_namespace(
                "https://bucket.s3.amazonaws.com/btc/khac.csv",
                pd=SimpleNamespace(read_csv=lambda path: None),
                urlopen=urlopen,
            ),
        )


def test_download_cell_skips_train_when_dataset_has_no_train_file(client, tmp_path, monkeypatch, capsys):
    """Cuộc thi chỉ có Test vẫn chạy được: thiếu tệp Train chỉ in nhắc, không assert."""
    monkeypatch.chdir(tmp_path)
    code = "".join(client.get(URL).json()["cells"][3]["source"])
    reads = []

    def urlopen(request, timeout=None):
        return io.BytesIO(b"id,feature\n1,2\n")

    class PandasStub:
        @staticmethod
        def read_csv(path):
            reads.append(Path(path))
            return SimpleNamespace(shape=(1, 2), head=lambda: None)

    namespace = _download_namespace(
        "https://bucket.s3.amazonaws.com/btc/test.csv", pd=PandasStub, urlopen=urlopen
    )
    exec(code, namespace)
    assert reads == [Path("dataset_btc") / "test.csv"]
    assert namespace["train"] is None
    assert "Không thấy tệp train.csv trong bộ dữ liệu BTC — bỏ qua đọc Train." in capsys.readouterr().out


def test_model_size_cell_prints_parameter_count_for_pytorch_and_tensorflow(client, capsys):
    notebook = client.get(URL).json()
    cell = next(
        item for item in notebook["cells"]
        if "".join(item["source"]).startswith("# 7. KÍCH THƯỚC MÔ HÌNH")
    )
    namespace: dict = {}
    exec("".join(cell["source"]), namespace)
    model_size = namespace["model_size"]

    class Param:
        def __init__(self, count):
            self._count = count

        def numel(self):
            return self._count

    class TorchLike:
        def parameters(self):
            return iter([Param(7_000_000), Param(0)])

    class KerasLike:
        def count_params(self):
            return 1_234_567

    assert model_size(TorchLike()) == 7_000_000
    assert "7,000,000 tham số (~26.7 MB float32)" in capsys.readouterr().out
    assert model_size(KerasLike()) == 1_234_567
    assert "1,234,567 tham số (~4.7 MB float32)" in capsys.readouterr().out


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
