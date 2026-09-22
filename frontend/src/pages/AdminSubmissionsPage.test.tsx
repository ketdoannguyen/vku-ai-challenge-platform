import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import type { AiReviewDetail } from "../api/aiReview";
import type { AdminSubmissionsResponse, GlobalSubmissionItem } from "../api/results";
import { MAX_POLLS, POLL_INTERVAL_MS } from "../hooks/usePendingPolling";
import { flushTimers, setDocumentHidden } from "../test/timers";
import { AdminSubmissionsPage } from "./AdminSubmissionsPage";

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
  // Chưa từng bị xét duyệt: mặc định hợp lệ.
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

/** Danh sách cuộc thi cho ô lọc tách khỏi các request bảng bài nộp. */
function isOptionsRequest(url: string) {
  return url.includes("/api/admin/competitions");
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
  expect(screen.getByText("cup-1")).toBeTruthy();
  // Trạng thái chỉ còn icon, kết luận nằm trong `aria-label`; nhãn chữ trùng với ô lọc nên chỉ
  // tra được bằng role.
  const region = screen.getByRole("region", { name: "Danh sách bài nộp toàn hệ thống" });
  expect(within(region).getByRole("img", { name: "Đã chấm điểm" })).toBeTruthy();
  expect(screen.getAllByText("0.900000").length).toBeGreaterThan(0);
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

  fireEvent.click(screen.getByRole("button", { name: "Notebook" }));

  await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
  expect(downloads).toEqual(["/api/admin/submissions/s-0/notebook"]);
  anchorClick.mockRestore();
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

  expect(labelsOf(tiers[0])).toEqual(["Thời gian", "Cuộc thi", "Đội", "Kết quả"]);
  // Ba trục phán quyết đứng liền nhau ở tầng dưới, thao tác đứng cuối.
  expect(labelsOf(tiers[1])).toEqual([
    "Tệp đã nộp",
    "AI sơ bộ",
    "Xét duyệt",
    "Trạng thái",
    "Thao tác",
  ]);

  // Cụm Kết quả giữ đủ bốn điểm: Điểm chính đứng riêng, ba metric phụ nằm trong một nhóm.
  const result = fieldValue(items[0], "Kết quả");
  expect(within(result).getByText("Điểm chính")).toBeTruthy();
  expect(result.querySelectorAll(".subm-metric")).toHaveLength(3);
});

test("thanh sắp xếp đổi trường và đảo chiều, mỗi trường có thứ tự mặc định riêng", async () => {
  const { urls } = mockApi();
  renderPage();
  await screen.findByText("Đội 0");

  const field = screen.getByLabelText("Sắp xếp theo");
  // Mặc định ban đầu: bài mới nhất trước.
  expect(field).toHaveValue("created_at");
  expect(screen.getByRole("button", { name: "Giảm dần" })).toBeTruthy();

  const fields: Array<[string, string, string, string]> = [
    ["competition", "asc", "Tăng dần", "Cuộc thi"],
    ["team", "asc", "Tăng dần", "Đội"],
    ["f1", "desc", "Giảm dần", "F1"],
    ["precision", "desc", "Giảm dần", "Precision"],
    ["recall", "desc", "Giảm dần", "Recall"],
    ["primary_score", "desc", "Giảm dần", "Điểm chính"],
    ["created_at", "desc", "Giảm dần", "Thời gian"],
  ];

  for (const [sort, order, direction, label] of fields) {
    fireEvent.change(field, { target: { value: sort } });
    await waitFor(() => expect(lastParams(urls).get("sort")).toBe(sort));
    expect(lastParams(urls).get("order")).toBe(order);
    expect(lastParams(urls).get("offset")).toBe("0");
    expect(field).toHaveValue(sort);
    // Mỗi lựa chọn đều có nhãn đọc được và nút đảo chiều nói đúng chiều đang áp dụng.
    expect(within(field).getByRole("option", { name: label })).toBeTruthy();
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

test("chỉ Điểm chính trong cụm Kết quả được nhấn, ba metric phụ giữ trung tính", async () => {
  mockApi();
  renderPage();
  await screen.findByText("Đội 0");

  const result = fieldValue(itemOf("Đội 0"), "Kết quả");
  expect(result.querySelector(".subm-result-primary-score")).toHaveTextContent("0.900000");
  // Điểm chính không nằm lẫn trong nhóm metric phụ.
  expect(result.querySelector(".subm-result-metrics .subm-result-primary-score")).toBeNull();

  for (const [label, value] of [
    ["F1", "0.900000"],
    ["Precision", "0.800000"],
    ["Recall", "0.700000"],
  ]) {
    const metric = Array.from(result.querySelectorAll(".subm-metric")).find(
      (node) => node.querySelector(".subm-metric-label")?.textContent === label,
    ) as HTMLElement;
    expect(metric, `không có metric "${label}"`).toBeTruthy();
    expect(metric.querySelector(".subm-metric-value")).toHaveTextContent(value);
  }
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
 * Ba trục trạng thái chỉ còn icon, nên kết luận phải tra qua `aria-label` chứ không qua chữ nhìn
 * thấy được. Phần chữ nằm trong `.subm-icon-label` chỉ hiện ở `@media (hover: none)`, còn jsdom
 * không nạp stylesheet nên `getByText` ở đây sẽ pass dù người dùng không hề thấy chữ.
 */
function statusIcon(item: HTMLElement, label: string): HTMLElement {
  const icon = fieldValue(item, label).querySelector<HTMLElement>(".subm-icon");
  expect(icon, `không có icon trạng thái ở trường "${label}"`).toBeTruthy();
  return icon as HTMLElement;
}

/**
 * Tooltip của một icon trạng thái. Nó là phần tử thật chứ không phải `::after` vì phải đặt được
 * theo vị trí icon, nên nội dung đọc thẳng từ DOM thay vì từ một thuộc tính.
 */
function statusTip(item: HTMLElement, label: string): HTMLElement {
  const tip = statusIcon(item, label).querySelector<HTMLElement>(".subm-tip");
  expect(tip, `không có tooltip ở trường "${label}"`).toBeTruthy();
  return tip as HTMLElement;
}

test("trường Xét duyệt chỉ còn icon; lý do, người duyệt và thời điểm nằm trong tooltip", async () => {
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
  const rejectedReview = statusIcon(rejectedItem, "Xét duyệt");
  expect(rejectedReview).toHaveAttribute("aria-label", "Không chấp nhận");
  // Lý do có thể dài tới 1000 ký tự nên không được chiếm chỗ trong thẻ: nó đi cùng người duyệt
  // và thời điểm vào tooltip, cách nhau bằng xuống dòng.
  const rejectedTip = statusTip(rejectedItem, "Xét duyệt").textContent ?? "";
  expect(rejectedTip).toContain(REJECTED_REVIEW.note);
  expect(rejectedTip).toContain("Admin A");
  expect(rejectedTip.split("\n")[0]).toBe("Không chấp nhận");
  expect(
    within(fieldValue(rejectedItem, "Thao tác")).getByRole("button", { name: "Khôi phục" }),
  ).toBeTruthy();

  // Chưa từng bị xét duyệt nghĩa là hợp lệ, và chỉ có thao tác từ chối.
  const validItem = itemOf("Đội hợp lệ");
  expect(statusIcon(validItem, "Xét duyệt")).toHaveAttribute("aria-label", "Hợp lệ");
  expect(
    within(fieldValue(validItem, "Thao tác")).getByRole("button", { name: "Không chấp nhận" }),
  ).toBeTruthy();

  // Bài lỗi chấm điểm không bao giờ xét duyệt được: hai trường đều là gạch, không có thao tác.
  const failedItem = itemOf("Đội lỗi chấm");
  expect(statusIcon(failedItem, "Xét duyệt")).toHaveAttribute(
    "aria-label",
    "Không xét duyệt được",
  );
  expect(fieldValue(failedItem, "Thao tác")).toHaveTextContent("—");
  expect(within(fieldValue(failedItem, "Thao tác")).queryByRole("button")).toBeNull();
  // Gạch chỉ dành cho hai trường phụ thuộc trạng thái chấm; tệp của bài lỗi vẫn tải được.
  expect(within(fieldValue(failedItem, "Tệp đã nộp")).getAllByRole("button")).toHaveLength(2);
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

const AI_ROW: GlobalSubmissionItem = {
  ...ROW,
  // `page` đặt tên đội theo offset, nhưng fixture này đứng riêng nên tự khai tên.
  account: { id: "a1", name: "Đội 0", email: "team@vku.vn" },
  ai_review: {
    state: "COMPLETED",
    verdict: "FLAGGED",
    summary: "Có một dấu hiệu cần xem lại.",
    generation: 1,
    run_id: "run-1",
    latest_review_id: "r1",
    requested_at: "2026-09-15T09:10:00Z",
    updated_at: "2026-09-15T09:11:00Z",
  },
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
  history: [],
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
  const flaggedIcon = statusIcon(flaggedItem, "AI sơ bộ");
  expect(flaggedIcon).toHaveAttribute("aria-label", "Có dấu hiệu");
  // Thời điểm cập nhật không chiếm thêm dòng nào trong thẻ, chỉ vào tooltip.
  expect(statusTip(flaggedItem, "AI sơ bộ").textContent).toContain("Cập nhật");
  expect(within(fieldValue(flaggedItem, "AI sơ bộ")).getByRole("button", { name: "Chi tiết AI" }))
    .toBeTruthy();

  // Bài nộp từ lúc cuộc thi chưa bật AI không có projection. Thiếu dữ liệu không phải bằng chứng
  // sạch, nên ô này không được hiện "Không phát hiện". Nút vẫn phải có: đó là đường duy nhất để BTC
  // mở modal và khởi tạo lượt kiểm tra cho bài cũ.
  const legacyItem = itemOf("Đội cũ");
  expect(statusIcon(legacyItem, "AI sơ bộ")).toHaveAttribute("aria-label", "Chưa đánh giá");
  expect(within(fieldValue(legacyItem, "AI sơ bộ")).getByRole("button", { name: "Chi tiết AI" }))
    .toBeTruthy();

  // AI sơ bộ đứng cạnh xét duyệt của người, nhưng là hai trường riêng biệt.
  expect(statusIcon(legacyItem, "Xét duyệt")).not.toHaveAttribute(
    "aria-label",
    "Chưa đánh giá",
  );
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
  expect(within(dialog).getByText(/Chỉ quyết định của Ban Tổ chức/)).toBeTruthy();

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

test("không có lượt AI nào đang chạy thì bảng không tự gọi lại", async () => {
  vi.useFakeTimers();
  const { urls } = mockApi(() => jsonResponse(pageOf([AI_ROW])));

  renderPage();
  await flushTimers();
  expect(urls).toHaveLength(1);

  // Kết luận đã xong thì bảng đứng yên: không có lý do gì để quay vòng tải.
  await flushTimers(POLL_INTERVAL_MS * 5);
  expect(urls).toHaveLength(1);
});

test("còn lượt AI đang chạy thì tự làm mới theo nhịp, hết lượt thì dừng", async () => {
  vi.useFakeTimers();
  let pending = true;
  const { urls } = mockApi(() =>
    jsonResponse(
      pageOf([
        {
          ...AI_ROW,
          ai_review: pending
            ? { ...AI_ROW.ai_review!, state: "QUEUED", verdict: null }
            : AI_ROW.ai_review,
        },
      ]),
    ),
  );

  renderPage();
  await flushTimers();
  expect(urls).toHaveLength(1);

  await flushTimers(POLL_INTERVAL_MS * 2);
  expect(urls).toHaveLength(3);

  // Lượt AI đã xong ở lần tải kế tiếp: vòng poll tự tắt, không cần ai bảo.
  pending = false;
  await flushTimers(POLL_INTERVAL_MS);
  expect(urls).toHaveLength(4);
  await flushTimers(POLL_INTERVAL_MS * 5);
  expect(urls).toHaveLength(4);
});

test("tab bị ẩn thì ngừng tốn lượt poll, và dừng hẳn sau ngân sách", async () => {
  vi.useFakeTimers();
  const pending = { ...AI_ROW.ai_review!, state: "QUEUED" as const, verdict: null };
  const { urls } = mockApi(() => jsonResponse(pageOf([{ ...AI_ROW, ai_review: pending }])));

  renderPage();
  await flushTimers();
  expect(urls).toHaveLength(1);

  // Ẩn tab trước khi hết nhịp: không lượt nào được tiêu.
  setDocumentHidden(true);
  await flushTimers(POLL_INTERVAL_MS * 3);
  expect(urls).toHaveLength(1);

  // Quay lại tab thì nhịp chạy tiếp.
  setDocumentHidden(false);
  await flushTimers(POLL_INTERVAL_MS);
  expect(urls.length).toBe(2);

  await flushTimers(POLL_INTERVAL_MS * MAX_POLLS);
  // Ngân sách đếm theo lượt thật sự gọi: dừng ở MAX_POLLS lượt poll, cộng lượt tải đầu.
  expect(urls).toHaveLength(MAX_POLLS + 1);
  expect(screen.getByText(/Đã tạm dừng tự động làm mới/)).toBeTruthy();

  // Đã cạn ngân sách thì không tự quay lại nữa; đây là lúc nút Làm mới có việc.
  await flushTimers(POLL_INTERVAL_MS * 3);
  expect(urls).toHaveLength(MAX_POLLS + 1);
});
