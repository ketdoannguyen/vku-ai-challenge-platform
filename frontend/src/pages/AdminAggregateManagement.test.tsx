/**
 * Danh sách + form tạo bảng tổng hợp cho admin: payload đổi phần trăm về trọng số 0–1, khóa
 * cuộc thi không ghép được (thiếu metric, thấp-là-tốt chưa bật chuẩn hóa, đã chọn ở dòng khác)
 * và validate tổng trọng số.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { AdminAggregateManagement } from "./AdminAggregateManagement";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const COMPETITIONS = {
  competitions: [
    {
      id: "c1",
      slug: "cv-a",
      name: "CV A",
      normalization: { enabled: true, baseline: 0.5, version: 1 },
      submission_config: {
        ready: true,
        version: 2,
        result_contract: {
          metrics: [{ key: "accuracy", label: "Accuracy", decimals: 2 }],
          primary_metric: "accuracy",
          higher_is_better: true,
        },
      },
    },
    {
      id: "c2",
      slug: "nlp-b",
      name: "NLP B",
      submission_config: {
        ready: true,
        version: 2,
        result_contract: {
          metrics: [{ key: "f1", label: "F1", decimals: 2 }],
          primary_metric: "f1",
          higher_is_better: true,
        },
      },
    },
    {
      id: "c3",
      slug: "loss-cup",
      name: "Loss Cup",
      submission_config: {
        ready: true,
        version: 2,
        result_contract: {
          metrics: [{ key: "loss", label: "Loss", decimals: 3 }],
          primary_metric: "loss",
          higher_is_better: false,
        },
      },
    },
    {
      id: "c4",
      slug: "nhap",
      name: "Nháp chưa metric",
      submission_config: {
        ready: false,
        version: 2,
        result_contract: { metrics: [], primary_metric: null, higher_is_better: true },
      },
    },
  ],
};

const AGGREGATES = {
  aggregates: [
    {
      slug: "tong-hop-cup",
      name: "Tổng hợp Cup",
      visibility: "members_any",
      sources: [
        { competition_id: "c1", slug: "cv-a", name: "CV A", weight: 0.6 },
        { competition_id: "c2", slug: "nlp-b", name: "NLP B", weight: 0.4 },
      ],
      updated_at: "2026-10-06T03:00:00Z",
      published: true,
      created_at: "2026-10-05T03:00:00Z",
      created_by: "admin@vku.vn",
    },
    {
      slug: "ban-nhap",
      name: "Bản nháp",
      visibility: "authenticated",
      sources: [
        { competition_id: "c3", slug: "loss-cup", name: "Loss Cup", weight: 0.7 },
        { competition_id: "c1", slug: "cv-a", name: "CV A", weight: 0.3 },
      ],
      updated_at: "2026-10-06T04:00:00Z",
      published: false,
      created_at: "2026-10-05T04:00:00Z",
      created_by: "admin@vku.vn",
    },
  ],
};

const CREATED = { ...AGGREGATES.aggregates[0], slug: "bang-moi", name: "Bảng mới", published: false };

const calls: Array<{ url: string; init?: RequestInit }> = [];

function mockApi(handler: (url: string, init?: RequestInit) => { body: unknown; status: number }) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const result = handler(url, init);
      return jsonResponse(result.body, result.status);
    }),
  );
}

/** Handler đọc danh sách: hai endpoint của trang, chưa tính lượt ghi. */
function readHandler(url: string): { body: unknown; status: number } {
  return url.includes("/admin/competitions")
    ? { body: COMPETITIONS, status: 200 }
    : { body: AGGREGATES, status: 200 };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminAggregateManagement />
    </MemoryRouter>,
  );
}

/** Mở form tạo trên danh sách đã tải; trả về dialog để test thao tác bên trong. */
async function openCreate() {
  renderPage();
  await screen.findByText("Tổng hợp Cup");
  fireEvent.click(screen.getByRole("button", { name: "Tạo bảng tổng hợp" }));
  return screen.getByRole("dialog", { name: "Tạo bảng tổng hợp" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("danh sách hiện trạng thái công bố, nguồn kèm trọng số và link sang trang chi tiết", async () => {
  mockApi(readHandler);
  renderPage();

  const row = (await screen.findByText("Tổng hợp Cup")).closest("tr") as HTMLElement;
  expect(within(row).getByText("Đang công bố")).toBeTruthy();
  expect(within(row).getByText("CV A")).toBeTruthy();
  expect(within(row).getByText("60%")).toBeTruthy();
  expect(within(row).getByRole("link", { name: "Tổng hợp Cup" })).toHaveAttribute(
    "href",
    "/admin/aggregates/tong-hop-cup",
  );

  const draft = screen.getByText("Bản nháp").closest("tr") as HTMLElement;
  expect(within(draft).getByText("Bản nháp — chỉ admin thấy")).toBeTruthy();
  expect(within(draft).getByText("Loss Cup")).toBeTruthy();
  expect(within(draft).getByText("70%")).toBeTruthy();
});

test("chưa có bảng nào: empty state mở được form tạo", async () => {
  mockApi((url) =>
    url.includes("/admin/competitions")
      ? { body: COMPETITIONS, status: 200 }
      : { body: { aggregates: [] }, status: 200 },
  );
  renderPage();

  expect(await screen.findByText("Chưa có bảng tổng hợp nào.")).toBeTruthy();
  expect(screen.getByText("0 bảng")).toBeTruthy();
  // Nút trong empty state là nút thứ hai; nút đầu nằm ở hero.
  fireEvent.click(screen.getAllByRole("button", { name: "Tạo bảng tổng hợp" })[1]);
  expect(screen.getByRole("dialog", { name: "Tạo bảng tổng hợp" })).toBeTruthy();
});

test("tạo bảng: payload đổi phần trăm về trọng số 0–1 theo đúng thứ tự nguồn", async () => {
  mockApi((url, init) =>
    init?.method === "POST" ? { body: CREATED, status: 201 } : readHandler(url),
  );
  const dialog = await openCreate();

  fireEvent.change(within(dialog).getByLabelText("Tên bảng tổng hợp"), {
    target: { value: "Bảng mới" },
  });
  const selects = within(dialog).getAllByLabelText(/^Cuộc thi nguồn \d$/);
  fireEvent.change(selects[0], { target: { value: "c1" } });
  fireEvent.change(selects[1], { target: { value: "c2" } });
  const weights = within(dialog).getAllByLabelText(/^Trọng số nguồn \d/);
  fireEvent.change(weights[0], { target: { value: "60" } });
  fireEvent.change(weights[1], { target: { value: "40" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Lưu bản nháp" }));

  await waitFor(() => expect(calls.some((call) => call.init?.method === "POST")).toBe(true));
  const post = calls.find((call) => call.init?.method === "POST")!;
  expect(post.url).toBe("/api/admin/aggregates");
  expect(JSON.parse(String(post.init?.body))).toEqual({
    name: "Bảng mới",
    sources: [
      { competition_id: "c1", weight: 0.6 },
      { competition_id: "c2", weight: 0.4 },
    ],
    visibility: "members_any",
  });

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    screen.getByText('Đã tạo bảng "Bảng mới" (bản nháp). Công bố ở trang chi tiết.'),
  ).toBeTruthy();
});

test("form chặn khi tổng trọng số khác 100% và không gọi API", async () => {
  mockApi(readHandler);
  const dialog = await openCreate();

  fireEvent.change(within(dialog).getByLabelText("Tên bảng tổng hợp"), {
    target: { value: "Bảng lỗi" },
  });
  const selects = within(dialog).getAllByLabelText(/^Cuộc thi nguồn \d$/);
  fireEvent.change(selects[0], { target: { value: "c1" } });
  fireEvent.change(selects[1], { target: { value: "c2" } });
  const weights = within(dialog).getAllByLabelText(/^Trọng số nguồn \d/);
  fireEvent.change(weights[0], { target: { value: "60" } });
  fireEvent.change(weights[1], { target: { value: "30" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Lưu bản nháp" }));

  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Tổng trọng số phải bằng 100% (đang là 90%).",
  );
  expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
});

test("form khóa cuộc thi không ghép được và cuộc thi đã chọn ở dòng khác", async () => {
  mockApi(readHandler);
  const dialog = await openCreate();

  const selects = within(dialog).getAllByLabelText(/^Cuộc thi nguồn \d$/);
  expect(
    within(selects[0]).getByRole("option", {
      name: "Loss Cup (xếp thấp-là-tốt nhưng chưa bật chuẩn hóa)",
    }),
  ).toBeDisabled();
  expect(
    within(selects[0]).getByRole("option", { name: "Nháp chưa metric (chưa khai báo metric chính)" }),
  ).toBeDisabled();
  expect(within(selects[0]).getByRole("option", { name: "CV A" })).not.toBeDisabled();

  // Chọn CV A ở dòng 1 thì dòng 2 không cho chọn lại cùng cuộc thi.
  fireEvent.change(selects[0], { target: { value: "c1" } });
  expect(within(selects[1]).getByRole("option", { name: "CV A" })).toBeDisabled();
  expect(within(selects[1]).getByRole("option", { name: "NLP B" })).not.toBeDisabled();
});

test("form tự chia đều trọng số khi thêm hoặc xoá nguồn, admin vẫn sửa tay được", async () => {
  mockApi(readHandler);
  const dialog = await openCreate();

  const weights = () => within(dialog).getAllByLabelText(/^Trọng số nguồn \d/);
  // Hai dòng đầu chia đôi sẵn.
  expect(weights().map((input) => (input as HTMLInputElement).value)).toEqual(["50.00", "50.00"]);

  fireEvent.click(within(dialog).getByRole("button", { name: "Thêm nguồn" }));
  // Ba nguồn chia đều, phần lẻ dồn vào dòng cuối để tổng vẫn đúng 100%.
  expect(weights().map((input) => (input as HTMLInputElement).value)).toEqual([
    "33.33",
    "33.33",
    "33.34",
  ]);

  // Sửa tay một dòng rồi xoá dòng khác: trọng số chia lại đều từ đầu.
  fireEvent.change(weights()[0], { target: { value: "10" } });
  fireEvent.click(within(dialog).getAllByRole("button", { name: "Xoá" })[1]);
  expect(weights().map((input) => (input as HTMLInputElement).value)).toEqual(["50.00", "50.00"]);
});
