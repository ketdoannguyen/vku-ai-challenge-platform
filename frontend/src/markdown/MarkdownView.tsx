/** Render Markdown GFM an toàn: sanitize AST, không raw HTML, asset chỉ từ competition assets. */

import type { ComponentProps } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { Components, ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import {
  remarkHeadingHierarchy,
  type HeadingHierarchy,
  type HeadingVisualRole,
} from "./headingHierarchy";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { MarkdownImage } from "./MarkdownImage";
import { resolveMarkdownAssetUrl } from "./resolveMarkdownAssetUrl";

const ROLE_CLASS: Record<HeadingVisualRole, string> = {
  title: "md-doc-title",
  section: "md-section",
  square: "md-h-square",
  dash: "md-h-dash",
  sub: "md-h-sub",
  label: "md-h-label",
};

/**
 * Semantic heading luôn hạ một bậc để H1 của trang vẫn là tên cuộc thi. Vai trò thị giác được lấy
 * từ mdast đã parse: đúng một source `#` thì đó là title tài liệu và các cấp dưới được nâng lên; có
 * nhiều `#` thì mỗi `#` là thanh mục. Không parse source bằng regex và không sửa text tác giả.
 */
function markdownHeading(
  sourceLevel: number,
  hierarchy: HeadingHierarchy,
): Components["h1"] {
  const Tag = `h${Math.min(sourceLevel + 1, 6)}` as "h2" | "h3" | "h4" | "h5" | "h6";

  return function MarkdownHeading({ children, node }: ComponentProps<"h2"> & ExtraProps) {
    const offset = node?.position?.start.offset;
    const metadata = typeof offset === "number" ? hierarchy.headings.get(offset) : undefined;
    const role = metadata?.role ?? (sourceLevel === 1 ? "section" : "label");
    const className = ROLE_CLASS[role];

    if (role === "section") {
      return (
        <Tag className={className} data-md-accent={metadata?.accent ?? "blue"}>
          <span className="md-section-badge" aria-hidden="true" />
          <span className="md-section-text">{children}</span>
          <span className="md-section-lead" aria-hidden="true" />
        </Tag>
      );
    }

    return (
      <Tag
        className={className}
        {...(role !== "title" ? { "data-md-accent": metadata?.accent ?? "blue" } : {})}
      >
        {children}
      </Tag>
    );
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

export function MarkdownView({
  markdown,
  competitionSlug,
}: {
  markdown: string;
  competitionSlug: string;
}) {
  const hierarchy: HeadingHierarchy = { headings: new Map() };
  const components: Components = {
    h1: markdownHeading(1, hierarchy),
    h2: markdownHeading(2, hierarchy),
    h3: markdownHeading(3, hierarchy),
    h4: markdownHeading(4, hierarchy),
    h5: markdownHeading(5, hierarchy),
    h6: markdownHeading(6, hierarchy),
    a: MarkdownLink,
    img: MarkdownImage,
    pre: MarkdownCodeBlock,
    table: MarkdownTable,
  };

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkHeadingHierarchy, hierarchy]]}
        rehypePlugins={[rehypeSanitize]}
        urlTransform={(url, key) =>
          // Ảnh chỉ được trỏ về asset của chính cuộc thi; URL khác vẫn qua allowlist của
          // react-markdown để giữ defense-in-depth, rồi rehype-sanitize là lớp chặn cuối.
          key === "src" ? (resolveMarkdownAssetUrl(url, competitionSlug) ?? "") : defaultUrlTransform(url)
        }
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
