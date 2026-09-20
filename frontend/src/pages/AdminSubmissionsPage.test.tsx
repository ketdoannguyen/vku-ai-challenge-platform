import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import type { AdminSubmissionsResponse, GlobalSubmissionItem } from "../api/results";
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
  handler: (url: string) => Response | Promise<Response> = () => jsonResponse(page(0, 1)),
  options: () => Response = () => jsonResponse(COMPETITION_OPTIONS),
) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (isOptionsRequest(url)) return options();
      urls.push(url);
      return await handler(url);
    }),
  );
  return { urls };
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
  // Nhãn trạng thái trùng với nhãn trong ô lọc nên phải đọc trong bảng.
  const region = screen.getByRole("region", { name: "Bảng bài nộp toàn hệ thống" });
  expect(within(region).getByText("Đã chấm điểm")).toBeTruthy();
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

  fireEvent.change(screen.getByLabelText("Lọc theo trạng thái"), { target: { value: "rejected" } });
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

test("bảy cột sắp xếp được với thứ tự mặc định riêng của từng cột", async () => {
  const { urls } = mockApi();
  renderPage();
  await screen.findByText("Đội 0");

  // Mặc định ban đầu: hàng mới nhất trước.
  expect(screen.getByRole("columnheader", { name: /^Thời gian/ })).toHaveAttribute(
    "aria-sort",
    "descending",
  );

  const columns: Array<[RegExp, string, string]> = [
    [/^Cuộc thi/, "competition", "asc"],
    [/^Đội/, "team", "asc"],
    [/^F1$/, "f1", "desc"],
    [/^Precision/, "precision", "desc"],
    [/^Recall/, "recall", "desc"],
    [/Điểm chính/, "primary_score", "desc"],
    [/^Thời gian/, "created_at", "desc"],
  ];

  for (const [label, field, order] of columns) {
    fireEvent.click(within(screen.getByRole("columnheader", { name: label })).getByRole("button"));
    await waitFor(() => expect(lastParams(urls).get("sort")).toBe(field));
    expect(lastParams(urls).get("order")).toBe(order);
    expect(lastParams(urls).get("offset")).toBe("0");
    expect(screen.getByRole("columnheader", { name: label })).toHaveAttribute(
      "aria-sort",
      order === "asc" ? "ascending" : "descending",
    );
  }

  // Bấm lại cột đang chọn thì đảo chiều; rời cột rồi quay lại thì về lại mặc định của cột.
  const primaryHeader = () => screen.getByRole("columnheader", { name: /Điểm chính/ });
  fireEvent.click(within(primaryHeader()).getByRole("button"));
  await waitFor(() => expect(lastParams(urls).get("sort")).toBe("primary_score"));
  expect(lastParams(urls).get("order")).toBe("desc");

  fireEvent.click(within(primaryHeader()).getByRole("button"));
  await waitFor(() => expect(lastParams(urls).get("order")).toBe("asc"));

  fireEvent.click(within(screen.getByRole("columnheader", { name: /^Đội/ })).getByRole("button"));
  await waitFor(() => expect(lastParams(urls).get("sort")).toBe("team"));
  fireEvent.click(within(primaryHeader()).getByRole("button"));
  await waitFor(() => expect(lastParams(urls).get("sort")).toBe("primary_score"));
  expect(lastParams(urls).get("order")).toBe("desc");

  // Cột không sắp xếp được thì không được mang trạng thái aria-sort.
  expect(screen.getByRole("columnheader", { name: "Trạng thái" })).not.toHaveAttribute(
    "aria-sort",
  );
  expect(screen.getByRole("columnheader", { name: "Tệp đã nộp" })).not.toHaveAttribute(
    "aria-sort",
  );
});

test("chỉ cột Điểm chính được đánh dấu nổi bật", async () => {
  mockApi();
  renderPage();
  await screen.findByText("Đội 0");

  const primary = screen.getByRole("columnheader", { name: /Điểm chính/ });
  expect(primary.className).toContain("primary-col");
  expect(screen.getByRole("columnheader", { name: /^F1$/ }).className).not.toContain("primary-col");

  const cells = within(screen.getByText("Đội 0").closest("tr") as HTMLElement).getAllByRole("cell");
  // Điểm chính là cột cuối; F1 đứng ngay sau cột trạng thái.
  expect(cells[cells.length - 1].className).toContain("primary-score");
  expect(cells[cells.length - 1].className).toContain("primary-col");
  expect(cells[cells.length - 4].className).not.toContain("primary-col");
});

test("hiện bốn thẻ thống kê theo bộ lọc hiện tại", async () => {
  const { urls } = mockApi();
  renderPage();
  await screen.findByText("Đội 0");

  const stats = statsRegion();
  expect(within(stats).getByText("Tổng bài nộp")).toBeTruthy();
  expect(within(stats).getByText("Cuộc thi")).toBeTruthy();
  expect(within(stats).getByText("Đội đã nộp")).toBeTruthy();
  expect(within(stats).getByText("Đã chấm điểm")).toBeTruthy();
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

  const region = screen.getByRole("region", { name: "Bảng bài nộp toàn hệ thống" });
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

  fireEvent.change(screen.getByLabelText("Lọc theo trạng thái"), { target: { value: "rejected" } });
  expect(await screen.findByText("Không có bài nộp phù hợp.")).toBeTruthy();

  // Hai nút cùng tên: một ở thanh lọc, một ở empty state; bấm nút trong empty state.
  const clearButtons = screen.getAllByRole("button", { name: "Xóa bộ lọc" });
  fireEvent.click(clearButtons[clearButtons.length - 1]);
  expect(await screen.findByText("Đội 0")).toBeTruthy();

  const requests = urls.length;
  expect(lastParams(urls).has("status")).toBe(false);
  // Debounce của ô tìm kiếm không được bắn thêm request khi từ khóa đã đúng như đang áp dụng.
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(urls.length).toBe(requests);
});

test("không tải được danh sách cuộc thi thì báo rõ thay vì để ô lọc trống", async () => {
  mockApi(undefined, () =>
    jsonResponse({ error: { code: "INTERNAL_ERROR", message: "Lỗi hệ thống." } }, 500),
  );
  renderPage();

  expect(await screen.findByText(/Không tải được danh sách cuộc thi/)).toBeTruthy();
  expect(screen.getByText("Đội 0")).toBeTruthy();
});
