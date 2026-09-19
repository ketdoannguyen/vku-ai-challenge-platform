import { useState } from "react";
import type { SubmissionArtifacts } from "../api/results";
import { downloadArtifact } from "../lib/downloadArtifact";

export type ArtifactKind = "prediction" | "notebook";

const KIND_LABEL: Record<ArtifactKind, string> = {
  prediction: "CSV",
  notebook: "Notebook",
};

const KINDS: ArtifactKind[] = ["prediction", "notebook"];

/**
 * Nút tải artifact của một bài nộp.
 *
 * Dùng chung cho lịch sử của participant và bảng admin: hai nơi chỉ khác tiền tố route
 * (`/competitions/{id}/submissions` và `/admin/submissions`), còn lại giống hệt nhau.
 * Bài nộp cũ chỉ có CSV nên chỉ hiện nút nào backend thực sự có tệp.
 */
export function ArtifactLinks({
  basePath,
  submissionId,
  artifacts,
}: {
  basePath: string;
  submissionId: string;
  artifacts: SubmissionArtifacts;
}) {
  const [busy, setBusy] = useState<ArtifactKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const available = KINDS.filter((kind) => artifacts[kind]?.available);

  if (!available.length) return <span className="cell-secondary">Không có tệp</span>;

  async function save(kind: ArtifactKind) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await downloadArtifact(
        `${basePath}/${submissionId}/${kind}`,
        artifacts[kind]?.filename ?? `${submissionId}-${kind}`,
      );
    } catch (reason) {
      // Lỗi nằm trong từng dòng: một bài nộp lỗi không được làm hỏng cả bảng.
      setError(reason instanceof Error ? reason.message : "Không tải được tệp.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="artifact-links">
      {available.map((kind) => (
        <button
          key={kind}
          type="button"
          className="btn btn-secondary btn-sm artifact-link"
          disabled={busy !== null}
          title={artifacts[kind]?.filename ?? KIND_LABEL[kind]}
          onClick={() => void save(kind)}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span>{busy === kind ? "Đang tải…" : KIND_LABEL[kind]}</span>
        </button>
      ))}
      {error && <span className="cell-error">{error}</span>}
    </div>
  );
}
