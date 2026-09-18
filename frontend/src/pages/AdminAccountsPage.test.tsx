import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { AdminAccountsPage } from "./AdminAccountsPage";

const ACCOUNT = {
  id: "64a000000000000000000001",
  email: "team@vku.vn",
  name: "Đội Một",
  role: "participant",
  active: true,
};

const calls: Array<{ url: string; init?: RequestInit }> = [];

/** Tài khoản đang đăng nhập, do test điều khiển; mặc định chưa đăng nhập như không có provider. */
let mockCurrentAccountId: string | null = null;

vi.mock("../auth/AuthContext", () => ({
  useOptionalAuth: () => (mockCurrentAccountId === null ? null : { account: { id: mockCurrentAccountId } }),
}));

/** Danh sách lớn để chứng minh phân trang chạm tới được tài khoản thứ 201+. */
function manyAccounts(total: number) {
  return Array.from({ length: total }, (_, i) => ({
    ...ACCOUNT,
    id: `id-${i}`,
    email: `team${i}@vku.vn`,
    name: `Đội ${i}`,
  }));
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

/** Thống kê toàn hệ thống: tính trên TOÀN BỘ dataset, không phụ thuộc q/limit/offset. */
function statsOf(accounts: Array<Record<string, unknown>>) {
  return {
    total: accounts.length,
    admin: accounts.filter((a) => a.role === "admin").length,
    participant: accounts.filter((a) => a.role === "participant").length,
    active: accounts.filter((a) => a.active !== false).length,
  };
}

/** Giả lập `offset`/`q`/`limit` như backend thật để test được chuyển trang và tìm kiếm. */
function mockApi(accounts: Array<Record<string, unknown>> = [ACCOUNT]) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === "PATCH") return json({ ...ACCOUNT, active: false });
      const params = new URL(url, "http://localhost").searchParams;
      const q = (params.get("q") ?? "").toLowerCase();
      const offset = Number(params.get("offset") ?? 0);
      const limit = Number(params.get("limit") ?? 50);
      const matched = q
        ? accounts.filter(
            (a) =>
              String(a.email).toLowerCase().includes(q) || String(a.name).toLowerCase().includes(q),
          )
        : accounts;
      return json({
        accounts: matched.slice(offset, offset + limit),
        total: matched.length,
        limit,
        offset,
        stats: statsOf(accounts),
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  mockCurrentAccountId = null;
});

test("loads the first page of accounts and protects passwords", async () => {
  mockApi();
  render(
    <MemoryRouter>
      <AdminAccountsPage />
    </MemoryRouter>,
  );

  expect(await screen.findByText("team@vku.vn")).toBeTruthy();
  expect(calls[0].url).toContain("/admin/accounts?limit=50&offset=0");
  // Chỉ một request cho lần tải đầu, không nhân đôi vì hai effect cùng chạy.
  expect(calls).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Tạo tài khoản" }));
  const password = screen.getByLabelText(/Mật khẩu \(tối thiểu 10 ký tự\)/) as HTMLInputElement;
  expect(password.type).toBe("password");
  expect(password.minLength).toBe(10);
  expect(password.autocomplete).toBe("new-password");
  fireEvent.click(screen.getByRole("button", { name: "Đóng" }));

  fireEvent.click(screen.getByRole("button", { name: "Đặt lại MK" }));
  const resetPassword = screen.getByLabelText(/Mật khẩu mới/) as HTMLInputElement;
  expect(resetPassword.type).toBe("password");
  expect(resetPassword.minLength).toBe(10);
  expect(resetPassword.autocomplete).toBe("new-password");
});

test("requires confirmation before disabling an account", async () => {
  mockApi();
  render(
    <MemoryRouter>
      <AdminAccountsPage />
    </MemoryRouter>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Vô hiệu hóa" }));
  expect(screen.getByRole("dialog", { name: "Vô hiệu hóa tài khoản" })).toBeTruthy();
  expect(calls.some((call) => call.init?.method === "PATCH")).toBe(false);

  fireEvent.click(screen.getAllByRole("button", { name: "Vô hiệu hóa" })[1]);
  await waitFor(() => {
    expect(calls.some((call) => call.init?.method === "PATCH")).toBe(true);
  });
});

test("bảng tài khoản là vùng cuộn focus được bằng bàn phím", async () => {
  mockApi();
  render(
    <MemoryRouter>
      <AdminAccountsPage />
    </MemoryRouter>,
  );
  await screen.findByText("team@vku.vn");

  const region = screen.getByRole("region", { name: "Bảng tài khoản" });
  expect(region).toHaveAttribute("tabindex", "0");
  expect(within(region).getByRole("table")).toBeTruthy();
});

function renderPage() {
  render(
    <MemoryRouter>
      <AdminAccountsPage />
    </MemoryRouter>,
  );
}

test("phân trang: Trang sau/Trang trước đổi offset và giữ trong biên", async () => {
  const accounts = manyAccounts(230);
  mockApi(accounts);
  renderPage();
  await screen.findByText("team0@vku.vn");

  expect(screen.getByRole("status").textContent).toContain("Đã hiển thị 1–50 trong số 230");
  fireEvent.click(screen.getByRole("button", { name: "Trang trước" }));
  expect(calls.every((call) => !call.url.includes("offset=-"))).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  expect(await screen.findByText("team50@vku.vn")).toBeTruthy();
  expect(calls.at(-1)?.url).toContain("offset=50");
  expect(screen.getByRole("status").textContent).toContain("Đã hiển thị 51–100 trong số 230");

  fireEvent.click(screen.getByRole("button", { name: "Trang trước" }));
  expect(await screen.findByText("team0@vku.vn")).toBeTruthy();
  expect(calls.at(-1)?.url).toContain("offset=0");
});

test("tài khoản thứ 201+ vẫn tới được bằng UI", async () => {
  mockApi(manyAccounts(230));
  renderPage();
  await screen.findByText("team0@vku.vn");

  for (let page = 1; page <= 4; page++) {
    fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
    await screen.findByText(`team${page * 50}@vku.vn`);
  }

  // Trang cuối chỉ có 30 dòng và nút "Trang sau" phải tự chặn ở biên.
  expect(await screen.findByText("team229@vku.vn")).toBeTruthy();
  const next = screen.getByRole("button", { name: "Trang sau" });
  expect(screen.getByRole("status").textContent).toContain("Đã hiển thị 201–230 trong số 230");
  expect(next.getAttribute("aria-disabled")).toBe("true");

  fireEvent.click(next);
  expect(calls.at(-1)?.url).toContain("offset=200");
});

test("đổi từ khóa tìm kiếm đặt lại offset về 0", async () => {
  mockApi(manyAccounts(230));
  renderPage();
  await screen.findByText("team0@vku.vn");

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  await screen.findByText("team50@vku.vn");

  fireEvent.change(screen.getByLabelText("Tìm tài khoản"), { target: { value: "team12@" } });
  expect(await screen.findByText("team12@vku.vn")).toBeTruthy();
  expect(calls.at(-1)?.url).toContain("q=team12%40");
  expect(calls.at(-1)?.url).toContain("offset=0");
  // Ô tìm kiếm không còn kết quả của trang cũ.
  expect(screen.queryByText("team50@vku.vn")).toBeNull();
});

test("phản hồi của trang cũ không ghi đè kết quả tìm kiếm mới", async () => {
  const accounts = manyAccounts(230);
  // Giữ riêng từng phản hồi để ép thứ tự: trang 2 về *sau* khi tìm kiếm đã phát đi.
  const pending = new Map<string, () => void>();
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const params = new URL(url, "http://localhost").searchParams;
      const offset = Number(params.get("offset") ?? 0);
      const q = (params.get("q") ?? "").toLowerCase();
      const matched = q
        ? accounts.filter(
            (a) =>
              String(a.email).toLowerCase().includes(q) || String(a.name).toLowerCase().includes(q),
          )
        : accounts;
      const gate = q ? "search" : `offset-${offset}`;
      if (gate !== "offset-0") await new Promise<void>((resolve) => pending.set(gate, resolve));
      return json({
        accounts: matched.slice(offset, offset + 50),
        total: matched.length,
        limit: 50,
        offset,
        stats: statsOf(accounts),
      });
    }),
  );
  renderPage();
  await screen.findByText("team0@vku.vn");

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  await waitFor(() => expect(pending.has("offset-50")).toBe(true));

  fireEvent.change(screen.getByLabelText("Tìm tài khoản"), { target: { value: "team12@" } });
  await waitFor(() => expect(pending.has("search")).toBe(true));

  // Trang 2 về muộn hơn nhưng đã cũ — không được ghi đè kết quả tìm kiếm.
  pending.get("offset-50")?.();
  await waitFor(() => expect(screen.queryByText("team50@vku.vn")).toBeNull());
  pending.get("search")?.();
  expect(await screen.findByText("team12@vku.vn")).toBeTruthy();
  expect(screen.queryByText("team50@vku.vn")).toBeNull();
});

test("trang cuối rỗng đi thì lùi về trang còn dữ liệu", async () => {
  const accounts = manyAccounts(60);
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") ?? 0);
      // Giữa hai lần tải, dữ liệu co lại còn 40 dòng nên trang 2 thành rỗng.
      const total = offset === 0 ? 60 : 40;
      const rows = offset === 0 ? accounts.slice(0, 50) : [];
      return json({ accounts: rows, total, limit: 50, offset, stats: statsOf(accounts) });
    }),
  );
  renderPage();
  await screen.findByText("team0@vku.vn");

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  expect(await screen.findByText("team0@vku.vn")).toBeTruthy();
  await waitFor(() => expect(calls.at(-1)?.url).toContain("offset=0"));
  expect(screen.queryByText("Không tìm thấy tài khoản nào.")).toBeNull();
});

/** Dataset 230 dòng trộn vai trò/trạng thái: page đầu chỉ có 50 dòng nên nếu KPI
 *  đọc từ page thay vì aggregate thì các số dưới đây sẽ sai. */
function mixedAccounts() {
  return manyAccounts(230).map((account, i) => ({
    ...account,
    role: i % 25 === 0 ? "admin" : "participant",
    active: i % 10 !== 0,
  }));
}

function statsRegion() {
  return within(screen.getByRole("region", { name: "Tổng quan tài khoản" }));
}

test("bốn ô thống kê đọc aggregate toàn hệ thống, không phải 50 dòng của page đầu", async () => {
  mockApi(mixedAccounts());
  renderPage();
  await screen.findByText("team0@vku.vn");

  // 230 dòng: 10 admin (i chia hết cho 25), 220 thí sinh, 23 dòng bị vô hiệu.
  expect(statsRegion().getByText("230")).toBeTruthy();
  expect(statsRegion().getByText("10")).toBeTruthy();
  expect(statsRegion().getByText("220")).toBeTruthy();
  expect(statsRegion().getByText("207")).toBeTruthy();
});

test("tìm kiếm không làm đổi thống kê toàn hệ thống", async () => {
  mockApi(mixedAccounts());
  renderPage();
  await screen.findByText("team0@vku.vn");

  fireEvent.change(screen.getByLabelText("Tìm tài khoản"), { target: { value: "team12@" } });
  expect(await screen.findByText("team12@vku.vn")).toBeTruthy();

  expect(statsRegion().getByText("230")).toBeTruthy();
  expect(statsRegion().getByText("207")).toBeTruthy();
});

test("bảng giữ đủ năm cột trong vùng cuộn focus được", async () => {
  mockApi();
  renderPage();
  await screen.findByText("team@vku.vn");

  const region = screen.getByRole("region", { name: "Bảng tài khoản" });
  expect(within(region).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
    "Email",
    "Tên",
    "Vai trò",
    "Trạng thái",
    "Thao tác",
  ]);
});

test("vai trò và trạng thái luôn có nhãn chữ, không chỉ dựa vào màu", async () => {
  mockApi([{ ...ACCOUNT, role: "admin", active: true }]);
  renderPage();
  await screen.findByText("team@vku.vn");

  const region = screen.getByRole("region", { name: "Bảng tài khoản" });
  expect(within(region).getByText("Admin")).toBeTruthy();
  expect(within(region).getByText("Hoạt động")).toBeTruthy();
});

test("admin không thể tự vô hiệu hóa: nút bị khóa kèm lý do và không phát PATCH", async () => {
  mockCurrentAccountId = ACCOUNT.id;
  mockApi();
  renderPage();
  await screen.findByText("team@vku.vn");

  expect(screen.getByText("Bạn")).toBeTruthy();
  const disable = screen.getByRole("button", { name: "Vô hiệu hóa" });
  expect(disable).toBeDisabled();
  expect(disable.getAttribute("aria-describedby")).toBe(`self-disable-reason-${ACCOUNT.id}`);
  expect(screen.getByText("Bạn không thể tự vô hiệu hóa tài khoản đang đăng nhập.")).toBeTruthy();

  fireEvent.click(disable);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((call) => call.init?.method === "PATCH")).toBe(false);
});

test("tiêu đề tab đặt theo tên trang", async () => {
  mockApi();
  render(
    <MemoryRouter>
      <AdminAccountsPage />
    </MemoryRouter>,
  );
  await screen.findByText("team@vku.vn");
  expect(document.title).toBe("Quản lý tài khoản — AI Challenge");
});
