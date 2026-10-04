import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";

type RefreshState = "idle" | "current" | "retrying" | "stopped";
export interface RefreshStatus {
  state: RefreshState;
  lastSuccessAt: Date | null;
}

/** Tự tải lại khi đang xem trang, không dồn request khi server trả lời chậm. */
export function useAutoRefresh(
  active: boolean,
  refresh: () => Promise<void | false>,
  options: { intervalMs?: number; jitterRatio?: number } = {},
): RefreshStatus {
  const { intervalMs = 3_000, jitterRatio = 0.1 } = options;
  const refreshRef = useRef(refresh);
  const runningRef = useRef<Promise<void> | null>(null);
  const [state, setState] = useState<RefreshState>("idle");
  const [lastSuccessAt, setLastSuccessAt] = useState<Date | null>(null);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!active) return;

    let timer: number | null = null;
    let cancelled = false;
    let stopped = false;
    let failures = 0;

    function clearTimer() {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    }

    function schedule(delay: number) {
      if (cancelled || stopped || document.hidden || timer !== null) return;
      timer = window.setTimeout(() => void fire(), delay);
    }

    async function fire() {
      timer = null;
      if (cancelled || stopped || document.hidden) return;
      if (runningRef.current) {
        void runningRef.current.then(() => {
          if (!cancelled && !stopped) schedule(0);
        });
        return;
      }
      const task = (async () => {
        try {
          const refreshed = await refreshRef.current();
          if (cancelled || refreshed === false) return;
          failures = 0;
          setLastSuccessAt(new Date());
          setState("current");
        } catch (error) {
          if (cancelled) return;
          if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
            stopped = true;
            setState("stopped");
            return;
          }
          failures += 1;
          setState("retrying");
        }
      })();
      runningRef.current = task;
      await task;
      if (runningRef.current === task) runningRef.current = null;
      const base = Math.min(60_000, intervalMs * 2 ** Math.min(failures, 6));
      schedule(Math.round(base * (1 + (Math.random() * 2 - 1) * jitterRatio)));
    }

    function onVisibilityChange() {
      if (document.hidden) clearTimer();
      else {
        clearTimer();
        schedule(0);
      }
    }

    schedule(intervalMs);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, intervalMs, jitterRatio]);

  return { state, lastSuccessAt };
}
