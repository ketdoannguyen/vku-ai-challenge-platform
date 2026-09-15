/** Competition layout: load theo slug, header + sidebar content theo order, tab disabled Sprint 05/06. */

import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { CompetitionContentPanel, CompetitionOverview } from "./CompetitionContentPanel";
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
  join_code_configured: true,
  membership: { active: true, joined_at: "2026-09-15T00:00:00Z" },
};

const CONTENTS = {
  contents: [
    { id: "a", slug: "problem", title: "Đề bài", order: 20, visibility: "public", size_bytes: 10, updated_at: "2026-09-15T00:00:00Z" },
    { id: "b", slug: "rules", title: "Rules", order: 10, visibility: "public", size_bytes: 10, updated_at: "2026-09-15T00:00:00Z" },
  ],
};

function apiMock(handler: (url: string) => { body: unknown; status: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const r = handler(String(input));
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/competitions/:slug" element={<CompetitionDetailPage />}>
          <Route index element={<CompetitionOverview />} />
          <Route path="content/:contentSlug" element={<CompetitionContentPanel />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("load competition + sidebar sắp theo order, tab active Tổng quan", async () => {
  apiMock((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (url.endsWith("/api/competitions/ai-challenge-2026")) return { body: COMPETITION, status: 200 };
    return { body: { error: { code: "NOT_FOUND", message: "Không tìm thấy cuộc thi." } }, status: 404 };
  });
  renderAt("/competitions/ai-challenge-2026");
  expect(await screen.findByRole("heading", { name: "AI Challenge 2026" })).toBeTruthy();
  expect(screen.getByText("Cần mã tham gia")).toBeTruthy();
  expect(screen.getByText("7 lượt/ngày")).toBeTruthy();
  expect(screen.getByText("Đã tham gia")).toBeTruthy(); // JoinControl đã join
  const nav = screen.getByRole("navigation", { name: "Nội dung cuộc thi" });
  const items = nav.querySelectorAll(".content-nav-item");
  // Frontend render theo thứ tự API trả về; backend đã sort theo order (Rules 10 trước Đề bài 20)
  expect(items[0].textContent).toContain("Đề bài");
  expect(items[1].textContent).toContain("Rules");
  expect(screen.getByText(/2 trang nội dung/)).toBeTruthy();
});

test("slug sai → 404 error box + link về danh sách", async () => {
  apiMock(() => ({ body: { error: { code: "NOT_FOUND", message: "Không tìm thấy cuộc thi." } }, status: 404 }));
  renderAt("/competitions/khong-ton-tai");
  await waitFor(() => screen.getByRole("alert"));
  expect(screen.getByText("Không tìm thấy cuộc thi.")).toBeTruthy();
  expect(screen.getByRole("link", { name: /Về danh sách cuộc thi/ })).toBeTruthy();
});

test("tab Sprint 05/06 disabled với aria-disabled, không còn Đề bài/Rules tĩnh", async () => {
  apiMock((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderAt("/competitions/ai-challenge-2026");
  await screen.findByRole("heading", { name: "AI Challenge 2026" });
  for (const label of ["Nộp bài", "Submissions", "Leaderboard"]) {
    const tab = screen.getByRole("tab", { name: label });
    expect(tab.getAttribute("aria-disabled")).toBe("true");
    expect(tab.tagName).not.toBe("A");
  }
});

test("deep-link content/:contentSlug render markdown panel", async () => {
  apiMock((url) => {
    if (url.endsWith("/contents/problem")) {
      return {
        body: { ...CONTENTS.contents[0], markdown: "# Đề bài chi tiết\n\nNội dung **quan trọng**." },
        status: 200,
      };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderAt("/competitions/ai-challenge-2026/content/problem");
  expect(await screen.findByRole("heading", { name: "Đề bài chi tiết", level: 1 })).toBeTruthy();
  expect(screen.getByText("quan trọng")).toBeTruthy();
});
