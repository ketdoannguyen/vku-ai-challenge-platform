"""Best-submission ranking shared by participant, admin and export APIs."""

from collections import Counter

from app.accounts.service import ACCOUNTS_COLLECTION
from app.core.datetimes import iso_z
from app.scoring import contracts
from app.submissions.service import SUBMISSIONS_COLLECTION, eligible_query


def _rank_direction(competition: dict) -> int:
    """Chiều sắp của metric chính: 1 khi chỉ số nhỏ hơn là tốt hơn, ngược lại -1.

    Bản nháp v2 chưa khai báo metric chính (`ranking()` trả None) không có bài nộp nào để xếp.
    """
    ranking = contracts.ranking(competition)
    return 1 if ranking and not ranking[1] else -1


async def ranked_entries(db, competition: dict) -> list[dict]:
    """Bài tốt nhất của mỗi account, xếp theo metric chính và chiều của hợp đồng kết quả."""
    # Participant, admin và file export dùng chung một tập eligible nên ba đường không thể lệch nhau.
    query = eligible_query({"competition_id": competition["_id"], "status": "completed"})
    cursor = db[SUBMISSIONS_COLLECTION].find(query).sort(
        [
            ("primary_score", _rank_direction(competition)),
            # Bằng điểm thì bài đạt điểm sớm hơn đứng trước, bất kể chiều xếp hạng.
            ("created_at", 1),
            ("account_id", 1),
            ("_id", 1),
        ]
    )
    submissions = [submission async for submission in cursor]
    counts = Counter(submission["account_id"] for submission in submissions)

    best = []
    seen = set()
    for submission in submissions:
        account_id = submission["account_id"]
        if account_id not in seen:
            seen.add(account_id)
            best.append(submission)

    accounts = {
        account["_id"]: account
        async for account in db[ACCOUNTS_COLLECTION].find({"_id": {"$in": list(seen)}})
    }
    entries = []
    for rank, submission in enumerate(best, start=1):
        account_id = submission["account_id"]
        account = accounts.get(account_id)
        entries.append(
            {
                "rank": rank,
                "account_id": str(account_id),
                "display_name": account["name"] if account else "Tài khoản đã xóa",
                "primary_score": submission["primary_score"],
                "metrics": submission["metrics"],
                "best_submission_id": str(submission["_id"]),
                "best_submission_at": iso_z(submission["created_at"]),
                "total_submissions": counts[account_id],
            }
        )
    return entries


def _participant_entry(entry: dict, current_account_id) -> dict:
    """Bỏ account_id và gắn cờ người xem - `me` dùng chung serializer này để không lộ định danh."""
    item = {key: value for key, value in entry.items() if key != "account_id"}
    item["is_current_user"] = entry["account_id"] == str(current_account_id)
    return item


def leaderboard_response(
    competition: dict,
    entries: list[dict],
    *,
    current_account_id=None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """Trang participant: `rank` giữ nguyên thứ hạng toàn cục; `me` tìm trên full list rồi mới cắt trang."""
    page = entries[offset : offset + limit]
    me = next(
        (entry for entry in entries if entry["account_id"] == str(current_account_id)), None
    )
    return {
        "competition_id": str(competition["_id"]),
        "primary_metric": _primary_metric(competition),
        "entries": [_participant_entry(entry, current_account_id) for entry in page],
        "total": len(entries),
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(page) < len(entries),
        "me": _participant_entry(me, current_account_id) if me else None,
    }


def admin_leaderboard_response(competition: dict, entries: list[dict]) -> dict:
    """Admin/export luôn nhận toàn bộ danh sách kèm account_id, không phân trang."""
    return {
        "competition_id": str(competition["_id"]),
        "primary_metric": _primary_metric(competition),
        "entries": entries,
        "total": len(entries),
    }


def _primary_metric(competition: dict) -> str | None:
    """Metric chính theo hợp đồng kết quả: v2 lấy từ khai báo của admin, v1 là metric lúc tạo cuộc thi."""
    ranking = contracts.ranking(competition)
    return ranking[0] if ranking else None
