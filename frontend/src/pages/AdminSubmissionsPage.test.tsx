import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import type { AdminAiReview, AiReviewDetail } from "../api/aiReview";
import type {
  AdminSubmissionsResponse,
  GlobalSubmissionItem,
  ResultContract,
} from "../api/results";
import { AdminSubmissionsPanel } from "../components/AdminSubmissionsPanel";
import { setDocumentHidden } from "../test/timers";
import { AdminSubmissionsPage } from "./AdminSubmissionsPage";

/** Nhịp tự làm mới ngầm của bảng. */
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

const ROW: GlobalSubmissionItem = {
  id: "s-0",
  competition_id: "c1",
  status: "completed",
  metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
  primary_score: 0.9,
  created_at: "2026-09-15T09:00:00Z",
  artifacts: {
    prediction: { filename: "prediction.csv", size_bytes: 128, available: true },
    notebook: { filename: "notebook.ipynb", size_bytes: 4096, available: true },
  },
  account: { id: "a1", name: "Đội 1", email: "team1@vku.vn" },
  competition: { id: "c1", slug: "cup-1", name: "Cup 1" },
  // Chưa từng bị xét duyệt: chưa có quyết định nào của BTC, không phải đã hợp lệ.
  review: null,
  // Cuộc thi chưa từng bật AI lúc nộp bài.
  ai_review: null,
};

const STATS = { total: 3, competitions: 2, teams: 2, completed: 2 };

/** Một trang bài nộp; tên đội nhúng offset để nhận ra trang đang hiển thị. */
function page(offset: number, total: number): AdminSubmissionsResponse {
  return {
    submissions: [
      {
        ...ROW,
        id: `s-${offset}`,
        account: { id: "a1", name: `Đội ${offset}`, email: "team@vku.vn" },
      },
    ],
    total,
    limit: 50,
    offset,
    sort: "created_at",
    order: "desc",
    stats: STATS,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const COMPETITION_OPTIONS = {
  competitions: [
    { id: "c1", name: "Cup 1" },
    { id: "c2", name: "Cup 2" },
  ],
};

/**
 * Danh sách cuộc thi cho ô lọc tách khỏi các request bảng bài nộp. So khớp cả đường dẫn chứ không
 * phải chuỗi con: bảng khóa cuộc thi gọi `/api/admin/competitions/{id}/submissions`, cũng chứa
 * tiền tố đó.
 */
function isOptionsRequest(url: string) {
  return new URL(url, "http://localhost").pathname === "/api/admin/competitions";
}

function mockApi(
  handler: (url: string, init: RequestInit) => Response | Promise<Response> = () =>
    jsonResponse(page(0, 1)),
  options: () => Response = () => jsonResponse(COMPETITION_OPTIONS),
) {
  /** Chỉ request tải bảng (GET) - nơi đọc ra query string đang áp dụng. */
  const urls: string[] = [];
  /** Mọi request ngoài danh sách cuộc thi, kèm method để phân biệt GET list với PATCH xét duyệt. */
  const requests: Array<{ url: string; method: string; body: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (isOptionsRequest(url)) return options();
      const method = init?.method ?? "GET";
      if (method === "GET") urls.push(url);
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : "" });
      return await handler(url, init ?? {});
    }),
  );
  return { urls, requests };
}

/** Các request xét duyệt đã gửi, tách khỏi request tải danh sách. */
function reviewRequests(requests: Array<{ url: string; method: string; body: string }>) {
  return requests.filter((request) => request.method === "PATCH");
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/submissions"]}>
      <AdminSubmissionsPage />
    </MemoryRouter>,
  );
}

/** Query string của request bảng bài nộp gần nhất. */
function lastParams(urls: string[]): URLSearchParams {
  return new URL(urls.at(-1) as string, "http://localhost").searchParams;
}

/** Dải phân trang của bảng; chỉ có khi total vượt PAGE_SIZE. */
function pagerStatus(): HTMLElement {
  return within(document.querySelector(".admin-results-pagination") as HTMLElement).getByRole(
    "status",
  );
}

function statsRegion() {
  return screen.getByRole("region", { name: "Tổng quan bài nộp" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setDocumentHidden(false);
});

test("hiển thị bảng toàn cục với cuộc thi, đội, trạng thái và điểm", async () => {
  const { urls } = mockApi();
  renderPage();

  expect(await screen.findByText("Đội 0")).toBeTruthy();
  expect(screen.getByText("team@vku.vn")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Cup 1" })).toHaveAttribute(
    "href",
    "/admin/competitions/c1",
  );
  // Slug là định danh kỹ thuật, không còn chỗ trong thẻ: tên cuộc thi đã đủ để nhận ra.
  expect(screen.queryByText("cup-1")).toBeNull();
  // Trạng thái chỉ còn icon, kết luận nằm trong `aria-label`; nhãn chữ trùng với ô lọc nên chỉ
  // tra được bằng role.
  const region = screen.getByRole("region", { name: "Danh sách bài nộp toàn hệ thống" });
  expect(within(region).getByRole("img", { name: "Đã chấm điểm" })).toBeTruthy();
  // Response cũ không có `result_contract` nên được mô tả lại thành bộ ba v1 với 4 số thập phân.
  expect(screen.getAllByText("0.9000").length).toBeGreaterThan(0);
  expect(screen.getByText("1 bài nộp trong bộ lọc hiện tại.")).toBeTruthy();

  // Mặc định: mới nhất trước, không gửi tham số lọc rỗng lên server.
  expect(urls[0]).toContain("/api/admin/submissions?");
  expect(lastParams(urls).get("sort")).toBe("created_at");
  expect(lastParams(urls).get("order")).toBe("desc");
  expect(lastParams(urls).get("limit")).toBe("50");
  expect(lastParams(urls).get("offset")).toBe("0");
  expect(lastParams(urls).has("competition_id")).toBe(false);
  expect(lastParams(urls).has("q")).toBe(false);
  expect(lastParams(urls).has("status")).toBe(false);
});

test("nút tải artifact gọi route admin toàn cục của đúng bài nộp", async () => {
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  URL.createObjectURL = vi.fn(() => "blob:mock-download");
  URL.revokeObjectURL = vi.fn();
  const downloads: string[] = [];
  mockApi((url) => {
    if (url.includes("/notebook")) {
      downloads.push(url);
      return new Response("notebook-bytes", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="cup-1-doi-1-s1-notebook.ipynb"',
        },
      });
    }
    return jsonResponse(page(0, 1));
  });

  renderPage();
  await screen.findByText("Đội 0");

  fireEvent.click(screen.getByRole("button", { name: "Tải Notebook" }));

  await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
  expect(downloads).toEqual(["/api/admin/submissions/s-0/notebook"]);
  anchorClick.mockRestore();
});

test("nút Xem CSV mở trình xem qua route admin toàn cục và đóng trả focus", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (isOptionsRequest(url)) return jsonResponse(COMPETITION_OPTIONS);
      requests.push(url);
      if (url.includes("/prediction")) {
        return new Response("id,label\n1,cat\n", {
          status: 200,
          headers: { "Content-Type": "text/csv" },
        });
      }
      return jsonResponse(page(0, 1));
    }),
  );

  renderPage();
  await screen.findByText("Đội 0");

  const trigger = screen.getByRole("button", { name: "Xem CSV" });
  trigger.focus();
  fireEvent.click(trigger);

  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByRole("table")).toBeTruthy();
  expect(requests).toContain("/api/admin/submissions/s-0/prediction");
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("đổi bộ lọc cuộc thi và trạng thái áp dụng ngay, không còn nút Lọc", async () => {
  const { urls } = mockApi((url) =>
    jsonResponse(page(Number(new URL(url, "http://localhost").searchParams.get("offset")), 120)),
  );
  renderPage();
  await screen.findByText("Đội 0");

  expect(screen.queryByRole("button", { name: "Lọc" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  await screen.findByText("Đội 50");

  fireEvent.change(screen.getByLabelText("Lọc theo cuộc thi"), { target: { value: "c2" } });
  await waitFor(() => expect(lastParams(urls).get("competition_id")).toBe("c2"));
  // Bộ lọc mới luôn bắt đầu từ trang đầu.
  expect(lastParams(urls).get("offset")).toBe("0");

  fireEvent.change(screen.getByLabelText("Lọc theo trạng thái chấm"), {
    target: { value: "rejected" },
  });
  await waitFor(() => expect(lastParams(urls).get("status")).toBe("rejected"));
  expect(lastParams(urls).get("competition_id")).toBe("c2");
  expect(lastParams(urls).get("offset")).toBe("0");
});

test("gõ tìm kiếm chỉ gọi server sau khi ngừng gõ, Enter áp dụng ngay", async () => {
  const { urls } = mockApi();
  renderPage();
  await screen.findByText("Đội 0");
  const before = urls.length;

  const input = screen.getByLabelText("Lọc theo đội");
  fireEvent.change(input, { target: { value: "Đ" } });
  fireEvent.change(input, { target: { value: "Đội" } });
  expect(urls.length).toBe(before);

  await waitFor(() => expect(lastParams(urls).get("q")).toBe("Đội"));
  expect(urls.length).toBe(before + 1);

  // Enter bỏ qua debounce; khoảng trắng thừa bị cắt trước khi gửi.
  fireEvent.change(input, { target: { value: "  Đội 1  " } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  await waitFor(() => expect(lastParams(urls).get("q")).toBe("Đội 1"));
  expect(lastParams(urls).get("offset")).toBe("0");
});

test("mỗi bài nộp là một thẻ hai tầng, đúng thứ tự trường của từng tầng", async () => {
  mockApi();
  renderPage();
  await screen.findByText("Đội 0");

  const region = screen.getByRole("region", { name: "Danh sách bài nộp toàn hệ thống" });
  // Một bài nộp vẫn là một item duy nhất, không tách thành hai dòng.
  const items = within(region).getAllByRole("listitem");
  expect(items).toHaveLength(1);

  const tiers = Array.from(items[0].querySelectorAll(".subm-card-tier")) as HTMLElement[];
  expect(tiers).toHaveLength(2);
  const labelsOf = (tier: HTMLElement) =>
    Array.from(tier.querySelectorAll("dt")).map((dt) => dt.textContent);

  expect(labelsOf(tiers[0])).toEqual([
    "Thời gian",
    "Cuộc thi",
    "Đội",
    "Điểm chính",
    "Kết quả",
  ]);
  // Tầng dưới theo đúng thứ tự đọc: chấm xong chưa → máy nói gì → người chốt gì, thao tác cuối.
  expect(labelsOf(tiers[1])).toEqual([
    "Tệp đã nộp",
    "Trạng thái",
    "AI sơ bộ",
    "Xét duyệt",
    "Thao tác",
  ]);

  // Điểm chính đứng riêng trong hộp của nó; cụm Kết quả chỉ còn hai metric phụ của hợp đồng v1
  // (f1 là metric chính nên không được hiện lại).
  expect(fieldValue(items[0], "Điểm chính").querySelector(".subm-score")).toBeTruthy();
  expect(fieldValue(items[0], "Kết quả").querySelectorAll(".subm-metric")).toHaveLength(2);
});

test("bảng toàn cục chỉ sắp xếp theo bốn trường cố định, mỗi trường có thứ tự mặc định riêng", async () => {
  const { urls } = mockApi();
  renderPage();
  await screen.findByText("Đội 0");

  const field = screen.getByLabelText("Sắp xếp theo");
  // Mặc định ban đầu: bài mới nhất trước.
  expect(field).toHaveValue("created_at");
  expect(screen.getByRole("button", { name: "Giảm dần" })).toBeTruthy();

  // Bảng toàn cục trộn nhiều thang điểm nên backend từ chối sort theo metric: thanh này chỉ còn
  // bốn trường cố định, không có F1/Precision/Recall như hồi metric còn cứng.
  expect(within(field).getAllByRole("option").map((option) => option.textContent)).toEqual([
    "Thời gian",
    "Cuộc thi",
    "Đội",
    "Điểm chính",
  ]);

  const fields: Array<[string, string, string]> = [
    ["competition", "asc", "Tăng dần"],
    ["team", "asc", "Tăng dần"],
    ["primary_score", "desc", "Giảm dần"],
    ["created_at", "desc", "Giảm dần"],
  ];

  for (const [sort, order, direction] of fields) {
    fireEvent.change(field, { target: { value: sort } });
    await waitFor(() => expect(lastParams(urls).get("sort")).toBe(sort));
    expect(lastParams(urls).get("order")).toBe(order);
    expect(lastParams(urls).get("offset")).toBe("0");
    expect(field).toHaveValue(sort);
    // Nút đảo chiều nói đúng chiều đang áp dụng.
    expect(screen.getByRole("button", { name: direction })).toBeTruthy();
  }

  // Rời trường rồi quay lại thì về lại thứ tự mặc định của trường đó, không giữ chiều cũ.
  fireEvent.change(field, { target: { value: "team" } });
  await waitFor(() => expect(lastParams(urls).get("order")).toBe("asc"));
  fireEvent.change(field, { target: { value: "primary_score" } });
  await waitFor(() => expect(lastParams(urls).get("sort")).toBe("primary_score"));
  expect(lastParams(urls).get("order")).toBe("desc");

  // Nút đảo chiều lật chiều của trường đang chọn, và đây là đường duy nhất để lật.
  fireEvent.click(screen.getByRole("button", { name: "Giảm dần" }));
  await waitFor(() => expect(lastParams(urls).get("order")).toBe("asc"));
  expect(lastParams(urls).get("sort")).toBe("primary_score");
  expect(screen.getByRole("button", { name: "Tăng dần" })).toBeTruthy();
});

test("Điểm chính đứng riêng trong hộp vàng, các metric phụ giữ trung tính", async () => {
  mockApi();
  renderPage();
  await screen.findByText("Đội 0");

  const primary = fieldValue(itemOf("Đội 0"), "Điểm chính");
  expect(primary.querySelector(".subm-score .subm-result-primary-score")).toHaveTextContent("0.9000");
  // Hộp điểm có ô icon vàng riêng, không mượn ô icon của trường nào khác.
  expect(primary.querySelector(".subm-score .subm-block-icon-gold")).toBeTruthy();

  const result = fieldValue(itemOf("Đội 0"), "Kết quả");
  // Điểm chính không nằm lẫn trong nhóm metric phụ.
  expect(result.querySelector(".subm-result-primary-score")).toBeNull();

  for (const [label, value] of [
    ["Precision", "0.8000"],
    ["Recall", "0.7000"],
  ]) {
    const metric = Array.from(result.querySelectorAll(".subm-metric")).find(
      (node) => node.querySelector(".subm-metric-label")?.textContent === label,
    ) as HTMLElement;
    expect(metric, `không có metric "${label}"`).toBeTruthy();
    expect(metric.querySelector(".subm-metric-value")).toHaveTextContent(value);
  }

  // f1 là metric chính nên chỉ hiện ở hộp Điểm chính, không lặp lại lần thứ hai ở cụm Kết quả.
  expect(
    Array.from(result.querySelectorAll(".subm-metric-label")).map((node) => node.textContent),
  ).toEqual(["Precision", "Recall"]);
});

/** Hợp đồng của một cuộc thi trong trang toàn cục: bộ metric khác hẳn ba cột v1. */
const CUP_ONE_CONTRACT: ResultContract = {
  metrics: [
    { key: "accuracy", label: "Độ chính xác", decimals: 2 },
    { key: "latency", label: "Độ trễ", decimals: 1 },
  ],
  primary_metric: "accuracy",
  higher_is_better: true,
};

test("bảng toàn cục gắn nhãn metric theo hợp đồng của từng cuộc thi trong trang", async () => {
  mockApi(() =>
    jsonResponse({
      ...pageOf([
        row("s-contract", "Đội hợp đồng riêng", {
          metrics: { accuracy: 0.9876, latency: 12.34 },
          primary_score: 0.9876,
        }),
        // Cuộc thi không có trong `competitions` của trang: mô tả lại thành bộ ba v1 chứ không
        // bỏ trắng cụm Kết quả.
        row("s-legacy", "Đội hợp đồng cũ", {
          competition_id: "c9",
          competition: { id: "c9", slug: "", name: "Cuộc thi đã xóa" },
        }),
      ]),
      competitions: [
        { id: "c1", slug: "cup-1", name: "Cup 1", result_contract: CUP_ONE_CONTRACT },
      ],
    }),
  );
  renderPage();
  await screen.findByText("Đội hợp đồng riêng");

  // Nhãn, thứ tự và số thập phân của cụm Kết quả đều theo hợp đồng của cuộc thi của dòng đó.
  const custom = fieldValue(itemOf("Đội hợp đồng riêng"), "Kết quả");
  expect(
    Array.from(custom.querySelectorAll(".subm-metric-label")).map((node) => node.textContent),
  ).toEqual(["Độ trễ"]);
  expect(custom.querySelector(".subm-metric-value")).toHaveTextContent("12.3");
  // Điểm chính lấy số thập phân từ định nghĩa metric chính của cùng hợp đồng.
  expect(
    fieldValue(itemOf("Đội hợp đồng riêng"), "Điểm chính").querySelector(
      ".subm-result-primary-score",
    ),
  ).toHaveTextContent("0.99");

  const legacy = fieldValue(itemOf("Đội hợp đồng cũ"), "Kết quả");
  expect(
    Array.from(legacy.querySelectorAll(".subm-metric-label")).map((node) => node.textContent),
  ).toEqual(["Precision", "Recall"]);
  expect(
    fieldValue(itemOf("Đội hợp đồng cũ"), "Điểm chính").querySelector(
      ".subm-result-primary-score",
    ),
  ).toHaveTextContent("0.9000");
});

/** Hợp đồng ba metric v1 dùng cho metadata của hai cuộc thi trong bài test norm. */
const NORM_CONTRACT: ResultContract = {
  metrics: [
    { key: "f1", label: "F1", decimals: 4 },
    { key: "precision", label: "Precision", decimals: 4 },
    { key: "recall", label: "Recall", decimals: 4 },
  ],
  primary_metric: "f1",
  higher_is_better: true,
};

test("bảng toàn cục: norm của từng dòng tra theo metadata cuộc thi, không lẫn giữa các hàng", async () => {
  mockApi(() =>
    jsonResponse({
      ...pageOf([
        row("s-norm", "Đội norm", {
          normalization_snapshot: {
            version: 1,
            source_metric: "f1",
            higher_is_better: true,
            baseline: 0.5,
            reference_best: 0.8,
            score: 37.5,
            calculated_at: "2026-09-15T09:00:00Z",
          },
        }),
        // Cuộc thi chưa bật norm: dòng này giữ nguyên "Điểm chính", không mọc trường norm.
        row("s-plain", "Đội thường", {
          competition_id: "c2",
          competition: { id: "c2", slug: "cup-2", name: "Cup 2" },
        }),
      ]),
      competitions: [
        {
          id: "c1",
          slug: "cup-1",
          name: "Cup 1",
          result_contract: NORM_CONTRACT,
          normalization: { enabled: true, baseline: 0.5, version: 1 },
        },
        // c2 vắng `normalization` trong metadata: hiểu là đang tắt.
        { id: "c2", slug: "cup-2", name: "Cup 2", result_contract: NORM_CONTRACT },
      ],
    }),
  );
  renderPage();
  await screen.findByText("Đội norm");

  const normItem = itemOf("Đội norm");
  // Điểm chính của cuộc thi bật norm xuống thành điểm gốc; con số lịch sử là trường riêng.
  expect(
    fieldValue(normItem, "Điểm gốc").querySelector(".subm-result-primary-score"),
  ).toHaveTextContent("0.9000");
  const snapshot = fieldValue(normItem, "Norm tạm lúc ghi nhận kết quả");
  expect(snapshot.querySelector(".subm-result-primary-score")).toHaveTextContent("37.50");
  expect(snapshot.querySelector(".subm-score")?.getAttribute("title")).toBe(
    "v1 · f1 · baseline 0.5 · best lúc ghi 0.8",
  );

  // Dòng của cuộc thi thường không bị kéo theo: nhãn cũ và không có trường norm nào.
  const plainItem = itemOf("Đội thường");
  expect(
    fieldValue(plainItem, "Điểm chính").querySelector(".subm-result-primary-score"),
  ).toHaveTextContent("0.9000");
  expect(Array.from(plainItem.querySelectorAll("dt")).map((dt) => dt.textContent)).not.toContain(
    "Norm tạm lúc ghi nhận kết quả",
  );
});

test("hợp đồng không còn metric phụ nào thì cụm Kết quả là gạch mờ, không phải cụm rỗng", async () => {
  mockApi(() =>
    jsonResponse({
      ...pageOf([
        row("s-draft", "Đội chưa khai metric", {
          competition_id: "c2",
          competition: { id: "c2", slug: "cup-2", name: "Cup 2" },
        }),
      ]),
      competitions: [
        // Bản nháp v2 chưa khai metric nào: hợp đồng rỗng, không được dựng lại ba cột cũ.
        {
          id: "c2",
          slug: "cup-2",
          name: "Cup 2",
          result_contract: { metrics: [], primary_metric: null, higher_is_better: true },
        },
      ],
    }),
  );
  renderPage();
  await screen.findByText("Đội chưa khai metric");

  const result = fieldValue(itemOf("Đội chưa khai metric"), "Kết quả");
  expect(result.querySelectorAll(".subm-metric")).toHaveLength(0);
  expect(result.querySelector(".subm-muted")).toHaveTextContent("—");
  // Chưa chọn metric chính thì Điểm chính lùi về 4 số thập phân như bộ chấm v1.
  expect(
    fieldValue(itemOf("Đội chưa khai metric"), "Điểm chính").querySelector(
      ".subm-result-primary-score",
    ),
  ).toHaveTextContent("0.9000");
});

/** Hợp đồng của cuộc thi đang khóa, có metric phụ càng nhỏ càng tốt. */
const LOCKED_CONTRACT: ResultContract = {
  metrics: [
    { key: "f1", label: "F1", decimals: 3 },
    { key: "rmse", label: "RMSE", decimals: 2 },
  ],
  primary_metric: "f1",
  higher_is_better: false,
};

test("bảng khóa cuộc thi lấy metric và chiều sắp xếp từ hợp đồng của prop", async () => {
  const { urls } = mockApi(() =>
    jsonResponse(
      pageOf([
        row("s-locked", "Đội khóa", { metrics: { f1: 0.9, rmse: 0.1234 }, primary_score: 0.9 }),
      ]),
    ),
  );
  render(
    <MemoryRouter initialEntries={["/admin/competitions/c1"]}>
      <AdminSubmissionsPanel
        competitionId="c1"
        resultContract={LOCKED_CONTRACT}
        title="Danh sách submissions"
        listLabel="Danh sách bài nộp của cuộc thi"
      />
    </MemoryRouter>,
  );
  await screen.findByText("Đội khóa");

  // Endpoint theo cuộc thi không trả hợp đồng: nhãn và số thập phân đến từ prop.
  const result = fieldValue(itemOf("Đội khóa"), "Kết quả");
  expect(
    Array.from(result.querySelectorAll(".subm-metric-label")).map((node) => node.textContent),
  ).toEqual(["RMSE"]);
  expect(result.querySelector(".subm-metric-value")).toHaveTextContent("0.12");
  expect(
    fieldValue(itemOf("Đội khóa"), "Điểm chính").querySelector(".subm-result-primary-score"),
  ).toHaveTextContent("0.900");

  const field = screen.getByLabelText("Sắp xếp theo");
  // Mọi dòng cùng một cuộc thi nên trường "Cuộc thi" bị bỏ; bù lại có metric của hợp đồng,
  // nhưng không có metric chính vì nó đã là "Điểm chính".
  expect(within(field).queryByRole("option", { name: "Cuộc thi" })).toBeNull();
  expect(within(field).getByRole("option", { name: "RMSE" })).toBeTruthy();
  expect(within(field).queryByRole("option", { name: "F1" })).toBeNull();

  fireEvent.change(field, { target: { value: "rmse" } });
  await waitFor(() => expect(lastParams(urls).get("sort")).toBe("rmse"));
  // RMSE càng nhỏ càng tốt nên chiều mặc định là tăng dần, không phải giảm dần.
  expect(lastParams(urls).get("order")).toBe("asc");
  expect(lastParams(urls).get("offset")).toBe("0");
  expect(screen.getByRole("button", { name: "Tăng dần" })).toBeTruthy();
  expect(urls.at(-1)).toContain("/api/admin/competitions/c1/submissions?");

  // Cột "Điểm chính" cũng lấy chiều từ hợp đồng, không mặc định "điểm cao là nhất".
  fireEvent.change(field, { target: { value: "primary_score" } });
  await waitFor(() => expect(lastParams(urls).get("sort")).toBe("primary_score"));
  expect(lastParams(urls).get("order")).toBe("asc");
});

test("hiện bốn thẻ thống kê theo bộ lọc hiện tại", async () => {
  const { urls } = mockApi();
  renderPage();
  await screen.findByText("Đội 0");

  const stats = statsRegion();
  expect(within(stats).getByText("Tổng bài nộp")).toBeTruthy();
  expect(within(stats).getByText("Cuộc thi")).toBeTruthy();
  expect(within(stats).getByText("Đội đã nộp")).toBeTruthy();
  // Bài bị từ chối vẫn đã chấm điểm nhưng không nằm trong thẻ này; nhãn nói rõ điều đó.
  expect(within(stats).getByText("Được tính kết quả")).toBeTruthy();
  expect(within(stats).getByText("Bài đã chấm và được chấp nhận")).toBeTruthy();
  expect(within(stats).getByText("3")).toBeTruthy();
  expect(within(stats).getAllByText("2").length).toBe(3);

  // Thẻ thống kê không được đổi thứ tự sắp xếp hay phân trang đang xem.
  fireEvent.change(screen.getByLabelText("Lọc theo cuộc thi"), { target: { value: "c2" } });
  await waitFor(() => expect(lastParams(urls).get("competition_id")).toBe("c2"));
  expect(lastParams(urls).get("sort")).toBe("created_at");
});

test("chưa có dữ liệu thì thẻ thống kê để chỗ trống thay vì số 0 giả", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockApi(async () => {
    await gate;
    return jsonResponse(page(0, 1));
  });
  renderPage();

  const stats = statsRegion();
  expect(within(stats).queryByText("0")).toBeNull();
  expect(within(stats).getAllByText("Đang tải thống kê").length).toBe(4);

  release();
  expect(await screen.findByText("Đội 0")).toBeTruthy();
  expect(within(statsRegion()).getByText("3")).toBeTruthy();
});

test("đổi trang giữ bảng cũ, báo đang bận rồi render trang mới", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Trang hai về chậm để kiểm tra trạng thái đang tải của bảng.
  mockApi(async (url) => {
    if (url.includes("offset=50")) {
      await gate;
      return jsonResponse(page(50, 120));
    }
    return jsonResponse(page(0, 120));
  });

  renderPage();
  await screen.findByText("Đội 0");
  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  const region = screen.getByRole("region", { name: "Danh sách bài nộp toàn hệ thống" });
  expect(region).toHaveAttribute("aria-busy", "true");
  expect(screen.getByText("Đội 0")).toBeTruthy();
  expect(screen.getByRole("status")).toHaveTextContent("Đang cập nhật…");

  release();
  expect(await screen.findByText("Đội 50")).toBeTruthy();
  expect(screen.queryByText("Đội 0")).toBeNull();
  expect(region).toHaveAttribute("aria-busy", "false");
  expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 51–100 trong số 120 bài nộp");
});

test("nút Làm mới tải lại đúng trang đang xem và tự khoá trong lúc chờ", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { urls } = mockApi(async (url) => {
    calls += 1;
    // Lượt thứ ba chính là nút Làm mới; giữ nó lại để bắt được trạng thái đang bận.
    if (calls === 3) await gate;
    return jsonResponse(url.includes("offset=50") ? page(50, 120) : page(0, 120));
  });

  renderPage();
  await screen.findByText("Đội 0");
  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  await screen.findByText("Đội 50");

  const refresh = screen.getByRole("button", { name: "Làm mới" });
  fireEvent.click(refresh);

  // Đang tải thì nút khoá, nên hai lượt gọi không chồng lên nhau.
  expect(refresh).toBeDisabled();

  release();
  await waitFor(() => expect(refresh).not.toBeDisabled());
  // Tải lại trang đang xem chứ không nhảy về trang đầu.
  expect(lastParams(urls).get("offset")).toBe("50");
});

test("lần tải đầu hiện khung xương ba thẻ, không để trống", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockApi(async () => {
    await gate;
    return jsonResponse(page(0, 1));
  });

  const { container } = renderPage();

  // Ba thẻ giữ đúng nhịp dọc của danh sách thật nên lúc dữ liệu về trang không nhảy.
  expect(container.querySelectorAll(".subm-skeleton-card")).toHaveLength(3);
  // Khung xương là trang trí; chữ báo đang tải mới là thứ trình đọc màn hình đọc.
  expect(screen.getByText("Đang tải danh sách bài nộp...")).toBeTruthy();

  release();
  expect(await screen.findByText("Đội 0")).toBeTruthy();
  expect(container.querySelector(".subm-skeleton")).toBeNull();
});

test("cuộc thi đã xóa hiện tên nhưng không có link để mở", async () => {
  mockApi(() =>
    jsonResponse({
      ...page(0, 1),
      submissions: [
        {
          ...ROW,
          competition: { id: "c9", slug: "", name: "Cuộc thi đã xóa" },
          account: { id: "a9", name: "Tài khoản đã xóa", email: "" },
        },
      ],
    }),
  );
  renderPage();

  expect(await screen.findByText("Cuộc thi đã xóa")).toBeTruthy();
  expect(screen.getByText("Tài khoản đã xóa")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Cuộc thi đã xóa" })).toBeNull();
});

test("lỗi tải danh sách hiện thông báo và nút thử lại gọi lại đúng trang", async () => {
  let calls = 0;
  const { urls } = mockApi(() => {
    calls += 1;
    return calls === 1
      ? jsonResponse({ error: { code: "INTERNAL_ERROR", message: "Lỗi hệ thống." } }, 500)
      : jsonResponse(page(0, 1));
  });
  renderPage();

  expect(await screen.findByRole("alert")).toHaveTextContent("Lỗi hệ thống.");
  fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));

  expect(await screen.findByText("Đội 0")).toBeTruthy();
  expect(urls.length).toBe(2);
});

test("bộ lọc không khớp thì hiện empty state và xóa bộ lọc không gọi trùng request", async () => {
  const { urls } = mockApi((url) =>
    jsonResponse(
      url.includes("status=rejected") ? { ...page(0, 0), submissions: [] } : page(0, 1),
    ),
  );
  renderPage();
  await screen.findByText("Đội 0");

  fireEvent.change(screen.getByLabelText("Lọc theo trạng thái chấm"), {
    target: { value: "rejected" },
  });
  expect(await screen.findByText("Không có bài nộp phù hợp.")).toBeTruthy();

  // Hai nút cùng tên: một ở thanh lọc, một ở empty state; bấm nút trong empty state.
  const clearButtons = screen.getAllByRole("button", { name: "Xóa bộ lọc" });
  fireEvent.click(clearButtons[clearButtons.length - 1]);
  expect(await screen.findByText("Đội 0")).toBeTruthy();

  const sent = urls.length;
  expect(lastParams(urls).has("status")).toBe(false);
  // Debounce của ô tìm kiếm không được bắn thêm request khi từ khóa đã đúng như đang áp dụng.
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(urls.length).toBe(sent);
});

test("cuộc thi chưa có bài nộp nào thì báo chưa có dữ liệu, không phải bị lọc hết", async () => {
  mockApi(() => jsonResponse({ ...page(0, 0), submissions: [] }));
  renderPage();

  expect(await screen.findByText("Chưa có bài nộp nào.")).toBeTruthy();
  // Chưa có dữ liệu khác hẳn bị lọc hết: không được mời xóa bộ lọc khi chưa hề đặt bộ lọc.
  expect(screen.queryByText("Không có bài nộp phù hợp.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Xóa bộ lọc" })).toBeNull();
});

test("không tải được danh sách cuộc thi thì báo rõ thay vì để ô lọc trống", async () => {
  mockApi(undefined, () =>
    jsonResponse({ error: { code: "INTERNAL_ERROR", message: "Lỗi hệ thống." } }, 500),
  );
  renderPage();

  expect(await screen.findByText(/Không tải được danh sách cuộc thi/)).toBeTruthy();
  expect(screen.getByText("Đội 0")).toBeTruthy();
});

const REJECTED_REVIEW = {
  status: "rejected" as const,
  note: "Notebook dùng kiến trúc không được phép.",
  reviewed_at: "2026-09-16T10:30:00Z",
  reviewed_by: { id: "ad1", name: "Admin A", email: "admin.a@vku.vn" },
};

/** Một dòng bài nộp với quyết định xét duyệt cụ thể. */
function row(
  id: string,
  name: string,
  overrides: Partial<GlobalSubmissionItem> = {},
): GlobalSubmissionItem {
  return {
    ...ROW,
    id,
    account: { id: `acc-${id}`, name, email: `${id}@vku.vn` },
    ...overrides,
  };
}

/** Thẻ bài nộp của một đội: mỗi bài nộp là đúng một `li`. */
function itemOf(name: string): HTMLElement {
  return screen.getByText(name).closest("li") as HTMLElement;
}

/** Giá trị của một trường trong thẻ, tra theo nhãn `dt` nên thêm trường mới không lệch assertion. */
function fieldValue(item: HTMLElement, label: string): HTMLElement {
  const term = Array.from(item.querySelectorAll("dt")).find((dt) => dt.textContent === label);
  expect(term, `không có trường "${label}"`).toBeTruthy();
  return (term as HTMLElement).nextElementSibling as HTMLElement;
}

/**
 * Badge của một trục trạng thái. Chữ kết luận giờ hiện ngay trên badge, nhưng assertion vẫn tra
 * qua `aria-label`: đó mới là tên trình đọc màn hình đọc, và nó không đổi theo CSS.
 */
function statusBadge(item: HTMLElement, label: string): HTMLElement {
  const badge = fieldValue(item, label).querySelector<HTMLElement>(".subm-badge");
  expect(badge, `không có badge trạng thái ở trường "${label}"`).toBeTruthy();
  return badge as HTMLElement;
}

/**
 * Tooltip của một icon trạng thái. Nó là phần tử thật chứ không phải `::after` vì phải đặt được
 * theo vị trí icon, nên nội dung đọc thẳng từ DOM thay vì từ một thuộc tính.
 */
function statusTip(item: HTMLElement, label: string): HTMLElement {
  const tip = statusBadge(item, label).querySelector<HTMLElement>(".subm-tip");
  expect(tip, `không có tooltip ở trường "${label}"`).toBeTruthy();
  return tip as HTMLElement;
}

test("trường Xét duyệt là badge có chữ; lý do, người duyệt và thời điểm nằm trong tooltip", async () => {
  mockApi(() =>
    jsonResponse({
      ...page(0, 3),
      submissions: [
        row("s-rej", "Đội bị từ chối", { review: REJECTED_REVIEW }),
        row("s-new", "Đội hợp lệ"),
        row("s-failed", "Đội lỗi chấm", { status: "failed" }),
      ],
    }),
  );
  renderPage();

  const region = await screen.findByRole("region", { name: "Danh sách bài nộp toàn hệ thống" });
  await within(region).findByText("Đội bị từ chối");

  const rejectedItem = itemOf("Đội bị từ chối");
  const rejectedReview = statusBadge(rejectedItem, "Xét duyệt");
  expect(rejectedReview).toHaveAttribute("aria-label", "Không chấp nhận");
  // Lý do có thể dài tới 1000 ký tự nên không được chiếm chỗ trong thẻ: nó đi cùng người duyệt
  // và thời điểm vào tooltip, cách nhau bằng xuống dòng. Nhãn kết luận đã hiện ngay trên badge
  // nên tooltip không lặp lại nó nữa.
  const rejectedTip = statusTip(rejectedItem, "Xét duyệt").textContent ?? "";
  expect(rejectedTip).toContain(REJECTED_REVIEW.note);
  expect(rejectedTip).toContain("Admin A");
  expect(rejectedTip).not.toContain("Không chấp nhận");
  expect(
    within(fieldValue(rejectedItem, "Thao tác")).getByRole("button", { name: "Khôi phục" }),
  ).toBeTruthy();

  // Chưa từng bị xét duyệt không phải "hợp lệ": badge phải nói rõ chưa có quyết định, nếu không
  // BTC đọc nhầm thành một phán quyết đã duyệt. Thao tác thì vẫn chỉ có từ chối.
  const validItem = itemOf("Đội hợp lệ");
  expect(statusBadge(validItem, "Xét duyệt")).toHaveAttribute(
    "aria-label",
    "Chưa có quyết định BTC",
  );
  expect(
    within(fieldValue(validItem, "Thao tác")).getByRole("button", { name: "Không chấp nhận" }),
  ).toBeTruthy();

  // Bài lỗi chấm điểm không bao giờ xét duyệt được: hai trường đều là gạch, không có thao tác.
  const failedItem = itemOf("Đội lỗi chấm");
  expect(statusBadge(failedItem, "Xét duyệt")).toHaveAttribute(
    "aria-label",
    "Không xét duyệt được",
  );
  expect(fieldValue(failedItem, "Thao tác")).toHaveTextContent("—");
  expect(within(fieldValue(failedItem, "Thao tác")).queryByRole("button")).toBeNull();
  // Gạch chỉ dành cho hai trường phụ thuộc trạng thái chấm; tệp của bài lỗi vẫn xem và tải
  // được: mỗi tệp là một cặp nút xem/tải nên bài có hai tệp là bốn nút.
  expect(within(fieldValue(failedItem, "Tệp đã nộp")).getAllByRole("button")).toHaveLength(4);
});

test("lọc theo trạng thái duyệt là trục riêng, không lẫn với trạng thái chấm", async () => {
  const { urls } = mockApi((url) =>
    jsonResponse(
      new URL(url, "http://localhost").searchParams.get("review") === "rejected"
        ? { ...page(0, 0), submissions: [] }
        : page(0, 1),
    ),
  );
  renderPage();
  await screen.findByText("Đội 0");
  expect(lastParams(urls).has("review")).toBe(false);

  fireEvent.change(screen.getByLabelText("Lọc theo trạng thái duyệt"), {
    target: { value: "rejected" },
  });
  await waitFor(() => expect(lastParams(urls).get("review")).toBe("rejected"));
  expect(lastParams(urls).has("status")).toBe(false);
  expect(lastParams(urls).get("offset")).toBe("0");

  fireEvent.change(screen.getByLabelText("Lọc theo trạng thái duyệt"), {
    target: { value: "accepted" },
  });
  await waitFor(() => expect(lastParams(urls).get("review")).toBe("accepted"));
  expect(lastParams(urls).has("status")).toBe(false);
});

test("từ chối bài nộp gửi đúng PATCH, đóng modal và tải lại đúng trang đang xem", async () => {
  const { urls, requests } = mockApi((url, init) => {
    if (init.method === "PATCH") return jsonResponse({ submission: ROW });
    return jsonResponse(
      page(Number(new URL(url, "http://localhost").searchParams.get("offset")), 120),
    );
  });
  renderPage();
  await screen.findByText("Đội 0");

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  await screen.findByText("Đội 50");

  fireEvent.click(screen.getByRole("button", { name: "Không chấp nhận" }));
  const dialog = await screen.findByRole("dialog", { name: "Không chấp nhận bài nộp" });
  const note = within(dialog).getByLabelText("Lý do không chấp nhận");
  const submit = within(dialog).getByRole("button", { name: "Không chấp nhận" });

  // Lý do chỉ có khoảng trắng thì không phải lý do: không gửi gì cả.
  fireEvent.change(note, { target: { value: "   " } });
  expect(submit).toBeDisabled();
  fireEvent.click(submit);
  expect(reviewRequests(requests)).toEqual([]);

  fireEvent.change(note, { target: { value: "  Notebook sai kiến trúc.  " } });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);

  await waitFor(() => expect(reviewRequests(requests).length).toBe(1));
  expect(reviewRequests(requests)[0].url).toBe("/api/admin/submissions/s-50/review");
  expect(JSON.parse(reviewRequests(requests)[0].body)).toEqual({
    status: "rejected",
    note: "Notebook sai kiến trúc.",
  });

  // Modal đóng, có live region báo thành công, và bảng tải lại đúng trang đang xem.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const banner = await screen.findByText("Đã đánh dấu bài nộp là không chấp nhận.");
  expect(banner.closest("[role='status']")).not.toBeNull();
  await waitFor(() => expect(lastParams(urls).get("offset")).toBe("50"));
});

test("PATCH lỗi thì modal vẫn mở, giữ nguyên lý do và không báo thành công", async () => {
  const { requests } = mockApi((_url, init) =>
    init.method === "PATCH"
      ? jsonResponse({ error: { code: "VALIDATION_ERROR", message: "Lý do không hợp lệ." } }, 422)
      : jsonResponse(page(0, 1)),
  );
  renderPage();
  await screen.findByText("Đội 0");

  fireEvent.click(screen.getByRole("button", { name: "Không chấp nhận" }));
  const dialog = await screen.findByRole("dialog", { name: "Không chấp nhận bài nộp" });
  const note = () => within(dialog).getByLabelText("Lý do không chấp nhận");
  fireEvent.change(note(), { target: { value: "Thiếu mô tả kiến trúc." } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Không chấp nhận" }));

  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Lý do không hợp lệ.");
  expect(note()).toHaveValue("Thiếu mô tả kiến trúc.");
  expect(note()).toHaveAttribute("aria-invalid", "true");
  expect(reviewRequests(requests).length).toBe(1);
  expect(screen.queryByText("Đã đánh dấu bài nộp là không chấp nhận.")).toBeNull();
});

test("ô lý do được điền sẵn bản nháp của AI, và bản admin sửa mới là thứ được gửi", async () => {
  const { requests } = mockApi((_url, init) =>
    init.method === "PATCH" ? jsonResponse({ submission: ROW }) : jsonResponse(pageOf([AI_ROW])),
  );
  renderPage();
  await screen.findByText("Đội 0");

  fireEvent.click(screen.getByRole("button", { name: "Không chấp nhận" }));
  const dialog = await screen.findByRole("dialog", { name: "Không chấp nhận bài nộp" });
  const note = within(dialog).getByLabelText("Lý do không chấp nhận");

  // Bản nháp của model phải nói rõ nguồn gốc, để admin không gửi thẳng nó mà chưa đọc.
  expect(note).toHaveValue(AI_HINT);
  expect(within(dialog).getByText(/AI soạn nháp/)).toBeTruthy();

  fireEvent.change(note, { target: { value: "  Bỏ dữ liệu ngoài rồi nộp lại.  " } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Không chấp nhận" }));

  await waitFor(() => expect(reviewRequests(requests).length).toBe(1));
  expect(JSON.parse(reviewRequests(requests)[0].body)).toEqual({
    status: "rejected",
    note: "Bỏ dữ liệu ngoài rồi nộp lại.",
  });
});

test("gợi ý của model chỉ được điền sẵn khi verdict là FLAGGED", async () => {
  // Verdict khác FLAGGED nghĩa là chưa có vi phạm nào được server xác minh - kể cả khi model có
  // viết gợi ý, nó cũng không được tự biến thành lời buộc tội.
  const clearRow: GlobalSubmissionItem = {
    ...AI_ROW,
    ai_review: {
      state: "COMPLETED",
      verdict: "CLEAR",
      summary: "Không thấy vi phạm.",
      participant_summary: AI_HINT,
      generation: 1,
      run_id: "run-1",
      latest_review_id: "r1",
      requested_at: "2026-09-15T09:10:00Z",
      updated_at: "2026-09-15T09:11:00Z",
    },
  };
  mockApi(() => jsonResponse(pageOf([clearRow])));
  renderPage();
  await screen.findByText("Đội 0");

  fireEvent.click(screen.getByRole("button", { name: "Không chấp nhận" }));
  const dialog = await screen.findByRole("dialog", { name: "Không chấp nhận bài nộp" });

  // Ô trống, không có dòng nhắc nguồn gốc, và nút vẫn khoá theo đúng luật cũ.
  expect(within(dialog).getByLabelText("Lý do không chấp nhận")).toHaveValue("");
  expect(within(dialog).queryByText(/AI soạn nháp/)).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Không chấp nhận" })).toBeDisabled();
});

test("khôi phục bài đã bị từ chối qua confirm modal", async () => {
  const { requests } = mockApi((_url, init) =>
    init.method === "PATCH"
      ? jsonResponse({ submission: ROW })
      : jsonResponse({
          ...page(0, 1),
          submissions: [row("s-0", "Đội 0", { review: REJECTED_REVIEW })],
        }),
  );
  renderPage();

  const region = await screen.findByRole("region", { name: "Danh sách bài nộp toàn hệ thống" });
  await within(region).findByText("Không chấp nhận");

  fireEvent.click(within(region).getByRole("button", { name: "Khôi phục" }));
  const dialog = await screen.findByRole("dialog", { name: "Khôi phục bài nộp" });
  // Copy xác nhận phải nói rõ không chấm lại và không hoàn lượt nộp.
  expect(within(dialog).getByText(/không được chấm lại/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Khôi phục" }));

  await waitFor(() => expect(reviewRequests(requests).length).toBe(1));
  expect(reviewRequests(requests)[0].url).toBe("/api/admin/submissions/s-0/review");
  expect(JSON.parse(reviewRequests(requests)[0].body)).toEqual({ status: "accepted" });
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Đã khôi phục bài nộp về trạng thái hợp lệ.",
  );
});

test("Hủy và Escape đều không gửi PATCH và trả focus về nút vừa bấm", async () => {
  const { requests } = mockApi();
  renderPage();
  await screen.findByText("Đội 0");

  const trigger = screen.getByRole("button", { name: "Không chấp nhận" });
  trigger.focus();
  fireEvent.click(trigger);
  let dialog = await screen.findByRole("dialog", { name: "Không chấp nhận bài nộp" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Hủy" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);

  fireEvent.click(trigger);
  dialog = await screen.findByRole("dialog", { name: "Không chấp nhận bài nộp" });
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);

  expect(reviewRequests(requests)).toEqual([]);
});

/** Bản nháp model soạn cho thí sinh - chỉ admin thấy, và chỉ được điền sẵn khi verdict là FLAGGED. */
const AI_HINT = "Dùng dữ liệu ngoài cuộc thi; chỉ dùng dữ liệu BTC cấp.";

/** Projection AI đứng riêng khỏi `AI_ROW` để bài khác đổi được kết luận mà giữ nguyên phần còn lại. */
const AI_PROJECTION: AdminAiReview = {
  state: "COMPLETED",
  verdict: "FLAGGED",
  summary: "Có một dấu hiệu cần xem lại.",
  participant_summary: AI_HINT,
  generation: 1,
  run_id: "run-1",
  latest_review_id: "r1",
  requested_at: "2026-09-15T09:10:00Z",
  updated_at: "2026-09-15T09:11:00Z",
};

const AI_ROW: GlobalSubmissionItem = {
  ...ROW,
  // `page` đặt tên đội theo offset, nhưng fixture này đứng riêng nên tự khai tên.
  account: { id: "a1", name: "Đội 0", email: "team@vku.vn" },
  ai_review: AI_PROJECTION,
};

const AI_DETAIL: AiReviewDetail = {
  submission: {
    id: "s-0",
    submission_no: 3,
    status: "completed",
    created_at: "2026-09-15T09:00:00Z",
    account: { id: "a1", name: "Đội 0", email: "team@vku.vn" },
    competition: { id: "c1", slug: "cup-1", name: "Cup 1" },
  },
  ai_review: AI_ROW.ai_review,
  content_snapshot: {
    state: "CAPTURED",
    revision_id: "rev-1",
    content_hash: "a".repeat(64),
    error_code: null,
    captured_at: "2026-09-15T09:00:00Z",
  },
  // `latest_review_id` chỉ có nghĩa khi record đó thật sự nằm trong history; modal đọc kết luận
  // từ record chứ không từ projection.
  history: [
    {
      id: "r1",
      run_id: "run-1",
      generation: 1,
      status: "COMPLETED",
      verdict: "FLAGGED",
      model_verdict: "FLAGGED",
      summary: "Có một dấu hiệu cần xem lại.",
      participant_summary: AI_HINT,
      findings: [],
      notebook_stats: {
        cells: 12,
        code_cells: 8,
        markdown_cells: 4,
        lines: 210,
        truncated: false,
        omitted_cells: 0,
      },
      provider: "openai-compatible",
      provider_host: "api.example.com",
      model: "gpt-oss-120b",
      versions: {
        prompt: "ai-review-v3",
        normalization: "notebook-v1",
        context_policy: "context-v2",
        canonicalization: null,
        rule_ref: null,
        verifier: null,
      },
      source: "PROVIDER",
      reused_from_review_id: null,
      bypass_cache: false,
      manual: false,
      attempts: 1,
      downgrade_codes: [],
      error: null,
      started_at: "2026-09-15T09:10:00Z",
      completed_at: "2026-09-15T09:10:02Z",
      duration_ms: 2000,
      created_at: "2026-09-15T09:10:02Z",
    },
  ],
};

/** Một trang có đúng những bài nộp được đưa vào, giữ nguyên tổng số để phân trang. */
function pageOf(submissions: GlobalSubmissionItem[], total = submissions.length, offset = 0) {
  return { ...page(offset, total), submissions };
}

test("trường AI hiện kết luận sơ bộ, bài chưa từng được đánh giá thì ghi rõ là chưa", async () => {
  mockApi(() =>
    jsonResponse(
      pageOf([
        AI_ROW,
        { ...ROW, id: "s-1", account: { id: "a2", name: "Đội cũ", email: "cu@vku.vn" } },
      ]),
    ),
  );
  renderPage();
  await screen.findByText("Đội 0");

  const flaggedItem = itemOf("Đội 0");
  const flaggedIcon = statusBadge(flaggedItem, "AI sơ bộ");
  expect(flaggedIcon).toHaveAttribute("aria-label", "Có dấu hiệu");
  // Thời điểm cập nhật không chiếm thêm dòng nào trong thẻ, chỉ vào tooltip.
  expect(statusTip(flaggedItem, "AI sơ bộ").textContent).toContain("Cập nhật");
  expect(within(fieldValue(flaggedItem, "AI sơ bộ")).getByRole("button", { name: "Chi tiết AI" }))
    .toBeTruthy();

  // Bài nộp từ lúc cuộc thi chưa bật AI không có projection. Thiếu dữ liệu không phải bằng chứng
  // sạch, nên ô này không được hiện "Không phát hiện". Nút vẫn phải có: đó là đường duy nhất để BTC
  // mở modal và khởi tạo lượt kiểm tra cho bài cũ.
  const legacyItem = itemOf("Đội cũ");
  expect(statusBadge(legacyItem, "AI sơ bộ")).toHaveAttribute("aria-label", "Chưa đánh giá");
  expect(within(fieldValue(legacyItem, "AI sơ bộ")).getByRole("button", { name: "Chi tiết AI" }))
    .toBeTruthy();

  // AI sơ bộ đứng cạnh xét duyệt của người, nhưng là hai trường riêng biệt.
  expect(statusBadge(legacyItem, "Xét duyệt")).not.toHaveAttribute(
    "aria-label",
    "Chưa đánh giá",
  );
});

test("trạng thái nguồn là trục riêng, không bị kết luận CLEAR che mất", async () => {
  mockApi(() => jsonResponse(pageOf([{ ...AI_ROW, ai_review: {
    ...AI_PROJECTION, verdict: "CLEAR", source_status: "EXTERNAL", source_signal_version: "v3",
  } }])));
  renderPage();
  await screen.findByText("Đội 0");
  const cell = fieldValue(itemOf("Đội 0"), "AI sơ bộ");
  expect(within(cell).getByText("Không phát hiện")).toBeTruthy();
  expect(within(cell).getByText("AI: Có dấu hiệu dùng nguồn ngoài")).toBeTruthy();
});

test("lượt cũ thiếu trạng thái nguồn không được im lặng như đã sạch", async () => {
  // Row COMPLETED trước phiên bản assessment: không có source_status. Thiếu dữ kiện không phải
  // bằng chứng sạch, nên badge nguồn vẫn phải hiện - nhưng là nhãn "chưa đánh giá theo phiên bản
  // mới" chứ không phải một nhãn sạch.
  mockApi(() => jsonResponse(pageOf([{ ...AI_ROW, ai_review: {
    ...AI_PROJECTION, verdict: "CLEAR",
  } }])));
  renderPage();
  await screen.findByText("Đội 0");
  const cell = fieldValue(itemOf("Đội 0"), "AI sơ bộ");
  expect(within(cell).getByText("Không phát hiện")).toBeTruthy();
  expect(within(cell).getByText("Nguồn: Chưa đánh giá theo phiên bản mới")).toBeTruthy();
});

test("trạng thái nguồn chưa đánh giá được hiện đúng nhãn riêng", async () => {
  mockApi(() => jsonResponse(pageOf([{ ...AI_ROW, ai_review: {
    ...AI_PROJECTION, verdict: "INCONCLUSIVE", source_status: "NOT_EVALUATED",
  } }])));
  renderPage();
  await screen.findByText("Đội 0");
  const cell = fieldValue(itemOf("Đội 0"), "AI sơ bộ");
  expect(within(cell).getByText("Nguồn: Chưa đánh giá được")).toBeTruthy();
});

test("lượt AI lỗi không có trạng thái nguồn nào để hiện", async () => {
  // ERROR không phải một kết luận về nguồn: không được thêm badge nguồn giả.
  mockApi(() => jsonResponse(pageOf([{ ...AI_ROW, ai_review: {
    ...AI_PROJECTION, verdict: "ERROR", source_status: null,
  } }])));
  renderPage();
  await screen.findByText("Đội 0");
  const cell = fieldValue(itemOf("Đội 0"), "AI sơ bộ");
  expect(within(cell).getByText("Chưa hoàn tất")).toBeTruthy();
  expect(within(cell).queryByText(/^Nguồn:/)).toBeNull();
});

test("vạch nhấn ở lề thẻ lấy mức nặng nhất trong ba trục", async () => {
  mockApi(() =>
    jsonResponse(
      pageOf([
        row("s-clean", "Đội sạch"),
        // AI không kết luận được: cảnh báo, chưa phải vi phạm.
        row("s-unsure", "Đội AI chưa kết luận", {
          ai_review: { ...AI_PROJECTION, verdict: "INCONCLUSIVE" },
        }),
        row("s-flagged", "Đội bị AI gắn cờ", { ai_review: AI_ROW.ai_review }),
        row("s-rejected", "Đội bị từ chối", { review: REJECTED_REVIEW }),
        row("s-failed", "Đội lỗi chấm", { status: "failed" }),
      ]),
    ),
  );
  renderPage();
  await screen.findByText("Đội sạch");

  // Sạch: không trục nào đáng xem nên vạch xanh.
  expect(itemOf("Đội sạch").className).toContain("subm-card-success");

  // Chưa kết luận được là vàng, dù trạng thái chấm và xét duyệt đều sạch.
  expect(itemOf("Đội AI chưa kết luận").className).toContain("subm-card-warning");

  // Gắn cờ đã là đỏ, dù chưa ai từ chối.
  expect(itemOf("Đội bị AI gắn cờ").className).toContain("subm-card-danger");

  // Từ chối cũng đỏ, và đỏ ở đây đến từ trục xét duyệt chứ không phải trục trạng thái.
  expect(itemOf("Đội bị từ chối").className).toContain("subm-card-danger");

  // Lỗi chấm cũng đỏ.
  expect(itemOf("Đội lỗi chấm").className).toContain("subm-card-danger");
});

test("mỗi trục phán quyết mang tông của chính nó, còn vạch thẻ vẫn là mức nặng nhất", async () => {
  mockApi(() =>
    jsonResponse(
      pageOf([row("s-flagged", "Đội bị AI gắn cờ", { ai_review: AI_ROW.ai_review })]),
    ),
  );
  renderPage();
  await screen.findByText("Đội bị AI gắn cờ");

  const flagged = itemOf("Đội bị AI gắn cờ");
  // Trục chấm và trục duyệt của bài này đều sạch...
  expect(statusBadge(flagged, "Trạng thái").className).toContain("subm-badge-success");
  expect(statusBadge(flagged, "Xét duyệt").className).toContain("subm-badge-success");
  // ...chỉ trục AI là đỏ, và đó là chỗ duy nhất nói "bài này có vấn đề".
  expect(statusBadge(flagged, "AI sơ bộ").className).toContain("subm-badge-danger");
  // Vạch nhấn của thẻ lấy mức nặng nhất trong ba nên đỏ theo trục AI, không xanh theo hai trục kia.
  expect(flagged.className).toContain("subm-card-danger");
});

test("lọc theo kết luận AI là trục riêng, không lẫn với trạng thái chấm hay trạng thái duyệt", async () => {
  const { urls } = mockApi();
  renderPage();
  await screen.findByText("Đội 0");
  expect(lastParams(urls).get("ai_review")).toBe("all");

  fireEvent.change(screen.getByLabelText("Lọc theo kết luận AI"), {
    target: { value: "flagged" },
  });
  await waitFor(() => expect(lastParams(urls).get("ai_review")).toBe("flagged"));
  expect(lastParams(urls).has("status")).toBe(false);
  expect(lastParams(urls).has("review")).toBe(false);
  expect(lastParams(urls).get("offset")).toBe("0");

  // Bộ lọc AI không được kéo theo bộ lọc duyệt vừa đặt: đổi cái này không xóa cái kia.
  fireEvent.change(screen.getByLabelText("Lọc theo trạng thái duyệt"), {
    target: { value: "accepted" },
  });
  await waitFor(() => expect(lastParams(urls).get("review")).toBe("accepted"));
  expect(lastParams(urls).get("ai_review")).toBe("flagged");
});

test("ba bộ lọc nguồn mới nằm cùng trục AI và gửi đúng giá trị", async () => {
  const { urls } = mockApi();
  renderPage();
  await screen.findByText("Đội 0");

  const filter = screen.getByLabelText("Lọc theo kết luận AI");
  const labels = within(filter).getAllByRole("option").map((option) => option.textContent);
  for (const label of [
    "AI: Có dấu hiệu dùng nguồn ngoài",
    "Nguồn: Chưa xác minh",
    "Nguồn: Chưa đánh giá được",
  ]) {
    expect(labels).toContain(label);
  }

  for (const value of ["source_external", "source_unclear", "source_not_evaluated"]) {
    fireEvent.change(filter, { target: { value } });
    await waitFor(() => expect(lastParams(urls).get("ai_review")).toBe(value));
    expect(lastParams(urls).get("offset")).toBe("0");
    // Trục nguồn không được kéo theo trạng thái chấm hay trạng thái duyệt.
    expect(lastParams(urls).has("status")).toBe(false);
    expect(lastParams(urls).has("review")).toBe(false);
  }
});

test("Chi tiết AI mở đúng modal và chạy lại làm mới bảng mà không đụng tới trục duyệt", async () => {
  const { urls, requests } = mockApi((url) => {
    if (url.includes("/ai-review/rerun")) return jsonResponse({ submission: ROW });
    if (url.includes("/ai-review")) return jsonResponse(AI_DETAIL);
    return jsonResponse(pageOf([AI_ROW], 120));
  });
  renderPage();
  await screen.findByText("Đội 0");

  fireEvent.click(screen.getByRole("button", { name: "Chi tiết AI" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText("AI chỉ tham khảo, không ảnh hưởng điểm số. Ban Tổ chức quyết định cuối cùng."),
  ).toBeTruthy();

  // Modal AI chỉ để đọc và chạy lại: không có thao tác duyệt nào của con người trong đó.
  expect(within(dialog).queryByRole("button", { name: "Không chấp nhận" })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Khôi phục" })).toBeNull();

  const before = urls.length;
  fireEvent.click(within(dialog).getByRole("button", { name: "Chạy lại AI" }));
  const confirm = await screen.findByRole("dialog", { name: "Chạy lại kiểm tra AI" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Chạy lại" }));

  await waitFor(() =>
    expect(requests.some((item) => item.url.endsWith("/ai-review/rerun"))).toBe(true),
  );
  await waitFor(() => expect(urls.length).toBeGreaterThan(before));
  expect(lastParams(urls).get("ai_review")).toBe("all");
  // Chạy lại AI không phải xét duyệt: không có PATCH nào được gửi.
  expect(reviewRequests(requests)).toEqual([]);
});

test("đang xem thì bảng tự làm mới ngầm theo nhịp, không nháy trạng thái tải", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  let name = "Đội 0";
  const { urls } = mockApi(() =>
    jsonResponse(pageOf([{ ...AI_ROW, account: { id: "a1", name, email: "team@vku.vn" } }], 120)),
  );

  renderPage();
  await advance(0);
  expect(urls).toHaveLength(1);
  expect(screen.getByText("Đội 0")).toBeTruthy();
  expect(pagerStatus()).toHaveTextContent("Đã hiển thị 1–50 trong số 120 bài nộp");

  // Kết luận AI đã xong từ lâu vẫn được làm mới: điểm chấm cũng có thể về sau đó.
  name = "Đội mới";
  await advance(AUTO_REFRESH_MS);
  expect(urls).toHaveLength(2);
  expect(screen.getByText("Đội mới")).toBeTruthy();
  expect(screen.queryByText("Đội 0")).toBeNull();
  // Lượt ngầm không đụng trạng thái tải: vùng danh sách không bật aria-busy, pager vẫn đọc số dòng.
  expect(
    screen.getByRole("region", { name: "Danh sách bài nộp toàn hệ thống" }),
  ).toHaveAttribute("aria-busy", "false");
  expect(pagerStatus()).toHaveTextContent("Đã hiển thị 1–50 trong số 120 bài nộp");
});

test("làm mới ngầm giữ nguyên bộ lọc, sắp xếp, trang đang xem và focus", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { urls } = mockApi((url) => {
    const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") ?? 0);
    return jsonResponse(page(offset, 120));
  });

  renderPage();
  await advance(0);
  fireEvent.change(screen.getByLabelText("Lọc theo trạng thái chấm"), {
    target: { value: "completed" },
  });
  await advance(0);
  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  await advance(0);
  expect(screen.getByText("Đội 50")).toBeTruthy();

  const next = screen.getByRole("button", { name: "Trang sau" });
  next.focus();
  await advance(AUTO_REFRESH_MS);
  // Lượt ngầm hỏi đúng bộ lọc, đúng trang đang xem - không kéo admin về trang một.
  const params = lastParams(urls);
  expect(params.get("offset")).toBe("50");
  expect(params.get("status")).toBe("completed");
  expect(params.get("sort")).toBe("created_at");
  expect(screen.getByText("Đội 50")).toBeTruthy();
  expect(document.activeElement).toBe(next);
});

test("modal đang mở thì bảng nhường lượt làm mới ngầm", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { urls } = mockApi((url) => {
    if (url.includes("/ai-review")) return jsonResponse(AI_DETAIL);
    return jsonResponse(pageOf([AI_ROW], 1));
  });

  renderPage();
  await advance(0);
  const listCalls = () => urls.filter((url) => url.includes("/submissions?")).length;
  expect(listCalls()).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Chi tiết AI" }));
  await advance(0);
  expect(screen.getByRole("dialog")).toBeTruthy();

  // Admin đang đọc một bài: bảng phía sau không chen thêm request nào.
  const during = listCalls();
  await advance(AUTO_REFRESH_MS * 3);
  expect(listCalls()).toBe(during);

  fireEvent.click(screen.getByRole("button", { name: "Đóng" }));
  await advance(AUTO_REFRESH_MS);
  expect(listCalls()).toBeGreaterThan(during);
});

test("trình xem tệp đang mở thì bảng nhường lượt làm mới ngầm", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (isOptionsRequest(url)) return jsonResponse(COMPETITION_OPTIONS);
      requests.push(url);
      if (url.includes("/prediction")) {
        return new Response("id,label\n1,cat\n", {
          status: 200,
          headers: { "Content-Type": "text/csv" },
        });
      }
      return jsonResponse(pageOf([AI_ROW], 1));
    }),
  );

  renderPage();
  await advance(0);
  const listCalls = () => requests.filter((url) => url.includes("/submissions?")).length;
  expect(listCalls()).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Xem CSV" }));
  await advance(0);
  expect(screen.getByRole("dialog")).toBeTruthy();

  // Admin đang đọc tệp của một bài: bảng phía sau không chen thêm request nào.
  const during = listCalls();
  await advance(AUTO_REFRESH_MS * 3);
  expect(listCalls()).toBe(during);

  fireEvent.keyDown(document, { key: "Escape" });
  await advance(0);
  expect(screen.queryByRole("dialog")).toBeNull();
  await advance(AUTO_REFRESH_MS);
  expect(listCalls()).toBeGreaterThan(during);
});

test("mất quyền giữa chừng: 403 dừng tự làm mới và báo rõ", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  let forbidden = false;
  const { urls } = mockApi(() => {
    if (forbidden) {
      return jsonResponse({ error: { code: "FORBIDDEN", message: "Không có quyền." } }, 403);
    }
    return jsonResponse(pageOf([AI_ROW], 1));
  });

  renderPage();
  await advance(0);
  expect(screen.getByText("Đội 0")).toBeTruthy();

  forbidden = true;
  await advance(AUTO_REFRESH_MS);
  expect(screen.getByText(/Đã dừng tự động làm mới/)).toBeTruthy();
  // Bảng cũ vẫn còn, nhưng vòng tự làm mới đã dừng hẳn thay vì quay mãi.
  expect(screen.getByText("Đội 0")).toBeTruthy();

  const calls = urls.length;
  await advance(AUTO_REFRESH_MS * 5);
  expect(urls).toHaveLength(calls);
});

test("lượt ngầm lỗi mạng giữ bảng và báo đang thử lại, sau đó tự phục hồi", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  let failing = false;
  const { urls } = mockApi(() => {
    if (failing) {
      return jsonResponse({ error: { code: "INTERNAL_ERROR", message: "Lỗi hệ thống." } }, 500);
    }
    return jsonResponse(pageOf([AI_ROW], 1));
  });

  renderPage();
  await advance(0);
  expect(screen.getByText("Đội 0")).toBeTruthy();

  failing = true;
  await advance(AUTO_REFRESH_MS);
  // Bảng cũ ở lại; trạng thái thử lại vẫn hiển thị thay vì giả vờ dữ liệu đã mới.
  expect(screen.getByText("Đội 0")).toBeTruthy();
  expect(screen.getByText(/Hệ thống đang tự thử lại/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();

  // Backoff sau lỗi đầu: 3000 * 2^1 = 6000ms (jitter đã cố định về hệ số 1.0).
  await advance(5_999);
  expect(urls).toHaveLength(2);
  failing = false;
  await advance(1);
  expect(urls).toHaveLength(3);
  expect(screen.getByText("Đội 0")).toBeTruthy();
  expect(screen.queryByText(/Hệ thống đang tự thử lại/)).toBeNull();
});

test("tab bị ẩn thì ngừng làm mới ngầm, quay lại thì chạy tiếp", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { urls } = mockApi(() => jsonResponse(pageOf([AI_ROW], 1)));

  renderPage();
  await advance(0);
  expect(urls).toHaveLength(1);

  // Ẩn tab trước khi hết nhịp: không lượt nào được tiêu.
  setDocumentHidden(true);
  await advance(AUTO_REFRESH_MS * 3);
  expect(urls).toHaveLength(1);

  // Quay lại tab thì nhịp chạy tiếp.
  setDocumentHidden(false);
  await advance(0);
  expect(urls).toHaveLength(2);
});
