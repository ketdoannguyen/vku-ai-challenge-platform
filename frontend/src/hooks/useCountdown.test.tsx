/** Hook đếm ngược: tự hẹn lại, nhịp theo độ xa deadline, dọn timer khi unmount. */

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FAST_TICK_MS, SLOW_TICK_MS } from "../lib/countdown";
import { useCountdown, useDeadlineClock } from "./useCountdown";

const T0 = Date.parse("2026-10-01T00:00:00Z");

function Label({ endAt }: { endAt: string }) {
  return <span data-testid="label">{useCountdown(endAt) ?? "hết hạn"}</span>;
}

function Clock({ endAts }: { endAts: string[] }) {
  const now = useDeadlineClock(endAts);
  return <span data-testid="now">{now === null ? "-" : new Date(now).toISOString()}</span>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

test("dưới một ngày: nhãn cập nhật theo từng giây", () => {
  render(<Label endAt="2026-10-01T00:00:05Z" />);
  expect(screen.getByTestId("label").textContent).toBe("còn 00:00:05");

  act(() => {
    vi.advanceTimersByTime(FAST_TICK_MS);
  });
  expect(screen.getByTestId("label").textContent).toBe("còn 00:00:04");
});

test("trên một ngày: không tick mỗi giây, chỉ tick theo nhịp thưa", () => {
  // Đặt lệch nửa ngày để vài giây trôi qua không làm nhãn "còn N ngày" đổi số.
  render(<Label endAt="2026-10-04T12:00:00Z" />);
  expect(screen.getByTestId("label").textContent).toBe("còn 3 ngày");

  act(() => {
    vi.advanceTimersByTime(FAST_TICK_MS * 5);
  });
  expect(vi.getTimerCount()).toBe(1);

  act(() => {
    vi.advanceTimersByTime(SLOW_TICK_MS);
  });
  expect(screen.getByTestId("label").textContent).toBe("còn 3 ngày");
});

test("qua hạn: dừng hẳn, không còn timer nào", () => {
  render(<Label endAt="2026-10-01T00:00:02Z" />);
  act(() => {
    vi.advanceTimersByTime(FAST_TICK_MS * 3);
  });
  expect(screen.getByTestId("label").textContent).toBe("hết hạn");
  expect(vi.getTimerCount()).toBe(0);
});

test("unmount dọn sạch timer", () => {
  const { unmount } = render(<Label endAt="2026-10-01T00:10:00Z" />);
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("quay lại tab: đồng hồ đồng bộ ngay thay vì chờ hết nhịp cũ", () => {
  render(<Label endAt="2026-10-04T00:00:00Z" />);
  // Giả lập tab bị treo rồi mở lại sau 2 giờ.
  vi.setSystemTime(T0 + 2 * 3_600_000);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(screen.getByTestId("label").textContent).toBe("còn 2 ngày");
  expect(vi.getTimerCount()).toBe(1);
});

test("clock dùng chung: nhịp lấy theo deadline gần nhất trong danh sách", () => {
  render(<Clock endAts={["2026-10-04T00:00:00Z", "2026-10-01T00:00:07Z"]} />);
  expect(screen.getByTestId("now").textContent).toBe(new Date(T0).toISOString());

  // Deadline gần nhất còn 7 giây nên phải tick mỗi giây, không phải nhịp thưa.
  act(() => {
    vi.advanceTimersByTime(FAST_TICK_MS);
  });
  expect(screen.getByTestId("now").textContent).toBe(new Date(T0 + 1000).toISOString());
});

test("clock dùng chung: hết deadline thì vẫn có mốc giờ nhưng không giữ timer", () => {
  render(<Clock endAts={["2026-09-01T00:00:00Z", "không-phải-ngày"]} />);
  expect(screen.getByTestId("now").textContent).toBe(new Date(T0).toISOString());
  expect(vi.getTimerCount()).toBe(0);
});
