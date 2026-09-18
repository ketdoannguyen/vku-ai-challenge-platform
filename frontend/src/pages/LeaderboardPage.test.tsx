import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockResponse(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body)));
}

/** Fetch phân trang thật; `gateOffset` giữ response của một trang lại để kiểm tra lúc đang tải. */
function mockPagedFetch({ total = 30, gateOffset }: { total?: number; gateOffset?: number } = {}) {
  const urls: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") ?? 0);
      if (offset === gateOffset) await gate;
      return jsonResponse(
        page({
          total,
          offset,
          has_more: offset + 25 < total,
          entries: [entry(offset + 1, `Người ${offset + 1}`)],
        }),
      );
    }),
  );
  return { urls, release };
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
  // Biên dùng aria-disabled (không phải `disabled`) để nút đang giữ focus không bị rơi focus.
  expect(screen.getByRole("button", { name: "Trang trước" })).toHaveAttribute("aria-disabled", "true");

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  expect(await screen.findByText("Người 26")).toBeTruthy();
  expect(urls.at(-1)).toContain("offset=25");
  expect(screen.getByRole("button", { name: "Trang sau" })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("button", { name: "Trang trước" })).toHaveAttribute("aria-disabled", "false");
});

test("bảng xếp hạng là vùng cuộn focus được bằng bàn phím", async () => {
  mockPagedFetch();

  renderPage();
  const region = await screen.findByRole("region", { name: "Bảng xếp hạng" });
  expect(region).toHaveAttribute("tabindex", "0");
  expect(within(region).getByRole("table")).toBeTruthy();
});

test("đổi trang vẫn giữ bảng cũ, pager và aria-busy trong lúc chờ", async () => {
  const { release } = mockPagedFetch({ gateOffset: 25 });

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  // Trang mới chưa về: bảng cũ và pager phải còn nguyên, vùng kết quả báo đang bận.
  const wrap = document.querySelector(".lb-table-wrap") as HTMLElement;
  expect(wrap).toHaveAttribute("aria-busy", "true");
  expect(screen.getByText("Người 1")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Trang sau" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Trang trước" })).toBeTruthy();
  expect(screen.getByRole("status")).toHaveTextContent("Đang cập nhật…");

  release();
  expect(await screen.findByText("Người 26")).toBeTruthy();
  expect(screen.queryByText("Người 1")).toBeNull();
  expect(wrap).toHaveAttribute("aria-busy", "false");
});

test("dải đang hiển thị và hạng của trang cập nhật theo trang mới", async () => {
  const { urls } = mockPagedFetch();

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();
  expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 1–25 trong số 30 thí sinh có điểm");

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  expect(await screen.findByText("Người 26")).toBeTruthy();
  expect(urls.at(-1)).toContain("offset=25");
  expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 26–30 trong số 30 thí sinh có điểm");
  // Hạng vẫn là hạng toàn cục do backend trả về, không đánh lại theo trang.
  const row = screen.getByText("Người 26").closest("tr") as HTMLElement;
  expect(row).toHaveTextContent("26");
});

test("bấm pager không làm focus rơi về body", async () => {
  const { release } = mockPagedFetch({ gateOffset: 25 });

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();

  const next = screen.getByRole("button", { name: "Trang sau" });
  next.focus();
  fireEvent.click(next);
  // Nút đang giữ focus không được unmount hay bị disabled cứng.
  expect(next).toBeInTheDocument();
  expect(document.activeElement).toBe(next);
  expect(next).toHaveAttribute("aria-disabled", "true");

  release();
  expect(await screen.findByText("Người 26")).toBeTruthy();
  expect(document.activeElement).toBe(next);
});

test("bấm trang liên tiếp chỉ phát một request và render trang cuối", async () => {
  const { urls, release } = mockPagedFetch({ gateOffset: 25 });

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();

  const next = screen.getByRole("button", { name: "Trang sau" });
  fireEvent.click(next);
  fireEvent.click(next);

  release();
  expect(await screen.findByText("Người 26")).toBeTruthy();
  expect(urls.filter((url) => url.includes("offset=25"))).toHaveLength(1);
  expect(screen.queryByText("Người 1")).toBeNull();
});

test("lỗi khi sang trang hai giữ nguyên trang một và cho thử lại", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("offset=25")) {
        return jsonResponse({ error: { code: "INTERNAL_ERROR", message: "Lỗi hệ thống." } }, 500);
      }
      return jsonResponse(
        page({ total: 30, offset: 0, has_more: true, entries: [entry(1, "Người 1")] }),
      );
    }),
  );

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Lỗi hệ thống.");
  expect(screen.getByText("Người 1")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Thử lại" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Trang sau" })).toBeTruthy();
  expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 1–25 trong số 30 thí sinh có điểm");
});

test("total co lại làm trang hiện tại vượt range thì lùi về trang cuối còn dữ liệu", async () => {
  const urls: string[] = [];
  let firstPageCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") ?? 0);
      if (offset === 25) {
        return jsonResponse(page({ total: 10, offset: 25, entries: [], has_more: false }));
      }
      firstPageCalls += 1;
      const total = firstPageCalls === 1 ? 30 : 10;
      return jsonResponse(page({ total, offset: 0, has_more: total > 25, entries: [entry(1, "Người 1")] }));
    }),
  );

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();
  expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 1–25 trong số 30 thí sinh có điểm");

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  // Trang 2 giờ vượt range: phải tự tải lại trang cuối hợp lệ thay vì bỏ trắng bảng.
  await waitFor(() => {
    expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 1–10 trong số 10 thí sinh có điểm");
  });
  expect(urls.filter((url) => url.includes("offset=0")).length).toBe(2);
  expect(screen.getByText("Người 1")).toBeTruthy();
});

test("trang rỗng nhưng vẫn còn dữ liệu thì mời quay lại, không báo chưa có kết quả", async () => {
  mockResponse(page({ total: 30, offset: 25, entries: [], has_more: true }));

  renderPage();

  expect(await screen.findByText("Trang này không có dữ liệu.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Về trang trước" })).toBeTruthy();
  expect(screen.queryByText("Chưa có kết quả xếp hạng.")).toBeNull();
});
