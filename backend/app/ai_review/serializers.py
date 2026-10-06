"""Chuyển projection AI trên submission thành payload an toàn cho participant và admin.

Participant chỉ thấy trạng thái và kết luận, không bao giờ thấy mã lỗi kỹ thuật, tên provider, model,
finding hay bằng chứng. Admin thấy đủ để làm việc nhưng vẫn không thấy key, raw prompt hay raw body.
"""

from app.ai_review import constants
from app.core.datetimes import iso_z

# Tóm tắt an toàn theo verdict: participant không nhận error code hay chi tiết provider.
_VERDICT_SUMMARIES = {
    constants.VERDICT_CLEAR: "AI không phát hiện dấu hiệu vi phạm thể lệ trong notebook.",
    constants.VERDICT_FLAGGED: "AI phát hiện dấu hiệu cần ban tổ chức xem lại.",
    constants.VERDICT_INCONCLUSIVE: "AI chưa đủ căn cứ để kết luận.",
}


def participant_projection(submission: dict, participant_visible: bool) -> dict | None:
    """Projection cho participant; `None` khi cuộc thi không công khai trạng thái AI.

    KHÔNG bao giờ trả `participant_summary`: gợi ý của model là bản nháp cho admin đọc. Chữ duy
    nhất tới tay thí sinh vẫn là `submissions.review.note` do người duyệt gửi (ADR-035).
    """
    if not participant_visible:
        return None
    projection = submission.get("ai_review")
    if not projection:
        return None
    state = projection.get("state")
    verdict = projection.get("verdict") if state == constants.AI_STATE_COMPLETED else None
    # Lượt hỏng phải nói đúng sự thật: báo "đang kiểm tra" khi state là ERROR là nói dối thí sinh.
    summary = (
        constants.PARTICIPANT_ERROR_SUMMARY
        if state == constants.AI_STATE_ERROR
        else _VERDICT_SUMMARIES.get(verdict) or constants.PARTICIPANT_QUEUED_SUMMARY
    )
    return {
        "state": state,
        "verdict": verdict,
        "summary": summary,
        "updated_at": iso_z(projection["updated_at"]) if projection.get("updated_at") else None,
    }


def admin_projection(submission: dict) -> dict | None:
    """Projection cho admin: thêm generation/run_id và tóm tắt do AI viết khi đã có kết luận."""
    projection = submission.get("ai_review")
    if not projection:
        return None
    state = projection.get("state")
    return {
        "state": state,
        "verdict": projection.get("verdict"),
        "summary": projection.get("summary"),
        "participant_summary": projection.get("participant_summary"),
        "generation": projection.get("generation"),
        "run_id": projection.get("run_id"),
        # Chỉ tin trạng thái nguồn khi version khớp phiên bản hiện hành: dữ liệu sót từ code khác
        # không được hiển thị như kết quả mới.
        "source_status": (
            projection.get("source_status")
            if projection.get("source_signal_version") == constants.SOURCE_SIGNAL_VERSION
            else None
        ),
        "source_signal_version": projection.get("source_signal_version"),
        "latest_review_id": (
            str(projection["latest_review_id"]) if projection.get("latest_review_id") else None
        ),
        "requested_at": (
            iso_z(projection["requested_at"]) if projection.get("requested_at") else None
        ),
        "updated_at": iso_z(projection["updated_at"]) if projection.get("updated_at") else None,
    }


def review_detail(review: dict) -> dict:
    """Một dòng audit đã che: chỉ host (không full URL), không key, không raw payload."""
    return {
        "id": str(review["_id"]),
        "run_id": review["run_id"],
        "generation": review["generation"],
        "status": review["status"],
        "verdict": review["verdict"],
        "model_verdict": review.get("model_verdict"),
        "summary": review["summary"],
        "participant_summary": review.get("participant_summary"),
        "findings": review.get("findings") or [],
        "source_assessment": review.get("source_assessment"),
        # `source_signals` chỉ còn để đọc lịch sử: row mới không bao giờ có field này.
        "source_signals": review.get("source_signals") or [],
        "resources_configured": review.get("resources_configured", 0),
        "resources_in_notebook": review.get("resources_in_notebook"),
        "notebook_stats": review.get("notebook_stats") or {},
        "provider": review.get("provider"),
        "provider_host": review.get("provider_host"),
        "model": review.get("model"),
        # `.get()` chứ không phải `[...]`: audit row ghi trước Hybrid B+D không có ba version dưới,
        # và một dòng lịch sử thiếu field không được làm hỏng cả endpoint.
        "versions": {
            "prompt": review.get("prompt_version"),
            "normalization": review.get("normalization_version"),
            "context_policy": review.get("context_policy_version"),
            "canonicalization": review.get("canonicalization_version"),
            "rule_ref": review.get("rule_ref_version"),
            "verifier": review.get("verifier_version"),
            "source_signal": review.get("source_signal_version"),
        },
        "source": review.get("source"),
        "reused_from_review_id": (
            str(review["reused_from_review_id"]) if review.get("reused_from_review_id") else None
        ),
        "bypass_cache": review.get("bypass_cache", False),
        "manual": review.get("manual", False),
        "attempts": review.get("attempts"),
        "downgrade_codes": review.get("downgrade_codes") or [],
        "error": review.get("error"),
        "started_at": iso_z(review["started_at"]) if review.get("started_at") else None,
        "completed_at": iso_z(review["completed_at"]) if review.get("completed_at") else None,
        "duration_ms": review.get("duration_ms"),
        "created_at": iso_z(review["created_at"]),
    }
