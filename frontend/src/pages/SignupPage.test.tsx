/** Trang tự đăng ký (ADR-049): validation tại client, thông điệp trung tính và không tự đăng nhập. */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { SignupPage } from "./SignupPage";

const ACCEPTED_MESSAGE =
  "Nếu đăng ký được ghi nhận, tài khoản cần Ban Tổ chức duyệt trước khi đăng nhập. " +
  "Nếu bạn đã có tài khoản, hãy đăng nhập hoặc liên hệ Ban Tổ chức.";

function renderSignup() {
  return render(
    <MemoryRouter initialEntries={["/register"]}>
      <Routes>
        <Route path="/register" element={<SignupPage />} />
        <Route path="/login" element={<div>TRANG ĐĂNG NHẬP</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fillValidForm() {
  await userEvent.type(screen.getByLabelText("Email"), "moi@vku.vn");
  await userEvent.type(screen.getByLabelText("Tên hiển thị"), "Người Mới");
  await userEvent.type(screen.getByLabelText("Mật khẩu"), "matkhaumoi1");
  await userEvent.type(screen.getByLabelText("Xác nhận mật khẩu"), "matkhaumoi1");
}

it("hiển thị form và tiêu đề tab", () => {
  renderSignup();
  expect(screen.getByRole("heading", { level: 1, name: "VKU AI Challenge Platform" })).toBeInTheDocument();
  expect(screen.getByLabelText("Email")).toBeInTheDocument();
  expect(screen.getByLabelText("Tên hiển thị")).toBeInTheDocument();
  expect(screen.getByLabelText("Mật khẩu")).toBeInTheDocument();
  expect(screen.getByLabelText("Xác nhận mật khẩu")).toBeInTheDocument();
  expect(document.title).toBe("Đăng ký - AI Challenge");
});

it("chặn submit rỗng, focus field lỗi đầu tiên và không gọi API", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  renderSignup();

  await userEvent.click(screen.getByRole("button", { name: "Đăng ký" }));

  expect(screen.getByLabelText("Email")).toHaveFocus();
  expect(document.getElementById("signup-email-error")).toHaveTextContent("Vui lòng nhập email.");
  expect(document.getElementById("signup-name-error")).toHaveTextContent("Vui lòng nhập tên hiển thị.");
  expect(document.getElementById("signup-password-error")).toHaveTextContent("Vui lòng nhập mật khẩu.");
  expect(document.getElementById("signup-confirm-error")).toHaveTextContent("Vui lòng xác nhận mật khẩu.");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("email sai định dạng và mật khẩu dưới 6 ký tự bị chặn tại client", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  renderSignup();

  await userEvent.type(screen.getByLabelText("Email"), "khong-phai-email");
  await userEvent.type(screen.getByLabelText("Tên hiển thị"), "Người Mới");
  await userEvent.type(screen.getByLabelText("Mật khẩu"), "ngan");
  await userEvent.type(screen.getByLabelText("Xác nhận mật khẩu"), "ngan");
  await userEvent.click(screen.getByRole("button", { name: "Đăng ký" }));

  expect(document.getElementById("signup-email-error")).toHaveTextContent("Email không hợp lệ.");
  expect(document.getElementById("signup-password-error")).toHaveTextContent(
    "Mật khẩu phải có ít nhất 6 ký tự.",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it("mật khẩu xác nhận không khớp bị chặn tại field xác nhận", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  renderSignup();

  await userEvent.type(screen.getByLabelText("Email"), "moi@vku.vn");
  await userEvent.type(screen.getByLabelText("Tên hiển thị"), "Người Mới");
  await userEvent.type(screen.getByLabelText("Mật khẩu"), "matkhaumoi1");
  await userEvent.type(screen.getByLabelText("Xác nhận mật khẩu"), "matkhaumoi2");
  await userEvent.click(screen.getByRole("button", { name: "Đăng ký" }));

  expect(document.getElementById("signup-confirm-error")).toHaveTextContent(
    "Mật khẩu xác nhận không khớp.",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it("gửi thành công: gửi email/tên đã trim, hiện thông điệp trung tính và link quay lại đăng nhập", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 202,
    json: async () => ({ ok: true, pending: true, message: ACCEPTED_MESSAGE }),
  });
  vi.stubGlobal("fetch", fetchMock);
  renderSignup();

  await userEvent.type(screen.getByLabelText("Email"), "  moi@vku.vn  ");
  await userEvent.type(screen.getByLabelText("Tên hiển thị"), "  Người Mới  ");
  await userEvent.type(screen.getByLabelText("Mật khẩu"), "matkhaumoi1");
  await userEvent.type(screen.getByLabelText("Xác nhận mật khẩu"), "matkhaumoi1");
  await userEvent.click(screen.getByRole("button", { name: "Đăng ký" }));

  const status = await screen.findByRole("status");
  expect(status).toHaveTextContent(ACCEPTED_MESSAGE);
  await waitFor(() => expect(status).toHaveFocus());
  // Không tự đăng nhập: chỉ có lối quay lại trang đăng nhập.
  expect(screen.getByRole("link", { name: "Quay lại đăng nhập" })).toHaveAttribute("href", "/login");

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/auth/register",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ email: "moi@vku.vn", name: "Người Mới", password: "matkhaumoi1" }),
    }),
  );
});

it("429 hiện message từ API trong alert và focus alert", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        error: { code: "RATE_LIMITED", message: "Có quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau." },
      }),
    }),
  );
  renderSignup();
  await fillValidForm();
  await userEvent.click(screen.getByRole("button", { name: "Đăng ký" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Có quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau.");
  await waitFor(() => expect(alert).toHaveFocus());
});

it("đang gửi thì khóa form và đổi nhãn nút", async () => {
  let resolveRegister: (v: unknown) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(
      () =>
        new Promise((res) => {
          resolveRegister = res;
        }),
    ),
  );
  renderSignup();
  await fillValidForm();
  await userEvent.click(screen.getByRole("button", { name: "Đăng ký" }));

  expect(await screen.findByRole("button", { name: /Đang gửi đăng ký/ })).toBeDisabled();
  expect(screen.getByLabelText("Email")).toBeDisabled();

  resolveRegister({ ok: true, status: 202, json: async () => ({ ok: true, pending: true, message: ACCEPTED_MESSAGE }) });
  expect(await screen.findByRole("status")).toHaveTextContent(ACCEPTED_MESSAGE);
});
