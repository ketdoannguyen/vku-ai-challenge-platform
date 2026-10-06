"""Cổng admission nguyên tử của cuộc thi hai nhánh (ADR-064).

Mongo standalone không có transaction đa document, nên thời điểm nhận bài được chốt bằng một
`find_one_and_update` duy nhất trên document competition: filter tự kiểm mode, lifecycle và cửa sổ
nhánh tại đúng thao tác DB, thao tác ghi tăng `tracks.<track>.admission_seq` và trả về snapshot
để lượt nộp ghim lại ngữ cảnh đã nhận. Cửa sổ nửa mở `start_at <= admitted_at < end_at`, giờ
server; thời gian của gate không lấy từ đầu request vì upload và chờ quota cũng nằm trong đó.
"""

from datetime import datetime

from pymongo import ReturnDocument

from app.competitions.service import COMPETITIONS_COLLECTION
from app.competitions import tracks as competition_tracks
from app.core.datetimes import as_utc


async def confirm(db, competition_id, track: str, *, now: datetime) -> dict | None:
    """Chốt admission của một nhánh; trả snapshot, hoặc None khi cửa đã đóng tại thao tác DB.

    Không so lại `control_revision` đã đọc trước đó: công bố kết quả hay đổi lịch xen giữa không
    làm lượt đang nộp sai - lịch tại thời điểm ghi mới là thứ quyết định. Người gọi đọc lại
    document khi nhận None để dịch thành lỗi cụ thể.
    """
    updated = await db[COMPETITIONS_COLLECTION].find_one_and_update(
        {
            "_id": competition_id,
            "mode": competition_tracks.MODE_DUAL,
            "status": "published",
            f"tracks.{track}.start_at": {"$lte": now},
            f"tracks.{track}.end_at": {"$gt": now},
        },
        {"$inc": {f"tracks.{track}.admission_seq": 1}},
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        return None
    config = updated["tracks"][track]
    # Sequence tăng nhưng intent chết là khoảng trống hợp lệ: gate không hứa mọi số đã cấp đều
    # thành một bài hoàn chỉnh, nên các bước sau không được đoán thành công từ sequence.
    return {
        "admitted_at": now,
        "admitted_end_at": config["end_at"],
        "control_revision": int(updated.get("control_revision", 1)),
        "stop_generation": int(updated.get("stop_generation", 0)),
        "admission_seq": int(config.get("admission_seq", 0)),
    }


async def closed_reason(db, competition_id, track: str, *, now: datetime) -> tuple[str, str]:
    """Vì sao cổng đã đóng, đọc lại ngay tại thời điểm trả lời thí sinh.

    Chỉ gọi sau khi `confirm` trả None; lúc đó lý do là một trong ba: cuộc thi không còn nhận
    bài, nhánh chưa mở, hoặc cửa sổ đã qua - kể cả trường hợp upload xong sau `end_at`.
    """
    competition = await db[COMPETITIONS_COLLECTION].find_one({"_id": competition_id})
    config = competition_tracks.track_config(competition or {}, track)
    if competition is None or competition["status"] != "published" or config is None:
        return "SUBMISSION_CLOSED", "Cuộc thi hiện không nhận bài nộp."
    if now < as_utc(config["start_at"]):
        return "SUBMISSION_NOT_OPEN", "Nhánh này chưa mở nhận bài."
    return "SUBMISSION_DEADLINE_PASSED", "Nhánh này đã hết hạn nộp bài."
