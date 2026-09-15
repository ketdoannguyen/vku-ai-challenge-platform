/** MarkdownView: render GFM representative + sanitize XSS + safe links/images. */

import { render, screen } from "@testing-library/react";
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
