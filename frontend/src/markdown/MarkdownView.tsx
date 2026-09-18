/** Render Markdown GFM an toàn: sanitize AST, không raw HTML, asset chỉ từ competition assets. */

import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

const ASSET_PREFIX = "assets/";

/**
 * Hạ một bậc mọi heading do tác giả viết: trang đã có H1 riêng (tên cuộc thi) nên
 * `#` trong Markdown không được tạo H1 thứ hai. `h6` giữ nguyên vì không còn bậc dưới.
 */
function demoteHeading(level: number) {
  const Tag = `h${Math.min(level + 1, 6)}` as "h2" | "h3" | "h4" | "h5" | "h6";
  return function Heading({ children, ...props }: ComponentProps<"h2">) {
    return <Tag {...props}>{children}</Tag>;
  };
}

const HEADING_COMPONENTS = {
  h1: demoteHeading(1),
  h2: demoteHeading(2),
  h3: demoteHeading(3),
  h4: demoteHeading(4),
  h5: demoteHeading(5),
  h6: demoteHeading(6),
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
        urlTransform={(url, key) => {
          if (key === "src") {
            // Ảnh chỉ cho phép relative asset của competition — đổi sang endpoint API có authz.
            if (url.startsWith(ASSET_PREFIX) && !url.includes("..")) {
              return `/api/competitions/${competitionSlug}/assets/${url.slice(ASSET_PREFIX.length)}`;
            }
            return "";
          }
          return url;
        }}
        components={{
          ...HEADING_COMPONENTS,
          a({ href, children, ...props }) {
            const isExternal = typeof href === "string" && /^https?:\/\//i.test(href);
            return (
              <a
                href={href}
                {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                {...props}
              >
                {children}
              </a>
            );
          },
          img({ src, alt, ...props }) {
            if (!src) return null;
            return <img src={src} alt={alt ?? ""} loading="lazy" {...props} />;
          },
          // Bảng rộng cuộn trong wrapper để giữ nguyên ngữ nghĩa table (không đổi display).
          table({ children, ...props }) {
            return (
              <div
                className="md-table-wrap"
                tabIndex={0}
                role="region"
                aria-label="Bảng dữ liệu"
              >
                <table {...props}>{children}</table>
              </div>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
