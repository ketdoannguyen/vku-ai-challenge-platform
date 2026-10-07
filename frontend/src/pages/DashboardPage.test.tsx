/** Dashboard: render competitions từ API, join states, empty state, error state. */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { AuthProvider, useOptionalAuth } from "../auth/AuthContext";
import { setDocumentHidden } from "../test/timers";
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
  vi.useRealTimers();
  setDocumentHidden(false);
});

/** Chạy hết timer giả trong `ms` và để chuỗi fetch → setState render xong. */
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
}

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

test("mặc định sắp theo bài của tôi: giảm dần, hòa rơi về tên A–Z kiểu số tự nhiên", async () => {
  mockApi({
    competitions: [
      { ...PUBLISHED, id: "10", slug: "cup-10", name: "Cuộc thi 10", my_submission_count: 9 },
      { ...PUBLISHED, id: "2", slug: "cup-2", name: "Cuộc thi 2", my_submission_count: 7 },
      { ...PUBLISHED, id: "1", slug: "cup-1", name: "Cuộc thi 1", my_submission_count: 7 },
    ],
  });
  renderDashboard();
  await screen.findAllByRole("article");

  // 9 > 7 = 7: cuộc thi 10 lên đầu dù tên đứng cuối A–Z; hai cuộc cùng 7 hòa thì theo tên
  // kiểu số tự nhiên (1 trước 2).
  expect(renderedCompetitionNames()).toEqual(["Cuộc thi 10", "Cuộc thi 1", "Cuộc thi 2"]);
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
  // Danh sách chỉ được gọi sau khi auth xác nhận phiên - chờ dữ liệu về rồi mới đọc số.
  await screen.findByRole("heading", { name: "Joined Cup", level: 3 });
  const stats = screen.getByRole("region", { name: "Thống kê cuộc thi" });

  expect(within(stats).getByText("Đang diễn ra")).toBeTruthy();
  expect(within(stats).getByText("Đã kết thúc")).toBeTruthy();
  expect(within(stats).getByText("Đã tham gia")).toBeTruthy();
  // 2 published, 1 closed, 1 joined - hiển thị số nguyên, không pad như trước.
  expect(within(stats).getByText("2")).toBeTruthy();
  expect(within(stats).getAllByText("1")).toHaveLength(2);
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

test("tự làm mới giữ nguyên từ khóa tìm kiếm và cập nhật KPI khi có cuộc thi mới", async () => {
  vi.useFakeTimers();
  const competitions = [PUBLISHED, JOINED];
  mockApi({ competitions });
  renderDashboard();
  await advance();

  const stats = screen.getByRole("region", { name: "Thống kê cuộc thi" });
  expect(within(stats).getByText("1")).toBeTruthy(); // Đã tham gia
  fireEvent.change(screen.getByLabelText("Tìm kiếm cuộc thi"), { target: { value: "AI" } });

  competitions.push({
    ...PUBLISHED,
    id: "new",
    slug: "new-cup",
    name: "AI Challenge Mới",
    membership: { active: true, joined_at: "2026-10-01T00:00:00Z" },
  });
  await advance(6_000);

  expect(screen.getByRole("heading", { name: "AI Challenge Mới" })).toBeTruthy();
  // Dữ liệu được thay nhưng bộ lọc tìm kiếm của người dùng còn nguyên.
  expect((screen.getByLabelText("Tìm kiếm cuộc thi") as HTMLInputElement).value).toBe("AI");
  expect(within(stats).getByText("2")).toBeTruthy(); // Đã tham gia
});

test("một cuộc thi tham gia không làm bật polling khi cuộc thi khác còn modal mở", async () => {
  vi.useFakeTimers();
  const competitions = [
    { ...PUBLISHED, id: "3", slug: "new-cup", name: "New Cup", membership: { active: false, joined_at: null as string | null } },
    { ...PUBLISHED, id: "4", slug: "code-cup", name: "Code Cup", join_mode: "code", membership: { active: false, joined_at: null as string | null } },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/me")) return json(ACCOUNT);
    if (init?.method === "POST" && url.endsWith("/join")) {
      competitions[0] = { ...competitions[0], membership: { active: true, joined_at: "2026-10-01T00:00:00Z" } };
      return json({ competition_id: "3", membership: competitions[0].membership, joined_now: true });
    }
    return json({ competitions });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderDashboard();
  await advance();
  const listGets = () => fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/competitions")).length;
  expect(listGets()).toBe(1);

  // Chuyển trạng thái thẻ A trong khi modal thẻ B đang mở; B vẫn giữ polling tạm dừng.
  fireEvent.click(screen.getByRole("button", { name: "Nhập mã tham gia" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Tham gia" })[0]);
  await advance();
  await advance(10_000);
  expect(listGets()).toBe(1);
});

test("trong lúc join thì tạm dừng tự làm mới; join xong thì dữ liệu thành viên được làm mới theo", async () => {
  vi.useFakeTimers();
  const competitions = [{ ...PUBLISHED, membership: { active: false, joined_at: null as string | null } }];
  let resolveJoin!: (response: Response) => void;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/me")) return json(ACCOUNT);
    if (init?.method === "POST" && url.endsWith("/join")) {
      return new Promise<Response>((resolve) => {
        resolveJoin = resolve;
      });
    }
    return json({ competitions });
  });
  vi.stubGlobal("fetch", fetchMock);
  const listGets = () =>
    fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/competitions")).length;

  renderDashboard();
  await advance();
  expect(listGets()).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Tham gia" }));
  await advance(20_000);
  // POST tham gia còn đang chờ: không có lượt làm mới nào chen vào.
  expect(listGets()).toBe(1);

  // Máy chủ ghi nhận thành viên trước khi trả response.
  competitions[0].membership = { active: true, joined_at: "2026-10-01T00:00:00Z" };
  resolveJoin(json({ competition_id: "1", membership: competitions[0].membership, joined_now: true }));
  await advance();
  expect(screen.queryByRole("button", { name: "Tham gia" })).toBeNull();
  expect(screen.getByRole("link", { name: "Vào cuộc thi" })).toBeTruthy();

  // Lượt làm mới kế tiếp trả về membership mới, không quay lại trạng thái chưa tham gia.
  await advance(6_000);
  expect(listGets()).toBe(2);
  expect(screen.getByRole("link", { name: "Vào cuộc thi" })).toBeTruthy();
});

/** Số liệu cá nhân backend tính sẵn trong `my_stats` của response danh sách. */
const MY_STATS = {
  rank: 2,
  rank_total: 3,
  best_score: 0.9123,
  best_normalized_score: null,
  used_today: 2,
};

function cardOf(name: string): HTMLElement {
  return screen.getByRole("heading", { name, level: 3 }).closest("article")!;
}

test("thẻ đã tham gia hiện hạng, điểm cao nhất và lượt nộp hôm nay", async () => {
  mockApi({ competitions: [{ ...JOINED, my_stats: MY_STATS }] });
  renderDashboard();
  await screen.findByRole("heading", { name: "Joined Cup", level: 3 });
  const card = cardOf("Joined Cup");

  expect(within(card).getByText("Hạng hiện tại")).toBeTruthy();
  expect(within(card).getByText("#2/3")).toBeTruthy();
  expect(within(card).getByText("0.91")).toBeTruthy();
  expect(within(card).getByText("2 lượt")).toBeTruthy();
});

test("điểm cao nhất làm tròn 2 chữ số thập phân", async () => {
  mockApi({
    competitions: [{ ...JOINED, my_stats: { ...MY_STATS, best_score: 0.9167 } }],
  });
  renderDashboard();
  await screen.findByRole("heading", { name: "Joined Cup", level: 3 });
  const card = cardOf("Joined Cup");

  expect(within(card).getByText("0.92")).toBeTruthy();
});

test("cuộc thi bật norm: thẻ hiện 'Điểm chuẩn hóa' lấy từ my_stats, không hiện điểm gốc", async () => {
  mockApi({
    competitions: [
      {
        ...JOINED,
        normalization: { enabled: true, baseline: 0.5, version: 1 },
        my_stats: { ...MY_STATS, best_normalized_score: 34.56 },
      },
    ],
  });
  renderDashboard();
  await screen.findByRole("heading", { name: "Joined Cup", level: 3 });
  const card = cardOf("Joined Cup");

  expect(within(card).getByText("Điểm chuẩn hóa")).toBeTruthy();
  expect(within(card).getByText("34.56")).toBeTruthy();
  expect(within(card).queryByText("0.91")).toBeNull();
});

test("norm bị ẩn nhưng điểm gốc còn: thẻ để '-', không gắn nhãn 'Điểm chuẩn hóa' cho raw", async () => {
  mockApi({
    competitions: [
      {
        ...JOINED,
        normalization: { enabled: true, baseline: 0.5, version: 1 },
        my_stats: { ...MY_STATS, best_normalized_score: null },
      },
    ],
  });
  renderDashboard();
  await screen.findByRole("heading", { name: "Joined Cup", level: 3 });
  const card = cardOf("Joined Cup");

  expect(within(card).getByText("Điểm chuẩn hóa")).toBeTruthy();
  expect(within(card).getByText("-")).toBeTruthy();
  expect(within(card).queryByText("0.91")).toBeNull();
});

test("chưa tham gia: hàng số liệu vẫn hiện với ba dấu '-'", async () => {
  mockApi({ competitions: [PUBLISHED] });
  renderDashboard();
  await screen.findByRole("heading", { name: "AI Challenge 2026", level: 3 });
  const card = cardOf("AI Challenge 2026");

  expect(within(card).getByText("Hạng hiện tại")).toBeTruthy();
  expect(within(card).getByText("Đã nộp hôm nay")).toBeTruthy();
  expect(within(card).getAllByText("-")).toHaveLength(3);
});

test("khách: hàng số liệu hiện '-' vì backend không trả số liệu cá nhân", async () => {
  mockApi({ competitions: [PUBLISHED], account: null });
  renderDashboard();
  await screen.findByRole("heading", { name: "AI Challenge 2026", level: 3 });
  const card = cardOf("AI Challenge 2026");

  expect(within(card).getAllByText("-")).toHaveLength(3);
});

test("thành viên chưa có bài hợp lệ: hạng và điểm '-', lượt hôm nay là 0", async () => {
  mockApi({
    competitions: [
      { ...JOINED, my_stats: { rank: null, rank_total: null, best_score: null, used_today: 0 } },
    ],
  });
  renderDashboard();
  await screen.findByRole("heading", { name: "Joined Cup", level: 3 });
  const card = cardOf("Joined Cup");

  expect(within(card).getAllByText("-")).toHaveLength(2);
  expect(within(card).getByText("0 lượt")).toBeTruthy();
});

test("bảng xếp hạng ẩn: hạng và điểm '-', vẫn hiện lượt đã nộp hôm nay", async () => {
  mockApi({
    competitions: [
      {
        ...JOINED,
        leaderboard_visible: false,
        my_stats: { rank: null, rank_total: null, best_score: null, used_today: 1 },
      },
    ],
  });
  renderDashboard();
  await screen.findByRole("heading", { name: "Joined Cup", level: 3 });
  const card = cardOf("Joined Cup");

  expect(within(card).getAllByText("-")).toHaveLength(2);
  expect(within(card).getByText("1 lượt")).toBeTruthy();
});

test("sau khi tham gia: số liệu tạm '-', lượt làm mới kế tiếp điền hạng/điểm/lượt", async () => {
  vi.useFakeTimers();
  const competitions = [{ ...PUBLISHED, membership: { active: false, joined_at: null as string | null } }];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/me")) return json(ACCOUNT);
    if (init?.method === "POST" && url.endsWith("/join")) {
      competitions[0] = {
        ...competitions[0],
        membership: { active: true, joined_at: "2026-10-01T00:00:00Z" },
        my_stats: { rank: 1, rank_total: 4, best_score: 0.5, used_today: 0 },
      } as (typeof competitions)[number];
      return json({ competition_id: "1", membership: competitions[0].membership, joined_now: true });
    }
    return json({ competitions });
  });
  vi.stubGlobal("fetch", fetchMock);

  renderDashboard();
  await advance();
  const card = cardOf("AI Challenge 2026");
  expect(within(card).getAllByText("-")).toHaveLength(3);

  fireEvent.click(screen.getByRole("button", { name: "Tham gia" }));
  await advance();
  // Join xong nhưng số liệu chưa về: hiện "-" chứ không bịa hạng/điểm.
  expect(screen.getByRole("link", { name: "Vào cuộc thi" })).toBeTruthy();
  expect(within(card).getAllByText("-")).toHaveLength(3);

  await advance(6_000);
  expect(within(card).getByText("#1/4")).toBeTruthy();
  expect(within(card).getByText("0.50")).toBeTruthy();
  expect(within(card).getByText("0 lượt")).toBeTruthy();
  // Số liệu đến từ payload danh sách: không thẻ nào tự gọi bảng xếp hạng.
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/leaderboard"))).toBe(false);
});

test("sắp theo bài của tôi: giảm dần theo my_submission_count, hòa thì A–Z", async () => {
  mockApi({
    competitions: [
      { ...PUBLISHED, id: "a", slug: "alpha", name: "Alpha", my_submission_count: 3 },
      { ...PUBLISHED, id: "b", slug: "beta", name: "Beta", my_submission_count: 9 },
      { ...PUBLISHED, id: "c", slug: "charlie", name: "Charlie", my_submission_count: 9 },
      // Response cũ thiếu field - coi như 0, không đẩy lên trước.
      { ...PUBLISHED, id: "d", slug: "delta", name: "Delta" },
    ],
  });
  const user = userEvent.setup();
  renderDashboard();
  await screen.findAllByRole("article");
  // Mặc định đã là kiểu này; đổi sang A–Z rồi chọn lại để chứng minh radio điều khiển thứ tự.
  await user.click(screen.getByRole("button", { name: "Lọc và sắp xếp cuộc thi" }));
  await user.click(screen.getByLabelText("Tên A–Z"));
  expect(renderedCompetitionNames()).toEqual(["Alpha", "Beta", "Charlie", "Delta"]);

  await user.click(screen.getByLabelText("Nhiều bài của tôi nhất"));

  expect(renderedCompetitionNames()).toEqual(["Beta", "Charlie", "Alpha", "Delta"]);
});

test("ghim đứng đầu dưới mọi kiểu sắp xếp, kể cả cuộc thi đã kết thúc", async () => {
  mockApi({
    competitions: [
      { ...PUBLISHED, id: "a", slug: "alpha", name: "Alpha", submission_count: 1 },
      { ...PUBLISHED, id: "b", slug: "beta", name: "Beta", submission_count: 9 },
      { ...CLOSED, id: "c", slug: "charlie", name: "Charlie", pinned: true },
    ],
  });
  const user = userEvent.setup();
  renderDashboard();
  await screen.findAllByRole("article");

  // Mặc định A–Z: ghim đứng trước dù tên xếp sau.
  expect(renderedCompetitionNames()).toEqual(["Charlie", "Alpha", "Beta"]);

  // Trong nhóm chưa ghim vẫn đúng thứ tự của kiểu sort đang chọn.
  await user.click(screen.getByRole("button", { name: "Lọc và sắp xếp cuộc thi" }));
  await user.click(screen.getByLabelText("Nhiều lượt nộp nhất"));
  expect(renderedCompetitionNames()).toEqual(["Charlie", "Beta", "Alpha"]);

  // Cuộc thi closed đang ghim vẫn trên published chưa ghim - quy tắc cố ý, badge vẫn rõ.
  await user.click(screen.getByLabelText("Sắp kết thúc"));
  expect(renderedCompetitionNames()).toEqual(["Charlie", "Alpha", "Beta"]);
});

test("lọc và tìm kiếm thắng ghim: cuộc thi bị loại không quay lại vì đang ghim", async () => {
  mockApi({
    competitions: [
      { ...PUBLISHED, id: "a", slug: "alpha", name: "Alpha", pinned: true },
      { ...CLOSED, id: "b", slug: "beta", name: "Beta" },
    ],
  });
  const user = userEvent.setup();
  renderDashboard();
  await screen.findAllByRole("article");
  expect(renderedCompetitionNames()).toEqual(["Alpha", "Beta"]);

  await user.click(screen.getByRole("button", { name: "Đã kết thúc" }));
  expect(renderedCompetitionNames()).toEqual(["Beta"]);

  await user.click(screen.getByRole("button", { name: "Tất cả" }));
  await user.type(screen.getByLabelText("Tìm kiếm cuộc thi"), "Beta");
  expect(renderedCompetitionNames()).toEqual(["Beta"]);
});

test("khách: radio 'Nhiều bài của tôi nhất' bị khóa kèm gợi ý, không có nút ghim", async () => {
  mockApi({ competitions: [PUBLISHED, JOINED], account: null });
  const user = userEvent.setup();
  renderDashboard();
  await screen.findAllByRole("article");

  expect(screen.queryByRole("button", { name: /ghim cuộc thi/i })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Lọc và sắp xếp cuộc thi" }));
  expect((screen.getByLabelText("Nhiều bài của tôi nhất") as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText("Đăng nhập để sắp xếp theo bài của bạn.")).toBeTruthy();
  // Kiểu sắp xếp đang hiệu lực vẫn là A–Z, không kẹt ở lựa chọn bị khóa.
  expect((screen.getByLabelText("Tên A–Z") as HTMLInputElement).checked).toBe(true);
});

/** fetch giả có tuyến ghim: PUT/DELETE trả `pinned` theo method, danh sách giữ nguyên. */
function mockPinApi(competitions: unknown[], { failPin = false } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/me")) return json(ACCOUNT);
    if (url.endsWith("/pin")) {
      if (failPin) {
        return json({ error: { code: "INTERNAL_ERROR", message: "Không ghim được." } }, 500);
      }
      return json({ competition_id: "2", pinned: init?.method === "PUT" });
    }
    return json({ competitions });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("ghim thành công: gọi PUT đúng slug, thẻ nhảy lên đầu và nhận màu theo vị trí mới", async () => {
  const fetchMock = mockPinApi([PUBLISHED, JOINED]);
  const user = userEvent.setup();
  renderDashboard();
  await screen.findAllByRole("article");
  expect(renderedCompetitionNames()).toEqual(["AI Challenge 2026", "Joined Cup"]);

  const pin = within(cardOf("Joined Cup")).getByRole("button", { name: "Ghim cuộc thi Joined Cup" });
  expect(pin.getAttribute("aria-pressed")).toBe("false");
  await user.click(pin);

  expect(renderedCompetitionNames()).toEqual(["Joined Cup", "AI Challenge 2026"]);
  expect(renderedThemes(screen.getAllByRole("article"))).toEqual(["blue", "red"]);
  const pinned = within(cardOf("Joined Cup")).getByRole("button", {
    name: "Bỏ ghim cuộc thi Joined Cup",
  });
  expect(pinned.getAttribute("aria-pressed")).toBe("true");
  // Thẻ đổi vị trí nhưng node được di chuyển nguyên vẹn - focus ở lại đúng nút vừa bấm.
  expect(document.activeElement).toBe(pinned);
  const pinCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/pin"));
  expect(pinCall?.[1]?.method).toBe("PUT");
});

test("bỏ ghim: gọi DELETE và thẻ trở về đúng thứ tự A–Z", async () => {
  const fetchMock = mockPinApi([{ ...JOINED, pinned: true }, PUBLISHED]);
  const user = userEvent.setup();
  renderDashboard();
  await screen.findAllByRole("article");
  expect(renderedCompetitionNames()).toEqual(["Joined Cup", "AI Challenge 2026"]);

  await user.click(
    within(cardOf("Joined Cup")).getByRole("button", { name: "Bỏ ghim cuộc thi Joined Cup" }),
  );

  expect(renderedCompetitionNames()).toEqual(["AI Challenge 2026", "Joined Cup"]);
  const pinCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/pin"));
  expect(pinCall?.[1]?.method).toBe("DELETE");
});

test("ghim thất bại: giữ nguyên thứ tự cũ và báo lỗi ngay tại thẻ", async () => {
  mockPinApi([PUBLISHED, JOINED], { failPin: true });
  const user = userEvent.setup();
  renderDashboard();
  await screen.findAllByRole("article");

  const card = cardOf("Joined Cup");
  await user.click(within(card).getByRole("button", { name: "Ghim cuộc thi Joined Cup" }));

  expect(renderedCompetitionNames()).toEqual(["AI Challenge 2026", "Joined Cup"]);
  const alert = await within(cardOf("Joined Cup")).findByRole("alert");
  expect(alert.textContent).toContain("Không ghim được.");
  expect(
    within(cardOf("Joined Cup"))
      .getByRole("button", { name: "Ghim cuộc thi Joined Cup" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
});

test("trong lúc ghim: nút khóa, tự làm mới tạm dừng; xong thì polling chạy lại", async () => {
  vi.useFakeTimers();
  let resolvePin!: (response: Response) => void;
  const competitions = [PUBLISHED, JOINED];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/me")) return json(ACCOUNT);
    if (url.endsWith("/pin")) {
      return new Promise<Response>((resolve) => {
        resolvePin = resolve;
      });
    }
    return json({ competitions });
  });
  vi.stubGlobal("fetch", fetchMock);
  const listGets = () =>
    fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/competitions")).length;

  renderDashboard();
  await advance();
  expect(listGets()).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Ghim cuộc thi Joined Cup" }));
  await advance();
  expect(screen.getByRole("button", { name: "Ghim cuộc thi Joined Cup" })).toBeDisabled();

  // PUT còn đang chờ: không lượt làm mới nào chen vào giữa.
  await advance(20_000);
  expect(listGets()).toBe(1);

  resolvePin(json({ competition_id: "2", pinned: true }));
  await advance();
  expect(renderedCompetitionNames()[0]).toBe("Joined Cup");

  // Ghim xong: polling chạy lại và lượt kế tiếp trả về trạng thái mới.
  await advance(6_000);
  expect(listGets()).toBe(2);
});

test("nhấn đúp nút ghim chỉ phát ra một request", async () => {
  vi.useFakeTimers();
  let resolvePin!: (response: Response) => void;
  const competitions = [PUBLISHED, JOINED];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/me")) return json(ACCOUNT);
    if (url.endsWith("/pin")) {
      return new Promise<Response>((resolve) => {
        resolvePin = resolve;
      });
    }
    return json({ competitions });
  });
  vi.stubGlobal("fetch", fetchMock);
  const pinCalls = () => fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/pin")).length;

  renderDashboard();
  await advance();

  const pin = screen.getByRole("button", { name: "Ghim cuộc thi Joined Cup" });
  fireEvent.click(pin);
  fireEvent.click(pin);
  await advance();
  expect(pinCalls()).toBe(1);

  resolvePin(json({ competition_id: "2", pinned: true }));
  await advance();
});

test("GET đang bay kết thúc sau PUT không đảo ngược trạng thái ghim", async () => {
  vi.useFakeTimers();
  let resolveList!: (response: Response) => void;
  let listCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/me")) return json(ACCOUNT);
    if (url.endsWith("/pin")) return json({ competition_id: "2", pinned: init?.method === "PUT" });
    listCalls += 1;
    if (listCalls === 1) return json({ competitions: [PUBLISHED, JOINED] });
    // Lượt polling thứ hai cố tình treo lại để nhấn ghim xong mới trả về dữ liệu cũ.
    return new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  renderDashboard();
  await advance();
  await advance(5_000);
  expect(listCalls).toBe(2);

  fireEvent.click(screen.getByRole("button", { name: "Ghim cuộc thi Joined Cup" }));
  await advance();
  expect(renderedCompetitionNames()[0]).toBe("Joined Cup");

  resolveList(json({ competitions: [PUBLISHED, JOINED] }));
  await advance();
  expect(renderedCompetitionNames()[0]).toBe("Joined Cup");
  expect(screen.getByRole("button", { name: "Bỏ ghim cuộc thi Joined Cup" })).toBeTruthy();
});

test("ghim trong lúc modal tham gia đang mở không mở khóa tự làm mới", async () => {
  vi.useFakeTimers();
  const competitions = [
    { ...PUBLISHED, id: "3", slug: "new-cup", name: "New Cup" },
    { ...PUBLISHED, id: "4", slug: "code-cup", name: "Code Cup", join_mode: "code" },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/me")) return json(ACCOUNT);
    if (url.endsWith("/pin")) return json({ competition_id: "3", pinned: init?.method === "PUT" });
    return json({ competitions });
  });
  vi.stubGlobal("fetch", fetchMock);
  const listGets = () =>
    fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/competitions")).length;

  renderDashboard();
  await advance();
  expect(listGets()).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Nhập mã tham gia" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Ghim cuộc thi New Cup" }));
  await advance();
  await advance(10_000);
  // Modal vẫn mở nên polling vẫn tạm dừng, dù lượt ghim đã xong.
  expect(listGets()).toBe(1);
});

/** Nút đổi phiên cho test danh tính - DashboardPage không có nút đăng nhập/đăng xuất. */
function IdentityControls() {
  const auth = useOptionalAuth();
  if (!auth) return null;
  return (
    <>
      <button type="button" onClick={() => void auth.logout()}>
        Đăng xuất
      </button>
      <button type="button" onClick={() => void auth.login("b@vku.vn", "matkhau")}>
        Đăng nhập B
      </button>
    </>
  );
}

test("đổi danh tính A → guest → B: không render dữ liệu phiên trước, sort cá nhân về A–Z", async () => {
  const accountA = { ...ACCOUNT, id: "9", name: "Thí sinh A" };
  const accountB = { ...ACCOUNT, id: "10", email: "b@vku.vn", name: "Thí sinh B" };
  // Số liệu cá nhân là dấu vết phiên: hạng của A/B khác nhau để test bắt được dữ liệu cũ rò rỉ.
  const joinedPublished = {
    ...PUBLISHED,
    membership: { active: true, joined_at: "2026-10-01T00:00:00Z" },
  };
  const STATS_A = { rank: 2, rank_total: 3, best_score: 0.9123, used_today: 2 };
  const STATS_B = { rank: 4, rank_total: 4, best_score: 0.5, used_today: 0 };
  let session: "A" | "guest" | "B" = "A";
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/me")) {
      if (session === "guest") {
        return json({ error: { code: "UNAUTHORIZED", message: "Chưa đăng nhập." } }, 401);
      }
      return json(session === "A" ? accountA : accountB);
    }
    if (url.endsWith("/auth/logout")) {
      session = "guest";
      return json({});
    }
    if (url.endsWith("/auth/login")) {
      session = "B";
      return json(accountB);
    }
    return json({
      competitions: [
        session === "A"
          ? { ...joinedPublished, my_stats: STATS_A, pinned: true }
          : session === "B"
            ? { ...joinedPublished, my_stats: STATS_B }
            : PUBLISHED,
      ],
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <AuthProvider>
        <IdentityControls />
        <DashboardPage />
      </AuthProvider>
    </MemoryRouter>,
  );

  // Phiên A: số liệu và cờ ghim của A hiển thị; chọn luôn sort cá nhân.
  await screen.findByText("#2/3");
  expect(
    screen.getByRole("button", { name: "Bỏ ghim cuộc thi AI Challenge 2026" }).getAttribute("aria-pressed"),
  ).toBe("true");
  await user.click(screen.getByRole("button", { name: "Lọc và sắp xếp cuộc thi" }));
  await user.click(screen.getByLabelText("Nhiều bài của tôi nhất"));
  await user.keyboard("{Escape}");

  await user.click(screen.getByRole("button", { name: "Đăng xuất" }));
  // Danh tính đổi: dữ liệu của A không được render thêm lần nào, nút ghim biến mất.
  await waitFor(() => expect(screen.queryByText("#2/3")).toBeNull());
  await waitFor(() =>
    expect(within(cardOf("AI Challenge 2026")).getAllByText("-")).toHaveLength(3),
  );
  expect(screen.queryByRole("button", { name: /ghim cuộc thi/i })).toBeNull();

  // Sort cá nhân không còn hiệu lực: hiển thị và áp dụng lại A–Z.
  await user.click(screen.getByRole("button", { name: "Lọc và sắp xếp cuộc thi" }));
  expect((screen.getByLabelText("Nhiều bài của tôi nhất") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText("Tên A–Z") as HTMLInputElement).checked).toBe(true);
  await user.keyboard("{Escape}");

  // Phiên B: chỉ số liệu của B, không hồi tưởng dữ liệu A.
  await user.click(screen.getByRole("button", { name: "Đăng nhập B" }));
  await screen.findByText("#4/4");
  expect(screen.queryByText("#2/3")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Ghim cuộc thi AI Challenge 2026" }).getAttribute("aria-pressed"),
  ).toBe("false");
});

/** fetch giả cho hai test đổi phiên giữa chừng lượt ghim: A đăng nhập, logout thành khách,
 *  PUT `/pin` và lượt nạp của khách đều treo để test tự quyết thứ tự kết thúc. */
function mockPinLogoutApi() {
  let session: "A" | "guest" = "A";
  let resolvePin!: (response: Response) => void;
  let resolveGuestList!: (response: Response) => void;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/me")) {
      if (session === "guest") {
        return json({ error: { code: "UNAUTHORIZED", message: "Chưa đăng nhập." } }, 401);
      }
      return json(ACCOUNT);
    }
    if (url.endsWith("/auth/logout")) {
      session = "guest";
      return json({});
    }
    if (url.endsWith("/pin")) {
      return new Promise<Response>((resolve) => {
        resolvePin = resolve;
      });
    }
    if (session === "guest") {
      return new Promise<Response>((resolve) => {
        resolveGuestList = resolve;
      });
    }
    return json({ competitions: [PUBLISHED, JOINED] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    resolvePin: (response: Response) => resolvePin(response),
    resolveGuestList: (response: Response) => resolveGuestList(response),
  };
}

function renderWithIdentityControls() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <IdentityControls />
        <DashboardPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

test("đăng xuất trong lúc ghim đang chờ: kết quả ghim không vá vào dữ liệu phiên mới", async () => {
  vi.useFakeTimers();
  const pinApi = mockPinLogoutApi();
  renderWithIdentityControls();
  await advance();
  expect(renderedCompetitionNames()).toEqual(["AI Challenge 2026", "Joined Cup"]);

  fireEvent.click(screen.getByRole("button", { name: "Ghim cuộc thi Joined Cup" }));
  await advance();
  fireEvent.click(screen.getByRole("button", { name: "Đăng xuất" }));
  await advance();
  // Danh tính đổi: dữ liệu A bị chặn render, trang chờ lượt nạp của khách thay vì hiện thẻ cũ.
  expect(screen.getByRole("status")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /ghim cuộc thi/i })).toBeNull();

  pinApi.resolveGuestList(json({ competitions: [PUBLISHED, JOINED] }));
  await advance();
  expect(renderedCompetitionNames()).toEqual(["AI Challenge 2026", "Joined Cup"]);

  // PUT của phiên A kết thúc muộn: không được ghim "Joined Cup" lên đầu danh sách của khách.
  pinApi.resolvePin(json({ competition_id: "2", pinned: true }));
  await advance();
  expect(renderedCompetitionNames()).toEqual(["AI Challenge 2026", "Joined Cup"]);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("đăng xuất trong lúc ghim đang chờ: lượt nạp của phiên mới không bị vô hiệu, trang thoát Loading", async () => {
  vi.useFakeTimers();
  const pinApi = mockPinLogoutApi();
  renderWithIdentityControls();
  await advance();

  fireEvent.click(screen.getByRole("button", { name: "Ghim cuộc thi Joined Cup" }));
  await advance();
  fireEvent.click(screen.getByRole("button", { name: "Đăng xuất" }));
  await advance();
  expect(screen.getByRole("status")).toBeTruthy();

  // PUT của phiên A kết thúc khi lượt nạp của khách còn đang bay: không được vô hiệu lượt nạp đó.
  pinApi.resolvePin(json({ competition_id: "2", pinned: true }));
  await advance();
  pinApi.resolveGuestList(json({ competitions: [PUBLISHED, JOINED] }));
  await advance();
  expect(screen.queryByRole("status")).toBeNull();
  expect(renderedCompetitionNames()).toEqual(["AI Challenge 2026", "Joined Cup"]);
});
