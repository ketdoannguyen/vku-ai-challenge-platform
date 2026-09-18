import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

function renderLoginWithReturnTo(from: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/login", state: { from } }]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>TRANG CHÍNH</div>} />
          <Route path="/competitions/:slug" element={<div>TRANG CUỘC THI</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** /auth/me -> 401 (khách), /auth/login -> 200 (đăng nhập thành công). */
function stubLoginFlow() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        url === "/api/auth/me"
          ? new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "x" } }), { status: 401 })
          : new Response(
              JSON.stringify({ id: "1", email: "a@vku.vn", name: "A", role: "participant", active: true }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
      ),
    ),
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

function stubAuthMeUnauthorized() {
  return Promise.resolve({
    ok: false,
    status: 401,
    json: async () => ({ error: { code: "UNAUTHORIZED", message: "x" } }),
  });
}

function stubLoginFailing(status: number, code: string, message: string) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === "/api/auth/me") return stubAuthMeUnauthorized();
    return Promise.resolve({ ok: false, status, json: async () => ({ error: { code, message } }) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("LoginPage validation và focus", () => {
  it("chặn submit rỗng trước khi gọi API, focus field sai đầu tiên và associate lỗi", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      url === "/api/auth/me"
        ? stubAuthMeUnauthorized()
        : Promise.resolve({ ok: false, status: 401, json: async () => ({ error: { code: "UNAUTHORIZED", message: "x" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderLogin();
    await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));

    const email = screen.getByLabelText("Email");
    expect(email).toHaveFocus();
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAttribute("aria-describedby", "email-error");
    expect(document.getElementById("email-error")).toHaveTextContent("Vui lòng nhập email.");

    const password = screen.getByLabelText("Mật khẩu");
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(password).toHaveAttribute("aria-describedby", "password-error");
    expect(document.getElementById("password-error")).toHaveTextContent("Vui lòng nhập mật khẩu.");

    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/auth/login")).toHaveLength(0);
  });

  it("sai credentials: focus alert, không rơi về body, giữ password value", async () => {
    stubLoginFailing(401, "INVALID_CREDENTIALS", "Email hoặc mật khẩu không đúng.");

    renderLogin();
    await userEvent.type(screen.getByLabelText("Email"), "sai@vku.vn");
    await userEvent.type(screen.getByLabelText("Mật khẩu"), "sai-mat-khau");
    await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Email hoặc mật khẩu không đúng.");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);

    const email = screen.getByLabelText("Email");
    expect(email).toHaveAttribute("autocomplete", "username");
    expect(email).toHaveAttribute("aria-describedby", "login-error");
    const password = screen.getByLabelText("Mật khẩu");
    expect(password).toHaveValue("sai-mat-khau");
    expect(password).toHaveAttribute("autocomplete", "current-password");
  });

  it("lỗi server 500: message nằm trong alert và alert được focus", async () => {
    stubLoginFailing(500, "INTERNAL", "Lỗi máy chủ.");

    renderLogin();
    await userEvent.type(screen.getByLabelText("Email"), "a@vku.vn");
    await userEvent.type(screen.getByLabelText("Mật khẩu"), "mat-khau");
    await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Lỗi máy chủ.");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("gõ lại vào field xóa aria-invalid và error tương ứng", async () => {
    stubLoginFailing(401, "INVALID_CREDENTIALS", "Email hoặc mật khẩu không đúng.");

    renderLogin();
    await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));

    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Mật khẩu");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(password).toHaveAttribute("aria-invalid", "true");

    await userEvent.type(email, "a@vku.vn");
    expect(email).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Vui lòng nhập email.")).not.toBeInTheDocument();
    expect(password).toHaveAttribute("aria-invalid", "true");

    await userEvent.type(password, "mat-khau");
    expect(password).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Vui lòng nhập mật khẩu.")).not.toBeInTheDocument();
  });

  it("sửa credentials sau lỗi server sẽ xóa alert cũ", async () => {
    stubLoginFailing(401, "INVALID_CREDENTIALS", "Email hoặc mật khẩu không đúng.");

    renderLogin();
    await userEvent.type(screen.getByLabelText("Email"), "sai@vku.vn");
    await userEvent.type(screen.getByLabelText("Mật khẩu"), "sai-mat-khau");
    await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Email hoặc mật khẩu không đúng.");

    await userEvent.type(screen.getByLabelText("Mật khẩu"), "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("đang submit vẫn disable nút và giữ aria-pressed của nút hiện/ẩn mật khẩu", async () => {
    let resolveLogin: (v: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        url === "/api/auth/me"
          ? stubAuthMeUnauthorized()
          : new Promise((res) => {
              resolveLogin = res;
            }),
      ),
    );

    renderLogin();
    await userEvent.type(screen.getByLabelText("Email"), "dung@vku.vn");
    await userEvent.type(screen.getByLabelText("Mật khẩu"), "mat-khau-dung-1");

    expect(screen.getByRole("button", { name: "Hiện mật khẩu" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "Hiện mật khẩu" }));
    expect(screen.getByRole("button", { name: "Ẩn mật khẩu" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));
    expect(await screen.findByRole("button", { name: /Đang đăng nhập/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ẩn mật khẩu" })).toHaveAttribute("aria-pressed", "true");

    resolveLogin({
      ok: true,
      status: 200,
      json: async () => ({ id: "1", email: "dung@vku.vn", name: "D", role: "participant", active: true }),
    });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});

describe("LoginPage return-to", () => {
  it("quay lại đúng deep link nội bộ sau khi đăng nhập", async () => {
    stubLoginFlow();
    renderLoginWithReturnTo("/competitions/ai-cup?tab=leaderboard#top");

    await userEvent.type(screen.getByLabelText("Email"), "a@vku.vn");
    await userEvent.type(screen.getByLabelText("Mật khẩu"), "mat-khau");
    await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));

    expect(await screen.findByText("TRANG CUỘC THI")).toBeInTheDocument();
  });

  it.each(["//evil.example", "https://evil.example", ""])(
    "return-to không an toàn %j bị đưa về trang chủ",
    async (from) => {
      stubLoginFlow();
      renderLoginWithReturnTo(from);

      await userEvent.type(screen.getByLabelText("Email"), "a@vku.vn");
      await userEvent.type(screen.getByLabelText("Mật khẩu"), "mat-khau");
      await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));

      expect(await screen.findByText("TRANG CHÍNH")).toBeInTheDocument();
    },
  );
});

describe("tiêu đề tab", () => {
  it("đặt theo tên trang đăng nhập", async () => {
    vi.stubGlobal("fetch", vi.fn(stubAuthMeUnauthorized));
    renderLogin();
    expect(await screen.findByRole("heading", { name: "VKU AI Challenge Platform" })).toBeInTheDocument();
    expect(document.title).toBe("Đăng nhập — AI Challenge");
  });
});
