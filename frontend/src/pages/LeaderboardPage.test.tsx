import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import type { Competition } from "../api/competitions";
import { LeaderboardPage } from "./LeaderboardPage";

const COMPETITION = {
  id: "64a000000000000000000001",
  slug: "results-cup",
  name: "Results Cup",
  primary_metric: "f1",
  leaderboard_visible: true,
} as Competition;

function renderPage(competition: Competition = COMPETITION) {
  return render(
    <MemoryRouter initialEntries={["/competitions/results-cup/leaderboard"]}>
      <Routes>
        <Route element={<Outlet context={{ competition, contents: [] }} />}>
          <Route path="/competitions/:slug/leaderboard" element={<LeaderboardPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function mockResponse(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

/** Payload nền cho một trang leaderboard; test nào quan tâm field nào thì override field đó. */
function page(overrides: Record<string, unknown> = {}) {
  return {
    competition_id: COMPETITION.id,
    primary_metric: "f1",
    entries: [],
    total: 0,
    limit: 25,
    offset: 0,
    has_more: false,
    me: null,
    ...overrides,
  };
}

function entry(rank: number, name: string, overrides: Record<string, unknown> = {}) {
  return {
    rank,
    display_name: name,
    primary_score: 1 - rank / 100,
    metrics: { f1: 1 - rank / 100, precision: 0.5, recall: 0.5 },
    best_submission_id: `s${rank}`,
    best_submission_at: "2026-09-15T08:00:00Z",
    total_submissions: 1,
    is_current_user: false,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

test("leaderboard visible hiển thị rank, score và highlight current user", async () => {
  mockResponse(
    page({
      total: 2,
      entries: [
        entry(1, "Đội Sớm", { primary_score: 0.91, total_submissions: 3 }),
        entry(2, "Thí Sinh", { primary_score: 0.9, is_current_user: true, total_submissions: 2 }),
      ],
    }),
  );

  renderPage();

  expect(await screen.findByText("Đội Sớm")).toBeTruthy();
  const current = screen.getByText("Thí Sinh").closest("tr");
  expect(current).toHaveClass("current-user-row");
  expect(current).toHaveTextContent("0.900000");
});

test("leaderboard hidden hiển thị thông báo và không gọi API", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  renderPage({ ...COMPETITION, leaderboard_visible: false });
  expect(screen.getByText("Bảng xếp hạng hiện chưa được công bố.")).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("leaderboard visible nhưng chưa có điểm hiển thị empty state", async () => {
  mockResponse(page());
  renderPage();
  expect(await screen.findByText("Chưa có kết quả xếp hạng.")).toBeTruthy();
});

test("hạng của bạn vẫn hiện khi nằm ngoài trang đang xem", async () => {
  mockResponse(
    page({
      total: 30,
      has_more: true,
      entries: [entry(1, "Đội Sớm"), entry(2, "Đội Nhì")],
      me: entry(27, "Thí Sinh", { is_current_user: true, total_submissions: 4 }),
    }),
  );

  renderPage();

  expect(await screen.findByText("Đội Sớm")).toBeTruthy();
  const strip = screen.getByText("Hạng của bạn").closest(".lb-me-strip") as HTMLElement;
  expect(strip).toHaveTextContent("#27");
  expect(strip).toHaveTextContent("/30");
  expect(strip).toHaveTextContent("Hạng của bạn nằm ngoài trang này.");
  // Không có dòng nào của mình trong trang thì không được giả highlight.
  expect(document.querySelectorAll(".current-user-row")).toHaveLength(0);
});

test("chưa có bài hoàn thành thì không hiện thẻ hạng", async () => {
  mockResponse(page({ total: 1, entries: [entry(1, "Đội Sớm")] }));

  renderPage();

  expect(await screen.findByText("Đội Sớm")).toBeTruthy();
  expect(screen.queryByText("Hạng của bạn")).toBeNull();
});

test("phân trang gửi limit/offset và khóa nút ở hai biên", async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const secondPage = url.includes("offset=25");
      return new Response(
        JSON.stringify(
          page({
            total: 30,
            offset: secondPage ? 25 : 0,
            has_more: !secondPage,
            entries: [entry(secondPage ? 26 : 1, secondPage ? "Người 26" : "Người 1")],
          }),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();
  expect(urls[0]).toContain("limit=25");
  expect(urls[0]).toContain("offset=0");
  expect(screen.getByRole("button", { name: "Trang trước" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  expect(await screen.findByText("Người 26")).toBeTruthy();
  expect(urls.at(-1)).toContain("offset=25");
  expect(screen.getByRole("button", { name: "Trang sau" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Trang trước" })).toBeEnabled();
});

test("trang rỗng nhưng vẫn còn dữ liệu thì mời quay lại, không báo chưa có kết quả", async () => {
  mockResponse(page({ total: 30, offset: 25, entries: [], has_more: true }));

  renderPage();

  expect(await screen.findByText("Trang này không có dữ liệu.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Về trang trước" })).toBeTruthy();
  expect(screen.queryByText("Chưa có kết quả xếp hạng.")).toBeNull();
});
