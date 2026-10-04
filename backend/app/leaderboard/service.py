"""Best-submission ranking shared by participant, admin and export APIs."""

import asyncio
import time
import weakref
from collections import Counter, OrderedDict

from app.accounts.service import ACCOUNTS_COLLECTION
from app.core.datetimes import iso_z
from app.scoring import contracts
from app.submissions.service import SUBMISSIONS_COLLECTION, eligible_query

# Bảng xếp hạng thô được cache rất ngắn: đủ lâu để gộp các lượt đọc trùng nhau lúc đông người xem,
# đủ ngắn để bài nộp hay quyết định duyệt mới xuất hiện gần như tức thì. Trần entry chặn RAM.
_CACHE_MAX_ENTRIES = 128
_CACHE_TTL_SECONDS = 1.0


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


class _RankedEntriesCache:
    """Cache TTL ngắn + single-flight cho danh sách xếp hạng thô.

    - Khoá gồm danh tính DB, id cuộc thi và chiều xếp hạng nên hai cuộc thi, hai chiều hay hai DB
      không bao giờ dùng chung kết quả - kể cả khi nhiều test chạy trong cùng một tiến trình.
    - Chỉ cache danh sách thô đầy đủ metric; payload thí sinh vẫn lọc `visible_metrics` theo từng
      request nên cache không thể làm lộ metric bị ẩn.
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

    async def get(self, db, competition: dict, loader) -> list[dict]:
        # `MongoContext.db` trả một wrapper mới mỗi lần đọc nên id(db) không ổn định; client và tên
        # database mới là danh tính thật của nguồn dữ liệu.
        key = (id(db.client), db.name, competition["_id"], _rank_direction(competition))
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

    def _lookup(self, key, db) -> list[dict] | None:
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

    def _store(self, key, db, entries: list[dict]) -> None:
        self._entries[key] = (
            weakref.ref(db.client),
            time.monotonic() + self._ttl_seconds,
            entries,
        )
        self._entries.move_to_end(key)
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)


_ranked_entries_cache = _RankedEntriesCache()


async def cached_ranked_entries(db, competition: dict) -> list[dict]:
    """Bản cache ngắn hạn của `ranked_entries` cho hai đường leaderboard.

    Export không đi qua đây: file tải về phải khớp dữ liệu tại đúng thời điểm admin bấm.
    """
    return await _ranked_entries_cache.get(db, competition, ranked_entries)


def invalidate_competition(competition_id) -> None:
    """Bỏ cache của một cuộc thi ngay sau thao tác đổi tư cách tính điểm (duyệt/từ chối bài nộp)."""
    _ranked_entries_cache.invalidate(competition_id)


def _participant_entry(entry: dict, current_account_id, contract) -> dict:
    """Bỏ account_id và gắn cờ người xem - `me` dùng chung serializer này để không lộ định danh.

    `contract` là hợp đồng thí sinh: metric admin ẩn không rời khỏi backend.
    """
    item = {key: value for key, value in entry.items() if key != "account_id"}
    item["is_current_user"] = entry["account_id"] == str(current_account_id)
    contracts.apply_metric_visibility(item, contract)
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
    contract = contracts.participant_contract(competition)
    page = entries[offset : offset + limit]
    me = next(
        (entry for entry in entries if entry["account_id"] == str(current_account_id)), None
    )
    return {
        "competition_id": str(competition["_id"]),
        "primary_metric": contract.primary_metric,
        "entries": [_participant_entry(entry, current_account_id, contract) for entry in page],
        "total": len(entries),
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(page) < len(entries),
        "me": _participant_entry(me, current_account_id, contract) if me else None,
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
