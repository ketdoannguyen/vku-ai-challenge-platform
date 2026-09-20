/** Dashboard: render competitions từ API, join states, empty state, error state. */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { DashboardPage } from "./DashboardPage";

const PUBLISHED = {
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
  membership: { active: false, joined_at: null },
};

const JOINED = {
  ...PUBLISHED,
  id: "2",
  slug: "joined-cup",
  name: "Joined Cup",
  membership: { active: true, joined_at: "2026-09-15T00:00:00Z" },
};

const CLOSED = { ...PUBLISHED, id: "3", slug: "old-cup", name: "Old Cup", status: "closed" };

const ACCOUNT = { id: "9", email: "thi.sinh@vku.vn", name: "Thí sinh", role: "participant", active: true };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * fetch giả: `/auth/me` trả phiên (401 khi `account` null = khách), `/competitions` trả danh sách.
 * DashboardPage nằm trong AuthProvider nên phải giả lập cả hai tuyến.
 */
function mockApi({
  competitions = [],
  loadStatus = 200,
  account = ACCOUNT as typeof ACCOUNT | null,
}: { competitions?: unknown[]; loadStatus?: number; account?: typeof ACCOUNT | null } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/auth/me")) {
      return account ? json(account) : json({ error: { code: "UNAUTHORIZED", message: "Chưa đăng nhập." } }, 401);
    }
    return loadStatus === 200
      ? json({ competitions })
      : json({ error: { code: "UNAUTHORIZED", message: "Chưa đăng nhập." } }, loadStatus);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <DashboardPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Mốc ISO cách hiện tại `seconds` giây - clock chạy bằng timer thật trong test này. */
function inSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("hiển thị competition với status badge; chưa join có nút Tham gia, đã join có link vào", async () => {
  mockApi({ competitions: [PUBLISHED, JOINED, CLOSED] });
  renderDashboard();
  expect(await screen.findByRole("heading", { name: "AI Challenge 2026" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Joined Cup" })).toBeTruthy();
  // Nhãn trạng thái §2.2: chip trên thẻ (2 cuộc published) + tab lọc + ô thống kê
  expect(screen.getAllByText("Đang diễn ra").length).toBe(4); // 2 chip + 1 tab + 1 thống kê
  expect(screen.getAllByText("Đã kết thúc").length).toBe(3); // 1 chip + 1 tab + 1 thống kê
  // PUBLISHED chưa join → nút Tham gia
  expect(screen.getByRole("button", { name: "Tham gia" })).toBeTruthy();
  // JOINED → link Vào cuộc thi đúng slug
  const enter = screen.getByRole("link", { name: "Vào cuộc thi" });
  expect(enter.getAttribute("href")).toBe("/competitions/joined-cup");
  // CLOSED → không có nút join, chỉ thông báo kết thúc
  expect(screen.getByText(/Cuộc thi đã kết thúc/)).toBeTruthy();
});

test("empty state khi không có competition", async () => {
  mockApi();
  renderDashboard();
  await waitFor(() => screen.getByText("Chưa có cuộc thi nào"));
  expect(screen.queryByRole("link", { name: "Vào cuộc thi" })).toBeNull();
  // Không có gì để liệt kê thì cũng không có tiêu đề khối lẫn số lượng.
  expect(screen.queryByRole("heading", { name: "Danh sách cuộc thi" })).toBeNull();
});

test("danh sách có tiêu đề khối kèm số lượng, tiêu đề thẻ nằm dưới nó", async () => {
  mockApi({ competitions: [PUBLISHED, JOINED, CLOSED] });
  renderDashboard();
  await screen.findByRole("heading", { name: "AI Challenge 2026", level: 3 });
  expect(screen.getByRole("heading", { name: "Danh sách cuộc thi", level: 2 })).toBeTruthy();
  expect(screen.getByText("Hiển thị 3 cuộc thi")).toBeTruthy();
});

test("bộ lọc không khớp: báo không tìm thấy, khác hẳn khi chưa có cuộc thi nào", async () => {
  mockApi({ competitions: [PUBLISHED, CLOSED] });
  const user = userEvent.setup();
  renderDashboard();
  await screen.findByRole("heading", { name: "AI Challenge 2026", level: 3 });

  await user.type(screen.getByLabelText("Tìm kiếm cuộc thi"), "khong-ton-tai");

  expect(
    await screen.findByRole("heading", { name: "Không tìm thấy cuộc thi phù hợp" }),
  ).toBeTruthy();
  expect(screen.queryByText("Chưa có cuộc thi nào")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Danh sách cuộc thi" })).toBeNull();
});

test("lỗi API hiện error box, không crash", async () => {
  mockApi({ loadStatus: 401 });
  renderDashboard();
  await waitFor(() => screen.getByRole("alert"));
  expect(screen.getByText("Chưa đăng nhập.")).toBeTruthy();
});

test("lỗi API không lộ mã lỗi thô ra giao diện", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/me")) return json(ACCOUNT);
      return json({ error: { code: "INTERNAL_ERROR", message: "Máy chủ gặp sự cố." } }, 500);
    }),
  );
  renderDashboard();

  expect(await screen.findByText("Máy chủ gặp sự cố.")).toBeTruthy();
  expect(screen.queryByText("INTERNAL_ERROR")).toBeNull();
});

test("khách: ẩn ô thống kê 'Đã tham gia', thẻ mời đăng nhập thay vì nút Tham gia", async () => {
  // Backend trả membership rỗng cho khách nên không có thẻ nào ở trạng thái "đã tham gia".
  mockApi({ competitions: [PUBLISHED, CLOSED], account: null });
  renderDashboard();
  expect(await screen.findByRole("heading", { name: "AI Challenge 2026" })).toBeTruthy();
  expect(screen.queryByText("Đã tham gia")).toBeNull();
  expect(screen.queryByRole("button", { name: "Tham gia" })).toBeNull();
  // PUBLISHED mời đăng nhập; CLOSED vẫn chỉ báo đã kết thúc (đăng nhập không mở được).
  expect(screen.getAllByRole("link", { name: "Đăng nhập để tham gia" }).length).toBe(1);
  expect(screen.getByText(/Cuộc thi đã kết thúc/)).toBeTruthy();
});

test("thẻ đã tham gia chỉ mời vào cuộc thi, không có nút rời ngay trên danh sách", async () => {
  mockApi({ competitions: [PUBLISHED, JOINED, CLOSED] });
  renderDashboard();
  await screen.findByRole("heading", { name: "Joined Cup", level: 3 });

  // Lối vào cuộc thi vẫn còn nguyên trên thẻ.
  expect(screen.getByRole("link", { name: "Vào cuộc thi" }).getAttribute("href")).toBe(
    "/competitions/joined-cup",
  );
  // Rời cuộc thi là thao tác ở trang chi tiết, không đặt trong danh sách.
  expect(screen.queryByRole("button", { name: "Rời cuộc thi" })).toBeNull();
});

test("mọi thẻ đang mở dùng chung clock của trang: nhãn cùng nhảy theo giây", async () => {
  mockApi({
    competitions: [
      { ...PUBLISHED, id: "a", slug: "a", name: "Cuộc thi A", end_at: inSeconds(65) },
      { ...PUBLISHED, id: "b", slug: "b", name: "Cuộc thi B", end_at: inSeconds(125) },
    ],
  });
  renderDashboard();

  // Cả hai thẻ đều nhận mốc giờ từ clock cấp trang, không thẻ nào tự đếm riêng.
  const before = (await screen.findAllByText(/^còn \d{2}:\d{2}:\d{2}$/)).map((el) => el.textContent);
  expect(before).toHaveLength(2);

  // Số timer thật của clock (đúng một timer cho cả trang) được khẳng định ở useCountdown.test.tsx.
  await waitFor(
    () => {
      const after = screen.getAllByText(/^còn /).map((el) => el.textContent);
      expect(after).not.toEqual(before);
    },
    { timeout: 3000 },
  );
});

test("hết hạn: thẻ vẫn hiện nhưng không còn chip đếm ngược", async () => {
  mockApi({ competitions: [{ ...PUBLISHED, id: "c", slug: "c", name: "Cuộc thi C", end_at: "2026-09-01T00:00:00Z" }] });
  renderDashboard();
  expect(await screen.findByRole("heading", { name: "Cuộc thi C" })).toBeTruthy();
  expect(screen.queryByText(/còn /)).toBeNull();
});

test("hết hạn: badge đổi sang Đã kết thúc dù backend vẫn giữ status published", async () => {
  mockApi({
    competitions: [
      { ...PUBLISHED, id: "expired", slug: "expired", name: "Quá hạn", end_at: inSeconds(-60) },
      { ...PUBLISHED, id: "open", slug: "open", name: "Còn hạn", end_at: inSeconds(3600) },
    ],
  });
  renderDashboard();
  const expiredCard = (await screen.findByRole("heading", { name: "Quá hạn" })).closest("article")!;
  const openCard = screen.getByRole("heading", { name: "Còn hạn" }).closest("article")!;
  expect(within(expiredCard).getByText("Đã kết thúc")).toBeTruthy();
  expect(within(expiredCard).queryByText("Đang diễn ra")).toBeNull();
  expect(within(openCard).getByText("Đang diễn ra")).toBeTruthy();
});

/** Sinh n competition khác nhau về id/slug/tên; giữ nguyên hình dạng dữ liệu API. */
function makeMany(count: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, i) => ({
    ...PUBLISHED,
    id: String(i + 1),
    slug: `cuoc-thi-${i + 1}`,
    name: `Cuộc thi ${i + 1}`,
    ...overrides,
  }));
}

/** Theme đang render của từng card, theo đúng thứ tự DOM. */
function renderedThemes(articles: HTMLElement[]) {
  return articles.map((el) => el.getAttribute("data-theme"));
}

function renderedCompetitionNames() {
  return screen
    .getAllByRole("article")
    .map((article) => within(article).getByRole("heading", { level: 3 }).textContent);
}

test("mặc định sắp tên A–Z theo số tự nhiên", async () => {
  mockApi({
    competitions: [
      { ...PUBLISHED, id: "10", slug: "cup-10", name: "Cuộc thi 10" },
      { ...PUBLISHED, id: "2", slug: "cup-2", name: "Cuộc thi 2" },
      { ...PUBLISHED, id: "1", slug: "cup-1", name: "Cuộc thi 1" },
    ],
  });
  renderDashboard();
  await screen.findAllByRole("article");

  expect(renderedCompetitionNames()).toEqual(["Cuộc thi 1", "Cuộc thi 2", "Cuộc thi 10"]);
});

test("dropdown sắp cuộc thi hot theo tổng lượt nộp và fallback A–Z", async () => {
  mockApi({
    competitions: [
      { ...PUBLISHED, id: "a", slug: "alpha", name: "Alpha", submission_count: 2 },
      { ...PUBLISHED, id: "b", slug: "beta", name: "Beta", submission_count: 7 },
      { ...PUBLISHED, id: "c", slug: "charlie", name: "Charlie", submission_count: 7 },
      { ...PUBLISHED, id: "d", slug: "delta", name: "Delta" },
    ],
  });
  const user = userEvent.setup();
  renderDashboard();
  await screen.findAllByRole("article");

  const trigger = screen.getByRole("button", { name: "Lọc và sắp xếp cuộc thi" });
  await user.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Lọc và sắp xếp cuộc thi" });
  await user.click(within(dialog).getByLabelText("Nhiều lượt nộp nhất"));

  expect(renderedCompetitionNames()).toEqual(["Beta", "Charlie", "Alpha", "Delta"]);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
});

test("sắp kết thúc ưu tiên cuộc thi đang mở gần hạn, rồi cuộc thi đã đóng gần đây", async () => {
  mockApi({
    competitions: [
      { ...PUBLISHED, id: "far", slug: "far", name: "Mở xa", end_at: "2026-12-01T00:00:00Z" },
      { ...PUBLISHED, id: "near", slug: "near", name: "Mở gần", end_at: "2026-10-01T00:00:00Z" },
      { ...PUBLISHED, id: "invalid", slug: "invalid", name: "Mở thiếu hạn", end_at: "không-hợp-lệ" },
      { ...CLOSED, id: "old", slug: "closed-old", name: "Đóng cũ", end_at: "2026-07-01T00:00:00Z" },
      { ...CLOSED, id: "recent", slug: "closed-recent", name: "Đóng gần", end_at: "2026-09-01T00:00:00Z" },
    ],
  });
  const user = userEvent.setup();
  renderDashboard();
  await screen.findAllByRole("article");

  await user.click(screen.getByRole("button", { name: "Lọc và sắp xếp cuộc thi" }));
  await user.click(screen.getByLabelText("Sắp kết thúc"));

  expect(renderedCompetitionNames()).toEqual(["Mở gần", "Mở xa", "Mở thiếu hạn", "Đóng gần", "Đóng cũ"]);
});

test("lọc tham gia kết hợp độc lập với bộ lọc trạng thái", async () => {
  mockApi({
    competitions: [
      { ...PUBLISHED, id: "open-joined", slug: "open-joined", name: "Mở đã tham gia", membership: JOINED.membership },
      { ...PUBLISHED, id: "open-new", slug: "open-new", name: "Mở chưa tham gia" },
      { ...CLOSED, id: "closed-joined", slug: "closed-joined", name: "Đóng đã tham gia", membership: JOINED.membership },
    ],
  });
  const user = userEvent.setup();
  renderDashboard();
  await screen.findAllByRole("article");

  const trigger = screen.getByRole("button", { name: "Lọc và sắp xếp cuộc thi" });
  await user.click(trigger);
  await user.click(within(screen.getByRole("group", { name: "Tham gia" })).getByLabelText("Đã tham gia"));
  // Pill trạng thái nằm ngoài panel nên click vào đó đóng panel - mở lại khi cần đổi tiếp.
  await user.click(screen.getByRole("button", { name: "Đang diễn ra" }));

  expect(renderedCompetitionNames()).toEqual(["Mở đã tham gia"]);
  expect(screen.getByText("Hiển thị 1 cuộc thi")).toBeTruthy();

  await user.click(trigger);
  await user.click(within(screen.getByRole("group", { name: "Tham gia" })).getByLabelText("Chưa tham gia"));
  expect(renderedCompetitionNames()).toEqual(["Mở chưa tham gia"]);
});

test("khách thấy bộ lọc tham gia bị khóa nhưng vẫn sắp xếp được", async () => {
  mockApi({ competitions: [CLOSED, PUBLISHED], account: null });
  const user = userEvent.setup();
  renderDashboard();
  await screen.findAllByRole("article");

  await user.click(screen.getByRole("button", { name: "Lọc và sắp xếp cuộc thi" }));
  const participation = screen.getByRole("group", { name: "Tham gia" }) as HTMLFieldSetElement;
  expect(participation.disabled).toBe(true);
  expect(within(participation).getByLabelText("Đã tham gia")).toBeDisabled();
  expect(screen.getByText("Đăng nhập để lọc theo tham gia.")).toBeTruthy();
  // Nhóm khóa phải hiển thị đúng lựa chọn đang áp dụng, không phải state cũ của phiên trước.
  expect((within(participation).getByLabelText("Tất cả") as HTMLInputElement).checked).toBe(true);

  await user.click(screen.getByLabelText("Sắp kết thúc"));
  expect(renderedCompetitionNames()).toEqual(["AI Challenge 2026", "Old Cup"]);
});

test("dropdown đóng bằng Escape, click ngoài và trả focus đúng chỗ", async () => {
  mockApi({ competitions: [PUBLISHED] });
  const user = userEvent.setup();
  renderDashboard();
  await screen.findByRole("article");

  const trigger = screen.getByRole("button", { name: "Lọc và sắp xếp cuộc thi" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await user.click(trigger);
  expect(await screen.findByRole("dialog", { name: "Lọc và sắp xếp cuộc thi" })).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Lọc và sắp xếp cuộc thi" })).toBeNull();
  expect(document.activeElement).toBe(trigger);

  await user.click(trigger);
  await user.click(document.body);
  expect(screen.queryByRole("dialog", { name: "Lọc và sắp xếp cuộc thi" })).toBeNull();
});

test("màu card theo vị trí render: blue → red → yellow lặp lại, không thêm card lấp ô trống", async () => {
  mockApi({ competitions: makeMany(5) });
  renderDashboard();
  const cards = await screen.findAllByRole("article");
  // 5 cuộc thi thì đúng 5 card; ô thứ 6 của hàng hai để trống.
  expect(cards).toHaveLength(5);
  expect(renderedThemes(cards)).toEqual(["blue", "red", "yellow", "blue", "red"]);
});

test("màu card độc lập với status: cuộc thi đã kết thúc ở vị trí 1 vẫn đỏ, chỉ badge xám", async () => {
  mockApi({
    competitions: [
      { ...PUBLISHED, id: "a", slug: "alpha", name: "Alpha" },
      { ...CLOSED, id: "b", slug: "beta", name: "Beta" },
      { ...JOINED, id: "c", slug: "gamma", name: "Gamma" },
    ],
  });
  renderDashboard();
  const cards = await screen.findAllByRole("article");
  const ended = cards[1];

  expect(ended.getAttribute("data-theme")).toBe("red");
  expect(ended.getAttribute("data-status")).toBe("closed");
  // Root card không mang class trạng thái - màu không được lấy từ status.
  expect(ended.className).not.toContain("closed");

  // Badge bên trong vẫn giữ ngữ nghĩa trạng thái và nhãn chữ, không chỉ dựa vào màu.
  const badge = within(ended).getByText("Đã kết thúc");
  expect(badge.className).toContain("closed");
});

test("lọc còn một kết quả: card tính lại theme theo vị trí mới", async () => {
  mockApi({ competitions: [PUBLISHED, JOINED, CLOSED] });
  const user = userEvent.setup();
  renderDashboard();
  await screen.findAllByRole("article");

  // "Old Cup" đứng ở vị trí 2 (vàng) trước khi lọc.
  await user.type(screen.getByLabelText("Tìm kiếm cuộc thi"), "Old");

  const cards = await screen.findAllByRole("article");
  expect(cards).toHaveLength(1);
  expect(renderedThemes(cards)).toEqual(["blue"]);
  expect(screen.getByText("Hiển thị 1 cuộc thi")).toBeTruthy();
});

test("ô thống kê lấy từ dữ liệu thật, nằm trong vùng có tên", async () => {
  mockApi({ competitions: [PUBLISHED, JOINED, CLOSED] });
  renderDashboard();
  const stats = await screen.findByRole("region", { name: "Thống kê cuộc thi" });

  expect(within(stats).getByText("Đang diễn ra")).toBeTruthy();
  expect(within(stats).getByText("Đã kết thúc")).toBeTruthy();
  expect(within(stats).getByText("Đã tham gia")).toBeTruthy();
  // 2 published, 1 closed, 1 joined - vẫn pad hai chữ số như trước.
  expect(within(stats).getByText("02")).toBeTruthy();
  expect(within(stats).getAllByText("01")).toHaveLength(2);
});

test("khách: vùng thống kê bỏ ô Đã tham gia nhưng giữ hai ô còn lại", async () => {
  mockApi({ competitions: [PUBLISHED, CLOSED], account: null });
  renderDashboard();
  const stats = await screen.findByRole("region", { name: "Thống kê cuộc thi" });

  expect(within(stats).queryByText("Đã tham gia")).toBeNull();
  expect(within(stats).getByText("Đang diễn ra")).toBeTruthy();
  expect(within(stats).getByText("Đã kết thúc")).toBeTruthy();
});

test("outline tiêu đề: một h1, section là h2, tiêu đề thẻ là h3", async () => {
  mockApi({ competitions: [PUBLISHED] });
  renderDashboard();
  await screen.findByRole("heading", { name: "AI Challenge 2026", level: 3 });

  expect(screen.getByRole("heading", { name: "Cuộc thi", level: 1 })).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("heading", { name: "Danh sách cuộc thi", level: 2 })).toBeTruthy();
});

test("trạng thái rỗng không sinh card competition nào", async () => {
  mockApi();
  renderDashboard();
  await screen.findByText("Chưa có cuộc thi nào");
  expect(screen.queryAllByRole("article")).toHaveLength(0);
});

test("tiêu đề tab đặt theo tên trang", async () => {
  mockApi({ competitions: [PUBLISHED] });
  renderDashboard();
  await screen.findByRole("link", { name: "AI Challenge 2026" });
  expect(document.title).toBe("Cuộc thi - AI Challenge");
});
