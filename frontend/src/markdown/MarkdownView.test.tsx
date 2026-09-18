/** MarkdownView: render GFM representative + sanitize XSS + safe links/images. */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { MarkdownView } from "./MarkdownView";

const FIXTURE = `
# Đề bài

Đoạn văn có **in đậm** và *nghiêng*.

- Mục 1
- Mục 2

1. Bước 1
2. Bước 2

| Cột A | Cột B |
|-------|-------|
| 1     | 2     |

\`\`\`python
print("hello")
\`\`\`

[Link ngoài](https://example.com)
[Link nội bộ](/competitions/x/content/rules)

![Diagram](assets/diagram.png)
`;

test("heading tác giả bị hạ một bậc để trang không có H1 thứ hai", () => {
  const { container } = render(
    <MarkdownView markdown={"# Đề bài\n\n## Thể lệ\n\n### Lưu ý"} competitionSlug="ai-cup" />,
  );
  expect(container.querySelector("h1")).toBeNull();
  // `#` của tác giả thành h2 - đây là mốc mục cấp cao nhất của prose.
  expect(screen.getByRole("heading", { level: 2, name: "Đề bài" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 3, name: "Thể lệ" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 4, name: "Lưu ý" })).toBeTruthy();
});

test("blockquote, code trong dòng và vạch ngăn render đúng phần tử để CSS VKU bám vào", () => {
  const md = [
    "> Ghi chú của Ban Tổ chức",
    "",
    "Dùng `id,prediction` cho dòng tiêu đề.",
    "",
    "---",
  ].join("\n");
  const { container } = render(<MarkdownView markdown={md} competitionSlug="ai-cup" />);
  expect(container.querySelector("blockquote")?.textContent).toContain("Ghi chú của Ban Tổ chức");
  // Code trong dòng phải nằm ngoài `pre`, nếu không sẽ ăn style của code block.
  const inline = container.querySelector("code");
  expect(inline?.textContent).toBe("id,prediction");
  expect(inline?.closest("pre")).toBeNull();
  expect(container.querySelector("hr")).toBeTruthy();
});

test("render GFM: heading, list, table, code, link, image", () => {
  const { container } = render(<MarkdownView markdown={FIXTURE} competitionSlug="ai-cup" />);
  expect(screen.getByRole("heading", { name: "Đề bài" })).toBeTruthy();
  expect(screen.getByText("Mục 1")).toBeTruthy();
  expect(screen.getByText("Bước 1")).toBeTruthy();
  expect(container.querySelector("table")).toBeTruthy();
  expect(container.querySelector("pre code")).toBeTruthy();
  const img = container.querySelector("img");
  expect(img).toBeTruthy();
  expect(img!.getAttribute("src")).toBe("/api/competitions/ai-cup/assets/diagram.png");
  expect(img!.getAttribute("loading")).toBe("lazy");
});

test("bảng GFM nằm trong vùng cuộn focus được và giữ nguyên ngữ nghĩa table", () => {
  render(<MarkdownView markdown={FIXTURE} competitionSlug="ai-cup" />);
  const region = screen.getByRole("region", { name: "Bảng dữ liệu" });
  expect(region).toHaveAttribute("tabindex", "0");
  expect(within(region).getByRole("table")).toBeTruthy();
});

test("XSS payload không sinh element nguy hiểm", () => {
  const evil = `
<script>alert(1)</script>
<iframe src="https://evil.com"></iframe>
<img src=x onerror=alert(1)>
[click](javascript:alert(1))
<a href="javascript:alert(1)">raw</a>
`;
  const { container } = render(<MarkdownView markdown={evil} competitionSlug="ai-cup" />);
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.querySelector("[onerror]")).toBeNull();
  for (const link of container.querySelectorAll("a")) {
    expect(link.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  }
});

test("link ngoài có rel safety, link nội bộ không ép mở tab", () => {
  const { container } = render(
    <MarkdownView
      markdown={"[ngoài](https://example.com) [trong](/competitions/x)"}
      competitionSlug="ai-cup"
    />,
  );
  const links = container.querySelectorAll("a");
  const external = links[0];
  expect(external.getAttribute("target")).toBe("_blank");
  expect(external.getAttribute("rel")).toContain("noopener");
  expect(external.getAttribute("rel")).toContain("noreferrer");
  const internal = links[1];
  expect(internal.getAttribute("target")).toBeNull();
});

test("ảnh external/data bị loại, chỉ asset same-origin được transform", () => {
  const md = "![ext](https://evil.com/x.png) ![data](data:image/png;base64,AAA) ![ok](assets/ok.png)";
  const { container } = render(<MarkdownView markdown={md} competitionSlug="ai-cup" />);
  const imgs = container.querySelectorAll("img");
  const srcs = Array.from(imgs).map((i) => i.getAttribute("src"));
  expect(srcs.filter(Boolean)).toEqual(["/api/competitions/ai-cup/assets/ok.png"]);
});

test("bốn cấp heading tác giả map thành h2..h5 và giữ nguyên chữ của tác giả", () => {
  const { container } = render(
    <MarkdownView
      markdown={"# Cấp một\n\n## Cấp hai\n\n### Cấp ba\n\n#### Cấp bốn"}
      competitionSlug="ai-cup"
    />,
  );
  expect(
    Array.from(container.querySelectorAll("h2, h3, h4, h5, h6")).map((el) => el.tagName),
  ).toEqual(["H2", "H3", "H4", "H5"]);
  // Renderer không tự đánh số hay thêm chữ vào heading.
  expect(
    Array.from(container.querySelectorAll("h2, h3, h4, h5")).map((el) => el.textContent),
  ).toEqual(["Cấp một", "Cấp hai", "Cấp ba", "Cấp bốn"]);
});

test("bold, italic và strikethrough giữ đúng element semantic", () => {
  const { container } = render(
    <MarkdownView markdown={"**Đậm** và *nghiêng* và ~~bỏ~~"} competitionSlug="ai-cup" />,
  );
  expect(container.querySelector("strong")?.textContent).toBe("Đậm");
  expect(container.querySelector("em")?.textContent).toBe("nghiêng");
  expect(container.querySelector("del")?.textContent).toBe("bỏ");
});

test("list lồng nhau giữ đúng quan hệ cha con ul/ol", () => {
  const { container } = render(
    <MarkdownView
      markdown={"- Ngoài\n  - Trong\n\n1. Một\n   1. Một con"}
      competitionSlug="ai-cup"
    />,
  );
  expect(container.querySelector("ul > li > ul")).toBeTruthy();
  expect(container.querySelector("ol > li > ol")).toBeTruthy();
});

test("task list GFM render checkbox thật, giữ trạng thái và không cho tương tác", () => {
  const { container } = render(
    <MarkdownView markdown={"- [x] Đã xong\n- [ ] Chưa xong"} competitionSlug="ai-cup" />,
  );
  const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  expect(boxes).toHaveLength(2);
  expect(boxes[0].checked).toBe(true);
  expect(boxes[1].checked).toBe(false);
  expect(boxes[0].disabled).toBe(true);
  expect(container.querySelectorAll("li.task-list-item")).toHaveLength(2);
});

test("autolink trần của GFM trở thành link ngoài có rel safety", () => {
  const { container } = render(
    <MarkdownView markdown={"Xem https://vku.udn.vn để biết thêm."} competitionSlug="ai-cup" />,
  );
  const link = container.querySelector("a");
  expect(link?.getAttribute("href")).toBe("https://vku.udn.vn");
  expect(link?.getAttribute("target")).toBe("_blank");
  expect(link?.getAttribute("rel")).toContain("noopener");
});

test("ba dạng đường dẫn asset tương đối normalize về cùng endpoint phẳng", () => {
  const md = "![a](assets/a.png)\n\n![b](./assets/b.jpg)\n\n![c](../assets/c.webp)";
  const { container } = render(<MarkdownView markdown={md} competitionSlug="ai-cup" />);
  expect(Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"))).toEqual(
    [
      "/api/competitions/ai-cup/assets/a.png",
      "/api/competitions/ai-cup/assets/b.jpg",
      "/api/competitions/ai-cup/assets/c.webp",
    ],
  );
});

test("ảnh sai nguồn không tạo img mà hiện placeholder giữ alt", () => {
  const md = [
    "![Banner cuộc thi](https://evil.com/banner.png)",
    "![traversal](../../../etc/passwd.png)",
    "![icon](assets/icon.svg)",
    "![data](data:image/png;base64,AAA)",
  ].join("\n\n");
  const { container } = render(<MarkdownView markdown={md} competitionSlug="ai-cup" />);
  expect(container.querySelectorAll("img")).toHaveLength(0);
  expect(container.querySelectorAll(".md-image-fallback")).toHaveLength(4);
  expect(screen.getByText("Không tải được hình ảnh: Banner cuộc thi")).toBeTruthy();
});

test("ảnh lỗi tải chuyển sang placeholder và giữ mô tả alt", () => {
  const { container } = render(
    <MarkdownView markdown={"![Sơ đồ luồng](assets/flow.png)"} competitionSlug="ai-cup" />,
  );
  const img = container.querySelector("img") as HTMLImageElement;
  expect(img.getAttribute("alt")).toBe("Sơ đồ luồng");

  fireEvent.error(img);

  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".md-image-fallback")?.textContent).toContain("Sơ đồ luồng");
});

test("prop nội bộ `node` của react-markdown không rơi xuống DOM", () => {
  const { container } = render(<MarkdownView markdown={FIXTURE} competitionSlug="ai-cup" />);
  expect(container.querySelector("[node]")).toBeNull();
  expect(container.innerHTML).not.toContain("[object Object]");
});
