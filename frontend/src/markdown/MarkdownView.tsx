/** Render Markdown GFM an toàn: sanitize AST, không raw HTML, asset chỉ từ competition assets. */

import type { ComponentProps } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { MarkdownImage } from "./MarkdownImage";
import { resolveMarkdownAssetUrl } from "./resolveMarkdownAssetUrl";

/**
 * Hạ một bậc mọi heading do tác giả viết: trang đã có H1 riêng (tên cuộc thi) nên
 * `#` trong Markdown không được tạo H1 thứ hai. `h6` giữ nguyên vì không còn bậc dưới.
 */
function demoteHeading(level: number) {
  const Tag = `h${Math.min(level + 1, 6)}` as "h2" | "h3" | "h4" | "h5" | "h6";
  return function Heading({ children }: ComponentProps<"h2">) {
    return <Tag>{children}</Tag>;
  };
}

function MarkdownLink({ href, title, children }: ComponentProps<"a">) {
  const isExternal = typeof href === "string" && /^https?:\/\//i.test(href);
  return (
    <a
      href={href}
      title={title}
      {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
    </a>
  );
}

/** Bảng rộng cuộn trong wrapper để giữ nguyên ngữ nghĩa table (không đổi display). */
function MarkdownTable({ children }: ComponentProps<"table">) {
  return (
    <div className="md-table-wrap" tabIndex={0} role="region" aria-label="Bảng dữ liệu">
      <table>{children}</table>
    </div>
  );
}

const COMPONENTS = {
  h1: demoteHeading(1),
  h2: demoteHeading(2),
  h3: demoteHeading(3),
  h4: demoteHeading(4),
  h5: demoteHeading(5),
  h6: demoteHeading(6),
  a: MarkdownLink,
  img: MarkdownImage,
  pre: MarkdownCodeBlock,
  table: MarkdownTable,
};

export function MarkdownView({
  markdown,
  competitionSlug,
}: {
  markdown: string;
  competitionSlug: string;
}) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        urlTransform={(url, key) =>
          // Ảnh chỉ được trỏ về asset của chính cuộc thi; URL khác vẫn qua allowlist của
          // react-markdown để giữ defense-in-depth, rồi rehype-sanitize là lớp chặn cuối.
          key === "src" ? (resolveMarkdownAssetUrl(url, competitionSlug) ?? "") : defaultUrlTransform(url)
        }
        components={COMPONENTS}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
