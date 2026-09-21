"""Kiểm chứng output model trước khi lưu: backend không tin model, chỉ tin notebook và revision.

Mỗi finding phải chỉ đúng một trang nội dung có thật, trích đúng một đoạn có thật trong trang đó,
và trỏ vào cell/dòng có thật trong notebook. Snippet do model gửi bị vứt đi và được dựng lại từ
chính các dòng đó. Verdict chỉ được GIẢM độ chắc chắn, không bao giờ được nâng: một kết luận tự tin
không kèm bằng chứng kiểm chứng được sẽ hạ xuống INCONCLUSIVE.
"""

import re
from dataclasses import dataclass

from app.ai_review import constants
from app.ai_review.models import ModelFinding, ModelReviewOutput
from app.ai_review.notebook import NormalizedNotebook

DOWNGRADE_RULE_NOT_FOUND = "RULE_NOT_FOUND"
DOWNGRADE_EVIDENCE_INVALID = "EVIDENCE_INVALID"
DOWNGRADE_NO_VERIFIED_VIOLATION = "NO_VERIFIED_VIOLATION"
DOWNGRADE_NOTEBOOK_TRUNCATED = "NOTEBOOK_TRUNCATED"

_WHITESPACE = re.compile(r"\s+")


class ResponseInvalid(Exception):
    """Output model tự mâu thuẫn hoặc không dùng được - pipeline chuyển thành ERROR, không đoán."""


@dataclass(frozen=True)
class VerifiedFinding:
    source_content_title: str
    source_content_slug: str
    rule_text: str
    checkability: str
    status: str
    reason: str
    evidence: list[dict]
    verified: bool


def verify_review(
    output: ModelReviewOutput,
    *,
    pages: list[dict],
    notebook: NormalizedNotebook,
) -> tuple[str, list[VerifiedFinding], list[str]]:
    """Trả `(verdict cuối, findings đã kiểm chứng, mã downgrade)`."""
    if output.verdict == constants.VERDICT_CLEAR and any(
        finding.status == constants.FINDING_VIOLATION for finding in output.findings
    ):
        # Tự mâu thuẫn: vừa nói không có vi phạm vừa kể ra vi phạm. Chọn ERROR thay vì đoán bên nào đúng.
        raise ResponseInvalid("Model trả CLEAR kèm finding VIOLATION.")

    by_slug = {page["slug"]: page for page in pages}
    downgrades: set[str] = set()
    findings: list[VerifiedFinding] = []
    has_verified_violation = False

    for finding in output.findings:
        page = by_slug.get(finding.source_content_slug)
        rule_verified = page is not None and _rule_matches(finding.rule_text, page["markdown"])
        evidence = (
            _verify_evidence(finding, notebook)
            if rule_verified and finding.evidence
            else []
        )
        if page is not None and not rule_verified:
            downgrades.add(DOWNGRADE_RULE_NOT_FOUND)
        if rule_verified and finding.evidence and not evidence:
            downgrades.add(DOWNGRADE_EVIDENCE_INVALID)

        verified = rule_verified and bool(evidence)
        if (
            verified
            and finding.status == constants.FINDING_VIOLATION
            and finding.checkability == constants.CHECKABLE
        ):
            has_verified_violation = True
        findings.append(
            VerifiedFinding(
                source_content_title=finding.source_content_title,
                source_content_slug=finding.source_content_slug,
                rule_text=finding.rule_text,
                checkability=finding.checkability,
                status=finding.status,
                reason=finding.reason,
                evidence=evidence,
                verified=verified,
            )
        )

    verdict = output.verdict
    if verdict == constants.VERDICT_FLAGGED and not has_verified_violation:
        # Không có vi phạm nào kiểm chứng được thì không được buộc tội - hạ xuống INCONCLUSIVE.
        verdict = constants.VERDICT_INCONCLUSIVE
        downgrades.add(DOWNGRADE_NO_VERIFIED_VIOLATION)
    if verdict == constants.VERDICT_CLEAR and notebook.truncated:
        # Notebook bị cắt thì "không thấy vi phạm" chỉ có nghĩa "chưa xem hết".
        verdict = constants.VERDICT_INCONCLUSIVE
        downgrades.add(DOWNGRADE_NOTEBOOK_TRUNCATED)

    return verdict, findings, sorted(downgrades)


def _rule_matches(rule_text: str, markdown: str) -> bool:
    """Khớp sau khi gộp mọi khoảng trắng: quy định trong Markdown thường xuống dòng giữa câu."""
    return _normalize_whitespace(rule_text) in _normalize_whitespace(markdown)


def _normalize_whitespace(value: str) -> str:
    return _WHITESPACE.sub(" ", value).strip()


def _verify_evidence(finding: ModelFinding, notebook: NormalizedNotebook) -> list[dict]:
    verified = []
    for item in finding.evidence:
        cell = notebook.cell(item.cell)
        if cell is None or not 1 <= item.start_line <= item.end_line <= len(cell.lines):
            continue
        verified.append(
            {
                "cell": item.cell,
                "start_line": item.start_line,
                "end_line": item.end_line,
                "snippet": _build_snippet(cell.lines, item.start_line, item.end_line),
            }
        )
    return verified


def _build_snippet(lines: tuple[str, ...], start_line: int, end_line: int) -> str:
    """Dựng snippet thật từ notebook, giới hạn số dòng lẫn số ký tự (model không quyết định nội dung)."""
    total = len(lines)
    start = min(start_line, total)
    end = min(max(end_line, start), total)
    if end - start + 1 > constants.MAX_SNIPPET_LINES:
        end = start + constants.MAX_SNIPPET_LINES - 1
    low = max(1, start - constants.SNIPPET_LINE_WINDOW)
    high = min(total, end + constants.SNIPPET_LINE_WINDOW)
    if high - low + 1 > constants.MAX_SNIPPET_LINES:
        high = low + constants.MAX_SNIPPET_LINES - 1

    rendered: list[str] = []
    length = 0
    for number in range(low, high + 1):
        part = f"{number} {lines[number - 1]}".rstrip()
        room = constants.MAX_SNIPPET_CHARS - length
        if room <= 1:
            break
        if len(part) + 1 > room:
            # Một dòng dài hơn cả trần: cắt bớt, để trần ký tự là trần thật chứ không phải gợi ý.
            part = part[: room - 1]
        rendered.append(part)
        length += len(part) + 1
    return "\n".join(rendered)
