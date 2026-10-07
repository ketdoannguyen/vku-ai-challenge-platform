/**
 * Block "Tài nguyên": notebook khung built-in của nền tảng + link dataset/sample do BTC khai báo.
 * Notebook khung không nằm trong `competitions.resources` nên luôn có mặt ở mọi cuộc thi.
 */

import { useEffect, useRef, useState } from "react";
import { isSafeResourceUrl, type CompetitionResource } from "../api/competitions";
import { downloadArtifact } from "../lib/downloadArtifact";
import { ErrorBox } from "./ui";

/** Tên file dự phòng khi backend không kèm `Content-Disposition`. */
const STARTER_NOTEBOOK = {
  path: "/starter-notebook",
  filename: "starter-notebook.ipynb",
  label: "Notebook khởi đầu (.ipynb)",
};

/** Giữ phản hồi "đã sao chép" trên nút trước khi trả icon về trạng thái gốc. */
const COPIED_RESET_MS = 2000;

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function CopyIcon() {
  return (
    <Icon>
      <rect x="8" y="8" width="14" height="14" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Icon>
  );
}

function CopiedIcon() {
  return (
    <Icon>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}

function OpenIcon() {
  return (
    <Icon>
      <path d="M14 5h5v5" />
      <path d="M19 5l-8 8" />
      <path d="M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" />
    </Icon>
  );
}

export function CompetitionResources({
  resources,
}: {
  resources: CompetitionResource[];
}) {
  const safe = resources.filter((item) => isSafeResourceUrl(item.url));
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState<CompetitionResource | null>(null);
  const copyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  async function downloadStarterNotebook() {
    setDownloading(true);
    setError(null);
    try {
      await downloadArtifact(STARTER_NOTEBOOK.path, STARTER_NOTEBOOK.filename);
    } catch (err) {
      setError(err);
    } finally {
      setDownloading(false);
    }
  }

  /** Lỗi sao chép không có chỗ báo riêng nên dùng chung ErrorBox; danh sách link giữ nguyên. */
  function copyLink(item: CompetitionResource) {
    if (!navigator.clipboard) {
      setError(new Error(`Trình duyệt không cho phép sao chép tự động — liên kết là: ${item.url}`));
      return;
    }
    navigator.clipboard.writeText(item.url).then(
      () => {
        setError(null);
        setCopied(item);
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => {
          setCopied(null);
          copyTimer.current = null;
        }, COPIED_RESET_MS);
      },
      () =>
        setError(new Error(`Không sao chép được liên kết — hãy sao chép thủ công: ${item.url}`)),
    );
  }

  return (
    <section
      className="content-card content-card-resources content-card-vku"
      aria-labelledby="competition-resources-title"
    >
      <div className="content-card-head">
        <span className="content-card-title" id="competition-resources-title">
          <Icon>
            <ellipse cx="12" cy="6" rx="7" ry="3" />
            <path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
            <path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
          </Icon>
          Tài nguyên
        </span>
        <span className="content-card-count">{1 + safe.length}</span>
      </div>
      <ul className="resource-list">
        <li>
          <button
            type="button"
            className="resource-link"
            onClick={() => void downloadStarterNotebook()}
            disabled={downloading}
          >
            <span className="resource-label">{STARTER_NOTEBOOK.label}</span>
            <Icon>
              <path d="M12 4v11" />
              <path d="m8 11 4 4 4-4" />
              <path d="M5 20h14" />
            </Icon>
          </button>
        </li>
        {safe.map((item, index) => {
          const isCopied = copied?.url === item.url;
          return (
            <li key={`${item.url}-${index}`} className="resource-row">
              <span className="resource-label">{item.label}</span>
              {/* Mỗi link ngoài hai thao tác tách bạch: sao chép URL và mở trong tab mới. */}
              <button
                type="button"
                className={`btn btn-secondary btn-sm resource-action${isCopied ? " copied" : ""}`}
                title={isCopied ? "Đã sao chép" : "Sao chép liên kết"}
                aria-label={
                  isCopied
                    ? `Đã sao chép liên kết: ${item.label}`
                    : `Sao chép liên kết: ${item.label}`
                }
                onClick={() => copyLink(item)}
              >
                {isCopied ? <CopiedIcon /> : <CopyIcon />}
              </button>
              <a
                className="btn btn-secondary btn-sm resource-action"
                href={item.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                title="Mở liên kết trong tab mới"
                aria-label={`Mở liên kết: ${item.label}`}
              >
                <OpenIcon />
              </a>
            </li>
          );
        })}
      </ul>
      {/* Phản hồi sao chép chỉ đi qua live region: không đụng trạng thái tải notebook. */}
      <p className="sr-only" role="status">
        {copied ? `Đã sao chép liên kết "${copied.label}" vào clipboard.` : ""}
      </p>
      <ErrorBox error={error} />
    </section>
  );
}
