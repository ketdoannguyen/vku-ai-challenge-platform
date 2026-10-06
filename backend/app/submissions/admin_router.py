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
from openpyxl.utils import get_column_letter
from pydantic import BaseModel

from app.accounts.service import ACCOUNTS_COLLECTION
from app.ai_review import constants as ai_constants
from app.ai_review import service as ai_service
from app.ai_review import serializers as ai_serializers
from app.auth.dependencies import AdminAccount
from app.competitions import tracks as competition_tracks
from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.config import get_settings
from app.core.datetimes import iso_z
from app.core.errors import api_error
from app.leaderboard import service as leaderboard_service
from app.scoring import contracts, models, normalization
from app.scoring.models import OutputContract
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
# Lịch sử kiểm tra của một bài nộp hiếm khi dài; cắt ở đây để response không phình theo số lần chạy lại.
_AI_HISTORY_LIMIT = 50


class ReviewBody(BaseModel):
    status: str
    note: str | None = None


@router.get("/{competition_id}/submissions")
async def list_submissions(
    competition_id: str,
    request: Request,
    admin: AdminAccount,
    q: str = "",
    status: str | None = None,
    review: str | None = None,
    ai_review: str = ai_constants.FILTER_AI_ALL,
    track: str | None = None,
    sort: str = service.DEFAULT_SORT,
    order: str = service.DEFAULT_ORDER,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    # Trong một cuộc thi, sort được theo đúng các khóa metric trong hợp đồng kết quả của nó.
    metric_fields = service.metric_sort_fields(competition)
    _validate_query_params(
        status,
        review,
        ai_review,
        sort,
        order,
        (*service.SCOPED_SORT_FIELDS, *metric_fields),
    )

    query: dict = {"competition_id": competition["_id"]}
    if track is not None:
        # Lọc nhánh là tùy chọn ở bảng admin: bỏ trống nghĩa là xem cả hai nhánh, mỗi dòng mang
        # `track` của nó. Cuộc thi single không có nhánh nào để lọc.
        if not competition_tracks.is_dual(competition) or track not in competition_tracks.TRACKS:
            raise api_error(422, "INVALID_TRACK", "Nhánh không hợp lệ; chỉ có public hoặc private.")
        query["track"] = track
    await _apply_filters(db, query, q, status, review, ai_review)
    total = await db[service.SUBMISSIONS_COLLECTION].count_documents(query)
    submissions = await service.list_admin_submissions(
        db,
        query,
        sort=sort,
        order=order,
        limit=limit,
        offset=offset,
        metric_fields=metric_fields,
    )
    accounts = await _accounts_by_id(db, [item["account_id"] for item in submissions])
    reviewers = await _accounts_by_id(db, _reviewer_ids(submissions))
    return {
        "submissions": [
            _admin_submission(
                item, accounts.get(item["account_id"]), reviewers.get(_reviewer_id(item))
            )
            for item in submissions
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
        "sort": sort,
        "order": order,
    }


@router.get("/{competition_id}/submissions/stats")
async def submission_scope_stats(
    competition_id: str,
    request: Request,
    admin: AdminAccount,
    track: str | None = None,
) -> dict:
    """Số lượt chấm theo trạng thái của một nhánh (hoặc cả cuộc thi single).

    Trang công bố Private đọc số liệu này để admin thấy còn bài đang chạy trước khi bấm công bố;
    nhánh bắt buộc với cuộc thi dual như mọi bề mặt một-population khác.
    """
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    resolved = _scoped_track(competition, track)
    return await service.scope_stats(db, competition["_id"], track=resolved)


@global_router.get("/submissions")
async def list_all_submissions(
    request: Request,
    admin: AdminAccount,
    competition_id: str | None = None,
    q: str = "",
    status: str | None = None,
    review: str | None = None,
    ai_review: str = ai_constants.FILTER_AI_ALL,
    sort: str = service.DEFAULT_SORT,
    order: str = service.DEFAULT_ORDER,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    db = request.app.state.mongo.db
    _validate_query_params(status, review, ai_review, sort, order, service.SORT_FIELDS)
    query: dict = {}
    if competition_id:
        try:
            query["competition_id"] = ObjectId(competition_id)
        except InvalidId:
            raise api_error(422, "VALIDATION_ERROR", "Cuộc thi không hợp lệ.")
    await _apply_filters(db, query, q, status, review, ai_review)

    # Bảng toàn cục cần cả bốn số tổng quan nên đếm trong một lượt `$facet`; `total` lấy từ đó.
    stats = await service.submission_stats(db, query)
    total = stats["total"]
    submissions = await service.list_admin_submissions(
        db, query, sort=sort, order=order, limit=limit, offset=offset
    )
    accounts = await _accounts_by_id(db, [item["account_id"] for item in submissions])
    reviewers = await _accounts_by_id(db, _reviewer_ids(submissions))
    competitions = await _competitions_by_id(db, [item["competition_id"] for item in submissions])
    return {
        "submissions": [
            {
                **_admin_submission(
                    item, accounts.get(item["account_id"]), reviewers.get(_reviewer_id(item))
                ),
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
        # Bảng toàn cục trộn nhiều cuộc thi với bộ metric khác nhau: trả metadata một lần theo từng
        # cuộc thi có mặt trong trang, để UI gắn nhãn metric đúng cho từng hàng.
        "competitions": _competition_contracts(competitions),
    }


@global_router.patch("/submissions/{submission_id}/review")
async def set_submission_review(
    submission_id: str, body: ReviewBody, request: Request, admin: AdminAccount
) -> dict:
    """Xét duyệt hậu kiểm một bài đã chấm điểm: từ chối kèm lý do, hoặc khôi phục về hợp lệ.

    Không chấm lại và không hoàn lượt nộp - `status`, metrics, artifact và bộ đếm quota giữ nguyên;
    thao tác chỉ đổi quyết định duyệt. Vì vậy phải tách khỏi `PUT`/`POST` của luồng nộp bài.
    """
    db = request.app.state.mongo.db
    if body.status not in service.REVIEW_STATUSES:
        raise api_error(422, "VALIDATION_ERROR", "Trạng thái duyệt không hợp lệ.")
    note = body.note.strip() if body.note else ""
    if body.status == service.REVIEW_STATUS_REJECTED:
        if not note or len(note) > service.MAX_REVIEW_NOTE_LENGTH:
            raise api_error(
                422,
                "VALIDATION_ERROR",
                f"Lý do không chấp nhận phải có 1-{service.MAX_REVIEW_NOTE_LENGTH} ký tự.",
            )
    elif body.note is not None:
        raise api_error(422, "VALIDATION_ERROR", "Khôi phục bài nộp không nhận lý do.")

    try:
        oid = ObjectId(submission_id)
    except InvalidId:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy bài nộp.")

    updated = await service.set_submission_review(
        db,
        oid,
        status=body.status,
        note=note if body.status == service.REVIEW_STATUS_REJECTED else None,
        reviewed_by=admin["_id"],
        now=datetime.now(timezone.utc),
    )
    if updated is None:
        # Update không khớp vì id sai hoặc vì record chưa chấm được điểm; phân biệt bằng một lượt đọc.
        exists = await db[service.SUBMISSIONS_COLLECTION].count_documents({"_id": oid}, limit=1)
        if not exists:
            raise api_error(404, "NOT_FOUND", "Không tìm thấy bài nộp.")
        raise api_error(
            422, "INVALID_TRANSITION", "Chỉ xét duyệt được bài đã chấm điểm thành công."
        )

    # Quyết định duyệt đổi tư cách tính điểm nên bảng xếp hạng đã cache phải bỏ ngay, không chờ TTL:
    # admin vừa từ chối xong phải thấy bài rời bảng ở lượt đọc kế tiếp.
    leaderboard_service.invalidate_competition(updated["competition_id"])
    account = await db[ACCOUNTS_COLLECTION].find_one({"_id": updated["account_id"]})
    # Nội dung lý do là dữ liệu của người dùng, không ghi vào log.
    logger.info(
        "Admin %s reviewed submission=%s decision=%s",
        admin["email"],
        oid,
        body.status,
    )
    return {"submission": _admin_submission(updated, account, admin)}


@global_router.get("/submissions/{submission_id}/ai-review")
async def get_submission_ai_review(
    submission_id: str, request: Request, admin: AdminAccount
) -> dict:
    """Chi tiết kiểm tra AI của một bài nộp: projection hiện tại, revision đã dùng, và lịch sử.

    Không trả raw prompt, raw response, object key hay API key - chỉ host của provider, model,
    phiên bản prompt và finding đã được backend kiểm lại bằng chứng.
    """
    db = request.app.state.mongo.db
    submission = await _submission_or_404(db, submission_id)
    competition = await db[COMPETITIONS_COLLECTION].find_one(
        {"_id": submission["competition_id"]}
    )
    account = await db[ACCOUNTS_COLLECTION].find_one({"_id": submission["account_id"]})
    return {
        "submission": {
            "id": str(submission["_id"]),
            "submission_no": submission.get("submission_no"),
            "status": submission["status"],
            "created_at": iso_z(submission["created_at"]),
            "account": {
                "id": str(submission["account_id"]),
                "name": account["name"] if account else "Tài khoản đã xóa",
                "email": account["email"] if account else "",
            },
            "competition": _competition_ref(
                competition, submission["competition_id"]
            ),
        },
        "ai_review": ai_serializers.admin_projection(submission),
        "content_snapshot": _snapshot_view(submission),
        "history": await ai_service.review_history(
            db, submission["_id"], limit=_AI_HISTORY_LIMIT
        ),
    }


@global_router.post("/submissions/{submission_id}/ai-review/rerun")
async def rerun_submission_ai_review(
    submission_id: str, request: Request, admin: AdminAccount
) -> dict:
    """Chạy lại AI trên đúng nội dung đã chốt lúc nộp; không chấm lại điểm và không đổi quyết định BTC."""
    db = request.app.state.mongo.db
    submission = await _submission_or_404(db, submission_id)
    competition = await db[COMPETITIONS_COLLECTION].find_one(
        {"_id": submission["competition_id"]}
    )
    if competition is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy bài nộp.")
    try:
        updated = await ai_service.request_manual_review(
            db,
            submission,
            competition=competition,
            settings=get_settings(),
            requested_by=admin["_id"],
            now=datetime.now(timezone.utc),
        )
    except ai_service.ReviewRequestInvalid as exc:
        raise api_error(422, exc.code, exc.message)
    except ai_service.ReviewInProgress as exc:
        raise api_error(409, exc.code, exc.message)
    logger.info(
        "AI review rerun requested admin=%s submission=%s", admin["email"], submission["_id"]
    )
    account = await db[ACCOUNTS_COLLECTION].find_one({"_id": updated["account_id"]})
    return {"submission": _admin_submission(updated, account)}


async def _submission_or_404(db, submission_id: str) -> dict:
    try:
        oid = ObjectId(submission_id)
    except InvalidId:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy bài nộp.")
    submission = await db[service.SUBMISSIONS_COLLECTION].find_one({"_id": oid})
    if submission is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy bài nộp.")
    return submission


def _snapshot_view(submission: dict) -> dict | None:
    """Ảnh chụp policy đã dùng cho bài này; `None` khi cuộc thi chưa từng bật AI lúc nộp."""
    snapshot = submission.get("content_snapshot")
    if not snapshot:
        return None
    return {
        "state": snapshot.get("state"),
        "revision_id": (
            str(snapshot["revision_id"]) if snapshot.get("revision_id") else None
        ),
        "content_hash": snapshot.get("content_hash"),
        "error_code": snapshot.get("error_code"),
        "captured_at": (
            iso_z(snapshot["captured_at"]) if snapshot.get("captured_at") else None
        ),
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
    submission = await _submission_or_404(db, submission_id)
    competition = await db[COMPETITIONS_COLLECTION].find_one(
        {"_id": submission["competition_id"]}
    )
    if competition is None:
        raise api_error(404, "NOT_FOUND", "Không tìm thấy bài nộp.")
    account = await db[ACCOUNTS_COLLECTION].find_one({"_id": submission["account_id"]})
    return await artifacts_reader.artifact_response(submission, competition, account, kind)


def _validate_query_params(
    status: str | None,
    review: str | None,
    ai_review: str,
    sort: str,
    order: str,
    sort_fields: tuple[str, ...],
) -> None:
    if status is not None and status not in _STATUSES:
        raise api_error(422, "VALIDATION_ERROR", "Trạng thái submission không hợp lệ.")
    # Ba trục độc lập, ba tham số: `status` là trạng thái chấm điểm, `review` là quyết định của
    # admin, `ai_review` là kết luận sơ bộ của AI. Không trục nào ghi đè trục nào.
    if review is not None and review not in service.REVIEW_STATUSES:
        raise api_error(422, "VALIDATION_ERROR", "Trạng thái duyệt không hợp lệ.")
    if ai_review not in ai_constants.AI_FILTERS:
        raise api_error(422, "VALIDATION_ERROR", "Bộ lọc AI không hợp lệ.")
    if sort not in sort_fields:
        raise api_error(422, "VALIDATION_ERROR", "Tiêu chí sắp xếp không hợp lệ.")
    if order not in service.SORT_ORDERS:
        raise api_error(422, "VALIDATION_ERROR", "Thứ tự sắp xếp không hợp lệ.")


async def _apply_filters(
    db, query: dict, q: str, status: str | None, review: str | None, ai_review: str
) -> None:
    if status:
        query["status"] = status
    if review:
        query.update(service.review_filter(review))
    query.update(service.ai_review_filter(ai_review))
    account_ids = await service.matching_account_ids(db, q)
    if account_ids is not None:
        query["account_id"] = {"$in": account_ids}


def _scoped_track(competition: dict, track: str | None) -> str | None:
    """Nhánh của một thao tác admin: cuộc thi dual bắt buộc chỉ rõ, single không có nhánh.

    Không có mặc định "cả hai nhánh": bảng xếp hạng và file export là dữ liệu của đúng một
    population, đoán nhánh là trộn hai bảng mà không ai xin.
    """
    try:
        return competition_tracks.resolve_track(competition, track)
    except competition_tracks.TrackError as exc:
        raise api_error(422, exc.code, exc.message)


@router.get("/{competition_id}/leaderboard")
async def admin_leaderboard(
    competition_id: str, request: Request, admin: AdminAccount, track: str | None = None
) -> dict:
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    resolved_track = _scoped_track(competition, track)
    board = await leaderboard_service.cached_ranked_board(db, competition, track=resolved_track)
    return leaderboard_service.admin_leaderboard_response(competition, board)


@router.get("/{competition_id}/export.xlsx")
async def export_results(
    competition_id: str, request: Request, admin: AdminAccount, track: str | None = None
) -> Response:
    db = request.app.state.mongo.db
    competition = await _competition_or_404(db, competition_id)
    resolved_track = _scoped_track(competition, track)
    # Export cố ý bỏ cache: file tải về phải khớp dữ liệu tại đúng thời điểm admin bấm.
    board = await leaderboard_service.ranked_board(db, competition, track=resolved_track)
    released = competition_tracks.results_visible(competition, resolved_track)
    content = _build_workbook(
        competition, board, track=resolved_track, released=released
    )
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    # Tên file nói rõ nhánh và trạng thái công bố: bản chưa release là bản tạm, không phải kết quả
    # chính thức - người cầm file phải thấy điều đó mà không cần mở cuộc thi.
    scope = f"-{resolved_track}" if resolved_track else ""
    state = "" if released else "-provisional"
    filename = f"{competition['slug']}{scope}{state}-results-{timestamp}.xlsx"
    logger.info(
        "Results exported admin=%s competition=%s track=%s released=%s entries=%s",
        admin["email"],
        competition["_id"],
        resolved_track,
        released,
        len(board.entries),
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


def _admin_submission(
    submission: dict, account: dict | None, reviewer: dict | None = None
) -> dict:
    item = service.submission_history_item(submission)
    item["account"] = {
        "id": str(submission["account_id"]),
        "name": account["name"] if account else "Tài khoản đã xóa",
        "email": account["email"] if account else "",
    }
    # Ghi đè shape participant-safe bằng shape đầy đủ của admin (có người duyệt và thời điểm).
    item[service.REVIEW_FIELD] = _admin_review(submission, reviewer)
    item["ai_review"] = ai_serializers.admin_projection(submission)
    return item


def _reviewer_id(submission: dict):
    """Id admin đã ra quyết định duyệt gần nhất; None nếu bài chưa từng bị xét duyệt."""
    return (submission.get(service.REVIEW_FIELD) or {}).get("reviewed_by")


def _reviewer_ids(submissions: list[dict]) -> list[ObjectId]:
    """Gom theo trang để tra tên người duyệt bằng một truy vấn `$in`, không N+1."""
    return [rid for item in submissions if (rid := _reviewer_id(item)) is not None]


def _admin_review(submission: dict, reviewer: dict | None) -> dict | None:
    """`None` khi bài chưa từng được xét duyệt - UI hiểu là mặc định hợp lệ."""
    review = submission.get(service.REVIEW_FIELD)
    if not review:
        return None
    return {
        "status": review["status"],
        "note": review.get("note"),
        "reviewed_at": iso_z(review["reviewed_at"]),
        "reviewed_by": {
            "id": str(review["reviewed_by"]) if review.get("reviewed_by") else "",
            "name": reviewer["name"] if reviewer else "Tài khoản đã xóa",
            "email": reviewer["email"] if reviewer else "",
        },
    }


def _competition_ref(competition: dict | None, competition_id) -> dict:
    if competition is None:
        return {"id": str(competition_id), "slug": "", "name": "Cuộc thi đã xóa"}
    return {
        "id": str(competition["_id"]),
        "slug": competition["slug"],
        "name": competition["name"],
    }


def _competition_contracts(competitions: dict) -> list[dict]:
    """Metadata metric của từng cuộc thi trong trang, kèm id để UI tra theo hàng.

    Cấu hình chuẩn hóa đi kèm ở khóa riêng, không trộn vào `result_contract`: hợp đồng là output
    của evaluator và giữ nguyên; norm chỉ đổi cách hiển thị/xếp hạng dẫn xuất.
    """
    return [
        {
            **_competition_ref(competition, competition["_id"]),
            "result_contract": contracts.contract_payload(competition),
            "normalization": normalization.config_view(competition),
        }
        for competition in competitions.values()
    ]


def _build_workbook(
    competition: dict,
    board: leaderboard_service.RankedBoard,
    *,
    track: str | None = None,
    released: bool = True,
) -> bytes:
    """Một cột cho mỗi metric trong hợp đồng kết quả, cùng thứ hạng và số liệu như UI.

    Cuộc thi bật chuẩn hóa có thêm cột **Norm hiện tại** ngay sau điểm gốc - đây là điểm xếp hạng
    thật của bảng, lấy từ đúng lần build ra `rank` nên không thể lệch nhau. Snapshot tạm của bài
    nộp không bao giờ lên cột này. `track`/`released` chỉ đi vào tên sheet để bản Private chưa
    công bố tự nói mình là bản tạm.
    """
    contract = contracts.result_contract(competition)
    metadata = board.normalization_metadata
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Results"
    if track is not None:
        sheet.title = f"Results {track}" + ("" if released else " (provisional)")
    header = ["Rank", "Account ID", "Team name", "Best score"]
    if metadata is not None:
        header.append(f"Norm hiện tại (0–{metadata['max_score']})")
    header.extend(metric.label for metric in contract.metrics)
    header.extend(("Best submission time", "Total submissions"))
    sheet.append(tuple(header))
    for entry in board.entries:
        # Bản ghi cũ có thể thiếu metric: để ô trống thay vì ghi 0.
        metrics = entry["metrics"] or {}
        row = [
            entry["rank"],
            entry["account_id"],
            _formula_safe(entry["display_name"]),
            entry["primary_score"],
        ]
        if metadata is not None:
            row.append(entry["normalized_score"])
        row.extend(metrics.get(metric.key) for metric in contract.metrics)
        row.extend((entry["best_submission_at"], entry["total_submissions"]))
        sheet.append(tuple(row))

    header_fill = PatternFill("solid", fgColor="DCE8F8")
    for cell in sheet[1]:
        cell.font = Font(bold=True)
        cell.fill = header_fill
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    widths = (
        8,
        26,
        28,
        14,
        *((16,) if metadata is not None else ()),
        *(12 for _ in contract.metrics),
        24,
        18,
    )
    for index, width in enumerate(widths, start=1):
        sheet.column_dimensions[get_column_letter(index)].width = width
    _apply_number_formats(sheet, contract, normalization=metadata)
    _append_info_sheet(workbook, competition, contract, normalization=metadata)

    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


# Bốn cột đầu của sheet Results trước khi tới cột norm (nếu bật) và các cột metric.
_FIRST_METRIC_COLUMN = 5


def _apply_number_formats(sheet, contract: OutputContract, *, normalization: dict | None) -> None:
    """Ghi số gốc kèm định dạng hiển thị theo `decimals` - giá trị lưu không bị làm tròn."""
    primary = _metric_by_key(contract, contract.primary_metric)
    formats = {4: primary.decimals if primary else 4}
    first_metric_column = _FIRST_METRIC_COLUMN
    if normalization is not None:
        # Cột norm chèn trước dãy metric nên mọi cột metric dịch phải một ô.
        formats[_FIRST_METRIC_COLUMN] = normalization["decimals"]
        first_metric_column += 1
    for offset, metric in enumerate(contract.metrics):
        formats[first_metric_column + offset] = metric.decimals
    for row in sheet.iter_rows(min_row=2):
        for column, decimals in formats.items():
            row[column - 1].number_format = _decimals_format(decimals)


def _decimals_format(decimals: int) -> str:
    return "0" if decimals <= 0 else f"0.{'0' * decimals}"


def _metric_by_key(contract: OutputContract, key: str | None):
    return next((metric for metric in contract.metrics if metric.key == key), None)


def _append_info_sheet(
    workbook: Workbook,
    competition: dict,
    contract: OutputContract,
    *,
    normalization: dict | None,
) -> None:
    """Sheet thông tin: bảng này đọc theo bộ chấm nào. Không chứa source, ground truth hay đường dẫn.

    Cuộc thi bật chuẩn hóa ghi thêm baseline, metric nguồn, mặt bằng và luật hòa điểm để file
    đứng độc lập với UI về sau.
    """
    config = models.stored_config_or_none(competition)
    primary = _metric_by_key(contract, contract.primary_metric)
    info = workbook.create_sheet("Info")
    info.append(("Competition", competition["name"]))
    info.append(("Evaluator", config.evaluator.name if config else "Bộ chấm cố định v1"))
    info.append(("Config revision", config.revision if config else "—"))
    info.append(("Primary metric", f"{primary.label} ({primary.key})" if primary else "—"))
    info.append(
        ("Ranking", "Higher is better" if contract.higher_is_better else "Lower is better")
    )
    if normalization is not None:
        direction = "Higher is better" if normalization["higher_is_better"] else "Lower is better"
        formula = (
            "50 × (s − baseline) ÷ (best − baseline)"
            if normalization["higher_is_better"]
            else "50 × (baseline − s) ÷ (baseline − best)"
        )
        reference = normalization["reference_best"]
        info.append(("Norm version", normalization["version"]))
        info.append(("Norm formula", formula))
        info.append(("Norm baseline", normalization["baseline"]))
        info.append(("Norm source", f"{normalization['source_metric']} ({direction})"))
        info.append(("Norm reference best", reference if reference is not None else "—"))
        info.append(("Norm tie-break", "Earlier eligible submission ranks higher on equal norm"))
    info.append(("Exported at", iso_z(datetime.now(timezone.utc))))
    info.append(("",))
    info.append(("Metric key", "Label", "Decimals"))
    for metric in contract.metrics:
        info.append((metric.key, metric.label, metric.decimals))


def _formula_safe(value: str) -> str:
    value = _XLSX_ILLEGAL_CHARACTERS.sub("", value)
    if value.startswith(("=", "+", "-", "@")):
        return f"'{value}"
    return value
