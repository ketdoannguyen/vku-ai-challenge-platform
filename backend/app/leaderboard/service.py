"""Best-submission ranking shared by participant, admin and export APIs."""

from collections import Counter

from app.accounts.service import ACCOUNTS_COLLECTION
from app.submissions.service import SUBMISSIONS_COLLECTION, iso_datetime


async def ranked_entries(db, competition_id) -> list[dict]:
    query = {"competition_id": competition_id, "status": "completed"}
    cursor = db[SUBMISSIONS_COLLECTION].find(query).sort(
        [("primary_score", -1), ("created_at", 1), ("account_id", 1), ("_id", 1)]
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
                "best_submission_at": iso_datetime(submission["created_at"]),
                "total_submissions": counts[account_id],
            }
        )
    return entries


def leaderboard_response(
    competition: dict,
    entries: list[dict],
    *,
    current_account_id=None,
    include_account_id: bool = False,
) -> dict:
    response_entries = []
    for entry in entries:
        item = {key: value for key, value in entry.items() if key != "account_id"}
        if include_account_id:
            item["account_id"] = entry["account_id"]
        else:
            item["is_current_user"] = entry["account_id"] == str(current_account_id)
        response_entries.append(item)
    return {
        "competition_id": str(competition["_id"]),
        "primary_metric": competition["primary_metric"],
        "entries": response_entries,
        "total": len(response_entries),
    }
