import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** Vùng thông báo của dải phân trang - trang còn live region riêng cho phản hồi sao chép ID. */
function pagerStatus(): HTMLElement {
  return within(document.querySelector(".subm-pagination-footer") as HTMLElement).getByRole("status");
}

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockResponse(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, status)));
}

/** Một trang bài nộp có `total` dòng; ID trong pill `#s-{offset}` đánh dấu trang đang xem. */
function submissionsPage(offset: number, total: number) {
  return {
    submissions: [
      {
        id: `s-${offset}`,
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
        primary_score: 0.9,
        created_at: "2026-09-15T09:00:00Z",
        artifacts: {
          prediction: { filename: "prediction.csv", size_bytes: 128, available: true },
          notebook: { filename: "notebook.ipynb", size_bytes: 4096, available: true },
        },
      },
    ],
    total,
    limit: 50,
    offset,
  };
}

/** Fetch phân trang thật; `gateOffset` giữ response của một trang lại để kiểm tra lúc đang tải. */
function mockPagedFetch({ total = 120, gateOffset }: { total?: number; gateOffset?: number } = {}) {
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
      return jsonResponse(submissionsPage(offset, total));
    }),
  );
  return { urls, release };
}

afterEach(() => vi.unstubAllGlobals());

test("hiển thị history newest-first với nút tải artifact, status và metrics", async () => {
  mockResponse({
    submissions: [
      {
        id: "s2",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
        primary_score: 0.9,
        created_at: "2026-09-15T09:00:00Z",
        artifacts: {
          prediction: { filename: "latest.csv", size_bytes: 2048, available: true },
          notebook: { filename: "solution.ipynb", size_bytes: 40960, available: true },
        },
      },
      {
        id: "s1",
        competition_id: COMPETITION.id,
        status: "failed",
        metrics: null,
        primary_score: null,
        created_at: "2026-09-15T08:00:00Z",
        // Bài nộp cũ chỉ có CSV trên đĩa: không có notebook để tải.
        artifacts: {
          prediction: { filename: "first.csv", size_bytes: null, available: true },
          notebook: null,
        },
        error: { code: "SCORING_FAILED", message: "Không thể chấm điểm bài nộp." },
      },
    ],
    total: 2,
    limit: 50,
    offset: 0,
  });

  renderPage();

  expect(await screen.findByTitle("latest.csv")).toBeTruthy();
  expect(screen.getByTitle("solution.ipynb")).toBeTruthy();
  expect(screen.getByTitle("first.csv")).toBeTruthy();
  expect(screen.getByText("Không thể chấm điểm bài nộp.")).toBeTruthy();
  expect(screen.getAllByText("0.900000").length).toBeGreaterThan(0);

  const rows = screen.getAllByRole("row");
  // Dòng mới nhất có đủ hai nút; dòng legacy chỉ còn nút CSV.
  expect(within(rows[1]).getAllByRole("button")).toHaveLength(3);
  expect(within(rows[1]).getByRole("button", { name: "Notebook" })).toBeTruthy();
  expect(within(rows[2]).getAllByRole("button")).toHaveLength(2);
  expect(within(rows[2]).queryByRole("button", { name: "Notebook" })).toBeNull();
});

test("hiển thị empty state khi chưa có submission", async () => {
  mockResponse({ submissions: [], total: 0, limit: 50, offset: 0 });
  renderPage();
  expect(await screen.findByText("Bạn chưa có bài nộp nào.")).toBeTruthy();
});

test("đổi trang vẫn giữ bảng cũ, pager và aria-busy trong lúc chờ", async () => {
  const { release } = mockPagedFetch({ gateOffset: 50 });

  renderPage();
  expect(await screen.findByText("#s-0")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  // Trang mới chưa về: bảng cũ và pager phải còn nguyên, vùng kết quả báo đang bận.
  const wrap = document.querySelector(".subm-table-wrap") as HTMLElement;
  expect(wrap).toHaveAttribute("aria-busy", "true");
  expect(screen.getByText("#s-0")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Trang sau" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Trang trước" })).toBeTruthy();
  expect(pagerStatus()).toHaveTextContent("Đang cập nhật…");

  release();
  expect(await screen.findByText("#s-50")).toBeTruthy();
  expect(screen.queryByText("#s-0")).toBeNull();
  expect(wrap).toHaveAttribute("aria-busy", "false");
});

test("sang trang hai gửi offset=50 và cập nhật dải đang hiển thị", async () => {
  const { urls } = mockPagedFetch();

  renderPage();
  expect(await screen.findByText("#s-0")).toBeTruthy();
  expect(urls[0]).toContain("limit=50");
  expect(urls[0]).toContain("offset=0");
  expect(pagerStatus()).toHaveTextContent("Đã hiển thị 1–50 trong số 120 bài nộp");

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  expect(await screen.findByText("#s-50")).toBeTruthy();
  expect(urls.at(-1)).toContain("offset=50");
  expect(pagerStatus()).toHaveTextContent("Đã hiển thị 51–100 trong số 120 bài nộp");
  expect(screen.getByRole("button", { name: "Trang sau" })).toHaveAttribute("aria-disabled", "false");
  expect(screen.getByRole("button", { name: "Trang trước" })).toHaveAttribute("aria-disabled", "false");
});

test("bấm pager không làm focus rơi về body", async () => {
  const { release } = mockPagedFetch({ gateOffset: 50 });

  renderPage();
  expect(await screen.findByText("#s-0")).toBeTruthy();

  const next = screen.getByRole("button", { name: "Trang sau" });
  next.focus();
  fireEvent.click(next);
  // Nút đang giữ focus không được unmount hay bị disabled cứng.
  expect(next).toBeInTheDocument();
  expect(document.activeElement).toBe(next);
  expect(next).toHaveAttribute("aria-disabled", "true");

  release();
  expect(await screen.findByText("#s-50")).toBeTruthy();
  expect(document.activeElement).toBe(next);
});

test("bấm trang liên tiếp chỉ phát một request và render trang cuối", async () => {
  const { urls, release } = mockPagedFetch({ gateOffset: 50 });

  renderPage();
  expect(await screen.findByText("#s-0")).toBeTruthy();

  const next = screen.getByRole("button", { name: "Trang sau" });
  fireEvent.click(next);
  fireEvent.click(next);

  release();
  expect(await screen.findByText("#s-50")).toBeTruthy();
  expect(urls.filter((url) => url.includes("offset=50"))).toHaveLength(1);
  expect(screen.queryByText("#s-0")).toBeNull();
});

test("lỗi khi sang trang hai giữ nguyên trang một và cho thử lại", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("offset=50")) {
        return jsonResponse({ error: { code: "INTERNAL_ERROR", message: "Lỗi hệ thống." } }, 500);
      }
      return jsonResponse(submissionsPage(0, 120));
    }),
  );

  renderPage();
  expect(await screen.findByText("#s-0")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Lỗi hệ thống.");
  expect(screen.getByText("#s-0")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Thử lại" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Trang sau" })).toBeTruthy();
  expect(pagerStatus()).toHaveTextContent("Đã hiển thị 1–50 trong số 120 bài nộp");
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
      if (offset === 50) {
        return jsonResponse({ submissions: [], total: 30, limit: 50, offset: 50 });
      }
      firstPageCalls += 1;
      return jsonResponse(submissionsPage(0, firstPageCalls === 1 ? 120 : 30));
    }),
  );

  renderPage();
  expect(await screen.findByText("#s-0")).toBeTruthy();
  expect(screen.getByText(/Tổng cộng/)).toHaveTextContent("Tổng cộng 120 bài nộp");

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  // Trang 2 giờ vượt range: phải tự tải lại trang cuối hợp lệ thay vì bỏ trắng bảng.
  await waitFor(() => {
    expect(screen.getByText(/Tổng cộng/)).toHaveTextContent("Tổng cộng 30 bài nộp");
  });
  expect(urls.filter((url) => url.includes("offset=0")).length).toBe(2);
  expect(screen.getByText("#s-0")).toBeTruthy();
  expect(screen.queryByText("#s-50")).toBeNull();
});

test("hiển thị backend error", async () => {
  mockResponse(
    { error: { code: "NOT_FOUND", message: "Không tìm thấy cuộc thi." } },
    404,
  );
  renderPage();
  expect(await screen.findByRole("alert")).toHaveTextContent("Không tìm thấy cuộc thi.");
});

/** Clipboard là API ngoài jsdom; mỗi test tự cài đặt để kiểm cả nhánh thành công lẫn thất bại. */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

test("sao chép ID: nút đổi trạng thái, live region thông báo rồi tự tắt", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  stubClipboard(writeText);
  mockPagedFetch();
  renderPage();
  await screen.findByText("#s-0");

  fireEvent.click(screen.getAllByRole("button", { name: "Sao chép ID" })[0]);

  await waitFor(() => expect(writeText).toHaveBeenCalledWith("s-0"));
  expect(await screen.findByText("Đã sao chép ID s-0.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Đã sao chép ID" })).toBeTruthy();
  // Phản hồi sao chép không được đụng tới bảng.
  expect(screen.getByText("#s-0")).toBeTruthy();

  await waitFor(() => expect(screen.queryByText("Đã sao chép ID s-0.")).toBeNull(), {
    timeout: 3000,
  });
  expect(screen.getByRole("button", { name: "Sao chép ID" })).toBeTruthy();
});

test("sao chép ID thất bại: báo lỗi riêng và giữ nguyên bảng", async () => {
  stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
  mockPagedFetch();
  renderPage();
  await screen.findByText("#s-0");

  fireEvent.click(screen.getAllByRole("button", { name: "Sao chép ID" })[0]);

  expect(await screen.findByRole("alert")).toHaveTextContent("Không sao chép được ID");
  expect(screen.getByText("#s-0")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Sao chép ID" }).length).toBeGreaterThan(0);
});

test("trình duyệt không có Clipboard API: báo lỗi thay vì im lặng", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  mockPagedFetch();
  renderPage();
  await screen.findByText("#s-0");

  fireEvent.click(screen.getAllByRole("button", { name: "Sao chép ID" })[0]);

  expect(await screen.findByRole("alert")).toHaveTextContent("không cho phép sao chép tự động");
  expect(screen.getByText("#s-0")).toBeTruthy();
});

test("vùng cuộn ngang của bảng là region focus được bằng bàn phím", async () => {
  mockPagedFetch();
  renderPage();
  await screen.findByText("#s-0");

  const region = screen.getByRole("region", { name: "Bảng bài đã nộp" });
  expect(region).toHaveAttribute("tabindex", "0");
  expect(within(region).getByRole("table")).toBeTruthy();
});

test("bài bị từ chối vẫn giữ metrics và artifact, hiện lý do, nhưng không còn là bài tốt nhất", async () => {
  const REJECTED_NOTE = "Notebook dùng kiến trúc không được phép.";
  mockResponse({
    submissions: [
      {
        id: "s3",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { f1: 0.95, precision: 0.9, recall: 0.9 },
        primary_score: 0.95,
        created_at: "2026-09-16T10:00:00Z",
        review: { status: "rejected", note: REJECTED_NOTE },
        artifacts: {
          prediction: { filename: "rejected.csv", size_bytes: 128, available: true },
          notebook: { filename: "rejected.ipynb", size_bytes: 4096, available: true },
        },
      },
      {
        id: "s2",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { f1: 0.7, precision: 0.6, recall: 0.5 },
        primary_score: 0.7,
        created_at: "2026-09-15T09:00:00Z",
        artifacts: {
          prediction: { filename: "accepted.csv", size_bytes: 128, available: true },
          notebook: { filename: "accepted.ipynb", size_bytes: 4096, available: true },
        },
      },
    ],
    total: 2,
    limit: 50,
    offset: 0,
  });
  renderPage();
  await screen.findByTitle("rejected.csv");

  const rows = screen.getAllByRole("row");
  const rejectedRow = rows[1];
  // Trạng thái chấm điểm vẫn là "Đã chấm điểm"; quyết định của admin là badge riêng kèm lý do.
  expect(within(rejectedRow).getByText("Đã chấm điểm")).toBeTruthy();
  expect(within(rejectedRow).getByText("Không chấp nhận")).toBeTruthy();
  expect(within(rejectedRow).getByText(`Lý do: ${REJECTED_NOTE}`)).toBeTruthy();
  // Minh bạch: metrics và cả hai artifact vẫn còn (F1 và Điểm chính cùng bằng 0.95).
  expect(within(rejectedRow).getAllByText("0.950000").length).toBe(2);
  expect(within(rejectedRow).getAllByRole("button")).toHaveLength(3);
  expect(within(rejectedRow).getByRole("button", { name: "Notebook" })).toBeTruthy();
  expect(within(rejectedRow).queryByText("Tốt nhất")).toBeNull();

  // Bài hợp lệ thấp điểm hơn giữ badge "Tốt nhất" và là điểm cao nhất trong trang.
  expect(within(rows[2]).getByText("Tốt nhất")).toBeTruthy();
  expect(document.querySelector(".subm-summary-score")?.textContent).toBe("0.700000");
});

test("trang chỉ có bài bị từ chối thì không hiện điểm cao nhất", async () => {
  mockResponse({
    submissions: [
      {
        id: "s1",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { f1: 0.95, precision: 0.9, recall: 0.9 },
        primary_score: 0.95,
        created_at: "2026-09-16T10:00:00Z",
        review: { status: "rejected", note: "Thiếu mô tả kiến trúc." },
        artifacts: {
          prediction: { filename: "only.csv", size_bytes: 128, available: true },
          notebook: null,
        },
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  });
  renderPage();
  await screen.findByTitle("only.csv");

  expect(screen.queryByText("Điểm cao nhất trong trang:")).toBeNull();
  expect(screen.queryByText("Tốt nhất")).toBeNull();
});
