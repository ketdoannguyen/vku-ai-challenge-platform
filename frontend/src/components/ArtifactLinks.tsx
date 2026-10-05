import { lazy, useState } from "react";
import type { SubmissionArtifacts } from "../api/results";
import { downloadArtifact } from "../lib/downloadArtifact";

export type ArtifactKind = "prediction" | "notebook";

/** Tệp cần mở trong trình xem; nơi gọi giữ nó ở cấp danh sách chứ không phải từng dòng. */
export interface ArtifactViewerTarget {
  kind: ArtifactKind;
  submissionId: string;
  filename: string;
}

const KIND_LABEL: Record<ArtifactKind, string> = {
  prediction: "CSV",
  notebook: "Notebook",
};

const KINDS: ArtifactKind[] = ["prediction", "notebook"];

function ViewIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

/**
 * Trình xem được nạp lười. Định nghĩa đặt cạnh nút mở nó để hai nơi gọi dùng chung một điểm nạp:
 * chunk chỉ tải một lần, ở lần mở trình xem đầu tiên.
 */
export const LazyArtifactViewerModal = lazy(() =>
  import("./ArtifactViewer").then((module) => ({ default: module.ArtifactViewerModal })),
);

/**
 * Nút xem/tải artifact của một bài nộp.
 *
 * Dùng chung cho lịch sử của participant và bảng admin: hai nơi chỉ khác tiền tố route
 * (`/competitions/{id}/submissions` và `/admin/submissions`), còn lại giống hệt nhau.
 * Bài nộp cũ chỉ có CSV nên chỉ hiện nút nào backend thực sự có tệp.
 *
 * Trạng thái trình xem không nằm ở đây: nơi gọi giữ MỘT trình xem cho cả danh sách và nhận tệp
 * cần mở qua `onView`. Mỗi dòng tự mở modal riêng thì mở được nhiều modal cùng lúc, còn tín hiệu
 * "đang mở" báo theo từng dòng sẽ báo đóng sớm khi một dòng khác vẫn đang mở.
 */
export function ArtifactLinks({
  basePath,
  submissionId,
  artifacts,
  onView,
}: {
  basePath: string;
  submissionId: string;
  artifacts: SubmissionArtifacts;
  /** Thiếu callback thì không có nút xem - nơi gọi không có chỗ dựng trình xem. */
  onView?: (kind: ArtifactKind, submissionId: string, filename: string) => void;
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
        <span className="artifact-link-group" key={kind}>
          <span className="artifact-link-kind">{KIND_LABEL[kind]}</span>
          {onView && (
            <button
              type="button"
              className="btn btn-secondary btn-sm artifact-link artifact-link-icon"
              aria-label={`Xem ${KIND_LABEL[kind]}`}
              disabled={busy !== null}
              title={artifacts[kind]?.filename ?? KIND_LABEL[kind]}
              onClick={(event) => {
                // Trình xem nạp lười nên modal chỉ mount sau cú bấm, và nó chốt "focus trước đó"
                // ngay lúc mount. Đặt focus vào nút này tại đây để lượt đóng trả focus về đúng
                // chỗ - trình duyệt không tự làm việc đó khi bấm bằng chuột.
                event.currentTarget.focus();
                onView(kind, submissionId, artifacts[kind]?.filename ?? KIND_LABEL[kind]);
              }}
            >
              <ViewIcon />
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm artifact-link artifact-link-icon"
            aria-label={`Tải ${KIND_LABEL[kind]}`}
            aria-busy={busy === kind}
            disabled={busy !== null}
            title={artifacts[kind]?.filename ?? KIND_LABEL[kind]}
            onClick={() => void save(kind)}
          >
            {busy === kind ? (
              <span className="artifact-link-spinner" aria-hidden="true" />
            ) : (
              <DownloadIcon />
            )}
          </button>
        </span>
      ))}
      {error && <span className="cell-error">{error}</span>}
    </div>
  );
}
