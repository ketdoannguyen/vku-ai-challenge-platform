import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiClientError } from "../api/client";
import { setDocumentHidden } from "../test/timers";
import { useAutoRefresh } from "./useAutoRefresh";

function Probe({ active = true, refresh }: { active?: boolean; refresh: () => Promise<void> }) {
  const { state, lastSuccessAt } = useAutoRefresh(active, refresh, { intervalMs: 3_000, jitterRatio: 0 });
  return <p>{state}:{lastSuccessAt ? "updated" : "never"}</p>;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  setDocumentHidden(false);
  vi.useRealTimers();
});

test("refreshes repeatedly while visible and pauses while hidden", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => {});
  render(<Probe refresh={refresh} />);
  await advance(3_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByText("current:updated")).toBeTruthy();
  setDocumentHidden(true);
  await advance(9_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  setDocumentHidden(false);
  await advance(0);
  expect(refresh).toHaveBeenCalledTimes(2);
});

test("does not overlap requests, and stops on unmount", async () => {
  vi.useFakeTimers();
  let complete!: () => void;
  const refresh = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  const view = render(<Probe refresh={refresh} />);
  await advance(3_000);
  await advance(12_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => complete());
  await advance(2_999);
  expect(refresh).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  view.unmount();
  await advance(12_000);
  expect(refresh).toHaveBeenCalledTimes(2);
});

test("retries transient failures with backoff and recovers", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  render(<Probe refresh={refresh} />);
  await advance(3_000);
  expect(screen.getByText("retrying:never")).toBeTruthy();
  await advance(5_999);
  expect(refresh).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(screen.getByText("current:updated")).toBeTruthy();
  await advance(3_000);
  expect(refresh).toHaveBeenCalledTimes(3);
});

test("skipped ticks do not clear a retry warning or advance the last successful check", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(false).mockResolvedValue(undefined);
  render(<Probe refresh={refresh} />);
  await advance(3_000);
  expect(screen.getByText("retrying:never")).toBeTruthy();
  await advance(6_000);
  expect(screen.getByText("retrying:never")).toBeTruthy();
  await advance(6_000);
  expect(screen.getByText("current:updated")).toBeTruthy();
});

test("stops background requests on authorization errors", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => {
    throw new ApiClientError(403, { code: "FORBIDDEN", message: "Không có quyền" });
  });
  render(<Probe refresh={refresh} />);
  await advance(3_000);
  expect(screen.getByText("stopped:never")).toBeTruthy();
  await advance(60_000);
  expect(refresh).toHaveBeenCalledTimes(1);
});
