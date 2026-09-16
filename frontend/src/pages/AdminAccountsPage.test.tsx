import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function mockApi() {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ ...ACCOUNT, active: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ accounts: [ACCOUNT], total: 1, limit: 200, offset: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

test("loads up to 200 accounts and protects passwords", async () => {
  mockApi();
  render(
    <MemoryRouter>
      <AdminAccountsPage />
    </MemoryRouter>,
  );

  expect(await screen.findByText("team@vku.vn")).toBeTruthy();
  expect(calls[0].url).toContain("/admin/accounts?limit=200");

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
