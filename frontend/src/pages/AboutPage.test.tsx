/** Trang Giới thiệu: nội dung tĩnh, ba hàng full-width, không gọi API. */

import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { KHCN_HTQT_NAME, PLATFORM_SUPPORT_NAME, VKU_NAME } from "../lib/vkuInfo";
import { AboutPage } from "./AboutPage";

function renderPage() {
  return render(
    <MemoryRouter>
      <AboutPage />
    </MemoryRouter>,
  );
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

test("chỉ dẫn tiếp sang trang Hỗ trợ, không còn CTA hay link ngoài", () => {
  renderPage();
  expect(screen.getByRole("link", { name: "Hỗ trợ & Liên hệ" })).toHaveAttribute("href", "/ho-tro");
  expect(screen.getAllByRole("link")).toHaveLength(1);
});

test("trang tĩnh: không gọi API", () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  renderPage();
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("cấu trúc heading: một h1 và ba khối h2 theo đúng thứ tự đọc", () => {
  renderPage();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "Về nền tảng AI Challenge",
    "VKU - đơn vị chủ trì",
    "Đơn vị và đầu mối hỗ trợ",
  ]);
});

test("ba khối là ba hàng full-width, mỗi khối tự chia lưới con", () => {
  const { container } = renderPage();
  expect(container.querySelectorAll(".about-grid > .about-card")).toHaveLength(3);
  expect(
    container.querySelectorAll(".about-feature-list, .about-fact-list, .about-unit-list"),
  ).toHaveLength(3);
  // Không còn wrapper cột nửa hay card "Bắt đầu"/"Nguồn thông tin".
  expect(container.querySelector(".about-col, .about-cta, .about-sources")).toBeNull();
  expect(screen.queryByText(/Nguồn thông tin/)).toBeNull();
  expect(screen.queryByText(/Xem danh sách cuộc thi/)).toBeNull();
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

test("thông tin VKU giữ đủ năm dữ kiện, Sứ mệnh mang ô rộng", () => {
  const { container } = renderPage();
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
  // Dữ kiện dài nhất chiếm hai cột để hàng dữ kiện ở desktop không hở ô nào.
  const wide = container.querySelectorAll(".about-fact-wide");
  expect(wide).toHaveLength(1);
  expect(wide[0]?.querySelector("h3")?.textContent).toBe("Sứ mệnh");
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

test("không còn markup của giao diện cũ hay của trang Hỗ trợ", () => {
  const { container } = renderPage();
  expect(container.querySelector(".page, .card, .ov, .ov-facts, .ov-block")).toBeNull();
  expect(container.querySelector('[class*="support-"]')).toBeNull();
  expect(container.querySelector("form, input, textarea, aside, nav")).toBeNull();
});
