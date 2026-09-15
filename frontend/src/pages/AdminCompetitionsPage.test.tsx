/** Admin competitions UI: table render, tạo mới với validate, slug khóa khi edit. */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { AdminCompetitionsPage } from "./AdminCompetitionsPage";

const DRAFT = {
  id: "1",
  slug: "ai-challenge-2026",
  name: "AI Challenge 2026",
  short_description: "",
  status: "draft",
  start_at: "2026-10-01T00:00:00Z",
  end_at: "2026-11-01T00:00:00Z",
  join_mode: "open",
  primary_metric: "f1",
  quota_per_day: 5,
  leaderboard_visible: true,
  created_by: "admin@vku.vn",
};

function mockFetch(handler: (url: string, init?: RequestInit) => { body: unknown; status: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = handler(String(input), init);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("hiển thị table competitions với status badge và hành động theo trạng thái", async () => {
  mockFetch((url) => (url.includes("/api/admin/competitions") ? { body: { competitions: [DRAFT] }, status: 200 } : { body: {}, status: 500 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  expect(await screen.findByText("AI Challenge 2026")).toBeTruthy();
  expect(screen.getByText("Nháp")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Kết thúc" })).toBeNull(); // draft chưa có nút close
});

test("tạo cuộc thi thiếu field bắt buộc → form không submit (HTML validate)", async () => {
  mockFetch((url) => (url.includes("/api/admin/competitions") ? { body: { competitions: [] }, status: 200 } : { body: {}, status: 500 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Tạo cuộc thi" }));
  const submit = await screen.findByRole("button", { name: "Tạo" });
  // Tên + slug + dates trống → form HTML validation chặn; fetch create không được gọi
  fireEvent.click(submit);
  await waitFor(() => {
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).endsWith("/api/admin/competitions") && c[1]?.method === "POST");
    expect(calls).toHaveLength(0);
  });
});

test("edit form khóa slug và disable metric khi published", async () => {
  const published = { ...DRAFT, status: "published" as const };
  mockFetch((url) => (url.includes("/api/admin/competitions") ? { body: { competitions: [published] }, status: 200 } : { body: {}, status: 500 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Sửa" }));
  const slugInput = await screen.findByLabelText(/Slug \(không đổi được\)/);
  expect((slugInput as HTMLInputElement).disabled).toBe(true);
  const metricSelect = screen.getByLabelText("Chỉ số chính") as HTMLSelectElement;
  expect(metricSelect.disabled).toBe(true);
});
