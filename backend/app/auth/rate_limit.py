"""Process-local attempt limiter for the single-process MVP API (login + signup)."""

import math
import time
from collections import deque
from collections.abc import Callable
from threading import Lock

from app.core.config import get_settings


class AttemptLimiter:
    def __init__(
        self,
        max_failures: int = 10,
        window_seconds: int = 15 * 60,
        max_identifiers: int = 10_000,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self.max_identifiers = max_identifiers
        self._clock = clock
        self._failures: dict[str, deque[float]] = {}
        self._lock = Lock()

    def retry_after(self, identifier: str) -> int | None:
        now = self._clock()
        with self._lock:
            self._prune(now)
            failures = self._failures.get(identifier)
            if failures is None or len(failures) < self.max_failures:
                return None
            return max(1, math.ceil(self.window_seconds - (now - failures[0])))

    def is_blocked(self, identifier: str) -> int | None:
        """Signup không có "lần sai" để đếm - mọi lượt đều tiêu ngân sách, nên dùng tên này."""
        return self.retry_after(identifier)

    def record_failure(self, identifier: str) -> None:
        now = self._clock()
        with self._lock:
            self._prune(now)
            if identifier not in self._failures and len(self._failures) >= self.max_identifiers:
                self._failures.pop(next(iter(self._failures)))
            self._failures.setdefault(identifier, deque()).append(now)

    def reset(self, identifier: str) -> None:
        with self._lock:
            self._failures.pop(identifier, None)

    def reset_all(self) -> None:
        with self._lock:
            self._failures.clear()

    def _prune(self, now: float) -> None:
        cutoff = now - self.window_seconds
        expired_identifiers = []
        for identifier, failures in self._failures.items():
            while failures and failures[0] <= cutoff:
                failures.popleft()
            if not failures:
                expired_identifiers.append(identifier)
        for identifier in expired_identifiers:
            del self._failures[identifier]


login_limiter = AttemptLimiter()

# Signup công khai (ADR-049): mọi lượt đăng ký có cấu trúc hợp lệ đều tiêu ngân sách, kể cả lượt
# trùng email - nếu chỉ đếm lượt lỗi thì kẻ spam dò email vô hạn mà không bao giờ bị chặn. Hai lớp:
# mỗi email 5 lượt/giờ, toàn hệ thống 10 lượt/phút chống burst và `registration_rate_limit_per_hour`
# lượt/giờ. Ngân sách giờ đọc từ settings (BTC nới được theo đợt mở đăng ký); hai ngưỡng còn lại cố
# định vì chúng bảo vệ tài nguyên máy, không phải chính sách nghiệp vụ.
SIGNUP_EMAIL_MAX_PER_HOUR = 5
SIGNUP_GLOBAL_MAX_PER_MINUTE = 10
signup_email_limiter = AttemptLimiter(max_failures=SIGNUP_EMAIL_MAX_PER_HOUR, window_seconds=3600, max_identifiers=50_000)
signup_global_minute_limiter = AttemptLimiter(max_failures=SIGNUP_GLOBAL_MAX_PER_MINUTE, window_seconds=60, max_identifiers=4)
# max_failures lấy từ settings; đọc lúc import là chấp nhận được vì limiter process-local cũng reset khi restart.
signup_global_hour_limiter = AttemptLimiter(
    max_failures=get_settings().registration_rate_limit_per_hour, window_seconds=3600, max_identifiers=4
)

_SIGNUP_GLOBAL_KEY = "global"


def reset_signup_limiters() -> None:
    """Dùng trong test: limiter là process-local nên các lượt test trước sẽ ám sang test sau."""
    signup_email_limiter.reset_all()
    signup_global_minute_limiter.reset_all()
    signup_global_hour_limiter.reset_all()
