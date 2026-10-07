/**
 * Trang chi tiết bảng tổng hợp cho admin: form sửa cấu hình (xác nhận khi bảng đang công bố),
 * xem trước đọc bản đã lưu theo nhánh Public/Private, công bố/ẩn và xoá theo slug.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { AdminAggregateDetailPage } from "./AdminAggregateDetailPage";

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
  ],
};

const DETAIL = {
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
};

const PREVIEW = {
  slug: "tong-hop-cup",
  name: "Tổng hợp Cup",
  view: "public",
  has_private: false,
  updated_at: "2026-10-06T03:00:00Z",
  status: "ready",
  sources: [
    {
      competition_id: "c1",
      slug: "cv-a",
      name: "CV A",
      weight: 0.6,
      score_kind: "normalized",
      metric_label: "Accuracy",
      ready: true,
      reason: null,
    },
    {
      competition_id: "c2",
      slug: "nlp-b",
      name: "NLP B",
      weight: 0.4,
      score_kind: "normalized",
      metric_label: "F1",
      ready: true,
      reason: null,
    },
  ],
  entries: [
    {
      rank: 1,
      display_name: "An",
      is_current_user: false,
      total_score: 84,
      components: [
        { competition_id: "c1", score: 80 },
        { competition_id: "c2", score: 90 },
      ],
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
  has_more: false,
  me: null,
};

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

/** Handler đọc mặc định: chi tiết, danh sách cuộc thi và bảng xem trước đã lưu. */
function readHandler(url: string): { body: unknown; status: number } {
  if (url.includes("/leaderboard")) return { body: PREVIEW, status: 200 };
  if (url.includes("/api/admin/aggregates/tong-hop-cup")) return { body: DETAIL, status: 200 };
  return { body: COMPETITIONS, status: 200 };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/aggregates/tong-hop-cup"]}>
      <Routes>
        <Route path="/admin/aggregates" element={<p>Danh sách bảng</p>} />
        <Route path="/admin/aggregates/:slug" element={<AdminAggregateDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("trang chi tiết hiện cấu hình đã lưu; xem trước đọc bản đã lưu qua endpoint admin", async () => {
  mockApi(readHandler);
  renderPage();

  expect(await screen.findByText("An")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Tổng hợp Cup" })).toBeTruthy();
  expect(screen.getByText(/Đang công bố/)).toBeTruthy();
  expect((screen.getByLabelText("Tên bảng tổng hợp") as HTMLInputElement).value).toBe("Tổng hợp Cup");
  // Trọng số đã lưu quay về form dưới dạng phần trăm admin đã nhập.
  expect((screen.getAllByLabelText(/^Trọng số nguồn \d/)[0] as HTMLInputElement).value).toBe("60");
  expect(
    calls.some((call) =>
      call.url.includes(
        "/admin/aggregates/tong-hop-cup/leaderboard?view=public&limit=50&offset=0",
      ),
    ),
  ).toBe(true);
});

test("bảng đang công bố: lưu phải xác nhận, hủy thì không gọi PATCH", async () => {
  mockApi((url, init) => {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      return { body: { ...DETAIL, ...body }, status: 200 };
    }
    return readHandler(url);
  });
  renderPage();
  await screen.findByText("An");

  fireEvent.change(screen.getByLabelText("Tên bảng tổng hợp"), {
    target: { value: "Tổng hợp Cup v2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));

  const dialog = await screen.findByRole("dialog", { name: "Lưu cấu hình bảng đang công bố" });
  expect(dialog).toHaveTextContent(
    "Thay đổi áp dụng ngay và có thể làm thay đổi điểm, thứ hạng hoặc quyền xem của bảng.",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Hủy" }));
  expect(calls.some((call) => call.init?.method === "PATCH")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
  const again = await screen.findByRole("dialog", { name: "Lưu cấu hình bảng đang công bố" });
  fireEvent.click(within(again).getByRole("button", { name: "Lưu thay đổi" }));

  await waitFor(() => expect(calls.some((call) => call.init?.method === "PATCH")).toBe(true));
  const patch = calls.find((call) => call.init?.method === "PATCH")!;
  expect(patch.url).toBe("/api/admin/aggregates/tong-hop-cup");
  expect(JSON.parse(String(patch.init?.body)).name).toBe("Tổng hợp Cup v2");
  expect(
    await screen.findByText("Đã lưu cấu hình; thay đổi áp dụng ngay cho lượt đọc kế tiếp."),
  ).toBeTruthy();
});

test("bảng nháp: lưu thẳng không cần xác nhận", async () => {
  mockApi((url, init) => {
    if (init?.method === "PATCH") return { body: { ...DETAIL, published: false }, status: 200 };
    if (url.includes("/leaderboard")) return { body: PREVIEW, status: 200 };
    if (url.includes("/api/admin/aggregates/tong-hop-cup")) {
      return { body: { ...DETAIL, published: false }, status: 200 };
    }
    return { body: COMPETITIONS, status: 200 };
  });
  renderPage();
  await screen.findByText("An");

  fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
  await waitFor(() => expect(calls.some((call) => call.init?.method === "PATCH")).toBe(true));
  expect(screen.queryByRole("dialog", { name: "Lưu cấu hình bảng đang công bố" })).toBeNull();
});

test("công bố và ẩn bảng bằng một nút, trạng thái đổi theo response", async () => {
  mockApi((url, init) => {
    if (init?.method === "POST" && url.endsWith("/unpublish")) {
      return { body: { ...DETAIL, published: false }, status: 200 };
    }
    if (init?.method === "POST" && url.endsWith("/publish")) {
      return { body: { ...DETAIL, published: true }, status: 200 };
    }
    return readHandler(url);
  });
  renderPage();
  await screen.findByText("An");
  expect(screen.getByText(/Đang công bố/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Ẩn bảng" }));
  await waitFor(() => expect(calls.some((call) => call.url.endsWith("/unpublish"))).toBe(true));
  expect(await screen.findByText(/Bản nháp — chỉ admin thấy/)).toBeTruthy();
  expect(screen.getByText("Đã ẩn bảng tổng hợp.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Công bố bảng" }));
  await waitFor(() => expect(calls.some((call) => call.url.endsWith("/publish"))).toBe(true));
  expect(screen.getByText("Đã công bố bảng tổng hợp.")).toBeTruthy();
  expect(screen.getByText(/Đang công bố/)).toBeTruthy();
});

test("xoá bảng phải gõ đúng slug; xoá xong quay về danh sách", async () => {
  mockApi((url, init) => {
    if (init?.method === "DELETE") return { body: { deleted: true, slug: "tong-hop-cup" }, status: 200 };
    return readHandler(url);
  });
  renderPage();
  await screen.findByText("An");

  fireEvent.click(screen.getByRole("button", { name: "Xoá bảng" }));
  const dialog = screen.getByRole("dialog", { name: "Xoá bảng tổng hợp" });
  const confirm = within(dialog).getByRole("button", { name: "Xoá bảng" });
  expect(confirm).toBeDisabled();

  fireEvent.change(within(dialog).getByLabelText(/Gõ/), { target: { value: "sai-slug" } });
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText(/Gõ/), { target: { value: "tong-hop-cup" } });
  expect(confirm).not.toBeDisabled();

  fireEvent.click(confirm);
  await waitFor(() => expect(calls.some((call) => call.init?.method === "DELETE")).toBe(true));
  expect(calls.find((call) => call.init?.method === "DELETE")!.url).toBe(
    "/api/admin/aggregates/tong-hop-cup?confirm_slug=tong-hop-cup",
  );
  expect(await screen.findByText("Danh sách bảng")).toBeTruthy();
});

test("bảng có nhánh dual: xem trước đổi sang Private và đọc lại bản đã lưu", async () => {
  mockApi((url) => {
    if (url.includes("/leaderboard")) {
      const view = new URL(url, "http://localhost").searchParams.get("view");
      return {
        body: {
          ...PREVIEW,
          view,
          has_private: true,
          entries: [{ ...PREVIEW.entries[0], display_name: view === "private" ? "Riêng Tư" : "An" }],
        },
        status: 200,
      };
    }
    return readHandler(url);
  });
  renderPage();
  await screen.findByText("An");

  fireEvent.click(screen.getByRole("button", { name: "Private" }));
  expect(await screen.findByText("Riêng Tư")).toBeTruthy();
  expect(calls.some((call) => call.url.includes("view=private"))).toBe(true);
});
