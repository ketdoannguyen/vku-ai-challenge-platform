/** Đếm ngược: format thuần theo `now` truyền vào + nhịp tick cần thiết. */

import { expect, test } from "vitest";
import { DAY_MS, FAST_TICK_MS, SLOW_TICK_MS, formatCountdown, tickIntervalMs } from "./countdown";

const DAY = "2026-10-02T00:00:00Z";
const T0 = Date.parse("2026-10-01T00:00:00Z");

test("còn từ một ngày trở lên: hiện số ngày", () => {
  expect(formatCountdown(DAY, T0)).toBe("còn 1 ngày");
  expect(formatCountdown("2026-10-05T06:00:00Z", T0)).toBe("còn 4 ngày");
});

test("dưới một ngày: hiện HH:MM:SS đủ hai chữ số", () => {
  expect(formatCountdown("2026-10-01T03:02:01Z", T0)).toBe("còn 03:02:01");
  expect(formatCountdown("2026-10-01T00:00:09Z", T0)).toBe("còn 00:00:09");
});

test("đúng hạn, quá hạn và mốc không hợp lệ đều trả null", () => {
  expect(formatCountdown(DAY, Date.parse(DAY))).toBeNull();
  expect(formatCountdown(DAY, Date.parse(DAY) + 1)).toBeNull();
  expect(formatCountdown("không-phải-ngày", T0)).toBeNull();
  expect(formatCountdown("", T0)).toBeNull();
});

test("nhịp tick thưa khi còn xa, dày khi còn dưới một ngày", () => {
  expect(tickIntervalMs(DAY, T0)).toBe(SLOW_TICK_MS);
  expect(tickIntervalMs("2026-10-01T00:00:01Z", T0)).toBe(FAST_TICK_MS);
  expect(tickIntervalMs(DAY, Date.parse(DAY) + 1)).toBeNull();
  expect(tickIntervalMs("không-phải-ngày", T0)).toBeNull();
});

test("mốc đúng một ngày vẫn tính là còn xa", () => {
  expect(tickIntervalMs("2026-10-02T00:00:00Z", T0)).toBe(SLOW_TICK_MS);
  expect(formatCountdown("2026-10-02T00:00:00Z", T0)).toBe("còn 1 ngày");
  // Nhịp thưa vẫn phải ngắn hơn thời gian còn lại để nhãn không đứng yên quá lâu.
  expect(SLOW_TICK_MS).toBeLessThan(DAY_MS);
});
