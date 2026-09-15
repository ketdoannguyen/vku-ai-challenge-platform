/** Dashboard: render competitions từ API, join states, empty state, error state. */

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
  join_code_configured: false,
  membership: { active: false, joined_at: null },
};

const JOINED = {
  ...PUBLISHED,
  id: "2",
  slug: "joined-cup",
  name: "Joined Cup",
  membership: { active: true, joined_at: "2026-09-15T00:00:00Z" },
};

const CLOSED = { ...PUBLISHED, id: "3", slug: "old-cup", name: "Old Cup", status: "closed" };

function mockFetchOnce(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("hiển thị competition với status badge; chưa join có nút Tham gia, đã join có link vào", async () => {
  mockFetchOnce({ competitions: [PUBLISHED, JOINED, CLOSED] });
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("heading", { name: "AI Challenge 2026" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Joined Cup" })).toBeTruthy();
  expect(screen.getAllByText("Đang mở").length).toBe(2); // PUBLISHED + JOINED
  expect(screen.getByText("Đã kết thúc")).toBeTruthy();
  // PUBLISHED chưa join → nút Tham gia
  expect(screen.getByRole("button", { name: "Tham gia" })).toBeTruthy();
  // JOINED → link Vào cuộc thi đúng slug
  const enter = screen.getByRole("link", { name: "Vào cuộc thi" });
  expect(enter.getAttribute("href")).toBe("/competitions/joined-cup");
  // CLOSED → không có nút join, chỉ thông báo kết thúc
  expect(screen.getByText(/Cuộc thi đã kết thúc/)).toBeTruthy();
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
