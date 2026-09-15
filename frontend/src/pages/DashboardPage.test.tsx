/** Dashboard: render competitions từ API, empty state, không render draft (backend đã lọc). */

import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";

const PUBLISHED = {
  id: "1",
  slug: "ai-challenge-2026",
  name: "AI Challenge 2026",
  short_description: "Cuộc thi AI lần 1",
  status: "published",
  start_at: "2026-10-01T00:00:00Z",
  end_at: "2026-11-01T00:00:00Z",
  join_mode: "open",
  primary_metric: "f1",
  quota_per_day: 5,
  leaderboard_visible: true,
  created_by: "admin@vku.vn",
};

const CLOSED = { ...PUBLISHED, id: "2", slug: "old-cup", name: "Old Cup", status: "closed" };

function mockFetchOnce(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("hiển thị competition từ API với status badge và CTA", async () => {
  mockFetchOnce({ competitions: [PUBLISHED, CLOSED] });
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("heading", { name: "AI Challenge 2026" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Old Cup" })).toBeTruthy();
  expect(screen.getByText("Đang mở")).toBeTruthy();
  expect(screen.getByText("Đã kết thúc")).toBeTruthy();
  const cta = screen.getAllByRole("link", { name: "Vào cuộc thi" });
  expect(cta[0].getAttribute("href")).toBe("/competitions/ai-challenge-2026");
});

test("empty state khi không có competition", async () => {
  mockFetchOnce({ competitions: [] });
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
  await waitFor(() => screen.getByText("Chưa có cuộc thi nào"));
  expect(screen.queryByRole("link", { name: "Vào cuộc thi" })).toBeNull();
});

test("lỗi API hiện error box, không crash", async () => {
  mockFetchOnce({ error: { code: "UNAUTHORIZED", message: "Chưa đăng nhập." } }, 401);
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
  await waitFor(() => screen.getByRole("alert"));
  expect(screen.getByText("Chưa đăng nhập.")).toBeTruthy();
});
