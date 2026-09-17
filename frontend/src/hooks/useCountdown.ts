/** Đồng hồ đếm ngược: một timer cho mỗi lần dùng, tự hẹn lại theo độ xa của deadline. */

import { useEffect, useMemo, useState } from "react";
import { formatCountdown, tickIntervalMs } from "../lib/countdown";

/**
 * Clock cấp trang: trả về `now` và chỉ giữ MỘT timer, nhịp lấy theo deadline gần nhất
 * trong danh sách. Dashboard truyền cả danh sách để không phải mở timer cho từng thẻ.
 */
export function useDeadlineClock(endAts: string[]): number | null {
  // Nối thành chuỗi để danh sách mới nhưng nội dung cũ không làm effect chạy lại.
  const key = endAts.join("|");
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const deadlines = key ? key.split("|") : [];
    let timer: number | null = null;

    function tick() {
      const at = Date.now();
      setNow(at);
      const delays = deadlines
        .map((endAt) => tickIntervalMs(endAt, at))
        .filter((delay): delay is number => delay !== null);
      // Không còn deadline nào trong tương lai thì dừng hẳn, không giữ timer rỗng.
      timer = delays.length > 0 ? window.setTimeout(tick, Math.min(...delays)) : null;
    }

    tick();

    // Tab bị treo rồi mở lại: đồng bộ ngay thay vì chờ hết nhịp cũ (có thể đã trôi hàng giờ).
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") return;
      if (timer !== null) window.clearTimeout(timer);
      tick();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [key]);

  return now;
}

/** Nhãn đếm ngược cho một mốc; null khi mốc không hợp lệ hoặc đã qua. */
export function useCountdown(endAt: string): string | null {
  const deadlines = useMemo(() => [endAt], [endAt]);
  const now = useDeadlineClock(deadlines);
  return now === null ? null : formatCountdown(endAt, now);
}
