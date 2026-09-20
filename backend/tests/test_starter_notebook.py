"""Notebook khung dùng chung: tải công khai, đúng header và là notebook v4 hợp lệ."""

import json
from pathlib import Path

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
    # Cấu hình bài nộp, chỗ sinh dự đoán và đường ống xuất tệp.
    assert "ID_COLUMN" in code and "PREDICTION_COLUMN" in code
    assert "predictions = [0] * len(test)" in code
    assert "to_csv(OUTPUT_FILE, index=False)" in code
    # Hai bước của thí sinh nằm đúng chỗ và được đánh dấu TODO.
    assert "# 5. TIỀN XỬ LÝ DỮ LIỆU" in code
    assert "# 6. HUẤN LUYỆN MÔ HÌNH" in code
    assert "TODO" in code
    # Không phải file stub rỗng: có cả markdown hướng dẫn lẫn cell code.
    assert any(cell["cell_type"] == "markdown" for cell in notebook["cells"])


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
