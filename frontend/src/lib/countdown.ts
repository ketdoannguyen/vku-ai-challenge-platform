/** Đếm ngược dùng chung cho dashboard và trang chi tiết — thuần, nhận `now` từ ngoài. */

export const DAY_MS = 86_400_000;
/** Còn xa thì chỉ cần đủ nhịp để nhãn "còn N ngày" không đứng yên quá lâu. */
export const SLOW_TICK_MS = 30_000;
export const FAST_TICK_MS = 1_000;

/**
 * "còn 3 ngày" khi còn từ một ngày trở lên, dưới một ngày thì "còn HH:MM:SS".
 * Trả null khi mốc không hợp lệ hoặc đã qua — nơi gọi tự ẩn chip.
 */
export function formatCountdown(endAt: string, now: number): string | null {
  const remaining = new Date(endAt).getTime() - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const days = Math.floor(remaining / DAY_MS);
  if (days >= 1) return `còn ${days} ngày`;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `còn ${pad(Math.floor(remaining / 3_600_000))}:${pad(
    Math.floor((remaining % 3_600_000) / 60_000),
  )}:${pad(Math.floor((remaining % 60_000) / 1000))}`;
}

/** Nhịp tick cần cho mốc này; null khi không còn gì để đếm nên không cần hẹn giờ. */
export function tickIntervalMs(endAt: string, now: number): number | null {
  const remaining = new Date(endAt).getTime() - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  // Đúng một ngày vẫn đang hiển thị nhãn theo ngày nên chưa cần nhịp mỗi giây.
  return remaining >= DAY_MS ? SLOW_TICK_MS : FAST_TICK_MS;
}
