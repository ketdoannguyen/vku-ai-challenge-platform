/** Trang Hỗ trợ & Liên hệ: hướng dẫn, FAQ bám hành vi thật và ba tầng liên hệ. */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { KHCN_HTQT_NAME } from "../lib/vkuInfo";
import { SupportPage } from "./SupportPage";

function renderPage() {
  return render(
    <MemoryRouter>
      <SupportPage />
    </MemoryRouter>,
  );
}

function linksWithHref(prefix: string) {
  return screen
    .getAllByRole("link")
    .filter((link) => link.getAttribute("href")?.startsWith(prefix));
}

function externalLinks() {
  return screen.getAllByRole("link").filter((link) => link.getAttribute("target") === "_blank");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("tiêu đề trang và tiêu đề tab", () => {
  renderPage();
  expect(screen.getByRole("heading", { level: 1, name: "Hỗ trợ & Liên hệ" })).toBeTruthy();
  expect(document.title).toBe("Hỗ trợ & Liên hệ - AI Challenge");
});

test("nêu các bước tham gia theo đúng hành vi nền tảng", () => {
  renderPage();
  expect(screen.getByText(/tài khoản do Ban Tổ chức cấp/)).toBeTruthy();
  expect(screen.getByText(/mở tự do, cần mã do Ban Tổ chức cấp hoặc chỉ theo lời mời/)).toBeTruthy();
  expect(screen.getByText(/Nộp bài CSV/)).toBeTruthy();
});

test("lưới sáu bước trình bày đủ và đúng thứ tự", () => {
  const { container } = renderPage();
  const steps = container.querySelectorAll(".support-step");
  expect(steps).toHaveLength(6);
  expect([...steps].map((step) => step.querySelector("h3")?.textContent)).toEqual([
    "Đăng nhập",
    "Chọn cuộc thi",
    "Tham gia cuộc thi",
    "Đọc đề bài",
    "Nộp bài",
    "Theo dõi kết quả",
  ]);
  // Bước 2 vẫn là lối vào danh sách cuộc thi.
  expect(screen.getByRole("link", { name: "Cuộc thi" })).toHaveAttribute("href", "/");
});

test("nhịp màu số bước xoay vòng và chỉ mang tính trang trí", () => {
  const { container } = renderPage();
  expect(
    [...container.querySelectorAll(".support-step")].map((step) => step.getAttribute("data-tone")),
  ).toEqual(["blue", "red", "yellow", "blue", "red", "yellow"]);
});

test("FAQ trả lời các tình huống đã có trong hệ thống", () => {
  renderPage();
  expect(screen.getByText(/không có chức năng tự đăng ký/)).toBeTruthy();
  expect(screen.getByText(/quản trị viên đặt lại mật khẩu/)).toBeTruthy();
  expect(screen.getByText(/quyền tham gia đang bị vô hiệu hoá/)).toBeTruthy();
  expect(screen.getByText(/hết lượt nộp trong ngày/)).toBeTruthy();
  expect(screen.getByText(/Tệp phải là CSV/)).toBeTruthy();
  expect(screen.getByText(/bảng xếp hạng chỉ hiển thị khi Ban Tổ chức công khai/)).toBeTruthy();
});

test("FAQ giữ đủ chín câu hỏi", () => {
  const { container } = renderPage();
  expect(container.querySelectorAll(".support-faq-item")).toHaveLength(9);
  expect(
    [...container.querySelectorAll(".support-faq-trigger")].map((trigger) => trigger.textContent),
  ).toEqual([
    "Tôi chưa có tài khoản thì làm sao?",
    "Quên mật khẩu thì làm sao?",
    "Vì sao tôi không tham gia được cuộc thi?",
    "Vì sao tôi không nộp được bài?",
    "Hạn mức nộp bài tính thế nào?",
    "Bài nộp cần định dạng nào?",
    "Điểm và bảng xếp hạng xem ở đâu?",
    "Tôi muốn rời cuộc thi?",
    "Tôi muốn tổ chức cuộc thi trên nền tảng?",
  ]);
  // Câu trả lời của item cuối vẫn nội suy tên đơn vị từ `vkuInfo.ts`; tên này cũng
  // xuất hiện ở khối Liên hệ nên phải soi đúng panel của FAQ.
  const answers = container.querySelectorAll(".support-faq-panel");
  expect(answers[answers.length - 1]?.textContent).toContain(KHCN_HTQT_NAME);
});

test("ba tầng liên hệ đúng thứ tự và đúng địa chỉ", () => {
  renderPage();
  expect(linksWithHref("mailto:").map((link) => link.getAttribute("href"))).toEqual([
    "mailto:info@vku.udn.vn",
    "mailto:khcn_htqt@vku.udn.vn",
    "mailto:nkdoan@vku.udn.vn",
  ]);
  expect(linksWithHref("tel:").map((link) => link.getAttribute("href"))).toEqual([
    "tel:+842363667117",
    "tel:+842363962972",
    "tel:+84396090576",
  ]);
});

test("công khai thông tin hỗ trợ kỹ thuật do người dùng uỷ quyền", () => {
  renderPage();
  expect(screen.getByText(/Nguyễn Kết Đoàn/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "nkdoan@vku.udn.vn" })).toHaveAttribute(
    "href",
    "mailto:nkdoan@vku.udn.vn",
  );
  expect(screen.getByRole("link", { name: "0396090576" })).toHaveAttribute(
    "href",
    "tel:+84396090576",
  );
});

test("link email và điện thoại không mở tab mới", () => {
  renderPage();
  for (const link of [...linksWithHref("mailto:"), ...linksWithHref("tel:")]) {
    expect(link).not.toHaveAttribute("target");
  }
});

test("link website mở tab mới an toàn", () => {
  renderPage();
  const hrefs = externalLinks().map((link) => link.getAttribute("href"));
  expect(hrefs).toEqual([
    "https://vku.udn.vn/",
    "https://vku.udn.vn/vi/co-cau-to-chuc/phong-khoa-hoc-cong-nghe-hop-tac-quoc-te/",
  ]);
  for (const link of externalLinks()) {
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  }
});

test("không còn khối Nguồn thông tin hay Danh mục hỗ trợ", () => {
  renderPage();
  // Sau ADR-024 không trang nào còn khối nguồn; khối này cũng không được quay lại `/ho-tro`.
  expect(screen.queryByText(/Nguồn thông tin/)).toBeNull();
  expect(screen.queryByText(/truy cập ngày/)).toBeNull();
  expect(screen.queryByText(/Giới thiệu Trường/)).toBeNull();
  expect(screen.queryByText(/Danh mục hỗ trợ/)).toBeNull();
  expect(screen.queryByText(/Cần hỗ trợ thêm/)).toBeNull();
});

test("không có sidebar, form liên hệ hay CTA phụ và không gọi API", () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const { container } = renderPage();
  expect(container.querySelector("form, input, textarea, aside, nav")).toBeNull();
  // Chín trigger FAQ là toàn bộ button của trang - không có CTA nào khác.
  expect(screen.getAllByRole("button")).toHaveLength(9);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("FAQ là accordion đóng mặc định với quan hệ aria đầy đủ", () => {
  const { container } = renderPage();
  const triggers = screen.getAllByRole("button");
  expect(triggers).toHaveLength(9);
  for (const trigger of triggers) {
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    const panelId = trigger.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    const panel = container.querySelector(`#${panelId}`);
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("hidden");
    expect(panel).toHaveAttribute("aria-labelledby", trigger.id);
  }
});

test("FAQ chỉ mở một mục tại một thời điểm và đóng lại được", async () => {
  const user = userEvent.setup();
  renderPage();
  const first = screen.getByRole("button", { name: "Quên mật khẩu thì làm sao?" });
  const second = screen.getByRole("button", { name: "Bài nộp cần định dạng nào?" });

  await user.click(first);
  expect(first).toHaveAttribute("aria-expanded", "true");

  await user.click(second);
  const expanded = screen.getAllByRole("button", { expanded: true });
  expect(expanded).toHaveLength(1);
  expect(expanded[0]).toHaveAccessibleName("Bài nộp cần định dạng nào?");
  expect(first).toHaveAttribute("aria-expanded", "false");

  await user.click(second);
  expect(screen.queryAllByRole("button", { expanded: true })).toHaveLength(0);
});

test("FAQ mở và đóng được bằng bàn phím", async () => {
  const user = userEvent.setup();
  renderPage();
  const trigger = screen.getByRole("button", { name: "Quên mật khẩu thì làm sao?" });

  trigger.focus();
  expect(trigger).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  await user.keyboard(" ");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("cấu trúc heading: một h1, ba section h2", () => {
  renderPage();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(
    ["Các bước tham gia", "Liên hệ", "Câu hỏi thường gặp"],
  );
});
