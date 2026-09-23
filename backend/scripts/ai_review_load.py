"""Harness tải cho AI review: N người dùng thật đi qua đường công khai, kết luận bằng số.

Mục đích: trả lời "60 người cùng nộp một lúc thì hệ thống chịu được không" bằng phép đo chứ không
bằng suy đoán. Harness **chỉ gọi API chính thức** - cuộc thi, account, membership, nội dung, ground
truth, cấu hình AI đều qua endpoint admin; bài nộp đi qua đúng endpoint mà thí sinh dùng. Nó không
mock gì, và chỉ ĐỌC Mongo khi có `--mongo-uri`.

Ba tầng, tách rõ để test được phần không cần mạng:

- **Dữ liệu** (`ground_truth_csv`, `prediction_csv`, `notebook_bytes`): sinh tại chỗ, tất định theo
  run-tag. Notebook phải KHÁC BYTES giữa các người dùng - cache của AI review khoá theo `sha256` của
  notebook, nên notebook giống nhau sẽ biến 60 lượt gọi provider thành 1 lượt gọi + 59 cache hit, và
  phép đo tải mất hết ý nghĩa.
- **Số liệu** (`percentile`, `summarize`, `gates`, `render_report`): thuần tuý từ danh sách bản ghi.
- **Chạy** (`stage`, `cleanup`): đăng nhập, nộp, chờ terminal, đối chiếu độc lập.

Harness không bao giờ ghi mật khẩu, session hay API key vào NDJSON, báo cáo hay log.

    export AI_REVIEW_LOAD_ADMIN_EMAIL=admin@example.com
    export AI_REVIEW_LOAD_ADMIN_PASSWORD=...
    export AI_REVIEW_LOAD_PROVIDER_KEY=...        # key provider: không bao giờ truyền qua argv
    python scripts/ai_review_load.py stage \\
        --base-url https://<host> --run-tag stage60-20260923 --users 60 \\
        --ai-base-url https://<provider>/v1 --ai-model <model> \\
        --acknowledge-load-test

Một run-tag là một cuộc thi riêng, nên các stage (1/5/15/30/60) không lẫn số đo vào nhau và mỗi
stage xoá được độc lập bằng `cleanup`. Chạy lại trên cùng run-tag là thao tác rỗng, trừ khi có
`--resume` để nộp nốt những người còn thiếu.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.ai_review import constants, queue, service as ai_service  # noqa: E402
from app.submissions.service import SUBMISSIONS_COLLECTION  # noqa: E402

#: Số dòng ground truth. Đủ lớn để việc chấm điểm là việc thật, đủ nhỏ để một lượt nộp không phải
#: chờ I/O. Không đổi giữa các stage: đổi kích thước giữa chừng là đổi luôn phép đo.
GROUND_TRUTH_ROWS = 120

#: Đuôi miền của account test. Không dùng `.local`/`.test`: email-validator từ chối domain đặc dụng,
#: nên account sẽ bị 422 ngay ở bước tạo.
ACCOUNT_DOMAIN = "loadtest.example.com"

#: Dấu nhận dạng cuộc thi do harness tạo; `cleanup` từ chối xoá cuộc thi không mang dấu này.
NAME_MARKER = "[LOAD TEST]"

#: Số request đồng thời khi hỏi trạng thái AI. Đây chỉ là quan sát viên, nên để nhỏ; mục đích là
#: vòng hỏi không kéo dài hơn nhịp hỏi.
POLL_WORKERS = 8

SLUG_PREFIX_DEFAULT = "loadtest"
_RUN_TAG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,40}$")

RULES_SLUG = "rules"

RULES_MARKDOWN = """# Thể lệ (kiểm thử tải)

## Quy định bài nộp

- Bài nộp phải là notebook chạy được từ đầu đến cuối, không có ô nào lỗi.
- Không được dùng dữ liệu ngoài bộ dữ liệu ban tổ chức cấp.
- Không được sao chép lời giải của đội khác.
- Mọi bước tiền xử lý phải nằm trong notebook, không được giấu ở file ngoài.
"""

SCORING_CONFIG = {
    "id_column": "id",
    "prediction_column": "target",
    "label_column": "target",
    "average": "binary",
    "pos_label": "1",
    "higher_is_better": True,
}


# --------------------------------------------------------------------------------------------
# Tầng dữ liệu: sinh tại chỗ, tất định theo run-tag
# --------------------------------------------------------------------------------------------


def row_id(run_tag: str, index: int) -> str:
    return f"lt-{run_tag}-{index:04d}"


def ground_truth_csv(run_tag: str) -> bytes:
    """Nhãn tất định, có đủ hai lớp và chứa `pos_label` - điều kiện bắt buộc của scoring binary."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["id", "target"])
    for index in range(1, GROUND_TRUTH_ROWS + 1):
        writer.writerow([row_id(run_tag, index), index % 2])
    return buffer.getvalue().encode("utf-8")


def prediction_csv(run_tag: str, user: int) -> bytes:
    """Cùng tập id với ground truth; mỗi người sai một tập khác nhau nên điểm không giống hệt nhau."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["id", "target"])
    for index in range(1, GROUND_TRUTH_ROWS + 1):
        label = index % 2
        if (index + user) % 11 == 0:
            label = 1 - label
        writer.writerow([row_id(run_tag, index), label])
    return buffer.getvalue().encode("utf-8")


def notebook_bytes(run_tag: str, user: int) -> bytes:
    """Notebook hợp lệ, và khác bytes với mọi người dùng khác (xem docstring module)."""
    marker = f"# {run_tag} · người dùng {user:03d}"
    payload = {
        "cells": [
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "# Bài nộp kiểm thử tải\n",
                    "\n",
                    f"Người dùng {user:03d} · {run_tag}\n",
                ],
            },
            {
                "cell_type": "code",
                "execution_count": 1,
                "metadata": {},
                "outputs": [],
                "source": [
                    marker + "\n",
                    "import pandas as pd\n",
                    "\n",
                    "df = pd.read_csv('train.csv')\n",
                ],
            },
            {
                "cell_type": "code",
                "execution_count": 2,
                "metadata": {},
                "outputs": [],
                "source": [
                    "model = df.groupby('id')['target'].mean()\n",
                    f"model = model + {user} * 0.0\n",
                    "model.to_csv('submission.csv')\n",
                ],
            },
        ],
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.12"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    return json.dumps(payload, ensure_ascii=False, indent=1).encode("utf-8")


def account_email(run_tag: str, user: int) -> str:
    return f"{run_tag}-u{user:03d}@{ACCOUNT_DOMAIN}"


def load_password(run_tag: str) -> str:
    """Mật khẩu dùng chung cho account test của một run-tag; đủ dài để qua policy, không lưu ở đâu."""
    return f"loadtest-{run_tag}-{hashlib.sha256(run_tag.encode()).hexdigest()[:12]}"


def parse_iso_z(value: str | None) -> float | None:
    """Đổi timestamp `iso_z` của API thành epoch giây; `Z` không parse được ở Python < 3.11."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# --------------------------------------------------------------------------------------------
# Tầng số liệu: thuần tuý, không I/O
# --------------------------------------------------------------------------------------------


def percentile(values: list[float], q: float) -> float | None:
    """Nearest-rank: không nội suy, nên p95 luôn là một giá trị thật đã đo."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(q / 100 * len(ordered)))
    return ordered[rank - 1]


def _tally(items) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        if item is None:
            continue
        counts[str(item)] = counts.get(str(item), 0) + 1
    return dict(sorted(counts.items()))


def _latency(values: list[float]) -> dict[str, float | None]:
    return {
        "p50": percentile(values, 50),
        "p95": percentile(values, 95),
        "p99": percentile(values, 99),
        "max": max(values) if values else None,
    }


def summarize(records: list[dict], *, expected_users: int) -> dict:
    """Gộp bản ghi NDJSON thành số liệu báo cáo. Không phụ thuộc mạng, không phụ thuộc đồng hồ."""
    logins = [row for row in records if row["kind"] == "login"]
    submits = [row for row in records if row["kind"] == "submit"]
    terminals = [row for row in records if row["kind"] == "terminal"]

    ok_submits = [row for row in submits if row["status"] == 201]
    failed_submits = [row for row in submits if row["status"] != 201]
    done = [row for row in terminals if row["status"] == constants.REVIEW_STATUS_COMPLETED]

    by_user = {row["user"]: row for row in ok_submits}
    return {
        "expected_users": expected_users,
        "login_ok": sum(1 for row in logins if row["status"] == 200),
        "login_failed": sum(1 for row in logins if row["status"] != 200),
        "login_latency_ms": _latency([row["latency_ms"] for row in logins]),
        "submitted_ok": len(ok_submits),
        "submit_failed": len(failed_submits),
        "submit_status": _tally(row["status"] for row in submits),
        "submit_error_codes": _tally(row["error_code"] for row in failed_submits),
        "submit_latency_ms": _latency([row["latency_ms"] for row in ok_submits]),
        "duplicate_users": len(ok_submits) - len(by_user),
        "missing_users": sorted(set(range(1, expected_users + 1)) - set(by_user)),
        "terminal": len(terminals),
        "terminal_status": _tally(row["status"] for row in terminals),
        "terminal_verdict": _tally(row["verdict"] for row in done),
        "terminal_source": _tally(row["source"] for row in done),
        "terminal_error_codes": _tally(row["error_code"] for row in terminals if row["error_code"]),
        "not_terminal": sorted(set(by_user) - {row["user"] for row in terminals}),
        "review_latency_ms": _latency(
            [row["duration_ms"] for row in done if row.get("duration_ms") is not None]
        ),
        "drain_seconds": _drain_seconds(ok_submits, terminals),
    }


def _drain_seconds(ok_submits: list[dict], terminals: list[dict]) -> float | None:
    """Từ lúc bài ĐẦU TIÊN được ghi tới lúc lượt AI CUỐI CÙNG kết thúc, theo đồng hồ server.

    Cả hai mốc đều do server cấp - `created_at` của submission và `completed_at` của review - nên phép
    trừ không phụ thuộc lệch đồng hồ giữa máy chạy harness và VPS, và không phụ thuộc nhịp hỏi.
    `completed_at` của review là mốc KẾT THÚC thật của lượt gọi provider (xem `process_job`), không
    phải lúc job bắt đầu được xử lý.
    """
    starts = [at for row in ok_submits if (at := parse_iso_z(row.get("created_at"))) is not None]
    ends = [at for row in terminals if (at := parse_iso_z(row.get("completed_at"))) is not None]
    if not starts or not ends:
        return None
    return round(max(ends) - min(starts), 1)


def gate(label: str, ok: bool, detail) -> dict:
    return {"label": label, "ok": bool(ok), "detail": detail}


def gates(summary: dict, *, expected_users: int, verification: dict | None = None) -> list[dict]:
    """Cổng go/no-go. Cổng tài nguyên (RAM/CPU/load) do bộ lấy mẫu trên VPS đo, không ở đây."""
    expected = summary["submitted_ok"]
    checks = [
        gate(
            "Mọi người dùng nộp đúng một lần, không bài nào thất bại",
            summary["submitted_ok"] == expected_users and summary["submit_failed"] == 0,
            {
                "nộp được": summary["submitted_ok"],
                "thất bại": summary["submit_failed"],
                "trùng": summary["duplicate_users"],
                "thiếu": summary["missing_users"],
            },
        ),
        gate(
            "Không lượt nộp nào trả lỗi",
            not summary["submit_error_codes"],
            summary["submit_error_codes"] or "không có",
        ),
        gate(
            "Mọi lượt AI chạm terminal",
            summary["terminal"] == expected,
            {"terminal": summary["terminal"], "chưa xong": summary["not_terminal"]},
        ),
        gate(
            "Mọi lượt AI hoàn tất, không verdict ERROR",
            summary["terminal_status"] == {constants.REVIEW_STATUS_COMPLETED: expected}
            and constants.VERDICT_ERROR not in summary["terminal_verdict"],
            {
                "trạng thái": summary["terminal_status"],
                "kết luận": summary["terminal_verdict"],
                "lỗi": summary["terminal_error_codes"] or "không có",
            },
        ),
        gate(
            "Mọi lượt đi thẳng provider, không ăn cache",
            summary["terminal_source"] == {constants.SOURCE_PROVIDER: expected} and expected > 0,
            summary["terminal_source"] or "chưa có",
        ),
    ]
    if verification is not None:
        checks += _verification_gates(verification, expected=expected)
    return checks


def _verification_gates(verification: dict, *, expected: int) -> list[dict]:
    """Cổng chỉ trả lời được khi đọc thẳng Mongo: nguồn sự thật độc lập với những gì API kể."""
    return [
        gate(
            "Mongo có đúng số bài nộp, job và lượt audit hoàn tất",
            verification["submissions"] == expected
            and verification["jobs"] == expected
            and verification["completed_audits"] == expected,
            {
                "submissions": verification["submissions"],
                "jobs": verification["jobs"],
                "audit hoàn tất": verification["completed_audits"],
            },
        ),
        gate(
            "Không job nào còn lại sau khi rút hết hàng đợi",
            not verification["jobs_left"],
            verification["jobs_left"] or "không có",
        ),
        gate(
            "Không lượt nào phải chạy lại (không có dòng audit thất bại)",
            not verification["submissions_with_failed_audit"],
            verification["submissions_with_failed_audit"] or "không có",
        ),
        gate(
            "Mọi lượt audit đều ghi về đúng một host provider",
            verification["provider_hosts"] == 1,
            f"{verification['provider_hosts']} host",
        ),
    ]


def render_report(summary: dict, *, run_tag: str, users: int, concurrency: int, base_url: str,
                  verification: dict | None) -> str:
    checks = gates(summary, expected_users=users, verification=verification)
    lines = [
        f"# Kiểm thử tải AI review - `{run_tag}`",
        "",
        f"- Đích: `{base_url}` · người dùng **{users}** · nộp song song **{concurrency}**",
        f"- Nộp thành công **{summary['submitted_ok']}/{users}** · thất bại "
        f"**{summary['submit_failed']}** · trùng **{summary['duplicate_users']}**",
        f"- Đăng nhập: **{summary['login_ok']}** thành công / "
        f"**{summary['login_failed']}** thất bại",
        "",
        "## Độ trễ (ms)",
        "",
        "| Chặng | p50 | p95 | p99 | max |",
        "|---|---|---|---|---|",
        _latency_row("Đăng nhập", summary["login_latency_ms"]),
        _latency_row("Nộp bài", summary["submit_latency_ms"]),
        _latency_row("Lượt AI", summary["review_latency_ms"]),
        "",
        f"- Hàng đợi rút hết trong **{summary['drain_seconds']}s** (từ bài nộp đầu tiên tới lượt AI "
        "cuối cùng, theo đồng hồ server).",
        f"- Trạng thái nộp: {_inline(summary['submit_status'])}",
        f"- Lượt AI: {_inline(summary['terminal_status'])} · nguồn: "
        f"{_inline(summary['terminal_source'])} · kết luận: {_inline(summary['terminal_verdict'])}",
        "",
        "## Cổng go/no-go",
        "",
        "| Cổng | Kết quả |",
        "|---|---|",
    ]
    for check in checks:
        verdict = "ĐẠT" if check["ok"] else f"**KHÔNG ĐẠT**: {_detail(check['detail'])}"
        lines.append(f"| {check['label']} | {verdict} |")
    if verification:
        lines += ["", "## Đối chiếu độc lập trong Mongo", ""]
        lines += [
            f"- Bài nộp: **{verification['submissions']}** · job: **{verification['jobs']}** "
            f"({_inline(verification['job_status'])}) · dòng audit: **{verification['audit_rows']}**",
            f"- Token: **{verification['tokens_total']}** "
            f"(vào {verification['tokens_prompt']} / ra {verification['tokens_completion']})",
            f"- Lượt AI theo đồng hồ server: p50 {_ms(verification['review_duration_ms']['p50'])} · "
            f"p95 {_ms(verification['review_duration_ms']['p95'])} · "
            f"max {_ms(verification['review_duration_ms']['max'])}",
        ]
    if summary["not_terminal"]:
        lines += ["", f"- Người dùng chưa tới terminal: {summary['not_terminal']}"]
    if summary["missing_users"]:
        lines += ["", f"- Người dùng không nộp được: {summary['missing_users']}"]
    return "\n".join(lines) + "\n"


def _latency_row(label: str, values: dict[str, float | None]) -> str:
    cells = [values["p50"], values["p95"], values["p99"], values["max"]]
    return f"| {label} | " + " | ".join(_ms(value) for value in cells) + " |"


def _ms(value: float | None) -> str:
    return f"{value:.0f}" if value is not None else "—"


def _inline(counts: dict) -> str:
    if not counts:
        return "không có"
    return " · ".join(f"`{name}`×{count}" for name, count in sorted(counts.items()))


def _detail(detail) -> str:
    if isinstance(detail, dict):
        return ", ".join(f"{key}={value}" for key, value in detail.items())
    if isinstance(detail, list):
        return ", ".join(str(item) for item in detail) or "có phần tử"
    return str(detail)


# --------------------------------------------------------------------------------------------
# Tầng chạy: mọi thay đổi trạng thái đi qua API chính thức
# --------------------------------------------------------------------------------------------


class ApiError(SystemExit):
    """Lỗi vận hành của chính harness (khác với lỗi đo được của hệ thống đang kiểm)."""


def _client(base_url: str, timeout: float) -> httpx.Client:
    return httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, follow_redirects=True)


class Admin:
    """Bọc đúng những endpoint admin mà harness cần; không endpoint nào khác."""

    def __init__(self, base_url: str, email: str, password: str, timeout: float) -> None:
        self._client = _client(base_url, timeout)
        response = self._client.post(
            "/api/auth/login", json={"identifier": email, "password": password}
        )
        if response.status_code != 200:
            raise ApiError(f"Đăng nhập admin thất bại (HTTP {response.status_code}).")
        if response.json().get("role") != "admin":
            raise ApiError("Tài khoản đăng nhập không phải admin.")

    def close(self) -> None:
        self._client.close()

    def competition_by_slug(self, slug: str) -> dict | None:
        for competition in self._json(self._client.get("/api/admin/competitions"))["competitions"]:
            if competition["slug"] == slug:
                return competition
        return None

    def create_competition(self, *, slug: str, name: str, now: datetime) -> dict:
        response = self._client.post(
            "/api/admin/competitions",
            json={
                "slug": slug,
                "name": name,
                "short_description": "Cuộc thi tạm để kiểm thử tải AI review.",
                "start_at": (now - timedelta(hours=1)).isoformat(),
                "end_at": (now + timedelta(days=2)).isoformat(),
                "join_mode": "invite_only",
                "primary_metric": "f1",
                "quota_per_day": 5,
                "leaderboard_visible": False,
                "resources": [],
            },
        )
        if response.status_code != 201:
            raise ApiError(f"Tạo cuộc thi thất bại: {self._error(response)}")
        return self._json(response)

    def configure(self, competition_id: str, *, run_tag: str, ai_base_url: str, ai_model: str,
                  api_key: str) -> None:
        """Chấm điểm, ground truth, thể lệ và AI - theo đúng thứ tự phụ thuộc, trước khi publish.

        Chỉ gọi được khi cuộc thi còn draft: `PUT /scoring` và `/ground-truth` khoá lại ngay khi có
        bài nộp hoàn tất, mà chỉ cuộc thi đã publish mới nhận bài nộp. Trang thể lệ được dùng lại
        nếu đã có, để lượt chạy đứt giữa chừng gọi lại không sinh trang trùng (xem `_prepare`).
        """
        self._expect(
            self._client.put(
                f"/api/admin/competitions/{competition_id}/scoring", json=SCORING_CONFIG
            ),
            200,
            "cấu hình chấm điểm",
        )
        self._expect(
            self._client.put(
                f"/api/admin/competitions/{competition_id}/ground-truth",
                files={"file": ("ground_truth.csv", ground_truth_csv(run_tag), "text/csv")},
            ),
            200,
            "tải ground truth",
        )
        content = self._rules_content(competition_id) or self._expect(
            self._client.post(
                f"/api/admin/competitions/{competition_id}/contents",
                json={
                    "title": "Thể lệ",
                    "slug": RULES_SLUG,
                    "order": 1,
                    "visibility": "public",
                },
            ),
            201,
            "tạo trang nội dung",
        )
        self._expect(
            self._client.put(
                f"/api/admin/competitions/{competition_id}/contents/{content['id']}/file",
                files={"file": ("rules.md", RULES_MARKDOWN.encode("utf-8"), "text/markdown")},
            ),
            200,
            "tải nội dung thể lệ",
        )
        self._expect(
            self._client.put(
                f"/api/admin/competitions/{competition_id}/ai-review",
                json={
                    "enabled": True,
                    "auto_review": True,
                    "participant_visible": True,
                    "base_url": ai_base_url,
                    "model": ai_model,
                    "api_key": api_key,
                },
            ),
            200,
            "cấu hình AI",
        )

    def _rules_content(self, competition_id: str) -> dict | None:
        contents = self._json(
            self._client.get(f"/api/admin/competitions/{competition_id}/contents")
        )["contents"]
        return next((item for item in contents if item["slug"] == RULES_SLUG), None)

    def publish(self, competition_id: str) -> None:
        self._expect(
            self._client.post(f"/api/admin/competitions/{competition_id}/publish"),
            200,
            "publish cuộc thi",
        )

    def ensure_account(self, email: str, password: str, name: str) -> str:
        """Tạo account participant; đã tồn tại thì dùng lại (chạy lại giữa các stage không nổ)."""
        response = self._client.post(
            "/api/admin/accounts",
            json={"email": email, "name": name, "password": password, "role": "participant"},
        )
        if response.status_code == 201:
            return self._json(response)["id"]
        if response.status_code != 409:
            raise ApiError(f"Tạo account {email} thất bại: {self._error(response)}")
        for account in self.accounts_matching(email):
            if account["email"] == email:
                return account["id"]
        raise ApiError(f"Account {email} báo đã tồn tại nhưng không tra được.")

    def add_member(self, competition_id: str, email: str) -> None:
        self._expect(
            self._client.post(
                f"/api/admin/competitions/{competition_id}/members", json={"email": email}
            ),
            200,
            f"thêm thành viên {email}",
        )

    def submission_review(self, submission_id: str) -> dict:
        return self._json(self._client.get(f"/api/admin/submissions/{submission_id}/ai-review"))

    def close_competition(self, competition_id: str) -> None:
        self._expect(
            self._client.post(f"/api/admin/competitions/{competition_id}/close"),
            200,
            "kết thúc cuộc thi",
        )

    def delete_competition(self, competition_id: str, slug: str) -> dict:
        response = self._client.delete(
            f"/api/admin/competitions/{competition_id}", params={"confirm_slug": slug}
        )
        if response.status_code != 200:
            raise ApiError(f"Xoá cuộc thi thất bại: {self._error(response)}")
        return self._json(response)

    def accounts_matching(self, query: str) -> list[dict]:
        return self._json(
            self._client.get("/api/admin/accounts", params={"q": query, "limit": 200})
        )["accounts"]

    def set_active(self, account_id: str, active: bool) -> None:
        self._expect(
            self._client.patch(f"/api/admin/accounts/{account_id}", json={"active": active}),
            200,
            "đổi trạng thái account",
        )

    def _json(self, response: httpx.Response) -> dict:
        # Nhận mọi 2xx: `POST /competitions` trả 201, không phải 200. Trạng thái mong đợi cụ thể
        # do nơi gọi kiểm (`_expect`), ở đây chỉ phân biệt thành công với lỗi.
        if not response.is_success:
            raise ApiError(
                f"Gọi {response.request.url.path} thất bại: {self._error(response)}"
            )
        try:
            return response.json()
        except ValueError:
            raise ApiError(f"Phản hồi từ {response.request.url.path} không phải JSON.")

    @staticmethod
    def _error(response: httpx.Response) -> str:
        try:
            body = response.json()
        except ValueError:
            return f"HTTP {response.status_code}"
        return f"HTTP {response.status_code} {body.get('code') or body.get('detail') or ''}".strip()

    @classmethod
    def _expect(cls, response: httpx.Response, status: int, action: str) -> dict:
        if response.status_code != status:
            raise ApiError(f"{action} thất bại: {cls._error(response)}")
        try:
            return response.json()
        except ValueError:
            return {}


@dataclass
class Load:
    """Ghi bản ghi của một lượt chạy ra NDJSON, có khoá vì nhiều luồng cùng ghi."""

    output_dir: Path
    lock: threading.Lock = field(default_factory=threading.Lock)
    started_at: float = field(default_factory=time.time)

    def record(self, entry: dict) -> None:
        entry["at"] = round(time.time() - self.started_at, 3)
        with self.lock:
            with (self.output_dir / "requests.ndjson").open("a") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _error_code(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return f"HTTP_{response.status_code}"
    return body.get("code") or f"HTTP_{response.status_code}"


def _login(load: Load, base_url: str, timeout: float, user: int, email: str,
           password: str) -> httpx.Client | None:
    """Đăng nhập và giữ phiên cho pha nộp bài.

    Trả `None` khi hỏng - lỗi đã nằm trong bản ghi, không cần trả thêm. Phiên phải sống qua lúc trả
    về nên client KHÔNG được đóng ở đây; người gọi đóng sau khi nộp xong.
    """
    started = time.perf_counter()
    client = _client(base_url, timeout)
    status = 0
    error = None
    try:
        response = client.post(
            "/api/auth/login", json={"identifier": email, "password": password}
        )
        status = response.status_code
        if status != 200:
            error = _error_code(response)
    except httpx.HTTPError as exc:
        error = type(exc).__name__
    load.record(
        {
            "kind": "login",
            "user": user,
            "status": status,
            "error_code": error,
            "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        }
    )
    if status != 200:
        client.close()
        return None
    return client


def _submit(load: Load, client: httpx.Client, *, competition_id: str, run_tag: str, user: int,
            barrier: threading.Barrier | None) -> None:
    """Nộp một bài. Không thử lại: một lượt hỏng là dữ liệu, không phải sự cố cần che."""
    if barrier is not None:
        barrier.wait()
    started = time.perf_counter()
    status = 0
    error = None
    submission_id = None
    created_at = None
    try:
        response = client.post(
            f"/api/competitions/{competition_id}/submissions",
            files={
                "file": ("submission.csv", prediction_csv(run_tag, user), "text/csv"),
                "notebook": (
                    "notebook.ipynb",
                    notebook_bytes(run_tag, user),
                    "application/x-ipynb+json",
                ),
            },
        )
        status = response.status_code
        if status == 201:
            body = response.json()
            submission_id = body.get("id")
            created_at = body.get("created_at")
        else:
            error = _error_code(response)
    except httpx.HTTPError as exc:
        error = type(exc).__name__
    load.record(
        {
            "kind": "submit",
            "user": user,
            "status": status,
            "error_code": error,
            "submission_id": submission_id,
            "created_at": created_at,
            "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        }
    )


def _poll_terminals(load: Load, admin: Admin, pending: dict[int, str], *, timeout: float,
                    interval: float) -> None:
    """Chờ từng bài nộp tới terminal; chỉ hỏi những bài chưa xong nên chi phí giảm dần."""
    deadline = time.monotonic() + timeout
    while pending:
        with ThreadPoolExecutor(max_workers=POLL_WORKERS) as pool:
            for user, detail in zip(
                list(pending), pool.map(admin.submission_review, list(pending.values()))
            ):
                latest = (detail.get("history") or [None])[0]
                if not latest or latest.get("status") not in (
                    constants.REVIEW_STATUS_COMPLETED,
                    constants.REVIEW_STATUS_FAILED,
                ):
                    continue
                load.record(
                    {
                        "kind": "terminal",
                        "user": user,
                        "status": latest.get("status"),
                        "verdict": latest.get("verdict"),
                        "source": latest.get("source"),
                        "duration_ms": latest.get("duration_ms"),
                        "generation": latest.get("generation"),
                        "completed_at": latest.get("completed_at"),
                        "error_code": (latest.get("error") or {}).get("code"),
                    }
                )
                del pending[user]
        if pending and time.monotonic() < deadline:
            time.sleep(interval)
    if pending:
        print(f"  hết thời gian chờ, còn {len(pending)} lượt chưa tới terminal", flush=True)


def _verify_mongo(uri: str, competition_id: str) -> dict:
    """Đối chiếu độc lập với những gì API kể: đếm thẳng trong Mongo. Chỉ ĐỌC."""
    import pymongo
    from bson import ObjectId

    client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=8000)
    db = client.get_database()
    oid = ObjectId(competition_id)
    jobs = list(db[queue.JOBS_COLLECTION].find({"competition_id": oid}))
    reviews = list(db[ai_service.REVIEWS_COLLECTION].find({"competition_id": oid}))

    failed_ids = {
        str(row["submission_id"])
        for row in reviews
        if row["status"] == constants.REVIEW_STATUS_FAILED
    }
    completed_ids = {
        str(row["submission_id"])
        for row in reviews
        if row["status"] == constants.REVIEW_STATUS_COMPLETED
    }
    durations = [
        float(row["duration_ms"]) for row in reviews if row.get("duration_ms") is not None
    ]
    return {
        "submissions": db[SUBMISSIONS_COLLECTION].count_documents({"competition_id": oid}),
        "jobs": len(jobs),
        "job_status": _tally(job.get("status") for job in jobs),
        "jobs_left": [
            {"job": str(job["_id"]), "status": job.get("status"), "attempts": job.get("attempts")}
            for job in jobs
            if job.get("status") != constants.JOB_COMPLETED
        ],
        "audit_rows": len(reviews),
        "completed_audits": len(completed_ids),
        "submissions_with_failed_audit": sorted(failed_ids),
        "tokens_prompt": sum((row.get("usage") or {}).get("prompt_tokens") or 0 for row in reviews),
        "tokens_completion": sum(
            (row.get("usage") or {}).get("completion_tokens") or 0 for row in reviews
        ),
        "tokens_total": sum((row.get("usage") or {}).get("total_tokens") or 0 for row in reviews),
        "review_duration_ms": _latency(durations),
        "provider_hosts": len(
            {row.get("provider_host") for row in reviews if row.get("provider_host")}
        ),
    }


# --------------------------------------------------------------------------------------------
# Điều phối
# --------------------------------------------------------------------------------------------


def _prepare(args, admin: Admin, now: datetime) -> tuple[dict, list[str]]:
    """Tạo cuộc thi + account + membership; chạy lại trên cùng run-tag phải là thao tác rỗng."""
    slug = f"{args.slug_prefix}-{args.run_tag}"
    competition = admin.competition_by_slug(slug)
    if competition is None:
        competition = admin.create_competition(
            slug=slug, name=f"{NAME_MARKER} {args.run_tag}", now=now
        )
        print(f"  tạo cuộc thi {slug} -> {competition['id']}", flush=True)
    else:
        print(f"  dùng lại cuộc thi {slug} -> {competition['id']}", flush=True)
    if competition["status"] == "draft":
        # Cấu hình gắn với lượt publish: draft chưa từng nhận bài nộp nên cấu hình còn khoá-mở,
        # và lượt chạy chết giữa chừng (đã tạo cuộc thi, chưa publish) chạy lại vẫn đi tới đích.
        admin.configure(
            competition["id"],
            run_tag=args.run_tag,
            ai_base_url=args.ai_base_url,
            ai_model=args.ai_model,
            api_key=args.ai_api_key,
        )
        admin.publish(competition["id"])
        print("  đã cấu hình và publish cuộc thi", flush=True)

    password = load_password(args.run_tag)
    for user in range(1, args.users + 1):
        email = account_email(args.run_tag, user)
        admin.ensure_account(email, password, f"Load test {args.run_tag} #{user:03d}")
        admin.add_member(competition["id"], email)
        if user % 10 == 0:
            print(f"  {user}/{args.users} account sẵn sàng", flush=True)
    return competition, [account_email(args.run_tag, user) for user in range(1, args.users + 1)]


def _load_records(output_dir: Path) -> list[dict]:
    path = output_dir / "requests.ndjson"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _resume_filter(output_dir: Path) -> set[int]:
    """Giữ bản ghi nộp/terminal của lượt trước, bỏ bản ghi đăng nhập để phép đếm bắt đầu lại.

    Trả về tập người dùng đã nộp thành công: họ không nộp lại, nhưng vẫn được hỏi terminal ở
    `stage` nếu lượt trước dừng trước khi kịp ghi.
    """
    kept = [row for row in _load_records(output_dir) if row["kind"] != "login"]
    with (output_dir / "requests.ndjson").open("w") as handle:
        for row in kept:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return {row["user"] for row in kept if row["kind"] == "submit" and row["status"] == 201}


def stage(args) -> int:
    output_dir: Path = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    load = Load(output_dir=output_dir)
    now = datetime.now(timezone.utc)
    slug = f"{args.slug_prefix}-{args.run_tag}"

    print(
        f"run-tag={args.run_tag} · slug={slug} · {args.users} người dùng · "
        f"nộp song song {args.concurrency} · output {output_dir}",
        flush=True,
    )
    if args.dry_run:
        print(
            "  --dry-run: không tạo gì, không gọi provider. Kế hoạch ở trên là toàn bộ việc sẽ làm.",
            flush=True,
        )
        return 0

    admin = Admin(args.base_url, args.email, args.password, args.timeout)
    try:
        competition, emails = _prepare(args, admin, now)
        password = load_password(args.run_tag)
        already_submitted = _resume_filter(output_dir) if args.resume else set()
        if already_submitted:
            print(f"  --resume: bỏ qua {len(already_submitted)} người đã nộp thành công", flush=True)

        todo = [user for user in range(1, args.users + 1) if user not in already_submitted]
        print(
            f"  đăng nhập {len(todo)} phiên (tối đa {args.login_concurrency} cùng lúc)...",
            flush=True,
        )
        with ThreadPoolExecutor(max_workers=args.login_concurrency) as pool:
            sessions = {
                user: client
                for user, client in pool.map(
                    lambda user: (
                        user,
                        _login(
                            load, args.base_url, args.timeout, user, emails[user - 1], password
                        ),
                    ),
                    todo,
                )
                if client is not None
            }

        print(
            f"  nộp bài: {len(sessions)} phiên, giải phóng từng đợt {args.concurrency}...",
            flush=True,
        )
        try:
            for start in range(0, len(sessions), args.concurrency):
                wave = sorted(sessions)[start : start + args.concurrency]
                barrier = threading.Barrier(len(wave))
                with ThreadPoolExecutor(max_workers=len(wave)) as pool:
                    for user in wave:
                        pool.submit(
                            _submit,
                            load,
                            sessions[user],
                            competition_id=competition["id"],
                            run_tag=args.run_tag,
                            user=user,
                            barrier=barrier,
                        )
        finally:
            for client in sessions.values():
                client.close()

        records = _load_records(output_dir)
        submitted = {
            row["user"]: row["submission_id"]
            for row in records
            if row["kind"] == "submit" and row["status"] == 201
        }
        observed = {row["user"] for row in records if row["kind"] == "terminal"}
        pending = {user: sid for user, sid in submitted.items() if user not in observed}
        if pending:
            print(f"  chờ {len(pending)} lượt AI tới terminal...", flush=True)
            _poll_terminals(
                load, admin, pending, timeout=args.drain_timeout, interval=args.poll_interval
            )
    finally:
        admin.close()

    records = _load_records(output_dir)
    summary = summarize(records, expected_users=args.users)
    verification = _verify_mongo(args.mongo_uri, competition["id"]) if args.mongo_uri else None
    if verification:
        summary["verification"] = verification
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
    )
    (output_dir / "report.md").write_text(
        render_report(
            summary,
            run_tag=args.run_tag,
            users=args.users,
            concurrency=args.concurrency,
            base_url=args.base_url,
            verification=verification,
        )
    )

    checks = gates(summary, expected_users=args.users, verification=verification)
    failed = [check for check in checks if not check["ok"]]
    print(f"\nBáo cáo: {output_dir / 'report.md'}", flush=True)
    print(
        f"Nộp {summary['submitted_ok']}/{args.users} · drain {summary['drain_seconds']}s · "
        f"cổng đạt {len(checks) - len(failed)}/{len(checks)}",
        flush=True,
    )
    for check in failed:
        print(f"  KHÔNG ĐẠT: {check['label']} -> {_detail(check['detail'])}", flush=True)
    return 0 if not failed else 1


def cleanup(args) -> int:
    """Xoá cuộc thi của run-tag rồi vô hiệu hoá account; không xoá account để còn vết."""
    admin = Admin(args.base_url, args.email, args.password, args.timeout)
    slug = f"{args.slug_prefix}-{args.run_tag}"
    try:
        competition = admin.competition_by_slug(slug)
        if competition is None:
            print(f"  không có cuộc thi {slug}; bỏ qua phần cuộc thi", flush=True)
        elif not competition["name"].startswith(NAME_MARKER):
            raise ApiError(f"Cuộc thi {slug} không mang dấu {NAME_MARKER}; từ chối xoá.")
        else:
            if competition["status"] == "published":
                admin.close_competition(competition["id"])
            result = admin.delete_competition(competition["id"], slug)
            print(
                f"  đã xoá cuộc thi {slug} (files_removed={result.get('files_removed')})",
                flush=True,
            )

        disabled = 0
        for account in admin.accounts_matching(args.run_tag):
            if account["email"].endswith(f"@{ACCOUNT_DOMAIN}") and account.get("active", True):
                admin.set_active(account["id"], False)
                disabled += 1
        print(f"  đã vô hiệu hoá {disabled} account", flush=True)
    finally:
        admin.close()
    return 0


def _env_or_die(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ApiError(f"Thiếu {name}: truyền --email/--password hoặc đặt biến môi trường.")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Kiểm thử tải AI review qua đường công khai.")
    parser.add_argument("command", choices=("stage", "cleanup"))
    parser.add_argument("--base-url", required=True)
    parser.add_argument(
        "--run-tag",
        required=True,
        help="chữ thường, số và gạch ngang; dùng làm slug và tiền tố email",
    )
    parser.add_argument("--users", type=int, default=None, help="số người dùng ảo của stage này")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=None,
        help="số bài nộp cùng lúc; mặc định bằng --users (đúng kịch bản 'cả lớp nộp một lúc')",
    )
    parser.add_argument("--login-concurrency", type=int, default=8)
    parser.add_argument("--slug-prefix", default=SLUG_PREFIX_DEFAULT)
    parser.add_argument("--ai-base-url", default=None)
    parser.add_argument("--ai-model", default=None)
    parser.add_argument("--mongo-uri", default=None, help="tuỳ chọn, CHỈ để đọc token và đối chiếu")
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--poll-interval", type=float, default=10.0)
    parser.add_argument("--drain-timeout", type=float, default=3600.0)
    parser.add_argument("--resume", action="store_true", help="bỏ qua người đã nộp thành công")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--acknowledge-load-test",
        action="store_true",
        help="bắt buộc: xác nhận đang chạy trên môi trường đã được phép kiểm thử tải",
    )
    parser.add_argument("--email", default=None, help="mặc định $AI_REVIEW_LOAD_ADMIN_EMAIL")
    parser.add_argument("--password", default=None, help="mặc định $AI_REVIEW_LOAD_ADMIN_PASSWORD")
    args = parser.parse_args(argv)

    if not _RUN_TAG_RE.match(args.run_tag):
        raise ApiError("--run-tag phải là chữ thường/số/gạch ngang, 3-41 ký tự.")
    args.users = args.users or 0
    args.concurrency = args.concurrency or args.users
    if args.command == "stage":
        if not 1 <= args.users <= 500:
            raise ApiError("--users phải trong khoảng 1..500.")
        if not 1 <= args.concurrency <= args.users:
            raise ApiError("--concurrency phải trong khoảng 1..--users.")
    args.output_dir = args.output_dir or (
        Path(__file__).resolve().parents[2] / "data" / "ai-review-load" / args.run_tag
    )
    args.email = args.email or _env_or_die("AI_REVIEW_LOAD_ADMIN_EMAIL")
    args.password = args.password or _env_or_die("AI_REVIEW_LOAD_ADMIN_PASSWORD")
    # Key provider chỉ đi qua biến môi trường: argv hiện nguyên văn trong `ps` cho mọi tiến trình.
    args.ai_api_key = os.environ.get("AI_REVIEW_LOAD_PROVIDER_KEY", "")
    if args.command == "stage" and not args.dry_run:
        if not (args.ai_base_url and args.ai_model and args.ai_api_key):
            raise ApiError(
                "Thiếu cấu hình provider: cần --ai-base-url, --ai-model và "
                "$AI_REVIEW_LOAD_PROVIDER_KEY."
            )
        if not args.acknowledge_load_test:
            raise ApiError(
                "Thiếu --acknowledge-load-test: đây là thao tác ghi lên môi trường thật."
            )
    return stage(args) if args.command == "stage" else cleanup(args)


if __name__ == "__main__":
    raise SystemExit(main())
