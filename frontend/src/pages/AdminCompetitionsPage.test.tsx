/** Admin competitions UI: table render, tạo mới với validate, slug khóa khi edit. */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { AdminCompetitionsPage } from "./AdminCompetitionsPage";

const DRAFT = {
  id: "1",
  slug: "ai-challenge-2026",
  name: "AI Challenge 2026",
  short_description: "",
  status: "draft",
  start_at: "2026-10-01T00:00:00Z",
  end_at: "2026-11-01T00:00:00Z",
  join_mode: "open",
  primary_metric: "f1",
  quota_per_day: 5,
  leaderboard_visible: true,
  resources: [],
  created_by: "admin@vku.vn",
  member_count: 0,
  submission_count: 0,
};

const MENU_LABEL = "Thao tác cho AI Challenge 2026";

async function openRowMenu() {
  fireEvent.click(await screen.findByRole("button", { name: MENU_LABEL }));
}

function mockFetch(handler: (url: string, init?: RequestInit) => { body: unknown; status: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = handler(String(input), init);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
}

function makeCompetition(index: number, overrides: Record<string, unknown> = {}) {
  return { ...DRAFT, id: String(index), slug: `cuoc-thi-${index}`, name: `Cuộc thi ${index}`, ...overrides };
}

/** 6 cuộc thi: 2 draft, 3 published, 1 closed - đủ để kiểm cả đếm thống kê lẫn phân trang. */
const SIX = [
  makeCompetition(1),
  makeCompetition(2),
  makeCompetition(3, { status: "published" }),
  makeCompetition(4, { status: "published" }),
  makeCompetition(5, { status: "published" }),
  makeCompetition(6, { status: "closed" }),
];

/** Card thống kê chứa nhãn đã cho - tìm qua phần tử cha để không phụ thuộc cấu trúc bên trong. */
function statArticle(stats: HTMLElement, label: string) {
  return within(stats).getByText(label).closest("article") as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("khu vực thống kê giữ đủ 4 ô; đầu bảng có tiêu đề khối kèm số cuộc thi", async () => {
  mockFetch((url) => (url.includes("/api/admin/competitions") ? { body: { competitions: [DRAFT] }, status: 200 } : { body: {}, status: 500 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  await screen.findByText("AI Challenge 2026");

  const stats = screen.getByRole("region", { name: "Tổng quan cuộc thi" });
  expect(within(stats).getByText("Tổng cuộc thi")).toBeTruthy();
  expect(within(stats).getByText("Đang diễn ra")).toBeTruthy();
  expect(within(stats).getByText("Bản nháp")).toBeTruthy();
  expect(within(stats).getByText("Đã kết thúc")).toBeTruthy();

  expect(screen.getByRole("heading", { name: "Danh sách cuộc thi" })).toBeTruthy();
  expect(screen.getByText("1 cuộc thi")).toBeTruthy();
});

test("bảng danh sách cuộc thi là vùng cuộn focus được bằng bàn phím", async () => {
  mockFetch((url) => (url.includes("/api/admin/competitions") ? { body: { competitions: [DRAFT] }, status: 200 } : { body: {}, status: 500 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  await screen.findByText("AI Challenge 2026");

  const region = screen.getByRole("region", { name: "Bảng danh sách cuộc thi" });
  expect(region).toHaveAttribute("tabindex", "0");
  expect(within(region).getByRole("table")).toBeTruthy();
});

test("hiển thị table competitions với status badge và hành động theo trạng thái", async () => {
  mockFetch((url) => (url.includes("/api/admin/competitions") ? { body: { competitions: [DRAFT] }, status: 200 } : { body: {}, status: 500 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  expect(await screen.findByText("AI Challenge 2026")).toBeTruthy();
  expect(screen.getByText("Nháp")).toBeTruthy();
  await openRowMenu();
  expect(await screen.findByRole("menuitem", { name: "Publish" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Kết thúc" })).toBeNull(); // draft chưa có nút close
});

test("cuộc thi published đã quá end_at hiển thị Đã kết thúc", async () => {
  const expired = {
    ...DRAFT,
    status: "published",
    end_at: new Date(Date.now() - 60_000).toISOString(),
  };
  mockFetch((url) => (url.includes("/api/admin/competitions") ? { body: { competitions: [expired] }, status: 200 } : { body: {}, status: 500 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  await screen.findByText("AI Challenge 2026");

  const table = within(screen.getByRole("region", { name: "Bảng danh sách cuộc thi" }));
  expect(table.getByText("Đã kết thúc")).toBeTruthy();
  expect(table.queryByText("Đang diễn ra")).toBeNull();
});

test("menu ba chấm đóng khi bấm ra ngoài hoặc nhấn Escape", async () => {
  mockFetch((url) => (url.includes("/api/admin/competitions") ? { body: { competitions: [DRAFT] }, status: 200 } : { body: {}, status: 500 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  const trigger = await screen.findByRole("button", { name: MENU_LABEL });

  fireEvent.click(trigger);
  expect(await screen.findByRole("menuitem", { name: "Quản lý" })).toBeTruthy();
  fireEvent.mouseDown(document.body);
  await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Quản lý" })).toBeNull());

  fireEvent.click(trigger);
  expect(await screen.findByRole("menuitem", { name: "Quản lý" })).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Quản lý" })).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("cột Thành viên/Bài nộp hiển thị số và metric bỏ dòng leaderboard", async () => {
  const row = { ...DRAFT, member_count: 12, submission_count: 34, leaderboard_visible: false };
  mockFetch((url) => (url.includes("/api/admin/competitions") ? { body: { competitions: [row] }, status: 200 } : { body: {}, status: 500 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("columnheader", { name: "Thành viên" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Bài nộp" })).toBeTruthy();
  expect(screen.getByText("12")).toBeTruthy();
  expect(screen.getByText("34")).toBeTruthy();
  expect(screen.getByText("5 lượt/ngày")).toBeTruthy();
  expect(screen.queryByText(/Leaderboard/)).toBeNull();
});

test("tạo cuộc thi thiếu field bắt buộc → form không submit (HTML validate)", async () => {
  mockFetch((url) => (url.includes("/api/admin/competitions") ? { body: { competitions: [] }, status: 200 } : { body: {}, status: 500 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Tạo cuộc thi" }));
  const submit = await screen.findByRole("button", { name: "Tạo" });
  // Tên + slug + dates trống → form HTML validation chặn; fetch create không được gọi
  fireEvent.click(submit);
  await waitFor(() => {
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).endsWith("/api/admin/competitions") && c[1]?.method === "POST");
    expect(calls).toHaveLength(0);
  });
});

test("closed competition không cho mở form sửa", async () => {
  const closed = { ...DRAFT, status: "closed" as const };
  mockFetch((url) => (url.includes("/api/admin/competitions") ? { body: { competitions: [closed] }, status: 200 } : { body: {}, status: 500 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  await openRowMenu();
  const edit = await screen.findByRole("menuitem", { name: "Sửa" });
  expect(edit).toBeDisabled();
  expect(edit).toHaveAttribute("title", "Cuộc thi đã kết thúc và không thể chỉnh sửa.");
});

test("create validates end time after start time before API call", async () => {
  mockFetch((url) => (url.includes("/api/admin/competitions") ? { body: { competitions: [] }, status: 200 } : { body: {}, status: 500 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Tạo cuộc thi" }));
  fireEvent.change(screen.getByLabelText("Tên cuộc thi"), { target: { value: "Test Cup" } });
  fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "test-cup" } });
  fireEvent.change(screen.getByLabelText("Bắt đầu"), { target: { value: "2026-11-01T10:00" } });
  fireEvent.change(screen.getByLabelText("Kết thúc"), { target: { value: "2026-11-01T09:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Tạo" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Thời gian kết thúc phải sau thời gian bắt đầu.");
  expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
});

test("edit form khóa slug và disable metric khi published", async () => {
  const published = { ...DRAFT, status: "published" as const };
  mockFetch((url) => (url.includes("/api/admin/competitions") ? { body: { competitions: [published] }, status: 200 } : { body: {}, status: 500 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  await openRowMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Sửa" }));
  const slugInput = await screen.findByLabelText(/Slug \(không đổi được\)/);
  expect((slugInput as HTMLInputElement).disabled).toBe(true);
  const metricSelect = screen.getByLabelText("Chỉ số chính") as HTMLSelectElement;
  expect(metricSelect.disabled).toBe(true);
});

/**
 * Danh sách rỗng render thêm nút "Tạo cuộc thi" trong empty state nên có thể có hai nút
 * cùng tên; luôn lấy nút đầu (toolbar) rồi chờ form mount xong mới thao tác tiếp.
 */
async function openCreateForm() {
  fireEvent.click((await screen.findAllByRole("button", { name: "Tạo cuộc thi" }))[0]);
  fireEvent.change(await screen.findByLabelText("Tên cuộc thi"), { target: { value: "Test Cup" } });
  fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "test-cup" } });
  fireEvent.change(screen.getByLabelText("Bắt đầu"), { target: { value: "2026-11-01T08:00" } });
  fireEvent.change(screen.getByLabelText("Kết thúc"), { target: { value: "2026-11-02T08:00" } });
}

test("form tài nguyên: chặn link ngoài Drive và gửi payload resources khi hợp lệ", async () => {
  const posted: unknown[] = [];
  mockFetch((_url, init) => {
    if (init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      return { body: { ...DRAFT, id: "2" }, status: 201 };
    }
    return { body: { competitions: [] }, status: 200 };
  });
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  await openCreateForm();
  expect(screen.getByText("Chưa có tài nguyên nào.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "+ Thêm tài nguyên" }));
  fireEvent.change(screen.getByLabelText("Tên tài nguyên 1"), { target: { value: "Dataset" } });
  fireEvent.change(screen.getByLabelText("Link tài nguyên 1"), {
    target: { value: "https://evil.example.com/dataset.zip" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Tạo" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Link tài nguyên phải là https://drive.google.com hoặc https://docs.google.com.",
  );
  expect(posted).toHaveLength(0);

  fireEvent.change(screen.getByLabelText("Link tài nguyên 1"), {
    target: { value: "https://drive.google.com/drive/folders/abc" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Tạo" }));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]).toMatchObject({
    resources: [{ label: "Dataset", url: "https://drive.google.com/drive/folders/abc" }],
  });
});

test("form tài nguyên: xóa dòng và chặn thêm quá 10 tài nguyên", async () => {
  mockFetch(() => ({ body: { competitions: [] }, status: 200 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  fireEvent.click((await screen.findAllByRole("button", { name: "Tạo cuộc thi" }))[0]);
  await screen.findByText("Chưa có tài nguyên nào.");

  const addButton = screen.getByRole("button", { name: "+ Thêm tài nguyên" });
  for (let index = 0; index < 10; index += 1) fireEvent.click(addButton);
  expect(screen.getByLabelText("Tên tài nguyên 10")).toBeTruthy();
  expect(addButton).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Xóa tài nguyên 1" }));
  expect(screen.queryByLabelText("Tên tài nguyên 10")).toBeNull();
  expect(addButton).toBeEnabled();
});

test("xóa draft: phải gõ đúng slug rồi mới gọi DELETE kèm confirm_slug", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const body =
        init?.method === "DELETE"
          ? { deleted: true, competition_id: "1", slug: DRAFT.slug, files_removed: true }
          : { competitions: [DRAFT] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  await openRowMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Xóa" }));

  const dialog = screen.getByRole("dialog", { name: "Xóa cuộc thi" });
  const confirm = within(dialog).getByRole("button", { name: "Xóa vĩnh viễn" });
  expect(confirm).toBeDisabled();
  expect(calls.some((call) => call.init?.method === "DELETE")).toBe(false);

  fireEvent.change(within(dialog).getByLabelText(/Gõ chính xác slug/), {
    target: { value: DRAFT.slug },
  });
  fireEvent.click(confirm);

  await waitFor(() => {
    const call = calls.find((c) => c.init?.method === "DELETE");
    expect(call?.url).toContain(`/admin/competitions/1?confirm_slug=${DRAFT.slug}`);
  });
  expect(await screen.findByText(/Đã xóa cuộc thi/)).toBeTruthy();
});

test("xóa thất bại: modal giữ nguyên và hiện lỗi từ API", async () => {
  mockFetch((_url, init) =>
    init?.method === "DELETE"
      ? {
          body: {
            error: {
              code: "COMPETITION_NOT_DELETABLE",
              message: "Cuộc thi đang chạy phải Kết thúc trước khi xoá.",
            },
          },
          status: 409,
        }
      : { body: { competitions: [DRAFT] }, status: 200 },
  );
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  await openRowMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Xóa" }));
  const dialog = screen.getByRole("dialog", { name: "Xóa cuộc thi" });
  fireEvent.change(within(dialog).getByLabelText(/Gõ chính xác slug/), {
    target: { value: DRAFT.slug },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Xóa vĩnh viễn" }));

  expect(await screen.findByText(/phải Kết thúc trước khi xoá/)).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "Xóa cuộc thi" })).toBeTruthy();
});

test("modal mở từ menu ba chấm trả focus về nút trigger của row", async () => {
  mockFetch(() => ({ body: { competitions: [DRAFT] }, status: 200 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  const trigger = await screen.findByRole("button", { name: MENU_LABEL });

  await openRowMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Xóa" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Xóa cuộc thi" })).getByRole("button", { name: "Hủy" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Xóa cuộc thi" })).toBeNull(),
  );
  expect(document.activeElement).toBe(trigger);

  // Escape trên form sửa cũng phải trả focus về đúng row, không rơi xuống body.
  await openRowMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Sửa" }));
  await screen.findByRole("dialog", { name: /Sửa cuộc thi/ });
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: /Sửa cuộc thi/ })).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("published không có hành động xóa", async () => {
  mockFetch(() => ({
    body: { competitions: [{ ...DRAFT, status: "published" }] },
    status: 200,
  }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  await openRowMenu();
  expect(await screen.findByRole("menuitem", { name: "Kết thúc" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Xóa" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Mở lại" })).toBeNull();
});

test("đã kết thúc: menu có Mở lại và vẫn xoá được", async () => {
  mockFetch((url, init) =>
    url.endsWith("/reopen") && init?.method === "POST"
      ? { body: { ...DRAFT, status: "published" }, status: 200 }
      : { body: { competitions: [{ ...DRAFT, status: "closed" }] }, status: 200 },
  );
  renderPage();
  await openRowMenu();
  // Đã kết thúc vẫn xoá được: đóng là bước xác nhận có chủ đích trước khi mất lịch sử thi.
  expect(await screen.findByRole("menuitem", { name: "Xóa" })).toBeTruthy();

  fireEvent.click(screen.getByRole("menuitem", { name: "Mở lại" }));
  const dialog = screen.getByRole("dialog", { name: "Mở lại cuộc thi" });
  expect(screen.queryByRole("menuitem", { name: "Xóa" })).toBeNull(); // menu đã đóng
  fireEvent.click(within(dialog).getByRole("button", { name: "Mở lại" }));
  await waitFor(() => {
    const posts = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => String(call[0]).endsWith("/reopen") && call[1]?.method === "POST",
    );
    expect(posts).toHaveLength(1);
  });
});

test("bốn ô thống kê là bốn card rời, số lấy từ dữ liệu thật", async () => {
  mockFetch(() => ({ body: { competitions: SIX }, status: 200 }));
  renderPage();
  await screen.findByText("Cuộc thi 1");

  const stats = screen.getByRole("region", { name: "Tổng quan cuộc thi" });
  expect(within(stats).getAllByRole("article")).toHaveLength(4);
  expect(statArticle(stats, "Tổng cuộc thi").textContent).toContain("6");
  expect(statArticle(stats, "Đang diễn ra").textContent).toContain("3");
  expect(statArticle(stats, "Bản nháp").textContent).toContain("2");
  expect(statArticle(stats, "Đã kết thúc").textContent).toContain("1");
});

test("tìm kiếm khớp cả slug và tên, xóa bộ lọc phục hồi danh sách", async () => {
  mockFetch(() => ({ body: { competitions: SIX }, status: 200 }));
  renderPage();
  await screen.findByText("Cuộc thi 1");

  const search = screen.getByLabelText("Tìm kiếm cuộc thi");
  fireEvent.change(search, { target: { value: "cuoc-thi-4" } });
  expect(screen.getByText("Cuộc thi 4")).toBeTruthy();
  expect(screen.queryByText("Cuộc thi 1")).toBeNull();

  fireEvent.change(search, { target: { value: "khong-co-cuoc-thi-nao" } });
  expect(await screen.findByText("Không tìm thấy cuộc thi phù hợp.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Xóa bộ lọc" }));
  expect(screen.getByText("Cuộc thi 1")).toBeTruthy();
});

test("lọc theo trạng thái giữ aria-pressed và số đếm lấy từ dữ liệu", async () => {
  mockFetch(() => ({ body: { competitions: SIX }, status: 200 }));
  renderPage();
  await screen.findByText("Cuộc thi 1");

  const draftFilter = screen.getByRole("button", { name: "Bản nháp (2)" });
  expect(draftFilter).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(draftFilter);
  expect(draftFilter).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("Cuộc thi 1")).toBeTruthy();
  expect(screen.getByText("Cuộc thi 2")).toBeTruthy();
  expect(screen.queryByText("Cuộc thi 3")).toBeNull();
});

test("phân trang 5 dòng mỗi trang; đổi tìm kiếm từ trang 2 quay về trang 1", async () => {
  mockFetch(() => ({ body: { competitions: SIX }, status: 200 }));
  renderPage();
  await screen.findByText("Cuộc thi 1");

  const region = screen.getByRole("region", { name: "Bảng danh sách cuộc thi" });
  // 1 header + 5 dòng của trang đầu.
  expect(within(region).getAllByRole("row")).toHaveLength(6);
  expect(screen.queryByText("Cuộc thi 6")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  expect(within(region).getAllByRole("row")).toHaveLength(2);
  expect(screen.getByText("Cuộc thi 6")).toBeTruthy();

  // "cuoc-thi" khớp slug của cả 6 cuộc thi: về trang 1 thì phải thấy lại 5 dòng.
  fireEvent.change(screen.getByLabelText("Tìm kiếm cuộc thi"), { target: { value: "cuoc-thi" } });
  expect(within(region).getAllByRole("row")).toHaveLength(6);
});

test("nút Làm mới gọi lại API và khoá nút trong lúc chờ", async () => {
  let calls = 0;
  let resolveSecond!: (value: Response) => void;
  const second = new Promise<Response>((resolve) => {
    resolveSecond = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1;
      return calls === 1 ? json({ competitions: SIX }) : second;
    }),
  );
  renderPage();
  await screen.findByText("Cuộc thi 1");

  fireEvent.click(screen.getByRole("button", { name: "Làm mới" }));
  const busy = await screen.findByRole("button", { name: "Đang tải..." });
  expect(busy).toBeDisabled();

  resolveSecond(json({ competitions: [makeCompetition(9)] }));
  expect(await screen.findByText("Cuộc thi 9")).toBeTruthy();
  expect(screen.queryByText("Cuộc thi 1")).toBeNull();
});

test("tiêu đề tab đặt theo tên trang", async () => {
  mockFetch((url) => (url.includes("/api/admin/competitions") ? { body: { competitions: [DRAFT] }, status: 200 } : { body: {}, status: 500 }));
  render(
    <MemoryRouter>
      <AdminCompetitionsPage />
    </MemoryRouter>,
  );
  await screen.findByText("AI Challenge 2026");
  expect(document.title).toBe("Quản lý cuộc thi - AI Challenge");
});
