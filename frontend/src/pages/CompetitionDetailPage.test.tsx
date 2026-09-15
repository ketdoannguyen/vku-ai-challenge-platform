/** Competition detail: load theo slug động, header info, tab disabled chưa có Sprint 04/05. */

import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { CompetitionDetailPage } from "./CompetitionDetailPage";

const COMPETITION = {
  id: "1",
  slug: "ai-challenge-2026",
  name: "AI Challenge 2026",
  short_description: "Cuộc thi AI lần 1",
  status: "published",
  start_at: "2026-10-01T00:00:00Z",
  end_at: "2026-11-01T00:00:00Z",
  join_mode: "code",
  primary_metric: "f1",
  quota_per_day: 7,
  leaderboard_visible: true,
  created_by: "admin@vku.vn",
};

function renderAt(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/competitions/${slug}`]}>
      <Routes>
        <Route path="/competitions/:slug/*" element={<CompetitionDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("load competition theo slug và hiển thị header + meta", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const slug = url.match(/\/api\/competitions\/([^/?]+)/)?.[1] ?? "";
      const body = slug === "ai-challenge-2026" ? COMPETITION : { error: { code: "NOT_FOUND", message: "Không tìm thấy cuộc thi." } };
      return new Response(JSON.stringify(body), { status: slug === "ai-challenge-2026" ? 200 : 404, headers: { "Content-Type": "application/json" } });
    }),
  );
  renderAt("ai-challenge-2026");
  expect(await screen.findByRole("heading", { name: "AI Challenge 2026" })).toBeTruthy();
  expect(screen.getByText("Cần mã tham gia")).toBeTruthy();
  expect(screen.getByText("7 lượt/ngày")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Tổng quan" }) as HTMLElement).toBeTruthy();
});

test("slug sai → 404 error box + link về danh sách", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Không tìm thấy cuộc thi." } }), { status: 404, headers: { "Content-Type": "application/json" } })),
  );
  renderAt("khong-ton-tai");
  await waitFor(() => screen.getByRole("alert"));
  expect(screen.getByText("Không tìm thấy cuộc thi.")).toBeTruthy();
  expect(screen.getByRole("link", { name: /Về danh sách cuộc thi/ })).toBeTruthy();
});

test("tab chưa có ở Sprint 04/05 bị disabled với aria-disabled", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(COMPETITION), { status: 200, headers: { "Content-Type": "application/json" } })),
  );
  renderAt("ai-challenge-2026");
  await screen.findByRole("heading", { name: "AI Challenge 2026" });
  for (const label of ["Đề bài", "Rules", "Nộp bài", "Submissions", "Leaderboard"]) {
    const tab = screen.getByRole("tab", { name: label });
    expect(tab.getAttribute("aria-disabled")).toBe("true");
    expect(tab.tagName).not.toBe("A"); // không phải link — không click được
  }
});
