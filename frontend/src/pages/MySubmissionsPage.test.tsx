import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { AI_PARTICIPANT_DISCLAIMER } from "../api/aiReview";
import type { CompetitionDetail } from "../api/competitions";
import { PROVISIONAL_NORM_LABEL } from "../lib/normalization";
import { setDocumentHidden } from "../test/timers";
import { MySubmissionsPage } from "./MySubmissionsPage";

/** Nhịp tự làm mới ngầm của trang. */
const AUTO_REFRESH_MS = 3_000;

/**
 * Chạy đồng hồ ảo kèm flush microtask. Hook cộng jitter ±10% vào nhịp, nên các test đọc mốc
 * thời gian phải cố định `Math.random` về 0.5 (hệ số 1.0) để nhịp không trôi.
 */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const COMPETITION: CompetitionDetail = {
  id: "64a000000000000000000001",
  slug: "results-cup",
  name: "Results Cup",
  short_description: "",
  status: "published",
  start_at: "2026-01-01T00:00:00Z",
  end_at: "2027-01-01T00:00:00Z",
  join_mode: "open",
  primary_metric: "f1",
  quota_per_day: 5,
  leaderboard_visible: true,
  resources: [],
  join_code_configured: false,
  primary_metric_label: "F1",
  access: { allowed: true, reason: null },
  membership: { active: true, joined_at: "2026-09-15T00:00:00Z" },
  // Cuộc thi v1: response chưa có result_contract nên trang mô tả lại thành f1/precision/recall, 4 chữ số.
  submission_config: {
    ready: true,
    id_column: "id",
    prediction_column: "prediction",
    average: "binary",
    pos_label: "1",
    max_upload_mb: 10,
    max_notebook_mb: 20,
  },
};

/** Vùng thông báo của dải phân trang - trang còn live region riêng cho phản hồi sao chép ID. */
function pagerStatus(): HTMLElement {
  return within(document.querySelector(".subm-pagination-footer") as HTMLElement).getByRole("status");
}

/** Shell thật sẽ khóa gate khi được thông báo; ở đây chỉ cần ghi nhận lý do. */
const reportAccessLost = vi.fn();

function renderPage(competition: CompetitionDetail = COMPETITION) {
  return render(
    <MemoryRouter initialEntries={["/competitions/results-cup/submissions"]}>
      <Routes>
        <Route element={<Outlet context={{ competition, contents: [], reportAccessLost }} />}>
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  reportAccessLost.mockClear();
  vi.useRealTimers();
  setDocumentHidden(false);
});

/** Cột AI của một dòng, tra theo class để không phụ thuộc thứ tự cột. */
function aiCellOf(row: HTMLElement): HTMLElement {
  return row.querySelector(".subm-ai-cell") as HTMLElement;
}

/** Một trang một dòng với projection AI thay đổi được, dùng cho cột AI và vòng poll. */
function pagesWithAi(pending: boolean) {
  return {
    submissions: [
      {
        id: "s-ai",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
        primary_score: 0.9,
        created_at: "2026-09-15T09:00:00Z",
        artifacts: {
          prediction: { filename: "ai.csv", size_bytes: 128, available: true },
          notebook: null,
        },
        ai_review: {
          state: pending ? "QUEUED" : "COMPLETED",
          verdict: pending ? null : "CLEAR",
          summary: pending ? "Đang chờ kiểm tra." : "Không thấy vi phạm.",
          updated_at: "2026-09-15T09:05:00Z",
        },
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  };
}

/** Fetch trả body tính lại mỗi lần gọi, để đổi câu trả lời giữa các nhịp poll. */
function mockMutableResponse(body: () => unknown) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse(body());
    }),
  );
  return { urls };
}

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

  // Tên tệp là tooltip của cả nút xem lẫn nút tải, nên mỗi tệp có hai phần tử mang title này.
  expect(await screen.findAllByTitle("latest.csv")).toHaveLength(2);
  expect(screen.getAllByTitle("solution.ipynb")).toHaveLength(2);
  expect(screen.getAllByTitle("first.csv")).toHaveLength(2);
  expect(screen.getByText("Không thể chấm điểm bài nộp.")).toBeTruthy();
  // Hợp đồng v1 vẫn hiện đủ ba cột f1/precision/recall, mỗi số bốn chữ số theo hợp đồng.
  expect(screen.getAllByText("0.9000").length).toBeGreaterThan(0);
  expect(screen.getByText("0.8000")).toBeTruthy();
  expect(screen.getByText("0.7000")).toBeTruthy();

  const rows = screen.getAllByRole("row");
  expect(Array.from(rows[0].querySelectorAll("th")).slice(3).map((th) => th.textContent)).toEqual([
    "Điểm chính · F1", "Precision", "Recall",
  ]);
  // Dòng mới nhất có đủ hai tệp: mỗi tệp một cặp nút xem/tải, cộng nút sao chép ID của dòng.
  expect(within(rows[1]).getAllByRole("button")).toHaveLength(5);
  expect(within(rows[1]).getByRole("button", { name: "Xem CSV" })).toBeTruthy();
  expect(within(rows[1]).getByRole("button", { name: "Xem Notebook" })).toBeTruthy();
  expect(within(rows[1]).getByRole("button", { name: "Tải Notebook" })).toBeTruthy();
  // Dòng legacy chỉ còn tệp CSV: hai nút của nó, không có nút notebook nào.
  expect(within(rows[2]).getAllByRole("button")).toHaveLength(3);
  expect(within(rows[2]).queryByRole("button", { name: "Xem Notebook" })).toBeNull();
  expect(within(rows[2]).queryByRole("button", { name: "Tải Notebook" })).toBeNull();
  expect(rows[2].querySelector(".subm-primary-score-value")).toHaveTextContent("-");
});

test("Xem CSV mở trình xem qua route của chính cuộc thi và đóng trả focus", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/prediction")) {
        return new Response("id,label\n1,cat\n", {
          status: 200,
          headers: { "Content-Type": "text/csv" },
        });
      }
      return jsonResponse(submissionsPage(0, 1));
    }),
  );

  renderPage();
  await screen.findByText("#s-0");

  const trigger = screen.getByRole("button", { name: "Xem CSV" });
  trigger.focus();
  fireEvent.click(trigger);

  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByRole("table")).toBeTruthy();
  expect(requests).toContain(
    `/api/competitions/${COMPETITION.id}/submissions/s-0/prediction`,
  );
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

/** Cuộc thi v2 khai báo metric riêng: nhãn cột và số thập phân phải lấy từ hợp đồng, không phải bộ ba cố định. */
const V2_COMPETITION: CompetitionDetail = {
  ...COMPETITION,
  submission_config: {
    ...COMPETITION.submission_config,
    version: 2,
    primary_metric: "accuracy",
    higher_is_better: true,
    result_contract: {
      metrics: [
        { key: "n_items", label: "Số mẫu", decimals: 0 },
        { key: "accuracy", label: "Độ chính xác", decimals: 2 },
      ],
      primary_metric: "accuracy",
      higher_is_better: true,
    },
  },
};

test("cuộc thi v2 hiện metric, nhãn và số thập phân theo hợp đồng", async () => {
  mockResponse({
    submissions: [
      {
        id: "s-v2",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { accuracy: 0.9125, n_items: 1200 },
        primary_score: 0.9125,
        created_at: "2026-09-15T09:00:00Z",
        artifacts: {
          prediction: { filename: "v2.csv", size_bytes: 128, available: true },
          notebook: null,
        },
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  });
  renderPage(V2_COMPETITION);
  expect(await screen.findAllByTitle("v2.csv")).toHaveLength(2);

  const rows = screen.getAllByRole("row");
  // Metric chính khai báo sau nhưng đứng đầu cụm cột, nhãn nêu rõ vai trò xếp hạng.
  expect(Array.from(rows[0].querySelectorAll("th")).slice(3).map((th) => th.textContent)).toEqual([
    "Điểm chính · Độ chính xác", "Số mẫu",
  ]);
  expect(within(rows[0]).queryByText("F1")).toBeNull();

  const cells = Array.from(rows[1].querySelectorAll(".score-cell"));
  expect(cells.map((cell) => cell.textContent)).toEqual(["0.91", "1200"]);
  // Số chính có khung riêng, số phụ không có; không thêm cột điểm trùng lặp.
  expect(cells[0].className).toContain("primary-score");
  expect(cells[0].querySelector(".subm-primary-score-value")).toHaveTextContent("0.91");
  expect(cells[1].className).not.toContain("primary-score");
  expect(cells[1].querySelector(".subm-primary-score-value")).toBeNull();
  expect(document.querySelector(".subm-summary-score")?.textContent).toBe("0.91");
});

test("bài cũ thiếu metric chính vẫn hiện dấu gạch trước metric phụ", async () => {
  mockResponse({
    submissions: [{
      id: "s-partial",
      competition_id: COMPETITION.id,
      status: "completed",
      metrics: { n_items: 1200 },
      primary_score: null,
      created_at: "2026-09-15T09:00:00Z",
      artifacts: { prediction: null, notebook: null },
    }],
    total: 1,
    limit: 50,
    offset: 0,
  });
  renderPage(V2_COMPETITION);
  await screen.findByText("1200");

  const cells = Array.from(screen.getAllByRole("row")[1].querySelectorAll(".score-cell"));
  expect(cells.map((cell) => cell.textContent)).toEqual(["-", "1200"]);
  expect(cells[0].querySelector(".subm-primary-score-value")).toHaveTextContent("-");
});

test("bản nháp v2 chưa khai báo metric: ẩn cụm chỉ số thay vì hiện null/undefined", async () => {
  const draft: CompetitionDetail = {
    ...COMPETITION,
    submission_config: {
      ...COMPETITION.submission_config,
      version: 2,
      result_contract: { metrics: [], primary_metric: null, higher_is_better: true },
    },
  };
  mockResponse({
    submissions: [
      {
        id: "s-draft",
        competition_id: COMPETITION.id,
        status: "failed",
        metrics: null,
        primary_score: null,
        created_at: "2026-09-15T09:00:00Z",
        artifacts: { prediction: null, notebook: null },
        error: {
          code: "SCORING_TEST_REQUIRED",
          message: "Cần chọn metric chính trước khi chấm điểm.",
        },
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  });
  renderPage(draft);
  await screen.findByText("Cần chọn metric chính trước khi chấm điểm.");

  const rows = screen.getAllByRole("row");
  expect(rows[1].querySelectorAll(".score-cell")).toHaveLength(0);
  const seen = document.body.textContent ?? "";
  expect(seen).not.toContain("null");
  expect(seen).not.toContain("undefined");
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
  expect(await screen.findAllByTitle("rejected.csv")).toHaveLength(2);

  const rows = screen.getAllByRole("row");
  const rejectedRow = rows[1];
  // Trạng thái chấm điểm vẫn là "Đã chấm điểm"; quyết định của admin là badge riêng kèm lý do.
  expect(within(rejectedRow).getByText("Đã chấm điểm")).toBeTruthy();
  expect(within(rejectedRow).getByText("Không chấp nhận")).toBeTruthy();
  expect(within(rejectedRow).getByText(`Lý do: ${REJECTED_NOTE}`)).toBeTruthy();
  // Minh bạch: metrics và cả hai artifact vẫn còn; điểm chính là cột metric chính nên chỉ hiện một lần.
  expect(within(rejectedRow).getAllByText("0.9500")).toHaveLength(1);
  // Hai tệp, mỗi tệp một cặp nút xem/tải, cộng nút sao chép ID của dòng.
  expect(within(rejectedRow).getAllByRole("button")).toHaveLength(5);
  expect(within(rejectedRow).getByRole("button", { name: "Tải Notebook" })).toBeTruthy();
  expect(within(rejectedRow).queryByText("Tốt nhất")).toBeNull();

  // Bài hợp lệ thấp điểm hơn giữ badge "Tốt nhất" và là điểm tốt nhất trong trang.
  expect(within(rows[2]).getByText("Tốt nhất")).toBeTruthy();
  expect(document.querySelector(".subm-summary-score")?.textContent).toBe("0.7000");
});

test("lịch sử có norm: snapshot là cột riêng, điểm gốc hết được nhấn, bỏ pill 'tốt nhất' theo raw", async () => {
  const artifacts = {
    prediction: { filename: "prediction.csv", size_bytes: 128, available: true },
    notebook: { filename: "notebook.ipynb", size_bytes: 4096, available: true },
  };
  mockResponse({
    submissions: [
      {
        id: "s3",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { f1: 0.95, precision: 0.9, recall: 0.9 },
        primary_score: 0.95,
        created_at: "2026-09-16T10:00:00Z",
        normalization_snapshot: { score: 42.5, calculated_at: "2026-09-16T10:00:05Z" },
        artifacts,
      },
      {
        id: "s2",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { f1: 0.8, precision: 0.8, recall: 0.8 },
        primary_score: 0.8,
        created_at: "2026-09-16T09:00:00Z",
        review: { status: "rejected", note: "Notebook sai kiến trúc." },
        normalization_snapshot: { score: 12, calculated_at: "2026-09-16T09:00:05Z" },
        artifacts,
      },
      {
        // Dòng cũ thiếu snapshot: cột norm để "—", không tự bịa giá trị lịch sử.
        id: "s1",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { f1: 0.7, precision: 0.7, recall: 0.7 },
        primary_score: 0.7,
        created_at: "2026-09-15T09:00:00Z",
        artifacts,
      },
    ],
    total: 3,
    limit: 50,
    offset: 0,
  });
  renderPage();
  await screen.findByText("#s3");

  // Cột snapshot nằm cạnh cụm điểm; metric nguồn đổi nhãn "Điểm gốc" vì không còn là điểm xếp hạng.
  expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
    "Submission / thời gian",
    "Tệp đã nộp",
    "Trạng thái",
    PROVISIONAL_NORM_LABEL,
    "Điểm gốc · F1",
    "Precision",
    "Recall",
  ]);

  const rows = screen.getAllByRole("row");
  expect(within(rows[1]).getByText("42.50")).toBeTruthy();
  // Bài bị từ chối vẫn giữ snapshot khi có quyền xem, kèm nhắc là không còn tính vào BXH.
  expect(within(rows[2]).getByText("12.00")).toBeTruthy();
  expect(within(rows[2]).getByText("Không tính BXH")).toBeTruthy();
  expect(within(rows[3]).getByText("—")).toBeTruthy();

  // Snapshot có mẫu số khác nhau nên không suy "tốt nhất" từ raw; đường xem norm là bảng xếp hạng.
  expect(screen.queryByText("Tốt nhất")).toBeNull();
  expect(document.querySelector(".best-submission-row")).toBeNull();
  expect(screen.queryByText(/Điểm tốt nhất trong trang/)).toBeNull();
  expect(
    screen.getByRole("link", { name: "Điểm norm hiện tại xem ở bảng xếp hạng" }),
  ).toBeTruthy();
});

test("điểm tốt nhất theo chiều của hợp đồng: metric nhỏ hơn là tốt hơn", async () => {
  // Cuộc thi v2 khai `higher_is_better: false`: bài loss thấp nhất mới là bài tốt nhất.
  const lossCompetition: CompetitionDetail = {
    ...COMPETITION,
    submission_config: {
      ...COMPETITION.submission_config,
      version: 2,
      primary_metric: "loss",
      higher_is_better: false,
      result_contract: {
        metrics: [{ key: "loss", label: "Loss", decimals: 4 }],
        primary_metric: "loss",
        higher_is_better: false,
      },
    },
  };
  mockResponse({
    submissions: [
      {
        id: "s1",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { loss: 0.4 },
        primary_score: 0.4,
        created_at: "2026-09-16T10:00:00Z",
        artifacts: {
          prediction: { filename: "higher-loss.csv", size_bytes: 128, available: true },
          notebook: null,
        },
      },
      {
        id: "s2",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { loss: 0.1 },
        primary_score: 0.1,
        created_at: "2026-09-15T10:00:00Z",
        artifacts: {
          prediction: { filename: "lower-loss.csv", size_bytes: 128, available: true },
          notebook: null,
        },
      },
    ],
    total: 2,
    limit: 50,
    offset: 0,
  });
  renderPage(lossCompetition);
  expect(await screen.findAllByTitle("lower-loss.csv")).toHaveLength(2);

  const rows = screen.getAllByRole("row");
  expect(within(rows[2]).getByText("Tốt nhất")).toBeTruthy();
  expect(within(rows[1]).queryByText("Tốt nhất")).toBeNull();
  expect(document.querySelector(".subm-summary-score")?.textContent).toBe("0.1000");
});

test("trang chỉ có bài bị từ chối thì không hiện điểm tốt nhất", async () => {
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
  expect(await screen.findAllByTitle("only.csv")).toHaveLength(2);

  expect(screen.queryByText("Điểm tốt nhất trong trang:")).toBeNull();
  expect(screen.queryByText("Tốt nhất")).toBeNull();
});

test("cột AI chỉ hiện kết luận an toàn, kèm câu nhắc và không lộ chi tiết kỹ thuật", async () => {
  mockResponse({
    submissions: [
      {
        ...pagesWithAi(false).submissions[0],
        // Server không gửi những field này; nhét vào fixture để chắc rằng UI cũng không vẽ chúng
        // nếu một ngày projection rộng ra.
        ai_review: {
          state: "COMPLETED",
          verdict: "FLAGGED",
          summary: "Có một dấu hiệu cần xem lại.",
          updated_at: "2026-09-15T09:05:00Z",
          provider_host: "api.example.com",
          model: "gpt-oss-120b",
          error: { code: "AI_PROVIDER_UNAUTHORIZED", message: "Nhà cung cấp từ chối API key." },
          findings: [{ rule_text: "Không dùng dữ liệu ngoài." }],
        },
      },
      {
        id: "s-cu",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { f1: 0.5, precision: 0.4, recall: 0.3 },
        primary_score: 0.5,
        created_at: "2026-09-14T09:00:00Z",
        artifacts: {
          prediction: { filename: "cu.csv", size_bytes: 128, available: true },
          notebook: null,
        },
      },
    ],
    total: 2,
    limit: 50,
    offset: 0,
  });
  renderPage();
  expect(await screen.findAllByTitle("cu.csv")).toHaveLength(2);

  const rows = screen.getAllByRole("row");
  expect(within(rows[0]).getByText("AI sơ bộ")).toBeTruthy();
  expect(within(aiCellOf(rows[1])).getByText("Có dấu hiệu")).toBeTruthy();
  expect(within(aiCellOf(rows[1])).getByText("Có một dấu hiệu cần xem lại.")).toBeTruthy();

  // Bài nộp từ lúc cuộc thi chưa bật AI: thiếu dữ liệu chứ không phải "không phát hiện".
  const legacyCell = aiCellOf(rows[2]);
  expect(legacyCell.textContent).toBe("—");

  expect(screen.getByText(AI_PARTICIPANT_DISCLAIMER)).toBeTruthy();
  const seen = document.body.textContent ?? "";
  for (const secret of ["api.example.com", "gpt-oss-120b", "AI_PROVIDER_UNAUTHORIZED", "findings"]) {
    expect(seen).not.toContain(secret);
  }
});

test("chưa công khai kết luận AI cho thí sinh thì không có cột AI lẫn câu nhắc", async () => {
  mockResponse({
    submissions: [
      {
        id: "s1",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
        primary_score: 0.9,
        created_at: "2026-09-15T09:00:00Z",
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
  expect(await screen.findAllByTitle("only.csv")).toHaveLength(2);

  expect(screen.queryByText("AI sơ bộ")).toBeNull();
  expect(screen.queryByText(AI_PARTICIPANT_DISCLAIMER)).toBeNull();
  expect(document.querySelector(".subm-ai-cell")).toBeNull();
});

test("kết luận AI không đổi việc chọn bài tốt nhất: chỉ từ chối của con người mới loại bài", async () => {
  mockResponse({
    submissions: [
      {
        id: "s2",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { f1: 0.95, precision: 0.9, recall: 0.9 },
        primary_score: 0.95,
        created_at: "2026-09-16T10:00:00Z",
        review: null,
        ai_review: {
          state: "COMPLETED",
          verdict: "FLAGGED",
          summary: "Có dấu hiệu cần xem lại.",
          updated_at: "2026-09-16T10:05:00Z",
        },
        artifacts: {
          prediction: { filename: "flagged.csv", size_bytes: 128, available: true },
          notebook: null,
        },
      },
      {
        id: "s1",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { f1: 0.7, precision: 0.6, recall: 0.5 },
        primary_score: 0.7,
        created_at: "2026-09-15T09:00:00Z",
        review: { status: "rejected", note: "Notebook sai kiến trúc." },
        ai_review: {
          state: "COMPLETED",
          verdict: "CLEAR",
          summary: "Không thấy vi phạm.",
          updated_at: "2026-09-15T09:05:00Z",
        },
        artifacts: {
          prediction: { filename: "clear.csv", size_bytes: 128, available: true },
          notebook: null,
        },
      },
    ],
    total: 2,
    limit: 50,
    offset: 0,
  });
  renderPage();
  expect(await screen.findAllByTitle("flagged.csv")).toHaveLength(2);

  const rows = screen.getAllByRole("row");
  // Bài điểm cao có verdict xấu vẫn là bài tốt nhất: verdict AI không phải phán quyết.
  expect(within(rows[1]).getByText("Tốt nhất")).toBeTruthy();
  expect(document.querySelector(".subm-summary-score")?.textContent).toBe("0.9500");
  // Bài ngược lại - AI sạch nhưng người từ chối - thì mất suất, đúng như trước khi có AI.
  expect(within(rows[2]).queryByText("Tốt nhất")).toBeNull();
  expect(within(rows[2]).getByText("Không chấp nhận")).toBeTruthy();
});

test("đang xem thì trang tự làm mới ngầm theo nhịp, không nháy trạng thái tải", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  let id = "s-0";
  const { urls } = mockMutableResponse(() => ({
    ...submissionsPage(0, 120),
    submissions: [{ ...submissionsPage(0, 120).submissions[0], id }],
  }));

  renderPage();
  await advance(0);
  expect(urls).toHaveLength(1);
  expect(screen.getByText("#s-0")).toBeTruthy();
  expect(pagerStatus()).toHaveTextContent("Đã hiển thị 1–50 trong số 120 bài nộp");

  id = "s-live";
  await advance(AUTO_REFRESH_MS);
  expect(urls).toHaveLength(2);
  expect(screen.getByText("#s-live")).toBeTruthy();
  expect(screen.queryByText("#s-0")).toBeNull();
  // Lượt ngầm không đụng trạng thái tải: dải phân trang vẫn đọc số dòng, không thành "Đang cập nhật…".
  expect(pagerStatus()).toHaveTextContent("Đã hiển thị 1–50 trong số 120 bài nộp");
});

test("làm mới ngầm giữ nguyên trang đang xem và focus của nút phân trang", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { urls } = mockPagedFetch();

  renderPage();
  await advance(0);
  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  await advance(0);
  expect(screen.getByText("#s-50")).toBeTruthy();

  const next = screen.getByRole("button", { name: "Trang sau" });
  next.focus();
  await advance(AUTO_REFRESH_MS);
  // Lượt ngầm hỏi đúng trang đang xem, không kéo người dùng về trang một.
  expect(urls.at(-1)).toContain("offset=50");
  expect(screen.getByText("#s-50")).toBeTruthy();
  expect(document.activeElement).toBe(next);
});

test("membership bị vô hiệu hóa giữa chừng: xoá lịch sử đã tải và báo shell thay vì giữ bài cũ", async () => {
  let revoked = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const offset = Number(new URL(String(input), "http://localhost").searchParams.get("offset") ?? 0);
      if (revoked && offset === 50) {
        return jsonResponse(
          {
            error: {
              code: "MEMBERSHIP_INACTIVE",
              message: "Quyền tham gia cuộc thi đã bị vô hiệu hóa.",
            },
          },
          403,
        );
      }
      return jsonResponse(submissionsPage(offset, 120));
    }),
  );

  renderPage();
  expect(await screen.findByText("#s-0")).toBeTruthy();

  revoked = true;
  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  await waitFor(() => expect(reportAccessLost).toHaveBeenCalledWith("membership_inactive"));
  // Bài cũ của chính mình cũng không được nằm lại trên màn hình, và đây là mất quyền
  // chứ không phải lỗi tải nên không hiện băng báo lỗi.
  expect(screen.queryByText("#s-0")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("mất quyền giữa chừng: 403 dừng tự làm mới và báo rõ", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  let forbidden = false;
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (forbidden) {
        return jsonResponse(
          { error: { code: "FORBIDDEN", message: "Không có quyền xem bài nộp." } },
          403,
        );
      }
      return jsonResponse(submissionsPage(0, 1));
    }),
  );

  renderPage();
  await advance(0);
  expect(screen.getByText("#s-0")).toBeTruthy();

  forbidden = true;
  await advance(AUTO_REFRESH_MS);
  expect(screen.getByText(/Đã dừng tự động làm mới/)).toBeTruthy();
  // Bảng cũ vẫn còn, nhưng vòng tự làm mới đã dừng hẳn thay vì quay mãi.
  expect(screen.getByText("#s-0")).toBeTruthy();

  const calls = urls.length;
  await advance(AUTO_REFRESH_MS * 5);
  expect(urls).toHaveLength(calls);
});

test("lượt ngầm lỗi mạng giữ bảng và báo đang thử lại, sau đó tự phục hồi", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  let failing = false;
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (failing) {
        return jsonResponse({ error: { code: "INTERNAL_ERROR", message: "Lỗi hệ thống." } }, 500);
      }
      return jsonResponse(submissionsPage(0, 1));
    }),
  );

  renderPage();
  await advance(0);
  expect(screen.getByText("#s-0")).toBeTruthy();

  failing = true;
  await advance(AUTO_REFRESH_MS);
  // Bảng cũ ở lại; trạng thái thử lại vẫn hiển thị thay vì giả vờ dữ liệu đã mới.
  expect(screen.getByText("#s-0")).toBeTruthy();
  expect(screen.getByText(/Hệ thống đang tự thử lại/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();

  // Backoff sau lỗi đầu: 3000 * 2^1 = 6000ms (jitter đã cố định về hệ số 1.0).
  await advance(5_999);
  expect(urls).toHaveLength(2);
  failing = false;
  await advance(1);
  expect(urls).toHaveLength(3);
  expect(screen.getByText("#s-0")).toBeTruthy();
  expect(screen.queryByText(/Hệ thống đang tự thử lại/)).toBeNull();
});

test("tab bị ẩn thì ngừng làm mới ngầm, quay lại thì cập nhật ngay", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { urls } = mockMutableResponse(() => submissionsPage(0, 1));

  renderPage();
  await advance(0);
  expect(urls).toHaveLength(1);

  setDocumentHidden(true);
  await advance(AUTO_REFRESH_MS * 3);
  expect(urls).toHaveLength(1);

  setDocumentHidden(false);
  await advance(0);
  expect(urls).toHaveLength(2);
});

test("trình xem tệp đang mở thì trang nhường lượt làm mới ngầm", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/prediction")) {
        return new Response("id,label\n1,cat\n", {
          status: 200,
          headers: { "Content-Type": "text/csv" },
        });
      }
      return jsonResponse(submissionsPage(0, 1));
    }),
  );

  renderPage();
  await advance(0);
  expect(screen.getByText("#s-0")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Xem CSV" }));
  await advance(0);
  expect(screen.getByRole("dialog")).toBeTruthy();

  // Người dùng đang đọc tệp: trang không chen thêm lượt tải lịch sử nào phía sau.
  const listCalls = () => urls.filter((url) => url.includes("/submissions/me?")).length;
  const during = listCalls();
  await advance(AUTO_REFRESH_MS * 3);
  expect(listCalls()).toBe(during);

  fireEvent.keyDown(document, { key: "Escape" });
  await advance(0);
  expect(screen.queryByRole("dialog")).toBeNull();
  await advance(AUTO_REFRESH_MS);
  expect(listCalls()).toBeGreaterThan(during);
});
