"""Unit test cho lớp artifact: SDK wrapper, đặt tên download và validate notebook.

Không dựng MinIO thật ở đây (xem Phase F cho smoke với container); fixture `fake_artifact_storage`
thay `storage._client` nên logic map lỗi và đóng connection của wrapper vẫn chạy.
"""

import pytest

from app.core.config import get_settings
from app.submission_artifacts import naming, storage, validation

# Fixture autouse thay `storage._client` bằng fake; giữ bản thật để kiểm tra guard credential.
_real_client = storage._client


def _run(coro):
    import asyncio

    return asyncio.run(coro)


# --- storage ---------------------------------------------------------------


def test_object_keys_are_built_from_immutable_ids(fake_artifact_storage):
    prefix = storage.submission_prefix("cid", "aid", "sid")
    assert prefix == "competitions/cid/accounts/aid/submissions/sid"
    assert storage.prediction_key("cid", "aid", "sid") == f"{prefix}/prediction.csv"
    assert storage.notebook_key("cid", "aid", "sid") == f"{prefix}/notebook.ipynb"


def test_put_then_get_roundtrip_closes_response(fake_artifact_storage):
    key = storage.prediction_key("cid", "aid", "sid")
    _run(storage.put_bytes(key, b"id,prediction\n", "text/csv; charset=utf-8"))
    assert fake_artifact_storage.content_types[key] == "text/csv; charset=utf-8"

    assert _run(storage.get_bytes(key, 1024)) == b"id,prediction\n"
    response = fake_artifact_storage.responses[-1]
    assert response.closed and response.released


def test_get_missing_object_raises_not_found(fake_artifact_storage):
    with pytest.raises(storage.ArtifactNotFound):
        _run(storage.get_bytes(storage.notebook_key("cid", "aid", "sid"), 1024))


def test_get_rejects_object_larger_than_limit_without_reading_all(fake_artifact_storage):
    key = storage.prediction_key("cid", "aid", "sid")
    fake_artifact_storage.objects[key] = b"x" * 4096
    with pytest.raises(storage.ArtifactStorageUnavailable):
        _run(storage.get_bytes(key, max_bytes=1024))
    # Đọc thừa đúng một byte để phát hiện vượt trần, không nạp cả object vào RAM.
    assert fake_artifact_storage.responses[-1].closed


def test_storage_errors_map_to_unavailable(fake_artifact_storage):
    fake_artifact_storage.unavailable = True
    with pytest.raises(storage.ArtifactStorageUnavailable):
        _run(storage.put_bytes("k", b"data", "text/csv"))
    with pytest.raises(storage.ArtifactStorageUnavailable):
        _run(storage.get_bytes("k", 1024))


def test_unknown_bucket_is_treated_as_upload_failure(fake_artifact_storage):
    fake_artifact_storage.bucket = "other-bucket"
    with pytest.raises(storage.ArtifactStorageUnavailable):
        _run(storage.put_bytes("k", b"data", "text/csv"))


def test_missing_credentials_are_unavailable(monkeypatch):
    """Không cấu hình app credential thì mọi call phải là 503, không phải lỗi 500 khó hiểu."""
    monkeypatch.setenv("MINIO_ACCESS_KEY", "")
    monkeypatch.setenv("MINIO_SECRET_KEY", "")
    get_settings.cache_clear()
    with pytest.raises(storage.ArtifactStorageUnavailable):
        _real_client()


def test_remove_object_and_prefix_are_best_effort(fake_artifact_storage):
    key = storage.prediction_key("cid", "aid", "sid")
    fake_artifact_storage.objects[key] = b"data"
    fake_artifact_storage.objects["competitions/cid/accounts/aid/submissions/other/x"] = b"data"

    assert _run(storage.remove_object(key)) is True
    assert key not in fake_artifact_storage.objects
    # Xoá object không tồn tại vẫn là thành công: cleanup không được che lỗi gốc của request.
    assert _run(storage.remove_object(key)) is True

    assert _run(storage.remove_prefix(storage.competition_prefix("cid"))) is True
    assert fake_artifact_storage.objects == {}

    fake_artifact_storage.unavailable = True
    assert _run(storage.remove_object("k")) is False
    assert _run(storage.remove_prefix("competitions/cid/")) is False


# --- naming ----------------------------------------------------------------


def test_download_filename_uses_sequence_number_and_sanitized_segments():
    name = naming.download_filename(
        competition_slug="vku-cup-2026",
        account_name="Đội Thi Sinh",
        account_id="507f1f77bcf86cd799439011",
        artifact=naming.PREDICTION_ARTIFACT,
        submission_id="507f1f77bcf86cd799439012",
        submission_no=7,
    )
    assert name == "vku-cup-2026_Đội-Thi-Sinh_submission-0007_prediction.csv"
    assert "__" not in name


def test_download_filename_falls_back_to_short_id_for_legacy_submissions():
    name = naming.download_filename(
        competition_slug="vku-cup-2026",
        account_name="Thi Sinh",
        account_id="507f1f77bcf86cd799439011",
        artifact=naming.NOTEBOOK_ARTIFACT,
        submission_id="507f1f77bcf86cd799439012",
        submission_no=None,
    )
    assert name.endswith("_submission-99439012_notebook.ipynb")


def test_download_filename_strips_path_traversal_from_user_controlled_parts():
    name = naming.download_filename(
        competition_slug="../../etc/passwd",
        account_name='"; rm -rf /',
        account_id="507f1f77bcf86cd799439011",
        artifact=naming.PREDICTION_ARTIFACT,
        submission_id="507f1f77bcf86cd799439012",
        submission_no=1,
    )
    assert "/" not in name and "\\" not in name and '"' not in name
    assert name == "..-..-etc-passwd_;-rm-rf_submission-0001_prediction.csv"
    assert "__" not in name


def test_download_filename_is_bounded_for_long_names():
    name = naming.download_filename(
        competition_slug="s" * 200,
        account_name="a" * 200,
        account_id="507f1f77bcf86cd799439011",
        artifact=naming.PREDICTION_ARTIFACT,
        submission_id="507f1f77bcf86cd799439012",
        submission_no=12,
    )
    assert len(name) <= 180
    assert name.endswith("_submission-0012_prediction.csv")


def test_download_filename_empty_account_name_falls_back_to_account_id():
    name = naming.download_filename(
        competition_slug="cup",
        account_name="   ",
        account_id="507f1f77bcf86cd799439011",
        artifact=naming.PREDICTION_ARTIFACT,
        submission_id="507f1f77bcf86cd799439012",
        submission_no=1,
    )
    assert name == "cup_account-99439011_submission-0001_prediction.csv"


def test_content_disposition_keeps_unicode_name_and_ascii_fallback():
    filename = "cup_Đội-Thi-Sinh_submission-0001_prediction.csv"
    header = naming.content_disposition(filename)
    assert header.startswith(
        'attachment; filename="cup-Doi-Thi-Sinh-submission-0001-prediction.csv"'
    )
    assert "filename*=UTF-8''cup_%C4%90%E1%BB%99i-Thi-Sinh_submission-0001_prediction.csv" in header
    assert "\r" not in header and "\n" not in header


def test_download_filename_never_emits_double_underscore():
    """Regression: ba dấu phân cách luôn là một `_`, kể cả khi input chứa `_`/`__`/space."""
    cases = (
        ("cup__a", "Đội__Thi_Sinh"),
        ("cup a", "đội  thi"),
        ("__cup__", "__đội__"),
        ("cup", "đội-hai"),
    )
    for slug, account in cases:
        name = naming.download_filename(
            competition_slug=slug,
            account_name=account,
            account_id="507f1f77bcf86cd799439011",
            artifact=naming.PREDICTION_ARTIFACT,
            submission_id="507f1f77bcf86cd799439012",
            submission_no=1,
        )
        assert "__" not in name, (slug, account, name)
        assert name.count("_") == 3, name
        assert name.endswith("_submission-0001_prediction.csv")


def test_content_disposition_falls_back_when_ascii_is_empty():
    header = naming.content_disposition("日本語")
    assert 'filename="submission-artifact"' in header


# --- notebook validation ---------------------------------------------------

VALID_NOTEBOOK = (
    b'{"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}'
)


def test_has_notebook_extension_is_case_insensitive():
    assert validation.has_notebook_extension("solution.IPYNB")
    assert not validation.has_notebook_extension("solution.txt")
    assert not validation.has_notebook_extension(None)


@pytest.mark.parametrize(
    "payload",
    [
        b"",
        b"not json",
        b"\xff\xfe\x00bad",
        b"[]",
        b'{"nbformat": 3, "nbformat_minor": 0, "metadata": {}, "cells": []}',
        b'{"nbformat": 4, "metadata": {}, "cells": []}',
        b'{"nbformat": 4, "nbformat_minor": true, "metadata": {}, "cells": []}',
        b'{"nbformat": 4, "nbformat_minor": 5, "cells": []}',
        b'{"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": {}}',
        b'{"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": ["x"]}',
        b'{"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [{"cell_type": "sql", "source": ""}]}',
        b'{"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [{"cell_type": "code"}]}',
        b'{"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [{"cell_type": "code", "source": [1]}]}',
    ],
)
def test_validate_notebook_rejects_malformed_payloads(payload):
    with pytest.raises(validation.NotebookValidationError) as excinfo:
        validation.validate_notebook(payload)
    assert excinfo.value.code.startswith("NOTEBOOK_")


def test_validate_notebook_accepts_v4_notebook_with_nul_free_source():
    validation.validate_notebook(VALID_NOTEBOOK)
    with_bom = b"\xef\xbb\xbf" + b'{"nbformat": 4, "nbformat_minor": 5, "metadata": {},'
    with_bom += b' "cells": [{"cell_type": "markdown", "source": ["# a", "# b"]}]}'
    validation.validate_notebook(with_bom)
