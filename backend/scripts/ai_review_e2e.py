"""Chiến dịch E2E cho AI review bằng provider THẬT, chạy được lặp lại.

Mục đích: đo lại 25 notebook trong `ai_challenge_testcases_extended.zip` sau khi đổi verifier
(ADR-045) và đối chiếu với số liệu "before" của chiến dịch 2026-09-22. Không mock, không fake:
harness chỉ **gọi** hệ thống thật - admin rerun qua HTTP, `ai-review-worker` thật xử lý, provider
thật trả lời theo cấu hình LLM đang lưu trên từng cuộc thi.

Ba tầng, tách rõ để test được phần không cần mạng:

- **Đọc archive** (`read_archive`): hợp đồng kỳ vọng + SHA-256 của từng notebook.
- **Oracle** (`classify`, `summarize`, `render_report`): ánh xạ kỳ vọng sang verdict nghiêm ngặt và
  tổng hợp báo cáo.
- **Chạy** (`run`): đăng nhập admin, rerun, chờ terminal, đối chiếu SHA.

Harness **không bao giờ** đọc, in hay ghi API key: nó không biết key nằm ở đâu. Nó cũng không ghi
gì vào Mongo - mọi thay đổi trạng thái đi qua đúng endpoint admin, còn Mongo chỉ được **đọc** để
lấy SHA của artifact và `usage` (hai thứ API cố ý không trả).

    python scripts/ai_review_e2e.py --archive ../ai_challenge_testcases_extended.zip \\
        --run-tag after-adr045 --dry-run \\
        --mongo-uri "mongodb://<user>:<pass>@127.0.0.1:27018/ai_challenge?authSource=admin"

`--mongo-uri` là **bắt buộc** và cố ý không suy ra từ `.env`: cổng Mongo trong `.env` là cổng
trong mạng Compose (`mongo:27017`), còn chạy harness từ host thì phải qua một cổng forward riêng -
suy diễn sai ở đây nghĩa là đọc nhầm sang một môi trường khác.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path

import httpx
import pymongo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.ai_review import constants, service  # noqa: E402

FAIL = "FAIL"
PASS = "PASS"

#: Ánh xạ nghiêm ngặt: chỉ `FLAGGED` mới là "phát hiện vi phạm", chỉ `CLEAR` mới là "sạch".
#: `INCONCLUSIVE` **không** được tính là đúng cho một case FAIL - nó là chỗ mà verifier cũ trốn
#: tránh, và đếm nó là đúng sẽ che mất đúng cái lỗi mà đợt này đi sửa.
STRICT_VERDICT = {FAIL: "FLAGGED", PASS: "CLEAR"}

#: Sáu version phải có mặt trên mọi lượt mới; thiếu một cái nghĩa là worker đang chạy image cũ.
EXPECTED_VERSIONS = {
    "prompt": constants.PROMPT_VERSION,
    "normalization": constants.NORMALIZATION_VERSION,
    "context_policy": constants.CONTEXT_POLICY_VERSION,
    "canonicalization": constants.CANONICALIZATION_VERSION,
    "rule_ref": constants.RULE_REF_VERSION,
    "verifier": constants.VERIFIER_VERSION,
}

EXPECTED_CASES = 25
_ARCHIVE_ROOT = "ai_challenge_testcases"
_CASE_DIR_RE = re.compile(r"^competition_(?P<letter>[A-Z])_")


@dataclass(frozen=True)
class Case:
    """Một notebook trong archive, kèm hợp đồng kỳ vọng của nó."""

    letter: str
    rules_file: str
    notebook_name: str
    notebook_sha256: str
    expected: str

    @property
    def case_id(self) -> str:
        return f"{self.letter}/{self.notebook_name}"


@dataclass(frozen=True)
class Row:
    """Kết quả một case. Trường cố định, nên không có đường lọt văn bản model vào báo cáo."""

    case: Case
    status: str
    verdict: str
    model_verdict: str | None
    source: str | None
    provider_host: str | None
    model: str | None
    versions: tuple[tuple[str, str | None], ...]
    manual: bool
    bypass_cache: bool
    generation: int | None
    archive_sha: str
    submission_sha: str | None
    review_sha: str | None
    downgrade_codes: tuple[str, ...]
    findings_total: int
    findings_traceable: int
    findings_unresolved: int
    resolutions: tuple[tuple[str, int], ...]
    verification_codes: tuple[str, ...]
    truncated: bool
    duration_ms: int | None
    total_tokens: int | None
    error_code: str | None = None

    @property
    def version_mismatch(self) -> bool:
        """Đúng sáu version, đúng giá trị - lượt chạy bằng image/worker khác bị bắt ở đây."""
        return dict(self.versions) != EXPECTED_VERSIONS

    @property
    def sha_chain_ok(self) -> bool:
        """Chuỗi bytes archive → artifact đã nộp → notebook mà audit row ghi là đã gửi model.

        Mắt xích thứ nhất (`submission_sha`) do bước khớp SHA bảo đảm, nên nó là một khẳng định
        chứ không phải một phép đo. Mắt xích thứ hai (`review_sha`) mới là phép đo thật: nó đọc
        `notebook_sha256` mà worker đã ghi vào audit row, và đó là thứ duy nhất chứng minh model
        đã đọc **đúng** file này chứ không phải một bản khác.
        """
        return self.submission_sha == self.archive_sha and self.review_sha == self.archive_sha


@dataclass(frozen=True)
class Target:
    """Case đã khớp được với một bài nộp thật trên hệ thống."""

    case: Case
    competition_slug: str
    submission_id: str
    submission_no: int | None
    submission_sha: str | None
    last_generation: int | None


# --------------------------------------------------------------------------------------------
# Tầng đọc archive
# --------------------------------------------------------------------------------------------


def read_archive(path: Path) -> tuple[Case, ...]:
    """Đọc `expected_results.json` + SHA của từng notebook; không giải nén ra đĩa."""
    cases: list[Case] = []
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        for directory in _case_directories(names):
            letter = _CASE_DIR_RE.match(Path(directory).name).group("letter")
            contract = json.loads(archive.read(f"{directory}/expected_results.json"))
            for entry in contract["notebook_cases"]:
                raw = archive.read(f"{directory}/{entry['file']}")
                cases.append(
                    Case(
                        letter=letter,
                        rules_file=f"{directory}/{contract['rules_file']}",
                        notebook_name=entry["file"].split("/")[-1],
                        notebook_sha256=hashlib.sha256(raw).hexdigest(),
                        expected=entry["expected"],
                    )
                )
    return tuple(cases)


def _case_directories(names: list[str]) -> list[str]:
    """Thư mục `competition_<L>_*` có `expected_results.json`, theo thứ tự chữ cái."""
    found = {
        name.rsplit("/", 1)[0]
        for name in names
        if name.endswith("/expected_results.json")
        and _CASE_DIR_RE.match(Path(name.rsplit("/", 1)[0]).name)
    }
    return sorted(found)


# --------------------------------------------------------------------------------------------
# Tầng oracle: chỉ số, không văn bản tự do
# --------------------------------------------------------------------------------------------


def classify(expected: str, verdict: str) -> str:
    """`CORRECT` / `WRONG` theo ánh xạ nghiêm ngặt ở `STRICT_VERDICT`."""
    return "CORRECT" if verdict == STRICT_VERDICT.get(expected) else "WRONG"


def summarize(rows: list[Row]) -> dict:
    """Gộp các `Row` thành số liệu báo cáo; không trích câu chữ nào của model."""
    expected_fail = [row for row in rows if row.case.expected == FAIL]
    expected_pass = [row for row in rows if row.case.expected == PASS]

    downgrades: dict[str, int] = {}
    codes: dict[str, int] = {}
    resolutions: dict[str, int] = {}
    for row in rows:
        if row.model_verdict == "FLAGGED" and row.verdict != "FLAGGED":
            downgrades[row.case.case_id] = row.findings_total
        for code in row.downgrade_codes:
            codes[code] = codes.get(code, 0) + 1
        for name, count in row.resolutions:
            resolutions[name] = resolutions.get(name, 0) + count

    return {
        "cases": len(rows),
        "terminal": sum(1 for row in rows if row.status == "COMPLETED"),
        "errors": sum(1 for row in rows if row.status != "COMPLETED"),
        "from_provider": sum(1 for row in rows if row.source == "PROVIDER"),
        "from_cache": sum(1 for row in rows if row.source == "CACHE"),
        "manual": sum(1 for row in rows if row.manual and row.bypass_cache),
        "final_correct": sum(
            1 for row in rows if classify(row.case.expected, row.verdict) == "CORRECT"
        ),
        "model_correct": sum(
            1
            for row in rows
            if row.model_verdict and classify(row.case.expected, row.model_verdict) == "CORRECT"
        ),
        "confusion": _confusion(rows),
        "expected_fail": len(expected_fail),
        "expected_pass": len(expected_pass),
        "fail_flagged": sum(1 for row in expected_fail if row.verdict == "FLAGGED"),
        "pass_not_clear": sum(1 for row in expected_pass if row.verdict != "CLEAR"),
        "pass_flagged": sorted(
            row.case.case_id for row in expected_pass if row.verdict == "FLAGGED"
        ),
        "downgraded": len(downgrades),
        "downgraded_cases": sorted(downgrades),
        "flagged_without_traceable": sorted(
            row.case.case_id for row in rows if row.verdict == "FLAGGED" and not row.findings_traceable
        ),
        "traceable_rows": sum(1 for row in rows if row.findings_traceable > 0),
        "findings_total": sum(row.findings_total for row in rows),
        "findings_traceable": sum(row.findings_traceable for row in rows),
        "findings_unresolved": sum(row.findings_unresolved for row in rows),
        "resolutions": resolutions,
        "downgrade_codes": codes,
        "verification_codes": _tally(row.verification_codes for row in rows),
        "sha_chain_broken": sorted(row.case.case_id for row in rows if not row.sha_chain_ok),
        "version_mismatch": sorted(row.case.case_id for row in rows if row.version_mismatch),
        "truncated": sorted(row.case.case_id for row in rows if row.truncated),
        "wrong_cases": sorted(
            row.case.case_id for row in rows if classify(row.case.expected, row.verdict) == "WRONG"
        ),
        "error_codes": _tally(
            (row.error_code,) if row.error_code else () for row in rows
        ),
        "duration_ms_total": sum(row.duration_ms or 0 for row in rows),
        "duration_ms_max": max((row.duration_ms or 0 for row in rows), default=0),
        "tokens_total": sum(row.total_tokens or 0 for row in rows),
        "versions": _versions(rows),
    }


def _confusion(rows: list[Row]) -> dict[str, dict[str, int]]:
    table: dict[str, dict[str, int]] = {}
    for row in rows:
        table.setdefault(row.case.expected, {})
        table[row.case.expected][row.verdict] = table[row.case.expected].get(row.verdict, 0) + 1
    return table


def _tally(groups) -> dict[str, int]:
    counts: dict[str, int] = {}
    for group in groups:
        for item in group:
            counts[item] = counts.get(item, 0) + 1
    return counts


def _versions(rows: list[Row]) -> dict[str, list[str]]:
    """Version nào đã thực sự được ghi - phát hiện worker còn là image cũ."""
    seen: dict[str, set[str]] = {}
    for row in rows:
        for name, value in row.versions:
            if value is not None:
                seen.setdefault(name, set()).add(value)
    return {name: sorted(values) for name, values in sorted(seen.items())}


def render_report(summary: dict, *, run_tag: str, archive: Path) -> str:
    """Báo cáo markdown từ `summary`: chỉ số và tên case, không prose của model."""
    columns = _verdict_columns(summary)
    lines = [
        f"# Chiến dịch E2E AI review (Hybrid B+D) - `{run_tag}`",
        "",
        f"- Archive: `{archive.name}`",
        f"- Case chạy: **{summary['cases']}** · terminal **{summary['terminal']}** · lỗi **{summary['errors']}**",
        f"- Nguồn: **{summary['from_provider']}** từ provider · **{summary['from_cache']}** từ cache · "
        f"**{summary['manual']}** lượt manual có bypass cache",
        "",
        "## Kết luận cuối so với ground truth",
        "",
        "| Chỉ số | Số case |",
        "|---|---|",
        f"| Đúng (ánh xạ nghiêm ngặt) | **{summary['final_correct']}/{summary['cases']}** |",
        f"| Đúng theo kết luận thô của model | {summary['model_correct']}/{summary['cases']} |",
        f"| Case FAIL ra `FLAGGED` | {summary['fail_flagged']}/{summary['expected_fail']} |",
        f"| Case PASS ra `CLEAR` | {summary['expected_pass'] - summary['pass_not_clear']}/{summary['expected_pass']} |",
        f"| Bị hạ cấp (model nói FLAGGED, cuối cùng không phải) | {summary['downgraded']} |",
        "",
        "### Ma trận nhầm lẫn",
        "",
        "| Kỳ vọng \\ Kết luận | " + " | ".join(columns) + " |",
        "|---|" + "---|" * len(columns),
    ]
    for expected in (FAIL, PASS):
        cells = summary["confusion"].get(expected, {})
        lines.append(
            f"| {expected} | " + " | ".join(str(cells.get(name, 0)) for name in columns) + " |"
        )

    lines += [
        "",
        "## Finding và hậu kiểm",
        "",
        f"- Finding: **{summary['findings_total']}** · `traceable` **{summary['findings_traceable']}** · "
        f"không đối chiếu được quy định **{summary['findings_unresolved']}**",
        f"- Cách resolve: {_inline(summary['resolutions'])}",
        f"- Mã hạ cấp ở mức lượt: {_inline(summary['downgrade_codes'])}",
        f"- Mã hậu kiểm ở mức finding: {_inline(summary['verification_codes'])}",
        f"- Mã lỗi lượt: {_inline(summary['error_codes'])}",
        f"- Version ghi trong audit row: {_inline({k: v[0] for k, v in summary['versions'].items()})}",
        "",
        "## Cổng bắt buộc",
        "",
        "| Cổng | Kết quả |",
        "|---|---|",
        _gate("Không case nào lỗi", summary["errors"] == 0, summary["error_codes"]),
        _gate(
            "Mọi lượt tới từ provider, không phải cache",
            summary["from_cache"] == 0 and summary["from_provider"] == summary["cases"],
            {"provider": summary["from_provider"], "cache": summary["from_cache"]},
        ),
        _gate("Không case PASS nào bị `FLAGGED`", not summary["pass_flagged"], summary["pass_flagged"]),
        _gate(
            "Mọi `FLAGGED` có ít nhất một finding `traceable`",
            not summary["flagged_without_traceable"],
            summary["flagged_without_traceable"],
        ),
        _gate(
            "Chuỗi SHA archive = submission = audit row khớp",
            not summary["sha_chain_broken"],
            summary["sha_chain_broken"],
        ),
        _gate("Sáu version đúng trên mọi lượt", not summary["version_mismatch"], summary["version_mismatch"]),
        _gate("Không notebook nào bị cắt", not summary["truncated"], summary["truncated"]),
        "",
        f"- Thời gian chạy: tổng {summary['duration_ms_total'] / 1000:.1f}s · "
        f"lâu nhất {summary['duration_ms_max'] / 1000:.1f}s",
        f"- Token: {summary['tokens_total']}",
    ]
    if summary["wrong_cases"]:
        lines += ["", f"- Case sai: {', '.join(summary['wrong_cases'])}"]
    return "\n".join(lines) + "\n"


def _gate(label: str, ok: bool, detail) -> str:
    if ok:
        return f"| {label} | ĐẠT |"
    if isinstance(detail, dict):
        rendered = ", ".join(f"{name}={value}" for name, value in sorted(detail.items()))
    elif isinstance(detail, list):
        rendered = ", ".join(detail) or "có"
    else:
        rendered = str(detail)
    return f"| {label} | **KHÔNG ĐẠT**: {rendered} |"


def _verdict_columns(summary: dict) -> list[str]:
    seen = {name for cells in summary["confusion"].values() for name in cells}
    return sorted(seen) or ["(chưa có)"]


def _inline(counts: dict) -> str:
    if not counts:
        return "không có"
    return " · ".join(f"`{name}`×{count}" for name, count in sorted(counts.items()))


# --------------------------------------------------------------------------------------------
# Tầng chạy: chỉ đọc Mongo, mọi thay đổi đi qua API admin
# --------------------------------------------------------------------------------------------


def discover(
    db, cases: tuple[Case, ...], *, slugs: tuple[str, ...] = ()
) -> dict[str, Target]:
    """Khớp case với bài nộp thật bằng SHA của notebook - không đoán theo slug hay thứ tự.

    Cùng một notebook có thể đã được nộp vào nhiều cuộc thi (chiến dịch cũ và chiến dịch này dùng
    chung bộ 25 file), nên một SHA khớp hai bài nộp là **lỗi dừng**, không phải chuyện chọn bừa:
    chạy nhầm cuộc thi sẽ cho ra báo cáo trước/sau so sánh hai thứ khác nhau.
    """
    query = {"slug": {"$in": list(slugs)}} if slugs else {}
    by_sha: dict[str, list[tuple[dict, dict]]] = {}
    for competition in db["competitions"].find(query):
        for submission in db["submissions"].find({"competition_id": competition["_id"]}):
            sha = _notebook_sha(submission)
            if sha:
                by_sha.setdefault(sha, []).append((competition, submission))

    targets: dict[str, Target] = {}
    missing: list[str] = []
    ambiguous: list[str] = []
    for case in cases:
        candidates = by_sha.get(case.notebook_sha256) or []
        if not candidates:
            missing.append(case.case_id)
            continue
        if len(candidates) > 1:
            ambiguous.append(
                f"{case.case_id}: " + ", ".join(c.get("slug", "?") for c, _ in candidates)
            )
            continue
        competition, submission = candidates[0]
        projection = submission.get("ai_review") or {}
        targets[case.case_id] = Target(
            case=case,
            competition_slug=competition.get("slug", ""),
            submission_id=str(submission["_id"]),
            submission_no=submission.get("submission_no"),
            submission_sha=_notebook_sha(submission),
            last_generation=projection.get("generation"),
        )
    if missing or ambiguous:
        raise SystemExit(
            _discovery_error(missing, ambiguous)
            + "\nDừng trước khi gọi provider; không tự chọn hộ."
        )
    return targets


def _notebook_sha(submission: dict) -> str | None:
    return ((submission.get("artifacts") or {}).get("notebook") or {}).get("sha256")


def _discovery_error(missing: list[str], ambiguous: list[str]) -> str:
    parts = []
    if missing:
        parts.append("Không có bài nộp nào khớp SHA:\n  " + "\n  ".join(missing))
    if ambiguous:
        parts.append(
            "Nhiều bài nộp cùng SHA, cần `--competition` để chọn:\n  " + "\n  ".join(ambiguous)
        )
    return "\n".join(parts)


class AdminApi:
    """Bọc ba endpoint admin harness được phép gọi; không endpoint nào khác."""

    def __init__(self, base_url: str, email: str, password: str, timeout: float) -> None:
        self._client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, follow_redirects=True)
        response = self._client.post(
            "/api/auth/login", json={"identifier": email, "password": password}
        )
        if response.status_code != 200:
            raise SystemExit(f"Đăng nhập admin thất bại (HTTP {response.status_code}).")
        account = response.json()
        if account.get("role") != "admin":
            raise SystemExit("Tài khoản đăng nhập không phải admin.")

    def close(self) -> None:
        self._client.close()

    def detail(self, submission_id: str) -> dict:
        response = self._client.get(f"/api/admin/submissions/{submission_id}/ai-review")
        response.raise_for_status()
        return response.json()

    def rerun(self, submission_id: str) -> str:
        """Trả `""` khi đã bắt đầu, hoặc mã lỗi khi lượt cũ còn đang chiếm chỗ."""
        response = self._client.post(f"/api/admin/submissions/{submission_id}/ai-review/rerun")
        if response.status_code == 200:
            return ""
        try:
            return response.json().get("code") or f"HTTP_{response.status_code}"
        except ValueError:
            return f"HTTP_{response.status_code}"


def wait_for_terminal(
    api: AdminApi,
    target: Target,
    *,
    after_review_id: str | None,
    timeout: float,
    interval: float = 3.0,
) -> tuple[dict | None, str | None]:
    """Chờ audit row **mới** đi tới terminal. Trả `(detail, error_code)`."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        detail = api.detail(target.submission_id)
        history = detail.get("history") or []
        latest = history[0] if history else None
        if latest and latest.get("id") != after_review_id:
            if latest.get("status") in ("COMPLETED", "FAILED"):
                error = latest.get("error") or {}
                return detail, (None if latest["status"] == "COMPLETED" else error.get("code") or "FAILED")
        time.sleep(interval)
    return None, "HARNESS_TIMEOUT"


def _findings_rollup(findings: list[dict]) -> tuple[int, int, int, tuple[tuple[str, int], ...], tuple[str, ...]]:
    traceable = sum(1 for item in findings if item.get("traceable"))
    unresolved = sum(
        1 for item in findings if item.get("rule_resolution") == constants.RULE_RESOLUTION_UNRESOLVED
    )
    resolutions = _tally((item.get("rule_resolution"),) for item in findings if item.get("rule_resolution"))
    codes = _tally(item.get("verification_codes") or () for item in findings)
    return len(findings), traceable, unresolved, tuple(sorted(resolutions.items())), tuple(sorted(codes))


def build_row(target: Target, detail: dict, mongo_row: dict | None, *, archive_sha: str) -> Row:
    """Gộp payload API (đã che) với hai thứ chỉ Mongo có: `usage` và `notebook_sha256`."""
    latest = (detail.get("history") or [None])[0] or {}
    findings = latest.get("findings") or []
    total, traceable, unresolved, resolutions, codes = _findings_rollup(findings)
    versions = latest.get("versions") or {}
    usage = (mongo_row or {}).get("usage") or {}
    return Row(
        case=target.case,
        status=latest.get("status", "MISSING"),
        verdict=latest.get("verdict") or "MISSING",
        model_verdict=latest.get("model_verdict"),
        source=latest.get("source"),
        provider_host=latest.get("provider_host"),
        model=latest.get("model"),
        versions=tuple(sorted((name, versions.get(name)) for name in EXPECTED_VERSIONS)),
        manual=bool(latest.get("manual")),
        bypass_cache=bool(latest.get("bypass_cache")),
        generation=latest.get("generation"),
        archive_sha=archive_sha,
        submission_sha=target.submission_sha,
        review_sha=(mongo_row or {}).get("notebook_sha256"),
        downgrade_codes=tuple(sorted(latest.get("downgrade_codes") or ())),
        findings_total=total,
        findings_traceable=traceable,
        findings_unresolved=unresolved,
        resolutions=resolutions,
        verification_codes=codes,
        truncated=bool((latest.get("notebook_stats") or {}).get("truncated")),
        duration_ms=latest.get("duration_ms"),
        total_tokens=usage.get("total_tokens"),
        error_code=(latest.get("error") or {}).get("code"),
    )


def run(args: argparse.Namespace) -> int:
    output_dir: Path = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_path = output_dir / "rows.ndjson"

    cases = read_archive(args.archive)
    if args.case:
        cases = tuple(case for case in cases if case.case_id in set(args.case))
    if args.limit:
        cases = cases[: args.limit]
    if not cases:
        raise SystemExit("Không có case nào khớp bộ lọc.")
    if not (args.case or args.limit) and len(cases) != EXPECTED_CASES:
        # Chiến dịch đầy đủ phải là 25 case; archive khác đi thì báo cáo không còn so được với "before".
        print(f"! Archive có {len(cases)} case, không phải {EXPECTED_CASES}.", flush=True)

    client = pymongo.MongoClient(args.mongo_uri, serverSelectionTimeoutMS=8000)
    db = client.get_database()
    targets = discover(db, cases, slugs=tuple(args.competition or ()))

    done = _completed_cases(raw_path) if args.resume else set()
    print(f"{len(cases)} case · đã có kết quả: {len(done)} · output {output_dir}", flush=True)

    if args.dry_run:
        for target in targets.values():
            print(
                f"  {target.case.case_id:16s} {target.case.expected:4s} "
                f"-> {target.competition_slug:26s} #{target.submission_no} "
                f"gen={target.last_generation} sha={target.case.notebook_sha256[:12]}"
            )
        print("--dry-run: chỉ kiểm prerequisite, KHÔNG gọi provider.", flush=True)
        return 0

    # Chỉ đòi credential khi thật sự gọi API: kiểm prerequisite không cần mật khẩu admin.
    args.email = args.email or _env_or_die("AI_REVIEW_E2E_ADMIN_EMAIL")
    args.password = args.password or _env_or_die("AI_REVIEW_E2E_ADMIN_PASSWORD")

    api = AdminApi(args.base_url, args.email, args.password, args.timeout)
    try:
        with raw_path.open("a") as raw_file:
            for target in targets.values():
                if target.case.case_id in done:
                    print(f"  bỏ qua (--resume): {target.case.case_id}", flush=True)
                    continue
                row = run_one(args, api, target, db, raw_file)
                print(
                    f"  {row.case.case_id:16s} {row.case.expected:4s} -> {row.verdict:12s} "
                    f"({row.findings_traceable}/{row.findings_total} traceable, {row.source})",
                    flush=True,
                )
    finally:
        api.close()

    # Tổng hợp từ đĩa chứ không từ biến trong RAM: `--resume` và lần chạy lại phải ra cùng báo cáo.
    rows = [_row_from_json(line) for line in raw_path.read_text().splitlines() if line.strip()]
    summary = summarize(rows)
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    (output_dir / "report.md").write_text(
        render_report(summary, run_tag=args.run_tag, archive=args.archive)
    )
    print(f"\nBáo cáo: {output_dir / 'report.md'}", flush=True)
    print(f"Đúng {summary['final_correct']}/{summary['cases']} · lỗi {summary['errors']}", flush=True)
    return 0 if summary["errors"] == 0 else 1


def _completed_cases(raw_path: Path) -> set[str]:
    if not raw_path.exists():
        return set()
    return {json.loads(line)["case_id"] for line in raw_path.read_text().splitlines() if line.strip()}


def run_one(args: argparse.Namespace, api: AdminApi, target: Target, db, raw_file) -> Row:
    """Một case: chạy lại qua API admin, chờ terminal, rồi ghép với hai thứ chỉ Mongo có."""
    # `latest_review_id` cũ là mốc phân biệt: lượt mới phải mang `id` khác, nếu không thì vòng poll
    # sẽ đọc nhầm chính lượt cũ và báo "xong" ngay lập tức.
    previous_id = (api.detail(target.submission_id).get("history") or [{}])[0].get("id")
    for _ in range(args.rerun_retries):
        code = api.rerun(target.submission_id)
        if not code:
            break
        if code != constants.AI_REVIEW_IN_PROGRESS:
            raise SystemExit(f"Rerun {target.case.case_id} thất bại: {code}")
        time.sleep(args.poll_interval)
    else:
        raise SystemExit(f"Rerun {target.case.case_id} không chen được chỗ sau nhiều lần thử.")

    detail, error_code = wait_for_terminal(
        api,
        target,
        after_review_id=previous_id,
        timeout=args.timeout,
        interval=args.poll_interval,
    )
    if detail is None:
        raise SystemExit(f"{target.case.case_id}: {error_code}")
    if error_code:
        print(f"  ! {target.case.case_id} terminal với lỗi {error_code}", flush=True)
    latest = (detail.get("history") or [{}])[0]
    run_id = latest.get("run_id")
    mongo_row = db[service.REVIEWS_COLLECTION].find_one({"run_id": run_id}) if run_id else None
    row = build_row(target, detail, mongo_row, archive_sha=target.case.notebook_sha256)
    raw_file.write(_row_to_line(row) + "\n")
    raw_file.flush()
    return row


def _row_to_line(row: Row) -> str:
    """Dạng trên đĩa của một dòng: đây là thứ `_row_from_json` đọc lại, nên hai hàm đi thành cặp."""
    return json.dumps({
        "case_id": row.case.case_id,
        "expected": row.case.expected,
        "status": row.status,
        "verdict": row.verdict,
        "model_verdict": row.model_verdict,
        "source": row.source,
        "model": row.model,
        "versions": dict(row.versions),
        "manual": row.manual,
        "bypass_cache": row.bypass_cache,
        "generation": row.generation,
        "archive_sha": row.archive_sha,
        "submission_sha": row.submission_sha,
        "review_sha": row.review_sha,
        "downgrade_codes": list(row.downgrade_codes),
        "findings_total": row.findings_total,
        "findings_traceable": row.findings_traceable,
        "findings_unresolved": row.findings_unresolved,
        "resolutions": dict(row.resolutions),
        "verification_codes": list(row.verification_codes),
        "truncated": row.truncated,
        "duration_ms": row.duration_ms,
        "total_tokens": row.total_tokens,
        "error_code": row.error_code,
    }, ensure_ascii=False)


def _row_from_json(line: str) -> Row:
    """Dựng lại `Row` từ **một dòng** NDJSON đã ghi trên đĩa, dùng cho `--resume` và tổng hợp lại."""
    payload = json.loads(line)
    letter, _, notebook = payload["case_id"].partition("/")
    case = Case(
        letter=letter,
        rules_file="",
        notebook_name=notebook,
        notebook_sha256=payload["archive_sha"],
        expected=payload["expected"],
    )
    return Row(
        case=case,
        status=payload["status"],
        verdict=payload["verdict"],
        model_verdict=payload["model_verdict"],
        source=payload["source"],
        provider_host=None,
        model=payload["model"],
        versions=tuple(sorted(payload["versions"].items())),
        manual=payload["manual"],
        bypass_cache=payload["bypass_cache"],
        generation=payload["generation"],
        archive_sha=payload["archive_sha"],
        submission_sha=payload["submission_sha"],
        review_sha=payload["review_sha"],
        downgrade_codes=tuple(payload["downgrade_codes"]),
        findings_total=payload["findings_total"],
        findings_traceable=payload["findings_traceable"],
        findings_unresolved=payload["findings_unresolved"],
        resolutions=tuple(sorted(payload["resolutions"].items())),
        verification_codes=tuple(payload["verification_codes"]),
        truncated=payload["truncated"],
        duration_ms=payload["duration_ms"],
        total_tokens=payload["total_tokens"],
        error_code=payload["error_code"],
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Chiến dịch E2E AI review bằng provider thật.")
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--run-tag", required=True)
    parser.add_argument("--base-url", default="http://localhost:8080")
    parser.add_argument(
        "--mongo-uri",
        required=True,
        help="URI Mongo chỉ để ĐỌC (SHA artifact + usage). Bắt buộc, và phải trỏ đúng stack đang đo.",
    )
    parser.add_argument("--email", default=None, help="mặc định $AI_REVIEW_E2E_ADMIN_EMAIL")
    parser.add_argument("--password", default=None, help="mặc định $AI_REVIEW_E2E_ADMIN_PASSWORD")
    parser.add_argument("--case", action="append", default=None, help="chỉ chạy case này, ví dụ C/case_01.ipynb")
    parser.add_argument(
        "--competition",
        action="append",
        default=None,
        help="giới hạn ở slug cuộc thi này; bắt buộc khi một notebook đã nộp vào nhiều cuộc thi",
    )
    parser.add_argument("--limit", type=int, default=None, help="chạy N case đầu (smoke)")
    parser.add_argument("--resume", action="store_true", help="bỏ qua case đã có trong rows.ndjson")
    parser.add_argument("--dry-run", action="store_true", help="chỉ kiểm prerequisite, không gọi provider")
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--timeout", type=float, default=240.0, help="giây cho mỗi lượt review")
    parser.add_argument("--poll-interval", type=float, default=5.0)
    parser.add_argument("--rerun-retries", type=int, default=6)
    args = parser.parse_args(argv)

    args.output_dir = args.output_dir or Path(__file__).resolve().parents[2] / "data" / "ai-review-e2e" / args.run_tag
    return run(args)


def _env_or_die(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Thiếu {name}: truyền --email/--password hoặc đặt biến môi trường.")
    return value


if __name__ == "__main__":
    raise SystemExit(main())
