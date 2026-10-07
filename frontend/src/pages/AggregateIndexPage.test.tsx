/** Danh sách bảng tổng hợp (/tong-hop): chỉ liệt kê bảng mà người đang đăng nhập được xem. */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { AggregateIndexPage } from "./AggregateIndexPage";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockResponse(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, status)));
}

const LIST = {
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
    },
    {
      slug: "bang-mo",
      name: "Bảng mở",
      visibility: "authenticated",
      sources: [
        { competition_id: "c3", slug: null, name: null, weight: 0.7 },
        {
          competition_id: "c4",
          slug: "nlp-b",
          name: "NLP B với tên dài quá giới hạn hiển thị",
          weight: 0.3,
        },
      ],
      updated_at: "2026-10-06T04:00:00Z",
    },
  ],
};

function renderPage() {
  return render(
    <MemoryRouter>
      <AggregateIndexPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("danh sách hiện nguồn kèm trọng số, quyền xem và link vào bảng", async () => {
  mockResponse(LIST);
  renderPage();

  const row = (await screen.findByText("Tổng hợp Cup")).closest("tr") as HTMLElement;
  expect(within(row).getByText("60%")).toBeTruthy();
  expect(within(row).getByText("40%")).toBeTruthy();
  // Chip nguồn dẫn về chính cuộc thi nguồn.
  expect(within(row).getByRole("link", { name: "CV A" })).toHaveAttribute(
    "href",
    "/competitions/cv-a",
  );
  expect(within(row).getByText("Thành viên một trong các cuộc thi nguồn")).toBeTruthy();
  expect(within(row).getByRole("link", { name: "Tổng hợp Cup" })).toHaveAttribute(
    "href",
    "/tong-hop/tong-hop-cup",
  );

  // Nguồn đã bị xoá không còn tên: nhãn thay thế nói rõ bảng đang trỏ vào đâu; tên dài
  // được cắt gọn ở chip nhưng giữ nguyên văn ở tooltip.
  const other = screen.getByText("Bảng mở").closest("tr") as HTMLElement;
  expect(within(other).getByText("Nguồn đã bị xoá")).toBeTruthy();
  expect(within(other).getByText("70%")).toBeTruthy();
  expect(within(other).getByText("Mọi tài khoản đã đăng nhập")).toBeTruthy();
  const longChip = within(other).getByText("NLP B với tên dài quá giới…");
  expect(longChip.closest(".agg-chip")).toHaveAttribute(
    "title",
    "NLP B với tên dài quá giới hạn hiển thị",
  );
});

test("chưa được xem bảng nào: empty state nói rõ điều kiện hiện bảng", async () => {
  mockResponse({ aggregates: [] });
  renderPage();

  expect(await screen.findByText("Chưa có bảng tổng hợp nào bạn được xem.")).toBeTruthy();
  expect(screen.getByText(/Ban Tổ chức công bố/)).toBeTruthy();
});

test("lỗi tải thì hiện lỗi và nút thử lại đọc lại danh sách", async () => {
  let failing = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      failing
        ? jsonResponse({ error: { code: "INTERNAL", message: "Lỗi máy chủ." } }, 500)
        : jsonResponse(LIST),
    ),
  );
  renderPage();

  expect(await screen.findByText("Lỗi máy chủ.")).toBeTruthy();
  failing = false;
  fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
  expect(await screen.findByText("Tổng hợp Cup")).toBeTruthy();
});
