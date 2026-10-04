import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { setDocumentHidden } from "../test/timers";
import { AdminAccountsPage } from "./AdminAccountsPage";

const ACCOUNT = {
  id: "64a000000000000000000001",
  email: "team@vku.vn",
  name: "Đội Một",
  role: "participant",
  active: true,
  pending: false,
};

/** Tài khoản tự đăng ký chờ duyệt (ADR-049): `active: false` + marker `pending`. */
const PENDING_ACCOUNT = {
  id: "64a000000000000000000002",
  email: "cho.duyet@vku.vn",
  name: "Chờ Duyệt",
  role: "participant",
  active: false,
  pending: true,
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

/** Thống kê toàn hệ thống: tính trên TOÀN BỘ dataset, không phụ thuộc q/status/limit/offset. */
function statsOf(accounts: Array<Record<string, unknown>>) {
  return {
    total: accounts.length,
    admin: accounts.filter((a) => a.role === "admin").length,
    participant: accounts.filter((a) => a.role === "participant").length,
    active: accounts.filter((a) => a.active !== false).length,
    pending: accounts.filter((a) => a.pending === true).length,
  };
}

/** Giả lập `offset`/`q`/`status`/`limit` như backend thật để test chuyển trang và lọc. */
function mockApi(accounts: Array<Record<string, unknown>> = [ACCOUNT]) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === "DELETE") return json({ deleted: true });
      if (init?.method === "PATCH") return json({ ...ACCOUNT, active: false });
      if (init?.method === "POST") return json({ ...ACCOUNT, pending: false, active: true });
      const params = new URL(url, "http://localhost").searchParams;
      const q = (params.get("q") ?? "").toLowerCase();
      const status = params.get("status");
      const offset = Number(params.get("offset") ?? 0);
      const limit = Number(params.get("limit") ?? 50);
      let matched = accounts.filter((a) =>
        status === "pending" ? a.pending === true
          : status === "active" ? a.pending !== true && a.active !== false
          : status === "disabled" ? a.pending !== true && a.active === false : true,
      );
      if (q) {
        matched = matched.filter(
          (a) =>
            String(a.email).toLowerCase().includes(q) || String(a.name).toLowerCase().includes(q),
        );
      }
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
  vi.useRealTimers();
  setDocumentHidden(false);
  mockCurrentAccountId = null;
});

/** Chạy hết timer giả trong `ms` và để chuỗi fetch → setState render xong. */
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
}

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
  const password = screen.getByLabelText(/Mật khẩu \(tối thiểu 6 ký tự\)/) as HTMLInputElement;
  expect(password.type).toBe("password");
  expect(password.minLength).toBe(6);
  expect(password.autocomplete).toBe("new-password");
  fireEvent.click(screen.getByRole("button", { name: "Đóng" }));

  fireEvent.click(screen.getByRole("button", { name: "Đặt lại MK" }));
  const resetPassword = screen.getByLabelText(/Mật khẩu mới/) as HTMLInputElement;
  expect(resetPassword.type).toBe("password");
  expect(resetPassword.minLength).toBe(6);
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

  // Trang 2 về muộn hơn nhưng đã cũ - không được ghi đè kết quả tìm kiếm.
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

/** Dataset 230 dòng trộn vai trò/trạng thái/chờ duyệt: page đầu chỉ có 50 dòng nên nếu
 *  KPI đọc từ page thay vì aggregate thì các số dưới đây sẽ sai. */
function mixedAccounts() {
  return manyAccounts(230).map((account, i) => {
    const pending = i % 46 === 5;
    return {
      ...account,
      role: i % 25 === 0 ? "admin" : "participant",
      active: !pending && i % 10 !== 0,
      pending,
    };
  });
}

function statsRegion() {
  return within(screen.getByRole("region", { name: "Tổng quan tài khoản" }));
}

test("năm ô thống kê đọc aggregate toàn hệ thống, không phải 50 dòng của page đầu", async () => {
  mockApi(mixedAccounts());
  renderPage();
  await screen.findByText("team0@vku.vn");

  // 230 dòng: 10 admin (i chia hết cho 25), 220 thí sinh, 28 dòng bị vô hiệu
  // (i chia hết cho 10 hoặc đang chờ duyệt), 5 dòng chờ duyệt.
  expect(statsRegion().getByText("230")).toBeTruthy();
  expect(statsRegion().getByText("10")).toBeTruthy();
  expect(statsRegion().getByText("220")).toBeTruthy();
  expect(statsRegion().getByText("202")).toBeTruthy();
  expect(statsRegion().getByText("Chờ duyệt")).toBeTruthy();
  expect(statsRegion().getByText("5")).toBeTruthy();
});

test("tìm kiếm không làm đổi thống kê toàn hệ thống", async () => {
  mockApi(mixedAccounts());
  renderPage();
  await screen.findByText("team0@vku.vn");

  fireEvent.change(screen.getByLabelText("Tìm tài khoản"), { target: { value: "team12@" } });
  expect(await screen.findByText("team12@vku.vn")).toBeTruthy();

  expect(statsRegion().getByText("230")).toBeTruthy();
  expect(statsRegion().getByText("202")).toBeTruthy();
  expect(statsRegion().getByText("5")).toBeTruthy();
});

test("lọc Chờ duyệt: gửi status, reset offset và giữ nguyên khi đổi từ khóa", async () => {
  mockApi([
    ...manyAccounts(60),
    { ...PENDING_ACCOUNT, id: "pending-1", email: "p1@vku.vn", name: "P1" },
    { ...PENDING_ACCOUNT, id: "pending-2", email: "p2@vku.vn", name: "P2" },
  ]);
  renderPage();
  await screen.findByText("team0@vku.vn");

  // Đang ở trang 2 thì bật lọc: phải quay về trang đầu của tập đã lọc.
  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  await screen.findByText("team50@vku.vn");
  fireEvent.click(screen.getByRole("button", { name: "Chờ duyệt" }));

  expect(await screen.findByText("p1@vku.vn")).toBeTruthy();
  expect(screen.queryByText("team0@vku.vn")).toBeNull();
  expect(calls.at(-1)?.url).toContain("status=pending");
  expect(calls.at(-1)?.url).toContain("offset=0");
  expect(screen.getByRole("button", { name: "Chờ duyệt" })).toHaveAttribute("aria-pressed", "true");

  // Đổi từ khóa khi đang lọc: bộ lọc phải được giữ trong query mới.
  fireEvent.change(screen.getByLabelText("Tìm tài khoản"), { target: { value: "p1" } });
  await waitFor(() => expect(calls.at(-1)?.url).toContain("q=p1"));
  expect(calls.at(-1)?.url).toContain("status=pending");
  expect(await screen.findByText("p1@vku.vn")).toBeTruthy();

  // Tắt lọc: không còn tham số lọc, từ khóa vẫn giữ.
  fireEvent.click(screen.getByRole("button", { name: "Tất cả" }));
  await waitFor(() => expect(calls.at(-1)?.url).not.toContain("status="));
  expect(await screen.findByText("p1@vku.vn")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Chờ duyệt" })).toHaveAttribute("aria-pressed", "false");
});

test("lọc Chờ duyệt không có kết quả: câu rỗng riêng và Xóa bộ lọc tắt lọc", async () => {
  mockApi([ACCOUNT]);
  renderPage();
  await screen.findByText("team@vku.vn");

  fireEvent.click(screen.getByRole("button", { name: "Chờ duyệt" }));
  expect(await screen.findByText("Không có tài khoản nào đang chờ duyệt.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Xóa bộ lọc" }));
  expect(await screen.findByText("team@vku.vn")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Chờ duyệt" })).toHaveAttribute("aria-pressed", "false");
  expect(calls.at(-1)?.url).not.toContain("status=");
});

test("lọc Hoạt động và Vô hiệu hóa phân biệt chờ duyệt", async () => {
  mockApi([ACCOUNT, PENDING_ACCOUNT, { ...ACCOUNT, id: "disabled", email: "disabled@vku.vn", active: false }]);
  renderPage();
  await screen.findByText("team@vku.vn");
  fireEvent.click(screen.getByRole("button", { name: "Hoạt động" }));
  await waitFor(() => expect(calls.at(-1)?.url).toContain("status=active"));
  expect(screen.queryByText("cho.duyet@vku.vn")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Đã vô hiệu hóa" }));
  expect(await screen.findByText("disabled@vku.vn")).toBeTruthy();
  expect(calls.at(-1)?.url).toContain("status=disabled");
  expect(screen.queryByText("cho.duyet@vku.vn")).toBeNull();
});

test("hàng chờ duyệt: badge riêng, chỉ có Duyệt và Xóa", async () => {
  mockApi([ACCOUNT, PENDING_ACCOUNT]);
  renderPage();
  await screen.findByText("cho.duyet@vku.vn");

  const region = screen.getByRole("region", { name: "Bảng tài khoản" });
  const row = within(region).getByText("cho.duyet@vku.vn").closest("tr") as HTMLElement;
  // Pending có `active: false` nhưng phải hiện "Chờ duyệt", không phải "Vô hiệu".
  expect(within(row).getByText("Chờ duyệt")).toBeTruthy();
  expect(within(row).queryByText("Vô hiệu")).toBeNull();
  expect(within(row).getByRole("button", { name: "Duyệt" })).toBeTruthy();
  expect(within(row).getByRole("button", { name: "Xóa" })).toBeTruthy();
  expect(within(row).queryByRole("button", { name: "Đặt lại MK" })).toBeNull();
  expect(within(row).queryByRole("button", { name: "Kích hoạt" })).toBeNull();
  expect(within(row).queryByRole("button", { name: "Vô hiệu hóa" })).toBeNull();
});

test("duyệt tài khoản: xác nhận rồi gọi POST /approve và tải lại danh sách", async () => {
  mockApi([ACCOUNT, PENDING_ACCOUNT]);
  renderPage();
  await screen.findByText("cho.duyet@vku.vn");

  fireEvent.click(screen.getByRole("button", { name: "Duyệt" }));
  const dialog = screen.getByRole("dialog", { name: "Duyệt tài khoản" });
  expect(calls.some((call) => call.init?.method === "POST")).toBe(false);

  fireEvent.click(within(dialog).getByRole("button", { name: "Duyệt" }));
  await waitFor(() => {
    expect(
      calls.some(
        (call) =>
          call.init?.method === "POST" &&
          call.url.includes(`/admin/accounts/${PENDING_ACCOUNT.id}/approve`),
      ),
    ).toBe(true);
  });
  expect(await screen.findByText("Đã duyệt tài khoản cho.duyet@vku.vn.")).toBeTruthy();
  // Sau khi duyệt, danh sách được tải lại (thêm một GET ngoài lần tải đầu).
  await waitFor(() =>
    expect(calls.filter((call) => call.init?.method === undefined).length).toBeGreaterThan(1),
  );
});

test("duyệt tài khoản đã bị người khác duyệt: 409 hiện trong modal, modal vẫn mở", async () => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({
            error: {
              code: "ACCOUNT_NOT_PENDING",
              message: "Tài khoản không ở trạng thái chờ duyệt.",
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      return json({
        accounts: [PENDING_ACCOUNT],
        total: 1,
        limit: 50,
        offset: 0,
        stats: statsOf([PENDING_ACCOUNT]),
      });
    }),
  );
  renderPage();
  await screen.findByText("cho.duyet@vku.vn");

  fireEvent.click(screen.getByRole("button", { name: "Duyệt" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Duyệt tài khoản" })).getByRole("button", {
      name: "Duyệt",
    }),
  );

  expect(await screen.findByText("Tài khoản không ở trạng thái chờ duyệt.")).toBeTruthy();
  // Modal còn nguyên để admin đọc lý do và tài khoản không bị đổi trạng thái trên UI.
  expect(screen.getByRole("dialog", { name: "Duyệt tài khoản" })).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Bảng tài khoản" })).getByText("Chờ duyệt"),
  ).toBeTruthy();
});

test("bảng giữ đủ sáu cột trong vùng cuộn focus được", async () => {
  mockApi();
  renderPage();
  await screen.findByText("team@vku.vn");

  const region = screen.getByRole("region", { name: "Bảng tài khoản" });
  expect(within(region).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
    "",
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

test("xóa tài khoản: phải gõ đúng email rồi mới gọi DELETE kèm confirm_email", async () => {
  mockApi();
  renderPage();
  await screen.findByText("team@vku.vn");

  fireEvent.click(screen.getByRole("button", { name: "Xóa" }));
  expect(screen.getByRole("dialog", { name: "Xóa tài khoản" })).toBeTruthy();
  expect(calls.some((call) => call.init?.method === "DELETE")).toBe(false);

  const confirm = screen.getByRole("button", { name: "Xóa vĩnh viễn" });
  const guard = screen.getByLabelText(/để xác nhận/);

  fireEvent.change(guard, { target: { value: "sai@vku.vn" } });
  expect(confirm).toBeDisabled();
  fireEvent.click(confirm);
  expect(calls.some((call) => call.init?.method === "DELETE")).toBe(false);

  fireEvent.change(guard, { target: { value: ACCOUNT.email } });
  expect(confirm).not.toBeDisabled();
  fireEvent.click(confirm);

  await waitFor(() => expect(calls.some((call) => call.init?.method === "DELETE")).toBe(true));
  const remove = calls.find((call) => call.init?.method === "DELETE");
  expect(remove?.url).toContain(`/admin/accounts/${ACCOUNT.id}?confirm_email=team%40vku.vn`);
});

test("xóa tài khoản có bài đã chấm: 409 hiện trong modal, modal vẫn mở", async () => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === "DELETE") {
        return new Response(
          JSON.stringify({
            error: {
              code: "ACCOUNT_HAS_SUBMISSIONS",
              message: "Tài khoản đã có bài nộp được chấm điểm. Hãy dùng Vô hiệu hoá thay vì xoá.",
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      return json({ accounts: [ACCOUNT], total: 1, limit: 50, offset: 0, stats: statsOf([ACCOUNT]) });
    }),
  );
  renderPage();
  await screen.findByText("team@vku.vn");

  fireEvent.click(screen.getByRole("button", { name: "Xóa" }));
  fireEvent.change(screen.getByLabelText(/để xác nhận/), { target: { value: ACCOUNT.email } });
  fireEvent.click(screen.getByRole("button", { name: "Xóa vĩnh viễn" }));

  expect(await screen.findByText(/Hãy dùng Vô hiệu hoá thay vì xoá/)).toBeTruthy();
  // Modal còn nguyên để admin đọc lý do, và tài khoản không bị xoá khỏi bảng.
  expect(screen.getByRole("dialog", { name: "Xóa tài khoản" })).toBeTruthy();
  const region = screen.getByRole("region", { name: "Bảng tài khoản" });
  expect(within(region).getByText("team@vku.vn")).toBeTruthy();
});

test("admin không thể tự xóa: nút bị khóa kèm lý do và không phát DELETE", async () => {
  mockCurrentAccountId = ACCOUNT.id;
  mockApi();
  renderPage();
  await screen.findByText("team@vku.vn");

  const remove = screen.getByRole("button", { name: "Xóa" });
  expect(remove).toBeDisabled();
  expect(remove.getAttribute("aria-describedby")).toBe(`self-delete-reason-${ACCOUNT.id}`);
  expect(screen.getByText("Bạn không thể xóa tài khoản đang đăng nhập.")).toBeTruthy();

  fireEvent.click(remove);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((call) => call.init?.method === "DELETE")).toBe(false);
});

test("chọn trang hiện tại, chọn một phần, và bỏ chọn khi chuyển trang/lọc", async () => {
  mockApi(manyAccounts(51));
  renderPage();
  await screen.findByText("team0@vku.vn");
  const selectAll = screen.getByRole("checkbox", { name: "Chọn tất cả trên trang" }) as HTMLInputElement;
  fireEvent.click(screen.getByRole("checkbox", { name: "Chọn team0@vku.vn" }));
  expect(selectAll.indeterminate).toBe(true);
  expect(screen.getByText("Đã chọn 1 tài khoản")).toBeTruthy();
  fireEvent.click(selectAll);
  expect(screen.getByText("Đã chọn 50 tài khoản")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  await screen.findByText("team50@vku.vn");
  expect(screen.queryByText(/Đã chọn 50 tài khoản/)).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Chọn team50@vku.vn" }));
  fireEvent.click(screen.getByRole("button", { name: "Chờ duyệt" }));
  await screen.findByText("Không có tài khoản nào đang chờ duyệt.");
  expect(screen.queryByText(/Đã chọn 1 tài khoản/)).toBeNull();
});

test("không chọn được tài khoản đang đăng nhập để xóa hàng loạt", async () => {
  mockCurrentAccountId = ACCOUNT.id;
  mockApi([ACCOUNT, PENDING_ACCOUNT]);
  renderPage();
  await screen.findByText("team@vku.vn");
  expect(screen.getByRole("checkbox", { name: "Chọn team@vku.vn" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Chọn tất cả trên trang" }));
  expect(screen.getByText("Đã chọn 1 tài khoản")).toBeTruthy();
});

test("chỉ duyệt được khi tất cả tài khoản đã chọn đang chờ duyệt", async () => {
  mockApi([ACCOUNT, PENDING_ACCOUNT]);
  renderPage();
  await screen.findByText("cho.duyet@vku.vn");
  fireEvent.click(screen.getByRole("checkbox", { name: "Chọn tất cả trên trang" }));
  expect(screen.getByRole("button", { name: "Duyệt đã chọn" })).toBeDisabled();
  expect(screen.getByText(/Chỉ duyệt hàng loạt tài khoản chờ duyệt/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Xóa đã chọn" })).not.toBeDisabled();
});

test("duyệt nhiều tài khoản tuần tự và báo lỗi từng email", async () => {
  const accounts = [
    { ...PENDING_ACCOUNT, id: "p1", email: "p1@vku.vn" },
    { ...PENDING_ACCOUNT, id: "p2", email: "p2@vku.vn" },
  ];
  mockApi(accounts);
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST" && String(input).includes("/p1/approve")) {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ error: { code: "ACCOUNT_NOT_PENDING", message: "Không còn chờ duyệt." } }), { status: 409, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(input, init);
  }));
  renderPage();
  await screen.findByText("p1@vku.vn");
  fireEvent.click(screen.getByRole("checkbox", { name: "Chọn tất cả trên trang" }));
  fireEvent.click(screen.getByRole("button", { name: "Duyệt đã chọn" }));
  const dialog = screen.getByRole("dialog", { name: "Duyệt tài khoản đã chọn" });
  expect(within(dialog).getByText("p1@vku.vn")).toBeTruthy();
  expect(within(dialog).getByText("p2@vku.vn")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Duyệt 2 tài khoản" }));
  expect(await within(dialog).findByText(/Đã duyệt 1\/2 tài khoản/)).toBeTruthy();
  expect(within(dialog).getByText(/p1@vku.vn: Không còn chờ duyệt/)).toBeTruthy();
  const posts = calls.filter((call) => call.init?.method === "POST");
  expect(posts.map((call) => call.url)).toEqual(["/api/admin/accounts/p1/approve", "/api/admin/accounts/p2/approve"]);
  expect(calls.filter((call) => call.init?.method === undefined)).toHaveLength(2);
});

test("xóa tài khoản mọi trạng thái cần gõ XÓA và giữ guard email từng dòng", async () => {
  mockApi([ACCOUNT, PENDING_ACCOUNT]);
  renderPage();
  await screen.findByText("cho.duyet@vku.vn");
  fireEvent.click(screen.getByRole("checkbox", { name: "Chọn tất cả trên trang" }));
  fireEvent.click(screen.getByRole("button", { name: "Xóa đã chọn" }));
  const dialog = screen.getByRole("dialog", { name: "Xóa tài khoản đã chọn" });
  const confirm = within(dialog).getByRole("button", { name: "Xóa 2 tài khoản" });
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText(/Gõ XÓA/), { target: { value: "XÓA" } });
  fireEvent.click(confirm);
  expect(await within(dialog).findByText(/Đã xóa 2\/2 tài khoản/)).toBeTruthy();
  expect(calls.filter((call) => call.init?.method === "DELETE").map((call) => call.url)).toEqual([
    `/api/admin/accounts/${ACCOUNT.id}?confirm_email=team%40vku.vn`,
    `/api/admin/accounts/${PENDING_ACCOUNT.id}?confirm_email=cho.duyet%40vku.vn`,
  ]);
});

test("xóa hàng loạt tiếp tục khi một tài khoản có bài đã chấm và hiển thị lý do", async () => {
  mockApi([ACCOUNT, PENDING_ACCOUNT]);
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE" && String(input).includes(ACCOUNT.id)) {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ error: { code: "ACCOUNT_HAS_SUBMISSIONS", message: "Đã có bài được chấm." } }), {
        status: 409, headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }));
  renderPage();
  await screen.findByText("team@vku.vn");
  fireEvent.click(screen.getByRole("checkbox", { name: "Chọn tất cả trên trang" }));
  fireEvent.click(screen.getByRole("button", { name: "Xóa đã chọn" }));
  const dialog = screen.getByRole("dialog", { name: "Xóa tài khoản đã chọn" });
  fireEvent.change(within(dialog).getByLabelText(/Gõ XÓA/), { target: { value: "XÓA" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Xóa 2 tài khoản" }));
  expect(await within(dialog).findByText(/Đã xóa 1\/2 tài khoản/)).toBeTruthy();
  expect(within(dialog).getByText(/team@vku.vn: Đã có bài được chấm/)).toBeTruthy();
  expect(calls.filter((call) => call.init?.method === "DELETE")).toHaveLength(2);
  expect(calls.filter((call) => !call.init?.method)).toHaveLength(2);
});

test("đổi từ khóa bỏ chọn trước khi hết debounce; chọn lại chỉ khi thấy trang mới", async () => {
  mockApi([ACCOUNT, PENDING_ACCOUNT]);
  renderPage();
  await screen.findByText("team@vku.vn");
  fireEvent.click(screen.getByRole("checkbox", { name: "Chọn team@vku.vn" }));
  fireEvent.change(screen.getByLabelText("Tìm tài khoản"), { target: { value: "cho.duyet" } });
  expect(screen.queryByRole("button", { name: "Xóa đã chọn" })).toBeNull();
  expect(await screen.findByText("cho.duyet@vku.vn")).toBeTruthy();
  await waitFor(() => expect(calls.at(-1)?.url).toContain("q=cho.duyet"));
});

test("tiêu đề tab đặt theo tên trang", async () => {
  mockApi();
  render(
    <MemoryRouter>
      <AdminAccountsPage />
    </MemoryRouter>,
  );
  await screen.findByText("team@vku.vn");
  expect(document.title).toBe("Quản lý tài khoản - AI Challenge");
});

test("tài khoản tự đăng ký tự hiện và KPI chờ duyệt tự tăng, không cần thao tác", async () => {
  vi.useFakeTimers();
  const accounts: Array<Record<string, unknown>> = [{ ...ACCOUNT }];
  mockApi(accounts);
  renderPage();
  await advance();
  expect(screen.getByText("team@vku.vn")).toBeTruthy();
  const stats = screen.getByRole("region", { name: "Tổng quan tài khoản" });
  const pendingValue = () => within(within(stats).getByText("Chờ duyệt").closest("article") as HTMLElement);
  expect(pendingValue().getByText("0")).toBeTruthy();

  // Người dùng tự đăng ký trong lúc admin đang mở trang: lượt làm mới ngầm kế tiếp phải thấy.
  accounts.push({ ...PENDING_ACCOUNT, id: "moi", email: "moi@vku.vn" });
  await advance(3_500);

  expect(screen.getByText("moi@vku.vn")).toBeTruthy();
  expect(pendingValue().getByText("1")).toBeTruthy();
});

test("modal đang mở thì tạm dừng tự làm mới; đóng modal và tab hiện lại thì làm mới ngay", async () => {
  vi.useFakeTimers();
  mockApi([ACCOUNT]);
  renderPage();
  await advance();
  const listGets = () => calls.filter((call) => !call.init?.method).length;
  expect(listGets()).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Tạo tài khoản" }));
  await advance(20_000);
  expect(listGets()).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Đóng" }));
  setDocumentHidden(true);
  setDocumentHidden(false);
  await advance();

  expect(listGets()).toBe(2);
});
