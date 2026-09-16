import { render, screen } from "@testing-library/react";
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

afterEach(() => vi.unstubAllGlobals());

test("leaderboard visible hiển thị rank, score và highlight current user", async () => {
  mockResponse({
    competition_id: COMPETITION.id,
    primary_metric: "f1",
    total: 2,
    entries: [
      {
        rank: 1,
        display_name: "Đội Sớm",
        primary_score: 0.91,
        metrics: { f1: 0.91, precision: 0.9, recall: 0.89 },
        best_submission_id: "s1",
        best_submission_at: "2026-09-15T08:00:00Z",
        total_submissions: 3,
        is_current_user: false,
      },
      {
        rank: 2,
        display_name: "Thí Sinh",
        primary_score: 0.9,
        metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
        best_submission_id: "s2",
        best_submission_at: "2026-09-15T09:00:00Z",
        total_submissions: 2,
        is_current_user: true,
      },
    ],
  });

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
  mockResponse({
    competition_id: COMPETITION.id,
    primary_metric: "f1",
    total: 0,
    entries: [],
  });
  renderPage();
  expect(await screen.findByText("Chưa có kết quả xếp hạng.")).toBeTruthy();
});
