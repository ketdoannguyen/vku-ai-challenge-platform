/**
 * Poll có giới hạn cho những bảng có thể đang chờ AI chạy.
 *
 * `setTimeout` nối tiếp chứ không `setInterval`: một lượt tải chậm sẽ không dồn request, và
 * ngân sách đếm theo số lượt thật sự gọi. Tab bị ẩn thì không tốn lượt nào - trình duyệt ngừng
 * đánh thức timer, nên phải tự dừng và chờ `visibilitychange`.
 */

import { useEffect, useRef, useState } from "react";

/** Một lượt cách nhau 8 giây; đủ nhanh để thấy kết quả, đủ thưa để không thành vòng lặp tải. */
export const POLL_INTERVAL_MS = 8_000;
/** 20 lượt ≈ 160 giây cho một lần xem: hết ngân sách thì dừng và để người dùng tự làm mới. */
export const MAX_POLLS = 20;

/**
 * Gọi `refresh` định kỳ trong khi `active` còn đúng.
 *
 * Trả về `exhausted` để nơi gọi nói được vì sao bảng đứng yên - im lặng dừng polling sẽ khiến
 * admin tưởng lượt AI đã xong.
 */
export function usePendingPolling(active: boolean, refresh: () => void): boolean {
  const refreshRef = useRef(refresh);
  const polls = useRef(0);
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // Ngân sách tính theo từng đợt có việc, không theo cả phiên sống của trang.
  useEffect(() => {
    polls.current = 0;
    setExhausted(false);
  }, [active]);

  useEffect(() => {
    if (!active || exhausted) return;

    let timer: number | null = null;

    function schedule() {
      if (document.hidden) return;
      timer = window.setTimeout(fire, POLL_INTERVAL_MS);
    }

    function fire() {
      timer = null;
      if (document.hidden) return;
      polls.current += 1;
      refreshRef.current();
      if (polls.current >= MAX_POLLS) {
        setExhausted(true);
        return;
      }
      schedule();
    }

    function onVisibilityChange() {
      if (document.hidden) {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        return;
      }
      schedule();
    }

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, exhausted]);

  return exhausted;
}
