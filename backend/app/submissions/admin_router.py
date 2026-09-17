"""Admin submission history, leaderboard and XLSX export."""

import logging
import re
from datetime import datetime, timezone
from io import BytesIO

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Query, Request, Response
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill

from app.accounts.service import ACCOUNTS_COLLECTION
from app.auth.dependencies import AdminAccount
from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.errors import api_error
from app.leaderboard import service as leaderboard_service
from app.submissions import service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/competitions")
_STATUSES = {"completed", "rejected", "failed"}
_XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_XLSX_ILLEGAL_CHARACTERS = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F]")


@router.get("/{competition_id}/submissions")
async def list_submissions(
    competition_id: str,
    request: Request,
    admin: AdminAccount,
    q: str = "",
    status: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    if status is not None and status not in _STATUSES:
        raise api_error(422, "VALIDATION_ERROR", "Trạng thái submission không hợp lệ.")

    query: dict = {"competition_id": competition["_id"]}
    if status:
        query["status"] = status
    account_ids = await _matching_account_ids(db, q)
    if account_ids is not None:
        query["account_id"] = {"$in": account_ids}

    collection = db[service.SUBMISSIONS_COLLECTION]
    total = await collection.count_documents(query)
    cursor = collection.find(query).sort([("created_at", -1), ("_id", -1)]).skip(offset).limit(limit)
    submissions = [item async for item in cursor]
    accounts = await _accounts_by_id(db, [item["account_id"] for item in submissions])
    return {
        "submissions": [_admin_submission(item, accounts.get(item["account_id"])) for item in submissions],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/{competition_id}/leaderboard")
async def admin_leaderboard(
    competition_id: str, request: Request, admin: AdminAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    entries = await leaderboard_service.ranked_entries(db, competition["_id"])
    return leaderboard_service.admin_leaderboard_response(competition, entries)


@router.get("/{competition_id}/export.xlsx")
async def export_results(
    competition_id: str, request: Request, admin: AdminAccount
) -> Response:
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    entries = await leaderboard_service.ranked_entries(db, competition["_id"])
    content = _build_workbook(entries)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    filename = f"{competition['slug']}-results-{timestamp}.xlsx"
    logger.info(
        "Results exported admin=%s competition=%s entries=%s",
        admin["email"],
        competition["_id"],
        len(entries),
    )
    return Response(
        content,
        media_type=_XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def _competition_or_404(db, competition_id: str) -> dict:
    try:
        object_id = ObjectId(competition_id)
    except InvalidId:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    competition = await db[COMPETITIONS_COLLECTION].find_one({"_id": object_id})
    if competition is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    return competition


async def _matching_account_ids(db, query: str) -> list[ObjectId] | None:
    query = query.strip()
    if not query:
        return None
    pattern = re.compile(re.escape(query), re.IGNORECASE)
    cursor = db[ACCOUNTS_COLLECTION].find(
        {"$or": [{"name": pattern}, {"email": pattern}]}, {"_id": 1}
    )
    return [account["_id"] async for account in cursor]


async def _accounts_by_id(db, account_ids: list[ObjectId]) -> dict[ObjectId, dict]:
    return {
        account["_id"]: account
        async for account in db[ACCOUNTS_COLLECTION].find({"_id": {"$in": account_ids}})
    }


def _admin_submission(submission: dict, account: dict | None) -> dict:
    item = service.submission_history_item(submission)
    item["account"] = {
        "id": str(submission["account_id"]),
        "name": account["name"] if account else "Tài khoản đã xóa",
        "email": account["email"] if account else "",
    }
    return item


def _build_workbook(entries: list[dict]) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Results"
    headers = (
        "Rank",
        "Account ID",
        "Team name",
        "Best score",
        "F1",
        "Precision",
        "Recall",
        "Best submission time",
        "Total submissions",
    )
    sheet.append(headers)
    for entry in entries:
        metrics = entry["metrics"]
        sheet.append(
            (
                entry["rank"],
                entry["account_id"],
                _formula_safe(entry["display_name"]),
                entry["primary_score"],
                metrics["f1"],
                metrics["precision"],
                metrics["recall"],
                entry["best_submission_at"],
                entry["total_submissions"],
            )
        )

    header_fill = PatternFill("solid", fgColor="DCE8F8")
    for cell in sheet[1]:
        cell.font = Font(bold=True)
        cell.fill = header_fill
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    widths = (8, 26, 28, 14, 12, 12, 12, 24, 18)
    for index, width in enumerate(widths, start=1):
        sheet.column_dimensions[chr(64 + index)].width = width

    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


def _formula_safe(value: str) -> str:
    value = _XLSX_ILLEGAL_CHARACTERS.sub("", value)
    if value.startswith(("=", "+", "-", "@")):
        return f"'{value}"
    return value
