/** Dashboard: render competitions từ API, join states, empty state, error state. */

import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
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

const ACCOUNT = { id: "9", email: "thi.sinh@vku.vn", name: "Thí sinh", role: "participant", active: true };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * fetch giả: `/auth/me` trả phiên (401 khi `account` null = khách), `/competitions` trả danh sách.
 * DashboardPage nằm trong AuthProvider nên phải giả lập cả hai tuyến.
 */
function mockApi({
  competitions = [],
  loadStatus = 200,
  account = ACCOUNT as typeof ACCOUNT | null,
}: { competitions?: unknown[]; loadStatus?: number; account?: typeof ACCOUNT | null } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/auth/me")) {
      return account ? json(account) : json({ error: { code: "UNAUTHORIZED", message: "Chưa đăng nhập." } }, 401);
    }
    return loadStatus === 200
      ? json({ competitions })
      : json({ error: { code: "UNAUTHORIZED", message: "Chưa đăng nhập." } }, loadStatus);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <DashboardPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("hiển thị competition với status badge; chưa join có nút Tham gia, đã join có link vào", async () => {
  mockApi({ competitions: [PUBLISHED, JOINED, CLOSED] });
  renderDashboard();
  expect(await screen.findByRole("heading", { name: "AI Challenge 2026" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Joined Cup" })).toBeTruthy();
  // Nhãn trạng thái §2.2: chip trên thẻ (2 cuộc published) + tab lọc + ô thống kê
  expect(screen.getAllByText("Đang diễn ra").length).toBe(4); // 2 chip + 1 tab + 1 thống kê
  expect(screen.getAllByText("Đã kết thúc").length).toBe(3); // 1 chip + 1 tab + 1 thống kê
  // PUBLISHED chưa join → nút Tham gia
  expect(screen.getByRole("button", { name: "Tham gia" })).toBeTruthy();
  // JOINED → link Vào cuộc thi đúng slug
  const enter = screen.getByRole("link", { name: "Vào cuộc thi" });
  expect(enter.getAttribute("href")).toBe("/competitions/joined-cup");
  // CLOSED → không có nút join, chỉ thông báo kết thúc
  expect(screen.getByText(/Cuộc thi đã kết thúc/)).toBeTruthy();
});

test("empty state khi không có competition", async () => {
  mockApi();
  renderDashboard();
  await waitFor(() => screen.getByText("Chưa có cuộc thi nào"));
  expect(screen.queryByRole("link", { name: "Vào cuộc thi" })).toBeNull();
});

test("lỗi API hiện error box, không crash", async () => {
  mockApi({ loadStatus: 401 });
  renderDashboard();
  await waitFor(() => screen.getByRole("alert"));
  expect(screen.getByText("Chưa đăng nhập.")).toBeTruthy();
});

test("khách: ẩn ô thống kê 'Đã tham gia', thẻ mời đăng nhập thay vì nút Tham gia", async () => {
  // Backend trả membership rỗng cho khách nên không có thẻ nào ở trạng thái "đã tham gia".
  mockApi({ competitions: [PUBLISHED, CLOSED], account: null });
  renderDashboard();
  expect(await screen.findByRole("heading", { name: "AI Challenge 2026" })).toBeTruthy();
  expect(screen.queryByText("Đã tham gia")).toBeNull();
  expect(screen.queryByRole("button", { name: "Tham gia" })).toBeNull();
  // PUBLISHED mời đăng nhập; CLOSED vẫn chỉ báo đã kết thúc (đăng nhập không mở được).
  expect(screen.getAllByRole("link", { name: "Đăng nhập để tham gia" }).length).toBe(1);
  expect(screen.getByText(/Cuộc thi đã kết thúc/)).toBeTruthy();
});
