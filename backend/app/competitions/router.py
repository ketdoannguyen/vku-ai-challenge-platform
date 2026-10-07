"""Participant competition API: list published/closed, detail by slug. Draft luôn ẩn.

Thẻ giới thiệu vẫn công khai cho mọi người, nhưng nội dung bên trong cuộc thi chỉ dành cho
thành viên đang hoạt động hoặc admin. List/detail trả `access` để frontend biết mở hay khóa
landing; `resources`/`submission_config` chỉ xuất hiện khi quyền đọc được cấp (xem
`app.competitions.access`). Draft vẫn ẩn với mọi đối tượng.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Request

from app.accounts import service as accounts_service
from app.auth.dependencies import CurrentAccount, OptionalAccount
from app.competitions import service
from app.competitions import tracks as competition_tracks
from app.core.errors import api_error
from app.leaderboard import service as leaderboard_service
from app.scoring import normalization
from app.submissions import service as submissions_service

router = APIRouter(prefix="/api/competitions")


@router.get("")
async def list_visible_competitions(request: Request, account: OptionalAccount) -> dict:
    from app.memberships.service import memberships_by_competition

    db = request.app.state.mongo.db
    competitions = [
        competition
        async for competition in db[service.COMPETITIONS_COLLECTION]
        .find({"status": {"$in": ["published", "closed"]}})
        .sort("name", 1)
    ]
    competition_ids = [competition["_id"] for competition in competitions]
    # Khách không có phiên thì không cần truy vấn membership - public_membership(None) đã đủ.
    memberships = (
        await memberships_by_competition(db, competition_ids, account["_id"]) if account else {}
    )
    now = datetime.now(timezone.utc)
    # Nhánh chưa tới giờ mở không đóng góp con số nào vào thẻ cuộc thi: cả tổng bài công khai lẫn
    # số liệu cá nhân đều bỏ qua nhánh đó, để dời lịch về sau không kéo theo rò rỉ gián tiếp.
    excluded_tracks = {}
    for competition in competitions:
        locked = competition_tracks.locked_tracks(competition, now=now)
        if locked:
            excluded_tracks[competition["_id"]] = locked
    submission_counts = await service.submission_counts(
        db, competition_ids, excluded_tracks=excluded_tracks or None
    )
    # Số liệu cá nhân (hạng/điểm/bài đã nộp) chỉ có nghĩa với thành viên đang hoạt động - người
    # chưa tham gia hoặc đã bị vô hiệu hóa không nhận gì. Một aggregation cho cả trang, không
    # truy vấn per-card; không có cuộc thi nào đủ điều kiện thì bỏ luôn lượt đọc.
    active_id_set = {
        competition_id
        for competition_id, membership in memberships.items()
        if membership.get("active", True)
    }
    my_stats = (
        await submissions_service.my_stats_by_competition(
            db, competition_ids, account["_id"], now, excluded_tracks=excluded_tracks or None
        )
        if active_id_set
        else {}
    )
    # Account doc đã nằm sẵn trong request.state từ middleware - không tốn truy vấn cho cờ ghim.
    pinned_ids = set(account.get(accounts_service.PINNED_COMPETITIONS_FIELD) or []) if account else set()
    return {
        "competitions": [
            {
                **service.competition_summary(
                    competition, memberships.get(competition["_id"]), account
                ),
                "submission_count": submission_counts[competition["_id"]],
                "pinned": competition["_id"] in pinned_ids,
                **(
                    await _my_stats_payload(
                        db, competition, account["_id"], my_stats[competition["_id"]], now=now
                    )
                    if competition["_id"] in active_id_set
                    else {}
                ),
            }
            for competition in competitions
        ]
    }


async def _my_stats_payload(
    db, competition: dict, account_id, counts_by_track: dict, *, now: datetime
) -> dict:
    """Số liệu cá nhân trên thẻ cuộc thi: dual tách hẳn hai nhánh, single giữ `my_stats` cũ.

    Dual không có số gộp: hai nhánh là hai bảng riêng, và nhánh Private chưa công bố chỉ trả quota
    chứ không trả hạng/điểm - kể cả cho chính chủ bài.
    """
    if not competition_tracks.is_dual(competition):
        counts = counts_by_track.get(None, submissions_service.EMPTY_COUNTS)
        return {
            "my_submission_count": counts["total"],
            "my_stats": await _my_stats(db, competition, account_id, counts, now=now),
        }
    return {
        "my_submission_count": sum(counts["total"] for counts in counts_by_track.values()),
        "my_stats_by_track": {
            track: await _my_stats(
                db,
                competition,
                account_id,
                counts_by_track.get(track, submissions_service.EMPTY_COUNTS),
                track=track,
                now=now,
            )
            for track in competition_tracks.TRACKS
        },
    }


async def _my_stats(
    db, competition: dict, account_id, counts: dict, *, track: str | None = None, now: datetime
) -> dict:
    """Hạng/điểm tốt nhất của thành viên đang hoạt động, lấy từ đúng bảng xếp hạng của nhánh.

    Không tự tính lại thứ hạng: `leaderboard_response` giữ nguyên quy tắc tie-break, chiều metric
    và lọc metric ẩn của bảng. Bảng bị ẩn thì không trả hạng/điểm và không tốn lượt đọc bảng;
    nhánh Private chưa công bố cũng vậy, chỉ quota là số thật. `best_score` là raw của đúng bài đại
    diện nên không hứa là raw tốt nhất của đội; norm hiện tại nằm ở `best_normalized_score`, null
    khi cuộc thi không bật norm hoặc người xem không được xem.

    Nhánh chưa tới giờ mở đứng trước mọi luật trên: không đọc bảng, không trả hạng/điểm - chốt
    chặn thứ hai sau khi truy vấn đếm đã loại nhánh đó.
    """
    stats = {
        "rank": None,
        "rank_total": None,
        "best_score": None,
        "best_normalized_score": None,
        "used_today": counts["today"],
    }
    if competition_tracks.track_locked(competition, track, now):
        return stats
    if not competition_tracks.results_visible(competition, track):
        return stats
    if not competition["leaderboard_visible"] or counts["eligible_count"] == 0:
        return stats
    try:
        board = await leaderboard_service.cached_ranked_board(db, competition, track=track)
    except normalization.NormalizationError:
        # Cấu hình norm hỏng (chỉ tới được bằng sửa tay ngoài API): thẻ vẫn phải mở được với số
        # liệu null, còn BXH của chính cuộc thi đó vẫn thất bại ồn ào thay vì xếp theo luật sai.
        return stats
    response = leaderboard_service.leaderboard_response(
        competition, board, track=track, current_account_id=account_id, limit=1
    )
    me = response["me"]
    if me is not None:
        stats["rank"] = me["rank"]
        stats["rank_total"] = response["total"]
        stats["best_score"] = me["primary_score"]
        stats["best_normalized_score"] = me.get("normalized_score")
    return stats


@router.get("/{slug}")
async def get_competition_by_slug(slug: str, request: Request, account: OptionalAccount) -> dict:
    from app.memberships.service import get_membership

    db = request.app.state.mongo.db
    competition = await service.find_competition_by_slug(db, slug)
    if competition is None or competition["status"] == "draft":
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    membership = await get_membership(db, competition["_id"], account["_id"]) if account else None
    payload = service.public_competition(competition, membership, account)
    # Quota chỉ tốn một count_documents nên chỉ tính khi thật sự dùng được: thành viên đang
    # hoạt động của cuộc thi đang mở. List cố ý không tính để tránh N+1. Dual không có quota cấp
    # cuộc thi: mỗi nhánh một bộ đếm riêng, cùng nguồn với `remaining_quota` của lượt nộp nên thẻ
    # nhánh và receipt không lệch.
    if (
        account
        and membership is not None
        and membership.get("active", True)
        and competition["status"] == "published"
    ):
        now = datetime.now(timezone.utc)
        if competition_tracks.is_dual(competition):
            for track, entry in (payload.get("tracks") or {}).items():
                if competition_tracks.track_locked(competition, track, now):
                    # Nhánh chưa mở: số đã dùng suy từ bài cũ nên đi cùng số phận với bài.
                    continue
                entry["quota"] = await submissions_service.quota_status(
                    db,
                    competition["_id"],
                    account["_id"],
                    competition_tracks.track_quota(competition, track),
                    now,
                    track=track,
                )
        else:
            payload["quota"] = await submissions_service.quota_status(
                db, competition["_id"], account["_id"], competition["quota_per_day"], now
            )
    return payload


@router.put("/{slug}/pin")
async def pin_competition(slug: str, request: Request, account: CurrentAccount) -> dict:
    """Ghim cuộc thi cho account hiện tại - sở thích riêng, không đòi hỏi membership."""
    return await _set_pin(request, account, slug, pinned=True)


@router.delete("/{slug}/pin")
async def unpin_competition(slug: str, request: Request, account: CurrentAccount) -> dict:
    return await _set_pin(request, account, slug, pinned=False)


async def _set_pin(request: Request, account: dict, slug: str, *, pinned: bool) -> dict:
    """Trả trạng thái SAU thao tác (PUT luôn true, DELETE luôn false) để gọi lặp vẫn nhất quán."""
    db = request.app.state.mongo.db
    competition = await service.find_competition_by_slug(db, slug)
    if competition is None or competition["status"] == "draft":
        raise api_error(404, "NOT_FOUND", "Không tìm thấy cuộc thi.")
    await accounts_service.set_competition_pin(
        db, account["_id"], competition["_id"], pinned=pinned
    )
    return {"competition_id": str(competition["_id"]), "pinned": pinned}
