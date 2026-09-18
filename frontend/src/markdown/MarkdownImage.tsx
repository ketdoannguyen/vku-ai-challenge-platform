/**
 * Ảnh trong Markdown: chỉ render khi resolver đã chấp nhận `src`, và thay bằng placeholder
 * khi ảnh không tải được - không bao giờ để lại broken image hoặc cú pháp thô.
 */

import { useState, type ComponentProps } from "react";

const FALLBACK_MESSAGE = "Không tải được hình ảnh";

function IconBrokenImage() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M21 5v6.59l-3-3.01-4 4.01-4-4-4 4-3-3.01V5c0-1.1.9-2 2-2h14c1.1 0 2 .9 2 2zm-3 6.42l3 3.01V19c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-6.58l3 2.99 4-4 4 4 4-3.99z" />
    </svg>
  );
}

function ImageFallback({ label }: { label: string }) {
  return (
    <span className="md-image-fallback">
      <IconBrokenImage />
      <span>{label === "" ? FALLBACK_MESSAGE : `${FALLBACK_MESSAGE}: ${label}`}</span>
    </span>
  );
}

export function MarkdownImage({ src, alt, title }: ComponentProps<"img">) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) return <ImageFallback label={alt ?? title ?? ""} />;

  return (
    <img
      src={src}
      alt={alt ?? ""}
      title={title}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
