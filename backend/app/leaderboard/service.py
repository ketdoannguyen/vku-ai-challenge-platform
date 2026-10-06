"""Best-submission ranking shared by participant, admin and export APIs."""

import asyncio
import logging
import time
import weakref
from collections import Counter, OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import partial

from app.accounts.service import ACCOUNTS_COLLECTION
from app.competitions import tracks as competition_tracks
from app.core.datetimes import iso_z
from app.scoring import contracts, normalization
from app.submissions.service import SUBMISSIONS_COLLECTION, eligible_query

logger = logging.getLogger(__name__)

# Bảng xếp hạng thô được cache rất ngắn: đủ lâu để gộp các lượt đọc trùng nhau lúc đông người xem,
# đủ ngắn để bài nộp hay quyết định duyệt mới xuất hiện gần như tức thì. Trần entry chặn RAM.
_CACHE_MAX_ENTRIES = 128
_CACHE_TTL_SECONDS = 1.0


@dataclass(frozen=True)
class RankedBoard:
    """Bảng đã xếp hạng kèm metadata chuẩn hóa của đúng lần dựng ra nó.

    Không suy `reference_best` từ các entry đã chọn: nhóm toàn 0 có thể chọn bài rất sớm với raw
    thấp, nên `max(entry.raw)` lúc đó không còn là best thực của cuộc thi. Metadata phải đi cùng
    entries như một gói để bảng, `me`, thẻ cuộc thi và file export không lệch nhau.
    """

    entries: list[dict] = field(default_factory=list)
    normalization_metadata: dict | None = None


def _rank_direction(competition: dict) -> int:
    """Chiều sắp của metric chính: 1 khi chỉ số nhỏ hơn là tốt hơn, ngược lại -1.

    Bản nháp v2 chưa khai báo metric chính (`ranking()` trả None) không có bài nộp nào để xếp.
    """
    ranking = contracts.ranking(competition)
    return 1 if ranking and not ranking[1] else -1


async def ranked_board(db, competition: dict, *, track: str | None = None) -> RankedBoard:
    """Bài đại diện của mỗi account, xếp theo norm khi cuộc thi bật chuẩn hóa, ngược lại theo raw.

    Nhánh chuẩn hóa tính norm cho **mọi** bài eligible rồi mới chọn bài đại diện: đội toàn 0 phải
    đứng theo bài 0 nộp sớm nhất, không phải theo bài raw tốt nhất của đội. `track` giới hạn bảng
    vào đúng một nhánh của cuộc thi dual; single không truyền track.
    """
    # Participant, admin và file export dùng chung một tập eligible nên ba đường không thể lệch nhau.
    rule = normalization.active_rule(competition)
    scope = {"competition_id": competition["_id"], "status": "completed"}
    if track is not None:
        # Bảng của dual chỉ gồm bài của đúng nhánh: hai population không bao giờ trộn.
        scope["track"] = track
    query = eligible_query(scope)
    cursor = db[SUBMISSIONS_COLLECTION].find(query)
    if rule is None:
        submissions = [
            submission
            async for submission in cursor.sort(
                [
                    ("primary_score", _rank_direction(competition)),
                    # Bằng điểm thì bài đạt điểm sớm hơn đứng trước, bất kể chiều xếp hạng.
                    ("created_at", 1),
                    ("account_id", 1),
                    ("_id", 1),
                ]
            )
        ]
        ranked = [(submission.get("primary_score"), submission) for submission in submissions]
        metadata = None
    else:
        submissions = [submission async for submission in cursor]
        usable = _usable(submissions)
        # Mẫu số tính trên TOÀN BỘ bài hợp lệ, trước khi chọn bài đại diện hay cắt trang.
        reference = normalization.reference_best(
            [submission["primary_score"] for submission in usable], rule.higher_is_better
        )
        ranked = _normalized(usable, rule, reference)
        metadata = normalization.board_metadata(
            rule, reference=reference, calculated_at=datetime.now(timezone.utc)
        )

    counts = Counter(submission["account_id"] for submission in submissions)
    best = _first_per_account(ranked)
    account_ids = [submission["account_id"] for _, submission in best]
    accounts = {
        account["_id"]: account
        async for account in db[ACCOUNTS_COLLECTION].find({"_id": {"$in": account_ids}})
    }
    entries = []
    for rank, (normalized_score, submission) in enumerate(best, start=1):
        account_id = submission["account_id"]
        account = accounts.get(account_id)
        entry = {
            "rank": rank,
            "account_id": str(account_id),
            "display_name": account["name"] if account else "Tài khoản đã xóa",
            "primary_score": submission["primary_score"],
            "metrics": submission["metrics"],
            "best_submission_id": str(submission["_id"]),
            "best_submission_at": iso_z(submission["created_at"]),
            "total_submissions": counts[account_id],
        }
        if metadata is not None:
            entry["normalized_score"] = normalized_score
        entries.append(entry)
    return RankedBoard(entries=entries, normalization_metadata=metadata)


def _valid(raw) -> bool:
    """Điểm gốc đọc từ DB phải là số hữu hạn thật; bản ghi hỏng bị loại khỏi cả bảng lẫn mẫu số."""
    return normalization.is_valid_score(raw)


def _usable(submissions: list[dict]) -> list[dict]:
    usable = [submission for submission in submissions if _valid(submission.get("primary_score"))]
    if len(usable) != len(submissions):
        logger.warning(
            "Bỏ %d bài nộp có điểm gốc không phải số hữu hạn khỏi bảng xếp hạng",
            len(submissions) - len(usable),
        )
    return usable


def _normalized(
    usable: list[dict], rule: normalization.Rule, reference: float | None
) -> list[tuple[float, dict]]:
    """`(norm, bài nộp)` của mọi bài dùng được, xếp `norm DESC` rồi mới tới thời điểm nộp.

    Hoà norm - kể cả cả bảng cùng 0 - phân định bằng bài được nhận sớm hơn; raw không bao giờ là
    tiêu chí phụ, vì làm vậy sẽ đảo ngược đúng thứ tự mà norm vừa quyết định.
    """
    ranked = [
        (
            normalization.score(
                submission["primary_score"],
                baseline=rule.baseline,
                reference=reference,
                higher_is_better=rule.higher_is_better,
            ),
            submission,
        )
        for submission in usable
    ]
    ranked.sort(
        key=lambda item: (
            -item[0],
            item[1]["created_at"],
            item[1]["account_id"],
            item[1]["_id"],
        )
    )
    return ranked


def _first_per_account(ranked: list[tuple]) -> list[tuple]:
    """Lấy bài đứng đầu của mỗi account trên danh sách ĐÃ xếp - giữ nguyên thứ tự toàn cục."""
    best: list[tuple] = []
    seen = set()
    for normalized_score, submission in ranked:
        account_id = submission["account_id"]
        if account_id not in seen:
            seen.add(account_id)
            best.append((normalized_score, submission))
    return best


class _RankedBoardCache:
    """Cache TTL ngắn + single-flight cho bảng xếp hạng đã dựng.

    - Khoá gồm danh tính DB, id cuộc thi, chiều xếp hạng và danh tính cấu hình chuẩn hóa nên hai
      cuộc thi, hai chiều, hai baseline hay hai DB không bao giờ dùng chung kết quả - kể cả khi
      nhiều test chạy trong cùng một tiến trình.
    - Chỉ cache bảng thô đầy đủ metric; payload thí sinh vẫn lọc `visible_metrics` và norm theo
      từng request nên cache không thể làm lộ metric bị ẩn.
    - Lượt đọc trùng khoá rơi vào lúc cache đang được nạp sẽ chờ chung một kết quả thay vì cùng
      chạy truy vấn.
    - `invalidate` tăng epoch: lượt nạp bắt đầu trước invalidate không được ghi lại vào cache và
      người đọc sau invalidate không chờ chung lượt nạp cũ, nên bản trước quyết định duyệt không
      thể quay lại phục vụ ai.
    """

    def __init__(
        self, *, max_entries: int = _CACHE_MAX_ENTRIES, ttl_seconds: float = _CACHE_TTL_SECONDS
    ) -> None:
        self._max_entries = max_entries
        self._ttl_seconds = ttl_seconds
        self._entries: OrderedDict[tuple, tuple] = OrderedDict()
        # Epoch tăng mỗi lần invalidate; lượt nạp ghi lại epoch lúc bắt đầu để biết mình còn hợp lệ.
        self._epoch = 0
        self._inflight: dict[tuple, tuple[int, asyncio.Future]] = {}

    async def get(self, db, competition: dict, loader, *, track: str | None = None) -> RankedBoard:
        # `MongoContext.db` trả một wrapper mới mỗi lần đọc nên id(db) không ổn định; client và tên
        # database mới là danh tính thật của nguồn dữ liệu.
        key = (
            id(db.client),
            db.name,
            competition["_id"],
            # Hai nhánh của cuộc thi dual là hai population riêng: chung khoá là trộn bảng.
            track,
            _rank_direction(competition),
            # Đổi baseline/nguồn là đổi luật xếp hạng: bảng cũ phải trượt khỏi cache ngay cả khi
            # entry còn trong TTL.
            *normalization.cache_identity(competition),
        )
        entries = self._lookup(key, db)
        if entries is not None:
            return entries

        epoch = self._epoch
        pending = self._inflight.get(key)
        if pending is not None and pending[0] == epoch:
            # Shield để một lượt chờ bỏ đi không hủy kết quả dùng chung của cả nhóm.
            return await asyncio.shield(pending[1])

        # Lượt nạp cũ (epoch khác) vẫn đang bay: người đọc lúc này tự nạp bản mới thay vì chờ chung
        # bản trước invalidate; future mới thay chỗ trong `_inflight` để lượt cũ không dọn nhầm.
        future = asyncio.get_running_loop().create_future()
        inflight = (epoch, future)
        self._inflight[key] = inflight
        try:
            entries = await loader(db, competition)
        except BaseException as exc:
            # Người đang chờ nhận đúng lỗi này thay vì treo; future không có ai chờ vẫn phải được
            # đánh dấu đã đọc để asyncio không log "exception was never retrieved".
            if not future.done():
                future.set_exception(exc)
                future.exception()
            raise
        finally:
            if self._inflight.get(key) is inflight:
                del self._inflight[key]
        # Invalid giữa chừng: bản trước quyết định duyệt không được quay lại cache.
        if self._epoch == epoch:
            self._store(key, db, entries)
        if not future.done():
            future.set_result(entries)
        return entries

    def invalidate(self, competition_id) -> None:
        # Tăng epoch trước khi xoá entry: lượt nạp đang bay của cuộc thi này trở thành cũ nên không
        # ghi lại cache, còn người đọc sau invalidate không chờ chung nó.
        self._epoch += 1
        stale = [key for key in self._entries if key[2] == competition_id]
        for key in stale:
            del self._entries[key]

    def _lookup(self, key, db) -> RankedBoard | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        client_ref, expires_at, entries = entry
        # DB của lượt test trước có thể đã bị thu hồi và id bộ nhớ được cấp lại cho DB khác.
        if client_ref() is not db.client or expires_at <= time.monotonic():
            del self._entries[key]
            return None
        self._entries.move_to_end(key)
        return entries

    def _store(self, key, db, board: RankedBoard) -> None:
        self._entries[key] = (
            weakref.ref(db.client),
            time.monotonic() + self._ttl_seconds,
            board,
        )
        self._entries.move_to_end(key)
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)


_ranked_board_cache = _RankedBoardCache()


async def cached_ranked_board(db, competition: dict, *, track: str | None = None) -> RankedBoard:
    """Bản cache ngắn hạn của `ranked_board` cho hai đường leaderboard và thẻ cuộc thi.

    Export không đi qua đây: file tải về phải khớp dữ liệu tại đúng thời điểm admin bấm.
    """
    return await _ranked_board_cache.get(
        db, competition, partial(ranked_board, track=track), track=track
    )


def invalidate_competition(competition_id) -> None:
    """Bỏ cache của một cuộc thi ngay sau thao tác đổi tư cách tính điểm (duyệt/từ chối bài nộp)."""
    _ranked_board_cache.invalidate(competition_id)


def _participant_entry(
    entry: dict, current_account_id, contract, *, normalization_visible: bool
) -> dict:
    """Bỏ account_id và gắn cờ người xem - `me` dùng chung serializer này để không lộ định danh.

    `contract` là hợp đồng thí sinh: metric admin ẩn không rời khỏi backend. `normalization_visible`
    false (bảng bị ẩn hoặc metric nguồn bị ẩn) thì điểm norm trả `null` - khoá vẫn có để UI biết
    cuộc thi đang bật chuẩn hóa, nhưng giá trị thì không.
    """
    item = {key: value for key, value in entry.items() if key != "account_id"}
    item["is_current_user"] = entry["account_id"] == str(current_account_id)
    if "normalized_score" in item and not normalization_visible:
        item["normalized_score"] = None
    contracts.apply_metric_visibility(item, contract)
    return item


def leaderboard_response(
    competition: dict,
    board: RankedBoard,
    *,
    track: str | None = None,
    current_account_id=None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """Trang participant: `rank` giữ nguyên thứ hạng toàn cục; `me` tìm trên full list rồi mới cắt trang.

    `track` là nhánh bảng đang phục vụ; người gọi phải tự chặn nhánh chưa công bố trước khi dựng
    payload - response này không có nhánh nào để che thêm.
    """
    contract = contracts.participant_contract(competition)
    # Đọc quyền xem một lần cho cả trang: mọi entry và metadata phải theo cùng một quyết định, và
    # quyết định đó là của đúng nhánh bảng đang phục vụ.
    normalization_visible = competition_tracks.can_view_norm(competition, track)[0]
    entries = board.entries
    page = entries[offset : offset + limit]
    me = next(
        (entry for entry in entries if entry["account_id"] == str(current_account_id)), None
    )
    payload = {
        "competition_id": str(competition["_id"]),
        "primary_metric": contract.primary_metric,
        "entries": [
            _participant_entry(
                entry, current_account_id, contract, normalization_visible=normalization_visible
            )
            for entry in page
        ],
        "total": len(entries),
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(page) < len(entries),
        "me": (
            _participant_entry(
                me, current_account_id, contract, normalization_visible=normalization_visible
            )
            if me
            else None
        ),
    }
    if track is not None:
        # Thí sinh phải biết bảng đang xem thuộc nhánh nào; single giữ hình dạng cũ.
        payload["track"] = track
    if board.normalization_metadata is not None:
        payload["normalization"] = (
            board.normalization_metadata if normalization_visible else None
        )
    return payload


def admin_leaderboard_response(competition: dict, board: RankedBoard) -> dict:
    """Admin/export luôn nhận toàn bộ danh sách kèm account_id và đủ metadata, không phân trang."""
    payload = {
        "competition_id": str(competition["_id"]),
        "primary_metric": _primary_metric(competition),
        "entries": board.entries,
        "total": len(board.entries),
    }
    if board.normalization_metadata is not None:
        payload["normalization"] = board.normalization_metadata
    return payload


def _primary_metric(competition: dict) -> str | None:
    """Metric chính theo hợp đồng kết quả: v2 lấy từ khai báo của admin, v1 là metric lúc tạo cuộc thi."""
    ranking = contracts.ranking(competition)
    return ranking[0] if ranking else None
