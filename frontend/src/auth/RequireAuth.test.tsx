import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "./AuthContext";
import { RequireAdmin, RequireAuth } from "./RequireAuth";

function renderAt(path: string, element: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<div>TRANG LOGIN</div>} />
          <Route path="/" element={<div>TRANG CHÍNH</div>} />
          <Route path="/admin/accounts" element={element} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function stubMe(role: string | null) {
  const meResponse =
    role === null
      ? { ok: false, status: 401, json: async () => ({ error: { code: "UNAUTHORIZED", message: "x" } }) }
      : { ok: true, status: 200, json: async () => ({ id: "1", email: "a@vku.vn", name: "A", role, active: true }) };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(meResponse));
}

describe("RequireAuth", () => {
  it("redirect về /login khi chưa đăng nhập", async () => {
    stubMe(null);
    renderAt(
      "/admin/accounts",
      <RequireAuth>
        <div>NỘI DUNG BẢO VỆ</div>
      </RequireAuth>,
    );
    expect(await screen.findByText("TRANG LOGIN")).toBeInTheDocument();
    expect(screen.queryByText("NỘI DUNG BẢO VỆ")).not.toBeInTheDocument();
  });

  it("hiển thị nội dung khi đã đăng nhập", async () => {
    stubMe("participant");
    renderAt(
      "/admin/accounts",
      <RequireAuth>
        <div>NỘI DUNG BẢO VỆ</div>
      </RequireAuth>,
    );
    expect(await screen.findByText("NỘI DUNG BẢO VỆ")).toBeInTheDocument();
  });
});

describe("RequireAdmin", () => {
  it("participant bị redirect về trang chính", async () => {
    stubMe("participant");
    renderAt(
      "/admin/accounts",
      <RequireAdmin>
        <div>CHỈ ADMIN</div>
      </RequireAdmin>,
    );
    expect(await screen.findByText("TRANG CHÍNH")).toBeInTheDocument();
    expect(screen.queryByText("CHỈ ADMIN")).not.toBeInTheDocument();
  });

  it("admin thấy nội dung", async () => {
    stubMe("admin");
    renderAt(
      "/admin/accounts",
      <RequireAdmin>
        <div>CHỈ ADMIN</div>
      </RequireAdmin>,
    );
    expect(await screen.findByText("CHỈ ADMIN")).toBeInTheDocument();
  });
});
