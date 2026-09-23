"""Schema Pydantic cho output của model.

`extra="forbid"` ở mọi object chính là hàng rào chống model tự thêm field ngoài hợp đồng (ví dụ
`confidence`); field lạ làm cả response không hợp lệ và pipeline trả ERROR thay vì đoán.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.ai_review import constants

_VERDICT = Literal["CLEAR", "FLAGGED", "INCONCLUSIVE"]
_CHECKABILITY = Literal["CHECKABLE_FROM_NOTEBOOK", "NOT_CHECKABLE_FROM_NOTEBOOK"]
_FINDING_STATUS = Literal["VIOLATION", "COMPLIANT", "UNCLEAR"]


def _text(max_length: int) -> type[str]:
    return Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=max_length)
    ]


class ModelEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cell: int = Field(ge=1)
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    # Model vẫn phải kể ra đoạn code, nhưng backend BỎ giá trị này và tự dựng lại từ notebook đã
    # normalize - nên nó không bắt buộc và không bao giờ được lưu nguyên văn.
    snippet: str = ""


class ModelFinding(BaseModel):
    """Một nhận định của model, neo vào `rule_ref` chứ không vào văn bản do model tự viết.

    Backend tự điền title, slug và rule text từ revision sau khi resolve ref (ADR-045). Nhờ vậy
    model không thể đưa prose của mình vào audit row dưới danh nghĩa "trích nguyên văn thể lệ".
    """

    model_config = ConfigDict(extra="forbid")

    rule_ref: _text(constants.MAX_RULE_REF_CHARS)
    # Bản sao nguyên văn của block để làm đường dự phòng khi ref bị sai và để người đọc đối chiếu.
    # KHÔNG phải nguồn sự thật: giá trị lưu trữ luôn lấy từ revision.
    rule_quote: Annotated[
        str, StringConstraints(strip_whitespace=True, max_length=constants.MAX_RULE_TEXT_CHARS)
    ] = ""
    checkability: _CHECKABILITY
    status: _FINDING_STATUS
    reason: _text(constants.MAX_REASON_CHARS)
    evidence: list[ModelEvidence] = Field(
        default_factory=list, max_length=constants.MAX_EVIDENCE_PER_FINDING
    )


class ModelReviewOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verdict: _VERDICT
    summary: _text(constants.MAX_SUMMARY_CHARS)
    # Câu gợi ý ngắn để admin duyệt trước khi gửi cho thí sinh. KHÔNG dùng `_text()`: helper đó đặt
    # `min_length=1`, mà "không có gì để nói" lại là câu trả lời hợp lệ - biến nó thành lỗi là làm
    # hỏng cả lượt review vì thiếu một field phụ.
    participant_summary: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True, max_length=constants.MAX_PARTICIPANT_SUMMARY_CHARS
        ),
    ] = ""
    findings: list[ModelFinding] = Field(
        default_factory=list, max_length=constants.MAX_FINDINGS
    )
