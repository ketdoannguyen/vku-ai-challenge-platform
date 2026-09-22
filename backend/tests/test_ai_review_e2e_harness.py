"""Test phần **thuần** của harness E2E: đọc archive, oracle và tổng hợp báo cáo.

Không case nào ở đây gọi mạng, Mongo thật hay provider - đó là chủ ý. Phần chạy thật chỉ chứng minh
được bằng một chiến dịch thật, còn những thứ dễ sai âm thầm thì phải khoá lại ở đây: ánh xạ nghiêm
ngặt (INCONCLUSIVE trên case FAIL là **sai**), chuỗi SHA ba mắt xích, và việc dừng lại khi một
notebook khớp nhiều bài nộp.

Archive trong test được **dựng tại chỗ** theo đúng cấu trúc của
`ai_challenge_testcases_extended.zip`, không sao chép archive thật vào repo.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import zipfile
from pathlib import Path

import mongomock
import pytest

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "ai_review_e2e.py"


def _load_harness():
    """Nạp script theo đường dẫn: nó là công cụ vận hành, không phải module của `app`."""
    spec = importlib.util.spec_from_file_location("ai_review_e2e_harness", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    # `@dataclass` tra ngược `sys.modules[cls.__module__]`; thiếu dòng này thì exec nổ ở decorator.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


harness = _load_harness()

FAIL = harness.FAIL
PASS = harness.PASS


def _archive(tmp_path: Path, competitions: list[tuple[str, list[tuple[str, str]]]]) -> Path:
    """Zip nhỏ đúng hình dạng archive thật: `competition_<L>_*/expected_results.json`."""
    path = tmp_path / "cases.zip"
    with zipfile.ZipFile(path, "w") as archive:
        for letter, entries in competitions:
            directory = f"ai_challenge_testcases/competition_{letter}_sample"
            archive.writestr(f"{directory}/rules.md", "## Thể lệ\n\nKhông được dùng dữ liệu ngoài.\n")
            archive.writestr(
                f"{directory}/expected_results.json",
                json.dumps(
                    {
                        "rules_file": "rules.md",
                        "notebook_cases": [
                            {"file": f"notebooks/{name}", "expected": expected}
                            for name, expected in entries
                        ],
                    }
                ),
            )
            for name, _ in entries:
                archive.writestr(f"{directory}/notebooks/{name}", f"body of {name}")
    return path


def _row(**overrides) -> harness.Row:
    """Một `Row` hợp lệ mặc định; test nào chỉ quan tâm một trường thì override đúng trường đó."""
    case = harness.Case(
        letter="A",
        rules_file="",
        notebook_name="case_01.ipynb",
        notebook_sha256="a" * 64,
        expected=FAIL,
    )
    fields = dict(
        case=case,
        status="COMPLETED",
        verdict="FLAGGED",
        model_verdict="FLAGGED",
        source="PROVIDER",
        provider_host="provider.example",
        model="some-model",
        versions=tuple(sorted(harness.EXPECTED_VERSIONS.items())),
        manual=True,
        bypass_cache=True,
        generation=2,
        archive_sha="a" * 64,
        submission_sha="a" * 64,
        review_sha="a" * 64,
        downgrade_codes=(),
        findings_total=1,
        findings_traceable=1,
        findings_unresolved=0,
        resolutions=(("REFERENCE", 1),),
        verification_codes=(),
        truncated=False,
        duration_ms=1_000,
        total_tokens=10,
    )
    fields.update(overrides)
    return harness.Row(**fields)


def _render(rows: list[harness.Row]) -> str:
    return harness.render_report(
        harness.summarize(rows), run_tag="test", archive=Path("cases.zip")
    )


# --------------------------------------------------------------------------------------------
# Đọc archive
# --------------------------------------------------------------------------------------------


def test_the_archive_reader_takes_the_contract_and_the_notebook_sha_from_the_zip(tmp_path):
    path = _archive(
        tmp_path,
        [
            ("B", [("case_01.ipynb", FAIL)]),
            ("A", [("case_01.ipynb", PASS), ("case_02.ipynb", FAIL)]),
        ],
    )

    cases = harness.read_archive(path)

    assert [case.case_id for case in cases] == ["A/case_01.ipynb", "A/case_02.ipynb", "B/case_01.ipynb"]
    assert [case.expected for case in cases] == [PASS, FAIL, FAIL]
    # SHA phải là SHA của **bytes trong zip**, vì đó là thứ đối chiếu với artifact đã nộp.
    assert cases[0].notebook_sha256 == hashlib.sha256(b"body of case_01.ipynb").hexdigest()
    assert len(cases[0].notebook_sha256) == 64


def test_the_archive_reader_ignores_directories_without_a_contract(tmp_path):
    path = tmp_path / "cases.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("ai_challenge_testcases/notes/readme.md", "không phải case")

    assert harness.read_archive(path) == ()


# --------------------------------------------------------------------------------------------
# Oracle
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("expected", "verdict", "outcome"),
    [
        (FAIL, "FLAGGED", "CORRECT"),
        (PASS, "CLEAR", "CORRECT"),
        (FAIL, "CLEAR", "WRONG"),
        (PASS, "FLAGGED", "WRONG"),
        # Đây là điểm mấu chốt của đợt này: verifier cũ trốn vào INCONCLUSIVE, nên nó phải là SAI.
        (FAIL, "INCONCLUSIVE", "WRONG"),
        (PASS, "INCONCLUSIVE", "WRONG"),
        (FAIL, "ERROR", "WRONG"),
    ],
)
def test_the_mapping_is_strict_and_inconclusive_on_a_fail_case_is_wrong(expected, verdict, outcome):
    assert harness.classify(expected, verdict) == outcome


def test_a_flagged_that_was_downgraded_is_reported_as_a_downgrade():
    rows = [
        _row(
            case=harness.Case("A", "", "case_02.ipynb", "a" * 64, FAIL),
            verdict="INCONCLUSIVE",
            findings_total=3,
        ),
        _row(),
    ]

    summary = harness.summarize(rows)

    assert summary["downgraded"] == 1
    assert summary["downgraded_cases"] == ["A/case_02.ipynb"]
    assert summary["final_correct"] == 1  # chỉ case_01 giữ được FLAGGED
    assert summary["model_correct"] == 2  # model nói đúng cả hai


def test_a_pass_case_that_comes_back_flagged_fails_the_gate():
    row = _row(
        case=harness.Case("A", "", "case_01.ipynb", "a" * 64, PASS),
        verdict="FLAGGED",
    )

    summary = harness.summarize([row])
    report = _render([row])

    assert summary["pass_flagged"] == ["A/case_01.ipynb"]
    assert summary["pass_not_clear"] == 1
    assert "Không case PASS nào bị `FLAGGED`" in report
    assert "KHÔNG ĐẠT" in report


def test_a_flagged_row_without_any_traceable_finding_fails_the_gate():
    row = _row(findings_total=2, findings_traceable=0)

    summary = harness.summarize([row])

    assert summary["flagged_without_traceable"] == ["A/case_01.ipynb"]
    assert "KHÔNG ĐẠT" in _render([row])


def test_the_sha_chain_breaks_when_the_review_hashed_a_different_notebook():
    ok = _row()
    broken = _row(review_sha="b" * 64)

    assert ok.sha_chain_ok is True
    assert broken.sha_chain_ok is False
    assert harness.summarize([ok, broken])["sha_chain_broken"] == ["A/case_01.ipynb"]
    assert "KHÔNG ĐẠT" in _render([ok, broken])


def test_a_row_that_recorded_an_older_verifier_is_flagged_as_a_version_mismatch():
    stale = _row(versions=tuple(sorted({**dict(harness.EXPECTED_VERSIONS), "verifier": "verifier-v1"}.items())))

    assert stale.version_mismatch is True
    assert harness.summarize([_row()])["version_mismatch"] == []
    assert harness.summarize([stale])["version_mismatch"] == ["A/case_01.ipynb"]


def test_the_summary_counts_codes_and_resolutions_across_findings():
    rows = [
        _row(
            downgrade_codes=("DOWNGRADE_NO_TRACEABLE_VIOLATION", "DOWNGRADE_NO_TRACEABLE_VIOLATION"),
            resolutions=(("REFERENCE", 2), ("UNRESOLVED", 1)),
            verification_codes=("EVIDENCE_INVALID",),
            findings_total=3,
            findings_traceable=2,
            findings_unresolved=1,
            duration_ms=2_000,
            total_tokens=40,
        ),
        _row(duration_ms=1_000, total_tokens=10, resolutions=(("CANONICAL_QUOTE", 1),)),
    ]

    summary = harness.summarize(rows)

    assert summary["downgrade_codes"] == {"DOWNGRADE_NO_TRACEABLE_VIOLATION": 2}
    assert summary["verification_codes"] == {"EVIDENCE_INVALID": 1}
    assert summary["resolutions"] == {"REFERENCE": 2, "UNRESOLVED": 1, "CANONICAL_QUOTE": 1}
    assert summary["duration_ms_total"] == 3_000
    assert summary["duration_ms_max"] == 2_000
    assert summary["tokens_total"] == 50


def test_an_error_row_is_counted_by_its_code_and_breaks_the_no_error_gate():
    row = _row(status="FAILED", verdict="ERROR", error_code="AI_PROVIDER_UNAVAILABLE")

    summary = harness.summarize([row])
    report = _render([row])

    assert summary["errors"] == 1
    assert summary["terminal"] == 0
    assert summary["error_codes"] == {"AI_PROVIDER_UNAVAILABLE": 1}
    assert "Không case nào lỗi" in report and "KHÔNG ĐẠT" in report


def test_the_report_survives_an_empty_row_set():
    report = _render([])

    assert "0/0" in report
    assert "(chưa có)" in report


# --------------------------------------------------------------------------------------------
# Vòng đời dữ liệu của một dòng: thứ duy nhất được phép chạm tới báo cáo
# --------------------------------------------------------------------------------------------


def test_a_row_survives_a_round_trip_through_the_raw_ndjson_file():
    row = _row(
        downgrade_codes=("DOWNGRADE_NO_TRACEABLE_VIOLATION",),
        resolutions=(("REFERENCE", 1), ("UNRESOLVED", 2)),
        verification_codes=("RULE_REF_UNKNOWN",),
        truncated=True,
        error_code=None,
    )

    # Đi qua **đúng chuỗi ký tự ghi ra đĩa**, không phải qua dict: đó là hình dạng thật của mắt xích
    # `rows.ndjson`, và là thứ `--resume` lẫn bước tổng hợp đều đọc lại.
    restored = harness._row_from_json(harness._row_to_line(row))

    # Trường không ghi ra đĩa (`provider_host`) là trường không được đọc lại; phần còn lại phải khớp.
    assert restored.case.case_id == row.case.case_id
    assert restored.verdict == row.verdict
    assert restored.versions == row.versions
    assert restored.sha_chain_ok == row.sha_chain_ok
    assert restored.version_mismatch == row.version_mismatch
    assert restored.resolutions == row.resolutions
    assert restored.verification_codes == row.verification_codes


def test_the_raw_row_carries_no_free_text_field():
    """Cố ý: hàng đợi báo cáo chỉ có số, mã và hash - không có chỗ cho câu chữ của model."""
    payload = json.loads(harness._row_to_line(_row()))

    assert set(payload) == {
        "case_id", "expected", "status", "verdict", "model_verdict", "source", "model", "versions",
        "manual", "bypass_cache", "generation", "archive_sha", "submission_sha", "review_sha",
        "downgrade_codes", "findings_total", "findings_traceable", "findings_unresolved",
        "resolutions", "verification_codes", "truncated", "duration_ms", "total_tokens", "error_code",
    }


# --------------------------------------------------------------------------------------------
# Cấu hình và khớp bài nộp
# --------------------------------------------------------------------------------------------


def test_the_cli_demands_an_explicit_mongo_uri(tmp_path):
    """Cố ý: suy từ `.env` là suy sai môi trường - cổng trong `.env` là cổng trong mạng Compose."""
    with pytest.raises(SystemExit):
        harness.main(
            [
                "--archive", str(tmp_path / "cases.zip"),
                "--run-tag", "t",
                "--dry-run",
            ]
        )


def _fake_db(competitions: list[tuple[str, list[dict]]]):
    db = mongomock.MongoClient().db
    for slug, submissions in competitions:
        competition_id = db.competitions.insert_one({"slug": slug}).inserted_id
        for submission in submissions:
            db.submissions.insert_one({"competition_id": competition_id, **submission})
    return db


def _submission(sha: str, number: int = 1) -> dict:
    return {
        "submission_no": number,
        "artifacts": {"notebook": {"sha256": sha}},
        "ai_review": {"generation": 1},
    }


def test_discovery_matches_a_case_to_a_submission_by_notebook_sha(tmp_path):
    case = harness.read_archive(_archive(tmp_path, [("A", [("case_01.ipynb", FAIL)])]))[0]
    db = _fake_db([("competition-a", [_submission(case.notebook_sha256)])])

    targets = harness.discover(db, (case,))

    target = targets["A/case_01.ipynb"]
    assert target.competition_slug == "competition-a"
    assert target.submission_no == 1
    assert target.submission_sha == case.notebook_sha256
    assert target.last_generation == 1


def test_discovery_stops_when_one_notebook_was_submitted_to_two_competitions(tmp_path):
    case = harness.read_archive(_archive(tmp_path, [("A", [("case_01.ipynb", FAIL)])]))[0]
    db = _fake_db(
        [
            ("competition-a", [_submission(case.notebook_sha256)]),
            ("competition-b", [_submission(case.notebook_sha256)]),
        ]
    )

    with pytest.raises(SystemExit) as excinfo:
        harness.discover(db, (case,))

    message = str(excinfo.value)
    assert "Nhiều bài nộp cùng SHA" in message
    assert "competition-a" in message and "competition-b" in message


def test_discovery_can_be_narrowed_to_one_competition(tmp_path):
    case = harness.read_archive(_archive(tmp_path, [("A", [("case_01.ipynb", FAIL)])]))[0]
    db = _fake_db(
        [
            ("competition-a", [_submission(case.notebook_sha256)]),
            ("competition-b", [_submission(case.notebook_sha256)]),
        ]
    )

    targets = harness.discover(db, (case,), slugs=("competition-b",))

    assert targets["A/case_01.ipynb"].competition_slug == "competition-b"


def test_discovery_stops_before_calling_the_provider_when_nothing_matches(tmp_path):
    case = harness.read_archive(_archive(tmp_path, [("A", [("case_01.ipynb", FAIL)])]))[0]
    db = _fake_db([("competition-a", [_submission("f" * 64)])])

    with pytest.raises(SystemExit) as excinfo:
        harness.discover(db, (case,))

    assert "Không có bài nộp nào khớp SHA" in str(excinfo.value)
    assert "A/case_01.ipynb" in str(excinfo.value)


def test_the_cli_refuses_to_run_without_admin_credentials(monkeypatch):
    monkeypatch.delenv("AI_REVIEW_E2E_ADMIN_EMAIL", raising=False)

    with pytest.raises(SystemExit):
        harness._env_or_die("AI_REVIEW_E2E_ADMIN_EMAIL")
