/**
 * Khối code fenced: giữ nguyên `pre > code` và nội dung gốc, thêm nhãn ngôn ngữ cùng nút sao
 * chép. Không syntax highlighting và không suy diễn nội dung - mọi thứ đọc từ cây đã parse.
 */

import { Children, isValidElement, useEffect, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

const COPY_LABEL = "Sao chép";
const COPIED_LABEL = "Đã sao chép";
const COPIED_STATUS = "Đã sao chép nội dung khối code.";
const UNAVAILABLE_MESSAGE =
  "Trình duyệt không cho phép sao chép tự động - hãy chọn nội dung và sao chép thủ công.";
const FAILED_MESSAGE = "Không sao chép được nội dung - hãy chọn và sao chép thủ công.";
const GENERIC_LANGUAGE = "Code";
const COPIED_RESET_MS = 2000;

const LANGUAGE_CLASS = /language-([A-Za-z0-9_+#.-]+)/;
/** Tên ngôn ngữ do tác giả viết, chỉ hiển thị khi khớp allowlist ngắn này. */
const SAFE_LANGUAGE = /^[A-Za-z0-9_+#.-]{1,20}$/;

/** Text của cây con - dùng cho clipboard, không đụng tới nội dung đang render. */
function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** `pre` chỉ bọc đúng một `code` do Markdown sinh ra; đọc ngôn ngữ và text từ chính element đó. */
function readCode(children: ReactNode): { language: string | null; text: string } {
  const code = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(code)) {
    return { language: null, text: "" };
  }
  const match = LANGUAGE_CLASS.exec(code.props.className ?? "");
  return {
    language: match !== null && SAFE_LANGUAGE.test(match[1]) ? match[1] : null,
    text: textOf(code.props.children),
  };
}

function IconCopy() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
    </svg>
  );
}

export function MarkdownCodeBlock({ children }: ComponentProps<"pre">) {
  const { language, text } = readCode(children);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const resetTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, []);

  function stopResetTimer() {
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
  }

  function copy() {
    if (!navigator.clipboard) {
      setCopied(false);
      setError(UNAVAILABLE_MESSAGE);
      return;
    }
    navigator.clipboard.writeText(text.replace(/\n$/, "")).then(
      () => {
        setError("");
        setCopied(true);
        stopResetTimer();
        resetTimer.current = window.setTimeout(() => {
          setCopied(false);
          resetTimer.current = null;
        }, COPIED_RESET_MS);
      },
      () => {
        setCopied(false);
        setError(FAILED_MESSAGE);
      },
    );
  }

  return (
    <div className="md-code-block">
      <div className="md-code-head">
        <span className="md-code-lang">{language ?? GENERIC_LANGUAGE}</span>
        <button
          type="button"
          className="md-code-copy"
          data-copied={copied}
          onClick={copy}
          aria-label={copied ? COPIED_LABEL : COPY_LABEL}
        >
          {copied ? <IconCheck /> : <IconCopy />}
          <span>{copied ? COPIED_LABEL : COPY_LABEL}</span>
        </button>
      </div>
      <pre>{children}</pre>
      {error !== "" && (
        <p className="md-code-error" role="alert">
          {error}
        </p>
      )}
      <span className="sr-only" role="status">
        {copied ? COPIED_STATUS : ""}
      </span>
    </div>
  );
}
