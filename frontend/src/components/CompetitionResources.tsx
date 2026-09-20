/**
 * Block "Tài nguyên": notebook khung built-in của nền tảng + link dataset/sample do BTC khai báo.
 * Notebook khung không nằm trong `competitions.resources` nên luôn có mặt ở mọi cuộc thi.
 */

import { useState } from "react";
import { isSafeResourceUrl, type CompetitionResource } from "../api/competitions";
import { downloadArtifact } from "../lib/downloadArtifact";
import { ErrorBox } from "./ui";

/** Tên file dự phòng khi backend không kèm `Content-Disposition`. */
const STARTER_NOTEBOOK = {
  path: "/starter-notebook",
  filename: "starter-notebook.ipynb",
  label: "Notebook khởi đầu (.ipynb)",
};

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

export function CompetitionResources({
  resources,
}: {
  resources: CompetitionResource[];
}) {
  const safe = resources.filter((item) => isSafeResourceUrl(item.url));
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<unknown>(null);

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
        {safe.map((item, index) => (
          <li key={`${item.url}-${index}`}>
            <a
              className="resource-link"
              href={item.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
            >
              <span className="resource-label">{item.label}</span>
              <Icon>
                <path d="M14 5h5v5" />
                <path d="M19 5l-8 8" />
                <path d="M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" />
              </Icon>
            </a>
          </li>
        ))}
      </ul>
      <ErrorBox error={error} />
    </section>
  );
}
