/** App: ranh giới công khai (ADR-014) — khách đọc được danh sách/chi tiết, trang cần danh tính thì chặn. */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";

const COMPETITION = {
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
  join_code_configured: false,
  resources: [],
  membership: { active: false, joined_at: null },
  submission_config: {
    ready: false,
    id_column: null,
    prediction_column: null,
    average: null,
    pos_label: null,
    max_upload_mb: 10,
  },
};

const CONTENTS = {
  contents: [
    { id: "a", slug: "problem", title: "Đề bài", order: 10, visibility: "public", size_bytes: 10, updated_at: "2026-09-15T00:00:00Z" },
  ],
};

const ACCOUNT = { id: "9", email: "team1@vku.vn", name: "Đội 1", role: "participant", active: true };

/** Phiên ẩn danh: `/auth/me` 401; các tuyến công khai trả dữ liệu bình thường. */
function mockGuestApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/auth/me")) return body({ error: { code: "UNAUTHORIZED", message: "Chưa đăng nhập." } }, 401);
      if (url.endsWith("/api/auth/login")) return body(ACCOUNT);
      if (url.endsWith("/api/competitions")) return body({ competitions: [COMPETITION] });
      if (url.includes("/contents")) return body(CONTENTS);
      if (url.endsWith("/api/competitions/ai-challenge-2026")) return body(COMPETITION);
      return body({ error: { code: "NOT_FOUND", message: "Không tìm thấy." } }, 404);
    }),
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("khách vào / thấy danh sách cuộc thi, không bị đẩy về /login", async () => {
  mockGuestApi();
  renderAt("/");
  expect(await screen.findByRole("heading", { name: "AI Challenge 2026" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1, name: "Cuộc thi" })).toBeTruthy();
  expect(screen.queryByLabelText("Mật khẩu")).toBeNull();
});

test("khách vào chi tiết cuộc thi thấy nội dung công khai và lời mời đăng nhập", async () => {
  mockGuestApi();
  renderAt("/competitions/ai-challenge-2026");
  expect(await screen.findByRole("heading", { level: 1, name: "AI Challenge 2026" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Đăng nhập để tham gia" })).toBeTruthy();
});

test("nút quay lại ở /login đưa khách về dashboard", async () => {
  mockGuestApi();
  renderAt("/login");
  fireEvent.click(await screen.findByRole("button", { name: "Về trang chủ" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Cuộc thi" })).toBeTruthy();
});

test("khách vào trang nộp bài bị đẩy về /login", async () => {
  mockGuestApi();
  renderAt("/competitions/ai-challenge-2026/submit");
  expect(await screen.findByLabelText("Mật khẩu")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Cuộc thi" })).toBeNull());
});

test("đăng nhập xong quay lại đúng trang nộp bài đã bị chặn", async () => {
  mockGuestApi();
  renderAt("/competitions/ai-challenge-2026/submit");
  await userEvent.type(await screen.findByLabelText("Email"), ACCOUNT.email);
  await userEvent.type(screen.getByLabelText("Mật khẩu"), "matkhau1234");
  await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));
  expect(await screen.findByRole("heading", { name: "Nộp bài CSV" })).toBeTruthy();
});
