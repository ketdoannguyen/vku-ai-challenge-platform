/**
 * Code block: cấu trúc semantic, nhãn ngôn ngữ, sao chép thành công/thất bại và state độc lập.
 *
 * Render qua `MarkdownView` để kiểm tra đúng tích hợp thật của renderer thay vì tự dựng props
 * `pre`/`code` giả.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { MarkdownView } from "./MarkdownView";

const TREE = [
  "```text",
  "├── train.csv",
  "└── sample_submission.csv",
  "```",
].join("\n");

const PYTHON = ["```python", 'ids = sample_submission["id"]', "```"].join("\n");

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

function renderMarkdown(markdown: string) {
  return render(<MarkdownView markdown={markdown} competitionSlug="ai-cup" />);
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

test("fence có ngôn ngữ: nhãn theo info string, giữ pre > code và ký tự gốc", () => {
  const { container } = renderMarkdown(TREE);

  const block = container.querySelector(".md-code-block");
  expect(block).toBeTruthy();
  expect(within(block as HTMLElement).getByText("text")).toHaveClass("md-code-lang");
  // Nội dung nằm nguyên trong pre > code, không bị đổi ký tự cây thư mục.
  const code = container.querySelector("pre > code");
  expect(code?.textContent).toBe("├── train.csv\n└── sample_submission.csv\n");
  // Toolbar phải ở ngoài pre, nếu không nút sẽ nằm trong vùng cuộn ngang của code.
  expect(screen.getByRole("button", { name: "Sao chép" }).closest("pre")).toBeNull();
});

test("fence không có ngôn ngữ dùng nhãn chung, không suy diễn nội dung", () => {
  const { container } = renderMarkdown(["```", "plain text", "```"].join("\n"));
  expect(within(container.querySelector(".md-code-block") as HTMLElement).getByText("Code")).toBeTruthy();
});

test("sao chép thành công: copy đúng text đã parse và đổi nhãn trong thời gian ngắn", async () => {
  const written: string[] = [];
  stubClipboard(async (text) => {
    written.push(text);
  });
  const { container } = renderMarkdown(PYTHON);
  const button = screen.getByRole("button", { name: "Sao chép" });

  fireEvent.click(button);

  await waitFor(() => expect(button).toHaveAttribute("aria-label", "Đã sao chép"));
  expect(button).toHaveTextContent("Đã sao chép");
  // Chỉ bỏ newline cuối của fence, phần nội dung giữ nguyên từng ký tự.
  expect(written).toEqual(['ids = sample_submission["id"]']);
  expect(within(container).getByRole("status")).toHaveTextContent("Đã sao chép nội dung khối code.");

  await waitFor(() => expect(button).toHaveAttribute("aria-label", "Sao chép"), { timeout: 3000 });
});

test("clipboard từ chối: hiện hướng dẫn sao chép thủ công và giữ nguyên code", async () => {
  stubClipboard(() => Promise.reject(new Error("blocked")));
  const { container } = renderMarkdown(TREE);

  fireEvent.click(screen.getByRole("button", { name: "Sao chép" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("hãy chọn và sao chép thủ công");
  expect(screen.getByRole("button", { name: "Sao chép" })).toBeTruthy();
  expect(container.querySelector("pre > code")?.textContent).toContain("sample_submission.csv");
});

test("trình duyệt không có clipboard API: vẫn còn code và có hướng dẫn thủ công", async () => {
  const { container } = renderMarkdown(PYTHON);

  fireEvent.click(screen.getByRole("button", { name: "Sao chép" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("không cho phép sao chép tự động");
  expect(container.querySelector("pre > code")).toBeTruthy();
});

test("state sao chép độc lập giữa hai code block và inline code không có toolbar", async () => {
  stubClipboard(async () => {});
  const { container } = renderMarkdown(`${TREE}\n\n${PYTHON}\n\nDùng \`id,prediction\` cho header.`);

  const blocks = container.querySelectorAll(".md-code-block");
  expect(blocks).toHaveLength(2);

  fireEvent.click(within(blocks[1] as HTMLElement).getByRole("button", { name: "Sao chép" }));

  await waitFor(() =>
    expect(within(blocks[1] as HTMLElement).getByRole("button")).toHaveAttribute(
      "aria-label",
      "Đã sao chép",
    ),
  );
  expect(within(blocks[0] as HTMLElement).getByRole("button")).toHaveAttribute(
    "aria-label",
    "Sao chép",
  );

  // Inline code giữ nguyên element và không bị bọc toolbar.
  const inline = Array.from(container.querySelectorAll("code")).find(
    (code) => code.textContent === "id,prediction",
  );
  expect(inline?.closest("pre")).toBeNull();
  expect(inline?.closest(".md-code-block")).toBeNull();
});
