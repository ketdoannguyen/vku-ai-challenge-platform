import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { LoginPage } from "./LoginPage";

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  it("hiển thị error message khi đăng nhập sai", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: "INVALID_CREDENTIALS", message: "Email hoặc mật khẩu không đúng." } }),
      }),
    );

    renderLogin();
    await userEvent.type(screen.getByLabelText("Email"), "sai@vku.vn");
    await userEvent.type(screen.getByLabelText("Mật khẩu"), "sai-mat-khau");
    await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Email hoặc mật khẩu không đúng.");
  });

  it("disable nút và hiện trạng thái loading khi đang submit", async () => {
    let resolveLogin: (v: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (url) =>
          url === "/api/auth/me"
            ? Promise.resolve({ ok: false, status: 401, json: async () => ({ error: { code: "UNAUTHORIZED", message: "x" } }) })
            : new Promise((res) => {
                resolveLogin = res;
              }),
      ),
    );

    renderLogin();
    await userEvent.type(screen.getByLabelText("Email"), "dung@vku.vn");
    await userEvent.type(screen.getByLabelText("Mật khẩu"), "mat-khau-dung-1");
    await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));

    const submitting = await screen.findByRole("button", { name: /Đang đăng nhập/ });
    expect(submitting).toBeDisabled();

    resolveLogin({ ok: true, status: 200, json: async () => ({ id: "1", email: "dung@vku.vn", name: "D", role: "participant", active: true }) });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("không có link đăng ký", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: "UNAUTHORIZED", message: "x" } }) }),
    );
    renderLogin();
    expect(screen.queryByText(/đăng ký/i)).not.toBeInTheDocument();
  });
});
