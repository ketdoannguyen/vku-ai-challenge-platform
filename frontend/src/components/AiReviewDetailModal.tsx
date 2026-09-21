/**
 * Chi tiết các lượt kiểm tra notebook bằng AI của một bài nộp.
 *
 * Modal này là nơi duy nhất admin nhìn thấy finding và bằng chứng. Ba điều nó phải giữ đúng:
 * - Kết luận AI là thông tin tham khảo. Câu nhắc đó đứng ngay cạnh verdict, không nằm cuối modal.
 * - Không có raw prompt hay raw response ở đây - backend không lưu chúng, nên UI cũng không hứa.
 * - Bằng chứng hiển thị nguyên văn trong `<pre>`: đó là đoạn notebook server tự trích lại, không
 *   phải output của model.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { formatLocal } from "../api/competitions";
import {
  AI_VERDICT_LABEL,
  AI_VERDICT_TONE,
  CHECKABILITY_LABEL,
  FINDING_STATUS_LABEL,
  fetchAiReviewDetail,
  rerunAiReview,
  type AiFinding,
  type AiReviewDetail,
  type AiReviewRecord,
} from "../api/aiReview";
import type { ArtifactMeta, AdminSubmissionItem } from "../api/results";
import { usePendingPolling } from "../hooks/usePendingPolling";
import { downloadArtifact } from "../lib/downloadArtifact";
import { ConfirmModal, Modal } from "./Modal";
import { ErrorBox, Loading } from "./ui";

/** Nhãn nguồn của một lượt: model thật, dùng lại cache, hay chính pipeline tự kết luận. */
const SOURCE_LABEL: Record<AiReviewRecord["source"], string> = {
  PROVIDER: "Gọi model",
  CACHE: "Dùng lại kết quả cũ",
  PIPELINE: "Pipeline tự kết luận",
};

const STATUS_LABEL: Record<AiReviewRecord["status"], string> = {
  COMPLETED: "Hoàn tất",
  FAILED: "Hỏng",
};

/** Lịch sử mới nhất lên đầu; lượt chạy lại là generation cao nhất. */
function newestFirst(history: AiReviewRecord[]): AiReviewRecord[] {
  return [...history].sort((a, b) => b.generation - a.generation);
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function AiReviewDetailModal({
  submission,
  onChanged,
  onClose,
  returnFocusRef,
}: {
  submission: AdminSubmissionItem;
  /** Gọi sau khi chạy lại thành công để bảng phía sau làm mới đúng trang đang xem. */
  onChanged: () => void;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const [detail, setDetail] = useState<AiReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [rerunError, setRerunError] = useState<unknown>(null);
  const [confirmingRerun, setConfirmingRerun] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const requestSequence = useRef(0);

  const load = useCallback(
    async (keepCurrent: boolean) => {
      const sequence = ++requestSequence.current;
      if (!keepCurrent) {
        setError(null);
        // Tải lại từ đầu (lần đầu, bấm "Thử lại", hoặc sau khi chạy lại) phải hiện lại trạng thái
        // đang tải: nếu không, modal rơi vào nhánh chính với `detail` cũ và báo sai là không có lượt.
        setLoading(true);
      }
      try {
        const response = await fetchAiReviewDetail(submission.id);
        // Lượt tải cũ không được ghi đè lượt mới khi admin bấm chạy lại liên tiếp.
        if (sequence !== requestSequence.current) return;
        setDetail(response);
        setError(null);
      } catch (reason) {
        if (sequence === requestSequence.current && !keepCurrent) setError(reason);
      } finally {
        if (sequence === requestSequence.current) setLoading(false);
      }
    },
    [submission.id],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // Lượt đang chờ thì poll trong lúc modal còn mở, để admin thấy kết quả ngay tại chỗ.
  const pending =
    detail?.ai_review?.state === "QUEUED" || detail?.ai_review?.state === "RUNNING";
  const exhausted = usePendingPolling(pending, () => void load(true));

  async function rerun() {
    setBusy(true);
    setRerunError(null);
    try {
      await rerunAiReview(submission.id);
      setConfirmingRerun(false);
      await load(false);
      onChanged();
    } catch (reason) {
      setRerunError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function downloadNotebook(artifact: ArtifactMeta | null) {
    if (downloading) return;
    setDownloading(true);
    setDownloadError("");
    try {
      await downloadArtifact(
        `/admin/submissions/${submission.id}/notebook`,
        artifact?.filename ?? "notebook.ipynb",
      );
    } catch (reason) {
      setDownloadError(reason instanceof Error ? reason.message : "Không tải được tệp.");
    } finally {
      setDownloading(false);
    }
  }

  const projection = detail?.ai_review ?? null;
  const snapshot = detail?.content_snapshot ?? null;
  // Chạy lại cần một bản thể lệ đã chụp tại thời điểm nộp; thiếu thì backend trả 422.
  const canRerun = snapshot?.state === "CAPTURED";

  return (
    <Modal
      title={`Kiểm tra AI · ${submission.account.name}`}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      {loading ? (
        <Loading label="Đang tải chi tiết kiểm tra AI..." />
      ) : error ? (
        <div className="admin-section-error">
          <ErrorBox error={error} />
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => void load(false)}>
            Thử lại
          </button>
        </div>
      ) : (
        <div className="ai-detail">
          <p className="ai-detail-disclaimer">
            Kết luận dưới đây chỉ mang tính tham khảo, <strong>không ảnh hưởng điểm số</strong> và
            không loại bài nộp khỏi kết quả. Chỉ quyết định của Ban Tổ chức mới làm được điều đó.
          </p>

          <section className="ai-detail-verdict">
            {projection ? (
              <>
                <span className={`status-badge ${AI_VERDICT_TONE[projection.verdict ?? "ERROR"]}`}>
                  {AI_VERDICT_LABEL[projection.verdict ?? "ERROR"]}
                </span>
                <p>{projection.summary}</p>
              </>
            ) : (
              <p className="text-muted">
                Bài nộp này không có lượt kiểm tra AI nào. Cuộc thi có thể chưa bật AI lúc nộp bài.
              </p>
            )}
          </section>

          {snapshot && snapshot.state !== "CAPTURED" && (
            <div className="status-banner warning">
              Không chụp được bản thể lệ tại thời điểm nộp ({snapshot.error_code ?? "lỗi không rõ"}),
              nên không chạy lại được cho bài này.
            </div>
          )}
          {exhausted && (
            <div className="status-banner warning">
              Đã tạm dừng tự động làm mới. Đóng và mở lại để xem kết quả mới nhất.
            </div>
          )}

          <div className="ai-detail-actions">
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              disabled={downloading || !submission.artifacts.notebook?.available}
              onClick={() => void downloadNotebook(submission.artifacts.notebook)}
            >
              {downloading ? "Đang tải…" : "Tải notebook"}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              disabled={busy || !canRerun || pending}
              onClick={() => {
                setRerunError(null);
                setConfirmingRerun(true);
              }}
            >
              Chạy lại AI
            </button>
            {pending && <span className="text-muted">Một lượt kiểm tra đang chạy.</span>}
          </div>

          {downloadError && <span className="cell-error">{downloadError}</span>}
          {rerunError ? <ErrorBox error={rerunError} /> : null}

          <h3 className="ai-detail-heading">Lịch sử các lượt chạy</h3>
          {!detail || detail.history.length === 0 ? (
            <p className="text-muted">Chưa có lượt nào được ghi lại.</p>
          ) : (
            <ul className="ai-run-list">
              {newestFirst(detail.history).map((record) => (
                <RunItem key={record.id} record={record} />
              ))}
            </ul>
          )}
        </div>
      )}

      {confirmingRerun && (
        <ConfirmModal
          title="Chạy lại kiểm tra AI"
          body="Chạy lại sẽ bỏ qua kết quả đã lưu và gọi model một lần nữa. Các lượt cũ vẫn được giữ trong lịch sử. Kết quả không làm thay đổi điểm số hay quyết định của Ban Tổ chức."
          confirmLabel="Chạy lại"
          onConfirm={rerun}
          onClose={() => setConfirmingRerun(false)}
        />
      )}
    </Modal>
  );
}

/** Một lượt trong lịch sử. Lượt hỏng chỉ hiện lỗi đã che, không hiện finding rỗng. */
function RunItem({ record }: { record: AiReviewRecord }) {
  return (
    <li className="ai-run-item">
      <div className="ai-run-head">
        <strong>Lần #{record.generation}</strong>
        <span className={`status-badge ${AI_VERDICT_TONE[record.verdict]}`}>
          {AI_VERDICT_LABEL[record.verdict]}
        </span>
        {record.manual && <span className="status-badge neutral">Chạy tay</span>}
        {record.bypass_cache && <span className="status-badge neutral">Bỏ qua cache</span>}
        <span className="cell-secondary">{SOURCE_LABEL[record.source]}</span>
      </div>

      <div className="ai-run-meta">
        <span>{STATUS_LABEL[record.status]}</span>
        <span>{formatLocal(record.created_at)}</span>
        <span>{formatDuration(record.duration_ms)}</span>
        {record.provider_host && <span>{record.provider_host}</span>}
        {record.model && <span>{record.model}</span>}
        {record.versions.prompt && <span>prompt {record.versions.prompt}</span>}
      </div>

      {record.summary && <p>{record.summary}</p>}

      {/* Kết luận thô khác kết luận cuối nghĩa là server đã hạ cấp vì thiếu bằng chứng. */}
      {record.model_verdict && record.model_verdict !== record.verdict && (
        <p className="cell-secondary">
          Model trả về “{AI_VERDICT_LABEL[record.model_verdict]}”, đã hạ cấp thành “
          {AI_VERDICT_LABEL[record.verdict]}”.
        </p>
      )}
      {record.downgrade_codes.length > 0 && (
        <p className="cell-secondary">Hạ cấp: {record.downgrade_codes.join(", ")}</p>
      )}
      {record.error && <p className="cell-error">{record.error.message}</p>}

      <NotebookStats stats={record.notebook_stats} />

      {record.findings.length > 0 && (
        <ul className="ai-finding-list">
          {record.findings.map((finding, index) => (
            <FindingItem key={`${record.id}-${index}`} finding={finding} />
          ))}
        </ul>
      )}
    </li>
  );
}

function NotebookStats({ stats }: { stats: AiReviewRecord["notebook_stats"] }) {
  if (!stats || stats.cells == null) return null;
  return (
    <p className="cell-secondary">
      Notebook: {stats.cells} cell ({stats.code_cells} code, {stats.markdown_cells} markdown),{" "}
      {stats.lines} dòng
      {stats.truncated ? `, đã lược bớt ${stats.omitted_cells} cell` : ""}.
    </p>
  );
}

/** Một đối chiếu giữa thể lệ và notebook; `rule_text` là nguyên văn thể lệ nên giữ trong `<q>`. */
function FindingItem({ finding }: { finding: AiFinding }) {
  return (
    <li className="ai-finding">
      <div className="ai-finding-head">
        <span className="status-badge warning">{FINDING_STATUS_LABEL[finding.status]}</span>
        <strong>{finding.source_content_title}</strong>
        <span className="cell-secondary">{finding.source_content_slug}</span>
      </div>
      <blockquote className="ai-finding-rule">{finding.rule_text}</blockquote>
      <p className="cell-secondary">{CHECKABILITY_LABEL[finding.checkability]}</p>
      <p>{finding.reason}</p>
      {finding.evidence.map((evidence, index) => (
        <figure key={index} className="ai-evidence">
          <figcaption className="cell-secondary">
            Cell {evidence.cell} · dòng {evidence.start_line}–{evidence.end_line}
          </figcaption>
          <pre>{evidence.snippet}</pre>
        </figure>
      ))}
    </li>
  );
}
