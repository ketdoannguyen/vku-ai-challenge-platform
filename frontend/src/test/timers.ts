/**
 * Điều khiển timer giả cho các test polling.
 *
 * Polling dùng `setTimeout` nối tiếp nên một cú nhảy thời gian lớn không đủ: mỗi lượt phải có
 * trọn một vòng render trước khi lượt sau được lên lịch. Vì vậy thời gian được chia thành từng
 * nhịp poll, và mỗi nhịp nằm trong một `act` riêng.
 */

import { act } from "@testing-library/react";
import { vi } from "vitest";
import { POLL_INTERVAL_MS } from "../hooks/usePendingPolling";

/** Chạy hết timer giả trong `ms` và để React render xong trước khi test đọc DOM. */
export async function flushTimers(ms = 0) {
  const steps = Math.max(1, Math.ceil(ms / POLL_INTERVAL_MS));
  const perStep = steps === 1 ? ms : POLL_INTERVAL_MS;
  for (let step = 0; step < steps; step += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(perStep);
    });
  }
  // Để chuỗi fetch → json() → setState đi hết.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Giả lập tab bị ẩn/hiện. jsdom cho gán lại `document.hidden` qua `defineProperty`. */
export function setDocumentHidden(value: boolean) {
  Object.defineProperty(document, "hidden", { value, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}
