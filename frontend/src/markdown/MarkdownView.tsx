/** Render Markdown GFM an toàn: sanitize AST, không raw HTML, asset chỉ từ competition assets. */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

const ASSET_PREFIX = "assets/";

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
              <div className="md-table-wrap">
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
