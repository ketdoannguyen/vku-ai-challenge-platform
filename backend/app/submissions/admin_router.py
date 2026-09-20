"""Admin submission history (per competition và toàn cục), leaderboard, artifact download, XLSX export."""

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
from app.submission_artifacts.naming import NOTEBOOK_ARTIFACT, PREDICTION_ARTIFACT
from app.submissions import artifacts as artifacts_reader
from app.submissions import service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/competitions")
# Bảng submission toàn cục không gắn cuộc thi nào nên tách prefix riêng.
global_router = APIRouter(prefix="/api/admin")
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
    sort: str = service.DEFAULT_SORT,
    order: str = service.DEFAULT_ORDER,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    _validate_query_params(status, sort, order, service.SCOPED_SORT_FIELDS)

    query: dict = {"competition_id": competition["_id"]}
    await _apply_filters(db, query, q, status)
    total = await db[service.SUBMISSIONS_COLLECTION].count_documents(query)
    submissions = await service.list_admin_submissions(
        db, query, sort=sort, order=order, limit=limit, offset=offset
    )
    accounts = await _accounts_by_id(db, [item["account_id"] for item in submissions])
    return {
        "submissions": [
            _admin_submission(item, accounts.get(item["account_id"])) for item in submissions
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
        "sort": sort,
        "order": order,
    }


@global_router.get("/submissions")
async def list_all_submissions(
    request: Request,
    admin: AdminAccount,
    competition_id: str | None = None,
    q: str = "",
    status: str | None = None,
    sort: str = service.DEFAULT_SORT,
    order: str = service.DEFAULT_ORDER,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    db = request.app.state.mongo.db
    _validate_query_params(status, sort, order, service.SORT_FIELDS)
    query: dict = {}
    if competition_id:
        try:
            query["competition_id"] = ObjectId(competition_id)
        except InvalidId:
            raise api_error(422, "VALIDATION_ERROR", "Cuộc thi không hợp lệ.")
    await _apply_filters(db, query, q, status)

    # Bảng toàn cục cần cả bốn số tổng quan nên đếm trong một lượt `$facet`; `total` lấy từ đó.
    stats = await service.submission_stats(db, query)
    total = stats["total"]
    submissions = await service.list_admin_submissions(
        db, query, sort=sort, order=order, limit=limit, offset=offset
    )
    accounts = await _accounts_by_id(db, [item["account_id"] for item in submissions])
    competitions = await _competitions_by_id(db, [item["competition_id"] for item in submissions])
    return {
        "submissions": [
            {
                **_admin_submission(item, accounts.get(item["account_id"])),
                "competition": _competition_ref(
                    competitions.get(item["competition_id"]), item["competition_id"]
                ),
            }
            for item in submissions
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
        "sort": sort,
        "order": order,
        "stats": stats,
    }


@global_router.get("/submissions/{submission_id}/prediction")
async def admin_download_prediction(
    submission_id: str, request: Request, admin: AdminAccount
) -> Response:
    return await _admin_download(request, submission_id, PREDICTION_ARTIFACT)


@global_router.get("/submissions/{submission_id}/notebook")
async def admin_download_notebook(
    submission_id: str, request: Request, admin: AdminAccount
) -> Response:
    return await _admin_download(request, submission_id, NOTEBOOK_ARTIFACT)


async def _admin_download(request: Request, submission_id: str, kind: str) -> Response:
    db = request.app.state.mongo.db
    try:
        oid = ObjectId(submission_id)
    except InvalidId:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy bài nộp.")
    submission = await db[service.SUBMISSIONS_COLLECTION].find_one({"_id": oid})
    if submission is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy bài nộp.")
    competition = await db[COMPETITIONS_COLLECTION].find_one(
        {"_id": submission["competition_id"]}
    )
    if competition is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy bài nộp.")
    account = await db[ACCOUNTS_COLLECTION].find_one({"_id": submission["account_id"]})
    return await artifacts_reader.artifact_response(submission, competition, account, kind)


def _validate_query_params(
    status: str | None, sort: str, order: str, sort_fields: tuple[str, ...]
) -> None:
    if status is not None and status not in _STATUSES:
        raise api_error(422, "VALIDATION_ERROR", "Trạng thái submission không hợp lệ.")
    if sort not in sort_fields:
        raise api_error(422, "VALIDATION_ERROR", "Tiêu chí sắp xếp không hợp lệ.")
    if order not in service.SORT_ORDERS:
        raise api_error(422, "VALIDATION_ERROR", "Thứ tự sắp xếp không hợp lệ.")


async def _apply_filters(db, query: dict, q: str, status: str | None) -> None:
    if status:
        query["status"] = status
    account_ids = await service.matching_account_ids(db, q)
    if account_ids is not None:
        query["account_id"] = {"$in": account_ids}


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


async def _accounts_by_id(db, account_ids: list[ObjectId]) -> dict[ObjectId, dict]:
    return {
        account["_id"]: account
        async for account in db[ACCOUNTS_COLLECTION].find({"_id": {"$in": account_ids}})
    }


async def _competitions_by_id(db, competition_ids: list[ObjectId]) -> dict[ObjectId, dict]:
    return {
        competition["_id"]: competition
        async for competition in db[COMPETITIONS_COLLECTION].find(
            {"_id": {"$in": competition_ids}}
        )
    }


def _admin_submission(submission: dict, account: dict | None) -> dict:
    item = service.submission_history_item(submission)
    item["account"] = {
        "id": str(submission["account_id"]),
        "name": account["name"] if account else "Tài khoản đã xóa",
        "email": account["email"] if account else "",
    }
    return item


def _competition_ref(competition: dict | None, competition_id) -> dict:
    if competition is None:
        return {"id": str(competition_id), "slug": "", "name": "Cuộc thi đã xóa"}
    return {
        "id": str(competition["_id"]),
        "slug": competition["slug"],
        "name": competition["name"],
    }


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
