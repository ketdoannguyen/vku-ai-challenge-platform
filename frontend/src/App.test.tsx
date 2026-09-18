/** App: ranh giới công khai (ADR-014) - khách đọc được danh sách/chi tiết, trang cần danh tính thì chặn. */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";

const COMPETITION = {
  id: "1",
  slug: "ai-challenge-2026",
  name: "AI Challenge 2026",
  short_description: "Cuộc thi AI lần 1",
  status: "published",
  start_at: "2026-10-01T00:00:00Z",
  end_at: "2026-11-01T00:00:00Z",
  join_mode: "open",
  primary_metric: "f1",
  quota_per_day: 5,
  leaderboard_visible: true,
  join_code_configured: false,
  resources: [],
  membership: { active: false, joined_at: null },
  submission_config: {
    ready: false,
    id_column: null,
    prediction_column: null,
    average: null,
    pos_label: null,
    max_upload_mb: 10,
  },
};

const CONTENTS = {
  contents: [
    { id: "a", slug: "problem", title: "Đề bài", order: 10, visibility: "public", size_bytes: 10, updated_at: "2026-09-15T00:00:00Z" },
  ],
};

const ACCOUNT = { id: "9", email: "team1@vku.vn", name: "Đội 1", role: "participant", active: true };

/** Phiên ẩn danh: `/auth/me` 401; các tuyến công khai trả dữ liệu bình thường. */
function mockGuestApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/auth/me")) return body({ error: { code: "UNAUTHORIZED", message: "Chưa đăng nhập." } }, 401);
      if (url.endsWith("/api/auth/login")) return body(ACCOUNT);
      if (url.endsWith("/api/competitions")) return body({ competitions: [COMPETITION] });
      if (url.includes("/contents")) return body(CONTENTS);
      if (url.endsWith("/api/competitions/ai-challenge-2026")) return body(COMPETITION);
      return body({ error: { code: "NOT_FOUND", message: "Không tìm thấy." } }, 404);
    }),
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Drawer khoá cuộn bằng inline style; reset để test sau không thừa hưởng.
  document.body.style.overflow = "";
});

test("khách vào / thấy danh sách cuộc thi, không bị đẩy về /login", async () => {
  mockGuestApi();
  renderAt("/");
  expect(await screen.findByRole("heading", { name: "AI Challenge 2026" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1, name: "Cuộc thi" })).toBeTruthy();
  expect(screen.queryByLabelText("Mật khẩu")).toBeNull();
  // Shell rộng 1440px là ngoại lệ riêng của `/ho-tro` và `/gioi-thieu`, không được
  // rò sang route khác.
  const main = document.getElementById("main-content");
  expect(main).not.toHaveClass("app-main-support");
  expect(main).not.toHaveClass("app-main-about");
});

test("khách vào chi tiết cuộc thi thấy nội dung công khai và lời mời đăng nhập", async () => {
  mockGuestApi();
  renderAt("/competitions/ai-challenge-2026");
  expect(await screen.findByRole("heading", { level: 1, name: "AI Challenge 2026" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Đăng nhập để tham gia" })).toBeTruthy();
});

test("nút quay lại ở /login đưa khách về dashboard", async () => {
  mockGuestApi();
  renderAt("/login");
  fireEvent.click(await screen.findByRole("button", { name: "Về trang chủ" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Cuộc thi" })).toBeTruthy();
});

test("khách vào trang nộp bài bị đẩy về /login", async () => {
  mockGuestApi();
  renderAt("/competitions/ai-challenge-2026/submit");
  expect(await screen.findByLabelText("Mật khẩu")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Cuộc thi" })).toBeNull());
});

test("đăng nhập xong quay lại đúng trang nộp bài đã bị chặn", async () => {
  mockGuestApi();
  renderAt("/competitions/ai-challenge-2026/submit");
  await userEvent.type(await screen.findByLabelText("Email"), ACCOUNT.email);
  await userEvent.type(screen.getByLabelText("Mật khẩu"), "matkhau1234");
  await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));
  expect(await screen.findByRole("heading", { name: "Nộp bài CSV" })).toBeTruthy();
});

/** App thật mount vào `#root`; gắn id lên container của RTL để test được `inert`. */
function renderAtRoot(path: string) {
  const result = render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  result.container.id = "root";
  return result;
}

function drawerNav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Điều hướng chính (menu di động)" });
}

async function openDrawer() {
  const toggle = await screen.findByRole("button", { name: "Mở menu điều hướng" });
  fireEvent.click(toggle);
  return { toggle, drawer: screen.getByRole("dialog", { name: "Menu điều hướng" }) };
}

/**
 * jsdom không thật sự chặn focus trong subtree `inert`, nên chỉ ghi lại thời điểm
 * gọi mới bắt được lỗi "trả focus khi `#root` còn inert" (focus sẽ bị nuốt trên browser).
 */
function recordInertAtFocus(element: HTMLElement) {
  const record: { inertAtFocus: boolean | null } = { inertAtFocus: null };
  const original = element.focus.bind(element);
  element.focus = () => {
    record.inertAtFocus = document.getElementById("root")?.inert ?? null;
    original();
  };
  return record;
}

test("drawer là dialog modal: khoá cuộn nền, đặt #root inert và focus vào trong", async () => {
  mockGuestApi();
  document.body.style.overflow = "scroll";
  renderAtRoot("/");
  await screen.findByRole("heading", { level: 1, name: "Cuộc thi" });

  const { drawer } = await openDrawer();
  expect(drawer).toHaveAttribute("aria-modal", "true");
  expect(screen.getByRole("button", { name: "Đóng menu điều hướng" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(document.getElementById("root")?.inert).toBe(true);
  expect(document.body.style.overflow).toBe("hidden");
  expect(within(drawer).getByRole("button", { name: "Đóng menu" })).toHaveFocus();
});

test("drawer: Tab/Shift+Tab quẩn trong drawer và Escape trả focus về nút hamburger", async () => {
  mockGuestApi();
  document.body.style.overflow = "scroll";
  renderAtRoot("/");
  await screen.findByRole("heading", { level: 1, name: "Cuộc thi" });

  const { toggle, drawer } = await openDrawer();
  const close = within(drawer).getByRole("button", { name: "Đóng menu" });
  const last = within(drawer).getByRole("link", { name: "Đăng nhập" });

  last.focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(close).toHaveFocus();

  fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
  expect(last).toHaveFocus();

  const focusRecord = recordInertAtFocus(toggle);
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Menu điều hướng" })).toBeNull());
  expect(document.activeElement).toBe(toggle);
  expect(document.getElementById("root")?.inert).toBe(false);
  expect(document.body.style.overflow).toBe("scroll");
  // Phải gỡ inert trước khi trả focus, nếu không browser sẽ bỏ qua lệnh focus.
  expect(focusRecord.inertAtFocus).toBe(false);
});

test("drawer: bấm overlay đóng menu và trả focus về nút hamburger", async () => {
  mockGuestApi();
  renderAtRoot("/");
  await screen.findByRole("heading", { level: 1, name: "Cuộc thi" });

  const { toggle } = await openDrawer();
  fireEvent.click(document.querySelector(".app-drawer-overlay") as HTMLElement);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Menu điều hướng" })).toBeNull());
  expect(document.activeElement).toBe(toggle);
  expect(document.getElementById("root")?.inert).toBe(false);
});

test("điều hướng từ drawer đóng menu, đổi route và đưa focus vào main", async () => {
  mockGuestApi();
  renderAtRoot("/competitions/ai-challenge-2026");
  await screen.findByRole("heading", { level: 1, name: "AI Challenge 2026" });

  await openDrawer();
  fireEvent.click(within(drawerNav()).getByRole("link", { name: "Cuộc thi" }));

  expect(await screen.findByRole("heading", { level: 1, name: "Cuộc thi" })).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Menu điều hướng" })).toBeNull();
  expect(document.activeElement).toBe(document.getElementById("main-content"));
});

test("lần render đầu không tự cướp focus về main", async () => {
  mockGuestApi();
  renderAtRoot("/");
  await screen.findByRole("heading", { level: 1, name: "Cuộc thi" });
  expect(document.activeElement).not.toBe(document.getElementById("main-content"));
});

test("điều hướng bằng link trên header đưa focus vào main", async () => {
  mockGuestApi();
  renderAtRoot("/competitions/ai-challenge-2026");
  await screen.findByRole("heading", { level: 1, name: "AI Challenge 2026" });

  const main = document.getElementById("main-content") as HTMLElement;
  expect(document.activeElement).not.toBe(main);

  const headerNav = screen.getByRole("navigation", { name: "Điều hướng chính" });
  fireEvent.click(within(headerNav).getByRole("link", { name: "Cuộc thi" }));

  expect(await screen.findByRole("heading", { level: 1, name: "Cuộc thi" })).toBeTruthy();
  expect(document.activeElement).toBe(main);
});

test("back/forward (POP) không bị cướp focus", async () => {
  mockGuestApi();
  function Back() {
    const navigate = useNavigate();
    return <button onClick={() => navigate(-1)}>quay lại</button>;
  }
  render(
    <MemoryRouter initialEntries={["/", "/competitions/ai-challenge-2026"]} initialIndex={1}>
      <App />
      <Back />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { level: 1, name: "AI Challenge 2026" });

  fireEvent.click(screen.getByRole("button", { name: "quay lại" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Cuộc thi" })).toBeTruthy();
  expect(document.activeElement).not.toBe(document.getElementById("main-content"));
});

test("route không tồn tại: H1 404 và tiêu đề tab mô tả trạng thái", async () => {
  mockGuestApi();
  renderAt("/khong-co-trang-nay");
  expect(await screen.findByRole("heading", { name: "404 - Không tìm thấy trang" })).toBeTruthy();
  expect(document.title).toBe("Không tìm thấy trang - AI Challenge");
  // Hai lối thoát: link về dashboard đúng route và nút quay lại lịch sử.
  expect(screen.getByRole("link", { name: "Về trang chính" })).toHaveAttribute("href", "/");
  expect(screen.getByRole("button", { name: "Quay lại" })).toBeTruthy();
  // Trang lỗi dùng icon SVG trang trí đã ẩn khỏi AT, không dùng emoji production.
  const main = document.getElementById("main-content") as HTMLElement;
  expect(main.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  expect(main.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
});

// ADR-021: hai trang tĩnh công khai, không đòi đăng nhập và không gọi API nghiệp vụ.
test("khách mở /gioi-thieu không bị đẩy về /login", async () => {
  mockGuestApi();
  renderAt("/gioi-thieu");
  expect(await screen.findByRole("heading", { level: 1, name: "Giới thiệu" })).toBeTruthy();
  expect(screen.queryByLabelText("Mật khẩu")).toBeNull();
  expect(document.title).toBe("Giới thiệu - AI Challenge");
  // Lưới hai cột của trang giới thiệu cũng cần trần rộng 1440px, nhưng chỉ riêng route này.
  const main = document.getElementById("main-content");
  expect(main).toHaveClass("app-main-about");
  expect(main).not.toHaveClass("app-main-support");
});

test("khách mở /ho-tro không bị đẩy về /login", async () => {
  mockGuestApi();
  renderAt("/ho-tro");
  expect(await screen.findByRole("heading", { level: 1, name: "Hỗ trợ & Liên hệ" })).toBeTruthy();
  expect(screen.queryByLabelText("Mật khẩu")).toBeNull();
  expect(document.title).toBe("Hỗ trợ & Liên hệ - AI Challenge");
  // Trang hỗ trợ có lưới hai cột nên dùng trần rộng 1440px; các route khác giữ 1280px.
  const main = document.getElementById("main-content");
  expect(main).toHaveClass("app-main-support");
  expect(main).not.toHaveClass("app-main-about");
});

test("điều hướng bằng link trên header tới hai trang tĩnh mới", async () => {
  mockGuestApi();
  renderAtRoot("/");
  await screen.findByRole("heading", { level: 1, name: "Cuộc thi" });

  const main = document.getElementById("main-content") as HTMLElement;
  const headerNav = screen.getByRole("navigation", { name: "Điều hướng chính" });

  fireEvent.click(within(headerNav).getByRole("link", { name: "Giới thiệu" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Giới thiệu" })).toBeTruthy();
  expect(document.activeElement).toBe(main);

  fireEvent.click(within(headerNav).getByRole("link", { name: "Hỗ trợ" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Hỗ trợ & Liên hệ" })).toBeTruthy();
  expect(document.activeElement).toBe(main);
});

test("drawer có hai mục tĩnh mới và vẫn để Đăng nhập là mục cuối", async () => {
  mockGuestApi();
  renderAtRoot("/");
  await screen.findByRole("heading", { level: 1, name: "Cuộc thi" });

  const { drawer } = await openDrawer();
  expect(within(drawerNav()).getByRole("link", { name: "Giới thiệu" })).toHaveAttribute(
    "href",
    "/gioi-thieu",
  );
  expect(within(drawerNav()).getByRole("link", { name: "Hỗ trợ" })).toHaveAttribute("href", "/ho-tro");

  // Thứ tự này giữ "Đăng nhập" là link cuối trong drawer - điều kiện của focus trap.
  expect(within(drawer).getAllByRole("link").map((link) => link.textContent)).toEqual([
    "Cuộc thi",
    "Giới thiệu",
    "Hỗ trợ",
    "Đăng nhập",
  ]);
});

test("đường dẫn con của trang tĩnh vẫn vào 404", async () => {
  mockGuestApi();
  renderAt("/ho-tro/khong-co");
  expect(await screen.findByRole("heading", { name: "404 - Không tìm thấy trang" })).toBeTruthy();
});
