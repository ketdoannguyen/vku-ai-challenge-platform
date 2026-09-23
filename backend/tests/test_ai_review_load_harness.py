"""Test phần **thuần** của harness tải: dữ liệu sinh ra, phép đếm, cổng go/no-go.

Không case nào ở đây gọi mạng, Mongo hay provider. Phần chạy thật chỉ chứng minh được bằng một
chiến dịch thật, còn những thứ dễ sai âm thầm thì phải khoá lại ở đây: notebook PHẢI khác bytes
giữa các người dùng (nếu không, cache biến 60 lượt gọi provider thành 1 lượt gọi + 59 cache hit và
phép đo tải mất hết ý nghĩa), hai file CSV phải khớp đúng tập ID, và một lượt hỏng phải làm cổng
gãy chứ không được lặng lẽ thành ĐẠT.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "ai_review_load.py"


def _load_harness():
    """Nạp script theo đường dẫn: nó là công cụ vận hành, không phải module của `app`."""
    spec = importlib.util.spec_from_file_location("ai_review_load_harness", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    # `@dataclass` tra ngược `sys.modules[cls.__module__]`; thiếu dòng này thì exec nổ ở decorator.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


harness = _load_harness()

TAG = "stage60-20260923"


# --- bản ghi mẫu ---------------------------------------------------------------------------


def _submit(user: int, *, status: int = 201, error_code: str | None = None,
            created_at: str = "2026-09-23T10:00:00.000000Z") -> dict:
    return {
        "kind": "submit", "user": user, "status": status, "error_code": error_code,
        "submission_id": f"sub-{user}" if status == 201 else None,
        "created_at": created_at if status == 201 else None, "latency_ms": 250.0, "at": 0.0,
    }


def _terminal(user: int, *, status: str = "COMPLETED", verdict: str = "CLEAR",
              source: str = "PROVIDER", error_code: str | None = None,
              completed_at: str = "2026-09-23T10:00:30.000000Z") -> dict:
    return {
        "kind": "terminal", "user": user, "status": status, "verdict": verdict,
        "source": source, "duration_ms": 9000, "generation": 1,
        "completed_at": completed_at, "error_code": error_code, "at": 0.0,
    }


def _clean_records(users: int) -> list[dict]:
    """Một lượt chạy sạch: mỗi người đăng nhập, nộp, rồi có một lượt AI hoàn tất từ provider."""
    records = []
    for user in range(1, users + 1):
        records.append({"kind": "login", "user": user, "status": 200, "error_code": None,
                        "latency_ms": 120.0, "at": 0.0})
        records.extend([_submit(user), _terminal(user)])
    return records


def _verification() -> dict:
    """Kết quả đọc Mongo của một lượt chạy hai người sạch sẽ."""
    return {
        "submissions": 2, "jobs": 2, "job_status": {"COMPLETED": 2},
        "jobs_left": [], "audit_rows": 2, "completed_audits": 2,
        "submissions_with_failed_audit": [], "tokens_prompt": 1000, "tokens_completion": 500,
        "tokens_total": 1500,
        "review_duration_ms": {"p50": 9000.0, "p95": 9000.0, "p99": 9000.0, "max": 9000.0},
        "provider_hosts": 1,
    }


# --- dữ liệu sinh tại chỗ -------------------------------------------------------------------


def test_notebook_khac_bytes_giua_cac_nguoi_dung_nhung_on_dinh_cho_tung_nguoi():
    """Cache của AI review khoá theo sha256 notebook: trùng bytes là trùng lượt gọi provider."""
    hashes = {user: hashlib.sha256(harness.notebook_bytes(TAG, user)).hexdigest()
              for user in range(1, 61)}
    assert len(set(hashes.values())) == 60
    assert harness.notebook_bytes(TAG, 7) == harness.notebook_bytes(TAG, 7)


def test_notebook_la_ipynb_hop_le_va_khac_nhau_giua_hai_run_tag():
    for user in (1, 42):
        payload = json.loads(harness.notebook_bytes(TAG, user))
        assert payload["nbformat"] == 4
        assert payload["cells"], "notebook rỗng sẽ bị validate_notebook từ chối"
        assert {cell["cell_type"] for cell in payload["cells"]} == {"markdown", "code"}
    assert harness.notebook_bytes(TAG, 1) != harness.notebook_bytes("stage30-20260923", 1)


def test_ground_truth_va_prediction_khop_dung_tap_id_va_nam_trong_tap_nhan():
    """Lệch một ID là `SUBMISSION_ID_MISMATCH`, và mọi lượt nộp sẽ hỏng ở bước chấm điểm."""
    truth = _rows(harness.ground_truth_csv(TAG))
    for user in (1, 30, 60):
        prediction = _rows(harness.prediction_csv(TAG, user))
        assert [row[0] for row in prediction] == [row[0] for row in truth]
        assert {row[1] for row in prediction} <= {row[1] for row in truth}
    assert {row[1] for row in truth} == {"0", "1"}, "scoring binary cần đủ hai lớp"


def test_hai_nguoi_dung_khac_nhau_nop_hai_bai_khac_nhau():
    assert harness.prediction_csv(TAG, 1) != harness.prediction_csv(TAG, 2)


def _rows(payload: bytes) -> list[tuple[str, str]]:
    lines = payload.decode("utf-8").strip().splitlines()
    assert lines[0] == "id,target"
    return [tuple(line.split(",")) for line in lines[1:]]


def test_account_test_dung_mien_that_de_khong_bi_tu_choi_o_buoc_tao():
    email = harness.account_email(TAG, 7)
    assert email == f"{TAG}-u007@loadtest.example.com"
    assert not email.endswith((".local", ".test", ".invalid"))


# --- số liệu -------------------------------------------------------------------------------


def test_percentile_lay_gia_tri_that_da_do_khong_noi_suy():
    assert harness.percentile([10, 20, 30, 40], 50) == 20
    assert harness.percentile([10, 20, 30, 40], 95) == 40
    assert harness.percentile([10, 20, 30, 40], 100) == 40
    assert harness.percentile([], 95) is None


def test_drain_tinh_tu_dong_ho_server_chu_khong_phai_luc_quan_sat():
    """Bản ghi có `at` cố tình lệch: drain phải bỏ qua nó và dùng mốc do server cấp.

    `completed_at` của review là mốc kết thúc thật do server ghi (`process_job` cộng độ trễ đo được
    vào lúc job bắt đầu), nên phép đo không được cộng thêm `duration_ms` một lần nữa.
    """
    records = [
        _submit(user=1, created_at="2026-09-23T10:00:00.000000Z"),
        _submit(user=2, created_at="2026-09-23T10:00:02.000000Z"),
        _terminal(user=1, completed_at="2026-09-23T10:00:40.000000Z"),
        _terminal(user=2, completed_at="2026-09-23T10:01:10.000000Z"),
    ]
    summary = harness.summarize(records, expected_users=2)
    assert summary["drain_seconds"] == 70.0


def test_summary_dem_du_trung_lap_thieu_va_trang_thai_cuoi():
    records = [
        _submit(user=1),
        _submit(user=1),  # nộp hai lần: phải hiện ra thành trùng, không được cộng nhầm
        _submit(user=2),
        _submit(user=3, status=429, error_code="SUBMISSION_QUOTA_EXCEEDED"),
        _submit(user=5),
        _terminal(user=1, verdict="FLAGGED"),
        _terminal(user=2, status="FAILED", verdict="ERROR", source="PIPELINE",
                  error_code="PROVIDER_TIMEOUT"),
    ]
    summary = harness.summarize(records, expected_users=5)
    assert summary["submitted_ok"] == 4
    assert summary["duplicate_users"] == 1
    assert summary["submit_failed"] == 1
    assert summary["submit_error_codes"] == {"SUBMISSION_QUOTA_EXCEEDED": 1}
    assert summary["terminal_status"] == {"COMPLETED": 1, "FAILED": 1}
    assert summary["terminal_source"] == {"PROVIDER": 1}
    # Hai kiểu "không có mặt" khác nhau: chưa bao giờ nộp được, và nộp rồi mà chưa có kết luận.
    assert summary["missing_users"] == [3, 4]
    assert summary["not_terminal"] == [5]


# --- cổng go/no-go -------------------------------------------------------------------------


def test_mot_luot_chay_sach_dat_toan_bo_cong():
    summary = harness.summarize(_clean_records(users=3), expected_users=3)
    assert [check["ok"] for check in harness.gates(summary, expected_users=3)] == [True] * 5


@pytest.mark.parametrize(
    "records, expected, label",
    [
        ([*_clean_records(users=2), _terminal(user=1, source="CACHE")], 2,
         "Mọi lượt đi thẳng provider, không ăn cache"),
        ([*_clean_records(users=2), _terminal(user=1, status="FAILED", verdict="ERROR")], 2,
         "Mọi lượt AI hoàn tất, không verdict ERROR"),
        ([*_clean_records(users=2)[:-1]], 2, "Mọi lượt AI chạm terminal"),
        ([*_clean_records(users=2), _submit(user=1)], 2,
         "Mọi người dùng nộp đúng một lần, không bài nào thất bại"),
        ([*_clean_records(users=2), _submit(user=3, status=502, error_code="HTTP_502")], 3,
         "Không lượt nộp nào trả lỗi"),
    ],
)
def test_mot_khuyet_diem_lam_gay_dung_cong_cua_no(records, expected, label):
    """Một lượt nộp hỏng có thể gãy nhiều cổng; điều bắt buộc là cổng sở hữu nó phải gãy."""
    summary = harness.summarize(records, expected_users=expected)
    checks = {check["label"]: check for check in harness.gates(summary, expected_users=expected)}
    assert checks[label]["ok"] is False


def test_cong_mongo_bat_duoc_job_con_lai_va_luot_phai_chay_lai():
    summary = harness.summarize(_clean_records(users=2), expected_users=2)
    verification = _verification()
    assert [check["ok"] for check in harness.gates(summary, expected_users=2, verification=verification)] \
        == [True] * 9

    for field, value, label in (
        ("jobs_left", [{"job": "j1", "status": "RUNNING", "attempts": 1}],
         "Không job nào còn lại sau khi rút hết hàng đợi"),
        ("submissions_with_failed_audit", ["s1"],
         "Không lượt nào phải chạy lại (không có dòng audit thất bại)"),
        ("provider_hosts", 2, "Mọi lượt audit đều ghi về đúng một host provider"),
        ("completed_audits", 1, "Mongo có đúng số bài nộp, job và lượt audit hoàn tất"),
    ):
        broken = [
            check["label"]
            for check in harness.gates(
                summary, expected_users=2, verification=_verification() | {field: value}
            )
            if not check["ok"]
        ]
        assert broken == [label], field


def test_bao_cao_ghi_ro_cong_nao_khong_dat():
    summary = harness.summarize(
        [_submit(user=1), _terminal(user=1, source="CACHE")], expected_users=1
    )
    report = harness.render_report(
        summary, run_tag=TAG, users=1, concurrency=1, base_url="https://example.test",
        verification=None,
    )
    assert "KHÔNG ĐẠT" in report
    assert "CACHE`×1" in report


# --- đường resume --------------------------------------------------------------------------


def test_resume_giu_ban_ghi_nop_bo_ban_ghi_dang_nhap(tmp_path: Path):
    """Đăng nhập của lượt trước phải biến mất, nếu không phép đếm sẽ cộng dồn qua các lượt chạy."""
    path = tmp_path / "requests.ndjson"
    path.write_text("".join(
        json.dumps(row) + "\n"
        for row in [_clean_records(users=2)[0], *_clean_records(users=2)]
    ))

    resumed = harness._resume_filter(tmp_path)
    kinds = [row["kind"] for row in harness._load_records(tmp_path)]
    assert resumed == {1, 2}
    assert "login" not in kinds
    assert kinds.count("submit") == 2


# --- tham số dòng lệnh ---------------------------------------------------------------------


def test_stage_tu_choi_chay_khi_thieu_xac_nhan_moi_truong_that(monkeypatch):
    monkeypatch.setenv("AI_REVIEW_LOAD_PROVIDER_KEY", "sk-test")
    with pytest.raises(harness.ApiError, match="acknowledge-load-test"):
        harness.main([
            "stage", "--base-url", "https://example.test", "--run-tag", TAG,
            "--users", "5", "--email", "a@b.test", "--password", "x",
            "--ai-base-url", "https://provider.test/v1", "--ai-model", "m",
        ])


def test_stage_tu_choi_khi_thieu_hoac_lech_so_nguoi_dung():
    base = ["stage", "--base-url", "https://example.test", "--run-tag", TAG,
            "--email", "a@b.test", "--password", "x", "--dry-run"]
    with pytest.raises(harness.ApiError, match="--users"):
        harness.main([*base, "--users", "0"])
    with pytest.raises(harness.ApiError, match="--concurrency"):
        harness.main([*base, "--users", "5", "--concurrency", "6"])


@pytest.mark.parametrize("run_tag", ["UPPER", "has_underscore", "ab", "x" * 42])
def test_run_tag_sai_dinh_dang_bi_tu_choi_truoc_khi_goi_mang(run_tag):
    with pytest.raises(harness.ApiError, match="run-tag"):
        harness.main([
            "stage", "--base-url", "https://example.test", "--run-tag", run_tag,
            "--users", "1", "--email", "a@b.test", "--password", "x", "--dry-run",
        ])


def test_dry_run_khong_goi_mang(capsys):
    assert harness.main([
        "stage", "--base-url", "https://example.test", "--run-tag", TAG,
        "--users", "60", "--email", "a@b.test", "--password", "x", "--dry-run",
    ]) == 0
    assert "--dry-run" in capsys.readouterr().out
