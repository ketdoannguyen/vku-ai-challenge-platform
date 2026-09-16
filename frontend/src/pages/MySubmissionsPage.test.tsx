import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import type { Competition } from "../api/competitions";
import { MySubmissionsPage } from "./MySubmissionsPage";

const COMPETITION = {
  id: "64a000000000000000000001",
  slug: "results-cup",
  name: "Results Cup",
  primary_metric: "f1",
} as Competition;

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/competitions/results-cup/submissions"]}>
      <Routes>
        <Route element={<Outlet context={{ competition: COMPETITION, contents: [] }} />}>
          <Route path="/competitions/:slug/submissions" element={<MySubmissionsPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function mockResponse(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

test("hiển thị history newest-first với filename, status và metrics", async () => {
  mockResponse({
    submissions: [
      {
        id: "s2",
        competition_id: COMPETITION.id,
        filename: "latest.csv",
        status: "completed",
        metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
        primary_score: 0.9,
        created_at: "2026-09-15T09:00:00Z",
      },
      {
        id: "s1",
        competition_id: COMPETITION.id,
        filename: "first.csv",
        status: "failed",
        metrics: null,
        primary_score: null,
        created_at: "2026-09-15T08:00:00Z",
        error: { code: "SCORING_FAILED", message: "Không thể chấm điểm bài nộp." },
      },
    ],
    total: 2,
    limit: 50,
    offset: 0,
  });

  renderPage();

  expect(await screen.findByText("latest.csv")).toBeTruthy();
  expect(screen.getByText("first.csv")).toBeTruthy();
  expect(screen.getByText("Không thể chấm điểm bài nộp.")).toBeTruthy();
  expect(screen.getAllByText("0.900000").length).toBeGreaterThan(0);
  const rows = screen.getAllByRole("row");
  expect(rows[1]).toHaveTextContent("latest.csv");
  expect(rows[2]).toHaveTextContent("first.csv");
});

test("hiển thị empty state khi chưa có submission", async () => {
  mockResponse({ submissions: [], total: 0, limit: 50, offset: 0 });
  renderPage();
  expect(await screen.findByText("Bạn chưa có bài nộp nào.")).toBeTruthy();
});

test("hiển thị backend error", async () => {
  mockResponse(
    { error: { code: "NOT_FOUND", message: "Không tìm thấy cuộc thi." } },
    404,
  );
  renderPage();
  expect(await screen.findByRole("alert")).toHaveTextContent("Không tìm thấy cuộc thi.");
});
