/** Trang Giới thiệu: nội dung tĩnh, có nguồn chính thức, không gọi API. */

import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { KHCN_HTQT_NAME, PLATFORM_SUPPORT_NAME, VKU_NAME, VKU_SOURCES } from "../lib/vkuInfo";
import { AboutPage } from "./AboutPage";

function renderPage() {
  return render(
    <MemoryRouter>
      <AboutPage />
    </MemoryRouter>,
  );
}

/** Link nguồn/website ngoài - tách khỏi link nội bộ để kiểm tra thuộc tính an toàn. */
function externalLinks() {
  return screen.getAllByRole("link").filter((link) => link.getAttribute("target") === "_blank");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("tiêu đề trang và tiêu đề tab", () => {
  renderPage();
  expect(screen.getByRole("heading", { level: 1, name: "Giới thiệu" })).toBeTruthy();
  expect(document.title).toBe("Giới thiệu - AI Challenge");
});

test("nêu tên chính thức và quan hệ thành viên Đại học Đà Nẵng", () => {
  renderPage();
  const facts = screen.getByRole("list", { name: "Thông tin VKU" });
  expect(
    within(facts).getByText(/Trường Đại học Công nghệ Thông tin và Truyền thông Việt - Hàn/),
  ).toBeTruthy();
  expect(within(facts).getByText(/thành viên của Đại học Đà Nẵng/)).toBeTruthy();
});

test("nêu căn cứ thành lập theo Quyết định 15/QĐ-TTg ngày 03/01/2020", () => {
  renderPage();
  expect(screen.getByText(/15\/QĐ-TTg ngày 03\/01\/2020/)).toBeTruthy();
});

test("hiển thị đơn vị chủ trì và các đầu mối hỗ trợ", () => {
  renderPage();
  expect(screen.getByText(/Phòng Khoa học Công nghệ - Hợp tác Quốc tế/)).toBeTruthy();
  expect(screen.getByText(/Nguyễn Kết Đoàn/)).toBeTruthy();
});

test("dẫn tiếp tới danh sách cuộc thi và trang hỗ trợ", () => {
  renderPage();
  expect(screen.getByRole("link", { name: "Xem danh sách cuộc thi" })).toHaveAttribute("href", "/");
  expect(screen.getByRole("link", { name: "Hỗ trợ & Liên hệ" })).toHaveAttribute("href", "/ho-tro");
});

test("link nguồn trỏ tới trang chính thức và mở tab mới an toàn", () => {
  renderPage();
  const sources = [
    "https://vku.udn.vn/gioi-thieu",
    "https://vku.udn.vn/lien-he",
    "https://vku.udn.vn/vi/co-cau-to-chuc/phong-khoa-hoc-cong-nghe-hop-tac-quoc-te/",
    "https://udn.vn/",
  ];
  const hrefs = externalLinks().map((link) => link.getAttribute("href"));
  expect(hrefs).toEqual(expect.arrayContaining(sources));

  for (const link of externalLinks()) {
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  }
});

test("trang tĩnh: không gọi API", () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  renderPage();
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("cấu trúc heading: một h1 và năm khối h2 theo đúng thứ tự đọc", () => {
  renderPage();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "Về nền tảng AI Challenge",
    "VKU - đơn vị chủ trì",
    "Đơn vị và đầu mối hỗ trợ",
    "Bắt đầu",
    "Nguồn thông tin",
  ]);
});

test("nền tảng được tách thành bốn feature item giữ nguyên nội dung", () => {
  const { container } = renderPage();
  const features = container.querySelectorAll(".about-feature");
  expect(features).toHaveLength(4);
  expect([...features].map((feature) => feature.querySelector("h3")?.textContent)).toEqual([
    "Một website, nhiều cuộc thi",
    "Đọc công khai",
    "Tài khoản",
    "Thể lệ và bài nộp",
  ]);
  // Bốn mô tả cũ phải còn nguyên, chỉ đổi cách trình bày.
  const text = [...features].map((feature) => feature.textContent).join(" ");
  expect(text).toContain("Mỗi cuộc thi có trang riêng gồm thể lệ, đề bài và tài liệu");
  expect(text).toContain("Danh sách và trang chi tiết cuộc thi đọc được không cần đăng nhập");
  expect(text).toContain("Do Ban Tổ chức cấp; nền tảng không có đăng ký tự do");
  expect(text).toContain("hạn mức nộp do Ban Tổ chức cấu hình cho từng cuộc thi");
});

test("thông tin VKU giữ đủ năm dữ kiện có nguồn", () => {
  renderPage();
  const facts = screen.getByRole("list", { name: "Thông tin VKU" });
  const items = within(facts).getAllByRole("listitem");
  expect(items).toHaveLength(5);
  expect(items.map((item) => item.querySelector("h3")?.textContent)).toEqual([
    "Tên đầy đủ",
    "Đại học Đà Nẵng",
    "Thành lập",
    "Sứ mệnh",
    "Địa chỉ",
  ]);
});

test("ba đầu mối hỗ trợ đúng thứ tự và không lặp dữ liệu liên hệ của trang Hỗ trợ", () => {
  const { container } = renderPage();
  const units = container.querySelectorAll(".about-unit");
  expect(units).toHaveLength(3);
  expect([...units].map((unit) => unit.querySelector("h3")?.textContent)).toEqual([
    VKU_NAME,
    KHCN_HTQT_NAME,
    PLATFORM_SUPPORT_NAME,
  ]);
  // Không lặp email/điện thoại: đó là việc của `/ho-tro`.
  expect(container.querySelector('a[href^="mailto:"], a[href^="tel:"]')).toBeNull();
  expect(screen.queryByText(/nkdoan@vku\.udn\.vn|info@vku\.udn\.vn/)).toBeNull();
});

test("khối Nguồn thông tin liệt kê bốn nguồn chính thức, gồm cả Phòng KHCN - HTQT", () => {
  const { container } = renderPage();
  expect(screen.getByRole("heading", { level: 2, name: "Nguồn thông tin" })).toBeTruthy();
  const sources = container.querySelectorAll(".about-sources li");
  expect(sources).toHaveLength(4);
  expect([...sources].map((item) => item.querySelector("a")?.getAttribute("href"))).toEqual([
    VKU_SOURCES.about.url,
    VKU_SOURCES.contact.url,
    VKU_SOURCES.department.url,
    VKU_SOURCES.udn.url,
  ]);
});

test("nhãn nguồn là tên ngắn, không dán URL", () => {
  const { container } = renderPage();
  const labels = [...container.querySelectorAll(".about-sources .resource-label")].map(
    (label) => label.textContent ?? "",
  );
  expect(labels).toEqual([
    VKU_SOURCES.about.label,
    VKU_SOURCES.contact.label,
    VKU_SOURCES.department.label,
    VKU_SOURCES.udn.label,
  ]);
  for (const label of labels) {
    expect(label).not.toMatch(/https?:\/\/|\.vn/);
    // Đếm chữ, bỏ dấu nối đứng riêng ("Phòng KHCN - Hợp tác Quốc tế" là sáu chữ).
    const words = label.split(/\s+/).filter((token) => /\p{L}/u.test(token));
    expect(words.length).toBeLessThanOrEqual(6);
  }
});

test("CTA chính là link VKU Blue duy nhất, không có CTA phụ", () => {
  const { container } = renderPage();
  const cta = screen.getByRole("link", { name: "Xem danh sách cuộc thi" });
  expect(cta).toHaveClass("btn", "about-cta-link");
  expect(container.querySelectorAll(".about-cta-link")).toHaveLength(1);
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
    "Hỗ trợ & Liên hệ",
    "Xem danh sách cuộc thi",
    VKU_SOURCES.about.label,
    VKU_SOURCES.contact.label,
    VKU_SOURCES.department.label,
    VKU_SOURCES.udn.label,
  ]);
});

test("không còn markup của giao diện cũ hay của trang Hỗ trợ", () => {
  const { container } = renderPage();
  expect(container.querySelector(".page, .card, .ov, .ov-facts, .ov-block")).toBeNull();
  expect(container.querySelector('[class*="support-"]')).toBeNull();
  expect(container.querySelector("form, input, textarea, aside, nav")).toBeNull();
});
