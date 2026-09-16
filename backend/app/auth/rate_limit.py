"""Process-local failed-login limiter for the single-process MVP API."""

import math
import time
from collections import deque
from collections.abc import Callable
from threading import Lock


class FailedLoginLimiter:
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


login_limiter = FailedLoginLimiter()
