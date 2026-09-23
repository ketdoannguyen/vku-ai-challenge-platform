"""Kiểm chứng output model trước khi lưu: backend không tin model, chỉ tin notebook và revision.

Model chỉ được nhắc lại `rule_ref` do backend sinh; title, slug và văn bản luật luôn được điền lại từ
revision bất biến. Ref sai thì có đúng một đường dự phòng: `rule_quote` phải canonical-hoá về đúng
canonical text của MỘT block - không substring, không similarity, 0 hay nhiều hơn 1 candidate đều
không resolve.

Bằng chứng được kiểm tra ĐỘC LẬP với việc resolve rule: một finding sai ref vẫn giữ được các range
hợp lệ và vẫn nói rõ được vì sao nó chưa xác minh. Snippet do model gửi luôn bị vứt đi và được dựng
lại từ chính các dòng đó.

Verdict chỉ được GIẢM độ chắc chắn, không bao giờ được nâng: FLAGGED mà không có vi phạm nào vừa
resolve được quy định vừa có bằng chứng hợp lệ sẽ hạ xuống INCONCLUSIVE.
"""

from dataclasses import dataclass

from app.ai_review import constants
from app.ai_review.models import ModelFinding, ModelReviewOutput
from app.ai_review.notebook import NormalizedNotebook
from app.ai_review.rule_refs import RuleBlock, RuleIndex

DOWNGRADE_RULE_NOT_FOUND = "RULE_NOT_FOUND"
DOWNGRADE_EVIDENCE_INVALID = "EVIDENCE_INVALID"
DOWNGRADE_NO_VERIFIED_VIOLATION = "NO_VERIFIED_VIOLATION"
DOWNGRADE_NOTEBOOK_TRUNCATED = "NOTEBOOK_TRUNCATED"


class ResponseInvalid(Exception):
    """Output model tự mâu thuẫn hoặc không dùng được - pipeline chuyển thành ERROR, không đoán."""


@dataclass(frozen=True)
class VerifiedFinding:
    """Một finding sau hậu kiểm, kèm đủ dữ kiện để UI giải thích nó đã được xác minh tới đâu."""

    # Provenance luôn lấy từ revision; rỗng khi không resolve được quy định nào.
    source_content_title: str
    source_content_slug: str
    rule_text: str
    rule_ref: str | None
    model_rule_ref: str
    rule_resolution: str
    rule_verified: bool
    evidence_count: int
    valid_evidence_count: int
    evidence_verified: bool
    verified: bool
    traceable: bool
    checkability: str
    status: str
    reason: str
    evidence: list[dict]
    verification_codes: list[str]


def verify_review(
    output: ModelReviewOutput,
    *,
    index: RuleIndex,
    notebook: NormalizedNotebook,
) -> tuple[str, list[VerifiedFinding], list[str]]:
    """Trả `(verdict cuối, findings đã kiểm chứng, mã downgrade cấp review)`."""
    if output.verdict == constants.VERDICT_CLEAR and any(
        finding.status == constants.FINDING_VIOLATION for finding in output.findings
    ):
        # Tự mâu thuẫn: vừa nói không có vi phạm vừa kể ra vi phạm. Chọn ERROR thay vì đoán bên nào đúng.
        raise ResponseInvalid("Model trả CLEAR kèm finding VIOLATION.")

    downgrades: set[str] = set()
    findings: list[VerifiedFinding] = []
    has_traceable_violation = False

    for finding in output.findings:
        block, resolution, codes = _resolve_rule(finding, index)
        evidence, evidence_codes = _verify_evidence(finding, notebook)
        codes.update(evidence_codes)

        rule_verified = block is not None
        evidence_verified = bool(evidence)
        verified = rule_verified and evidence_verified
        traceable = (
            verified
            and finding.status == constants.FINDING_VIOLATION
            and finding.checkability == constants.CHECKABLE
        )
        if traceable:
            has_traceable_violation = True
        if not rule_verified:
            downgrades.add(DOWNGRADE_RULE_NOT_FOUND)
        if rule_verified and finding.evidence and not evidence_verified:
            downgrades.add(DOWNGRADE_EVIDENCE_INVALID)

        findings.append(
            VerifiedFinding(
                source_content_title=block.page_title if block else "",
                source_content_slug=block.page_slug if block else "",
                rule_text=block.raw_text if block else "",
                rule_ref=block.ref if block else None,
                model_rule_ref=finding.rule_ref,
                rule_resolution=resolution,
                rule_verified=rule_verified,
                evidence_count=len(finding.evidence),
                valid_evidence_count=len(evidence),
                evidence_verified=evidence_verified,
                verified=verified,
                traceable=traceable,
                checkability=finding.checkability,
                status=finding.status,
                reason=finding.reason,
                evidence=evidence,
                verification_codes=sorted(codes),
            )
        )

    verdict = output.verdict
    if verdict == constants.VERDICT_FLAGGED and not has_traceable_violation:
        # Không có vi phạm nào kiểm chứng được thì không được buộc tội - hạ xuống INCONCLUSIVE.
        verdict = constants.VERDICT_INCONCLUSIVE
        downgrades.add(DOWNGRADE_NO_VERIFIED_VIOLATION)
    if verdict == constants.VERDICT_CLEAR and notebook.truncated:
        # Notebook bị cắt thì "không thấy vi phạm" chỉ có nghĩa "chưa xem hết".
        verdict = constants.VERDICT_INCONCLUSIVE
        downgrades.add(DOWNGRADE_NOTEBOOK_TRUNCATED)

    return verdict, findings, sorted(downgrades)


def _resolve_rule(
    finding: ModelFinding, index: RuleIndex
) -> tuple[RuleBlock | None, str, set[str]]:
    """Hai đường có thứ tự cố định: ref chính xác trước, canonical quote duy nhất sau."""
    block = index.get(finding.rule_ref)
    if block is not None:
        return block, constants.RULE_RESOLUTION_REFERENCE, set()

    # Ref không có trong revision: mọi đường đi tiếp đều phải kể ra điều đó.
    codes = {constants.VERIFY_RULE_REF_UNKNOWN}
    if not finding.rule_quote:
        return None, constants.RULE_RESOLUTION_UNRESOLVED, codes

    candidates = index.candidates_for_quote(finding.rule_quote)
    if len(candidates) == 1:
        return candidates[0], constants.RULE_RESOLUTION_CANONICAL_QUOTE, codes
    if not candidates:
        return None, constants.RULE_RESOLUTION_UNRESOLVED, codes | {
            constants.VERIFY_RULE_QUOTE_UNMATCHED
        }
    # Nhiều quy định cùng canonical text: chọn cái nào cũng là đoán, nên không chọn.
    return None, constants.RULE_RESOLUTION_UNRESOLVED, codes | {
        constants.VERIFY_RULE_QUOTE_AMBIGUOUS
    }


def _verify_evidence(
    finding: ModelFinding, notebook: NormalizedNotebook
) -> tuple[list[dict], set[str]]:
    """Giữ range hợp lệ, bỏ range sai, và nói rõ range nào bị bỏ.

    Chạy bất kể rule có resolve được hay không: bằng chứng là dữ kiện của notebook, không phụ thuộc
    việc model gọi tên quy định có đúng hay không.
    """
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

    if not finding.evidence:
        # Chỉ cáo buộc mới bắt buộc có bằng chứng; COMPLIANT/UNCLEAR thiếu bằng chứng là bình thường.
        if finding.status == constants.FINDING_VIOLATION:
            return [], {constants.VERIFY_EVIDENCE_MISSING}
        return [], set()
    if not verified:
        return [], {constants.VERIFY_EVIDENCE_INVALID}
    if len(verified) < len(finding.evidence):
        return verified, {constants.VERIFY_EVIDENCE_PARTIALLY_INVALID}
    return verified, set()


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
