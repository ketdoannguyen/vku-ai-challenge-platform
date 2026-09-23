/**
 * Chi tiết các lượt kiểm tra notebook bằng AI của một bài nộp.
 *
 * Modal này là nơi duy nhất admin nhìn thấy finding và bằng chứng. Bốn câu nó phải trả lời được:
 * AI kết luận gì, nội dung nào của cuộc thi có liên quan, vì sao AI đánh giá như vậy, và đoạn code
 * nào là bằng chứng. Mọi chi tiết audit khác - chạy tay hay tự động, cache, host, phiên bản prompt,
 * số cell notebook, slug nội dung - đều bị bỏ khỏi UI tác nghiệp; chúng vẫn nằm nguyên trong audit
 * row ở backend nên vẫn tra cứu được khi cần điều tra.
 *
 * Bốn điều nó phải giữ đúng:
 * - Kết luận AI là thông tin tham khảo. Câu nhắc đó đứng ngay trong thẻ kết quả, không nằm cuối modal.
 * - Không có raw prompt hay raw response ở đây - backend không lưu chúng, nên UI cũng không hứa.
 * - Mỗi thẻ kết quả lấy toàn bộ verdict, summary và finding từ ĐÚNG MỘT `AiReviewRecord`. Trộn
 *   verdict của projection này với finding của record khác sẽ tạo ra một kết luận chưa từng tồn tại.
 * - Verdict hiện trên header là kết quả SAU hậu kiểm, không phải ý kiến của model. Khi hai thứ khác
 *   nhau, thẻ phải nói ra cả hai thay vì để người đọc đoán vì sao chúng lệch.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatLocal } from "../api/competitions";
import {
  AI_VERDICT_LABEL,
  AI_VERDICT_TONE,
  FINDING_STATUS_LABEL,
  FINDING_VERIFICATION_LABEL,
  fetchAiReviewDetail,
  findingVerification,
  rerunAiReview,
  type AiFinding,
  type AiReviewDetail,
  type AiReviewRecord,
  type FindingStatus,
  type FindingVerification,
} from "../api/aiReview";
import type { ArtifactMeta, AdminSubmissionItem } from "../api/results";
import { usePendingPolling } from "../hooks/usePendingPolling";
import { downloadArtifact } from "../lib/downloadArtifact";
import { ConfirmModal, Modal } from "./Modal";
import { ErrorBox, Loading } from "./ui";

/**
 * Tông màu của một finding. Đây là quy ước trình bày của modal chứ không phải dữ liệu API: backend
 * chỉ nói finding là gì, việc dịch nó sang đỏ/vàng/xanh thuộc về chỗ hiển thị.
 */
const FINDING_TONE: Record<FindingStatus, "danger" | "warning" | "success"> = {
  VIOLATION: "danger",
  UNCLEAR: "warning",
  COMPLIANT: "success",
};

/**
 * Tông màu của trạng thái hậu kiểm. `VERIFIED` để trung tính chứ không tô xanh: nó là mặc định lành
 * mạnh, và một pill xanh cạnh pill trạng thái sẽ khiến "đã đối chiếu" trông như một kết luận. Hai
 * mức còn lại là cảnh báo vì chúng nói người đọc chớ dựa vào finding này. `UNKNOWN` không bao giờ
 * được vẽ - nhãn của nó rỗng - khóa ở đây chỉ để map đủ.
 */
const VERIFICATION_TONE: Record<FindingVerification, "neutral" | "warning"> = {
  VERIFIED: "neutral",
  RULE_ONLY: "warning",
  UNRESOLVED: "warning",
  UNKNOWN: "neutral",
};

const DISCLAIMER = "AI chỉ tham khảo, không ảnh hưởng điểm số. Ban Tổ chức quyết định cuối cùng.";

/** Ngưỡng để khỏi hiện nút "Xem thêm" cho những câu vốn đã ngắn. Chỉ là heuristic, không phải
    bảo đảm đúng hai dòng ở mọi viewport. */
const EXPAND_THRESHOLD = 180;

const secondsFormat = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });

/** `—` nghĩa là server không có số đo, không phải 0 - hai thứ đó khác nhau với người đọc. */
function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${secondsFormat.format(ms / 1000)} giây`;
}

/** Lịch sử mới nhất lên đầu; lượt chạy lại là generation cao nhất. */
function newestFirst(history: AiReviewRecord[]): AiReviewRecord[] {
  return [...history].sort((a, b) => b.generation - a.generation);
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

  const state = detail?.ai_review?.state ?? null;
  // Lượt đang chờ thì poll trong lúc modal còn mở, để admin thấy kết quả ngay tại chỗ.
  const pending = state === "QUEUED" || state === "RUNNING";
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

  // Record canonical là record mà projection trỏ tới; `settledLatest` chỉ là record gần nhất đang có.
  // Sau một lượt chạy lại hỏng, backend đã xoá `latest_review_id`, nên hai thứ này khác nhau - và
  // record cũ phải được gọi là "kết quả gần nhất", không phải "kết quả hiện tại".
  const ordered = newestFirst(detail?.history ?? []);
  const canonicalId = projection?.latest_review_id ?? null;
  const canonical = canonicalId ? ordered.find((record) => record.id === canonicalId) ?? null : null;
  const settledLatest = ordered[0] ?? null;
  const featured =
    state === "COMPLETED" || state === "ERROR" ? canonical ?? settledLatest : settledLatest;
  const others = ordered.filter((record) => record.id !== featured?.id);

  const heading =
    state === "COMPLETED"
      ? "Kết quả đánh giá"
      : state === "ERROR"
        ? "Chi tiết lượt không hoàn tất"
        : "Kết quả gần nhất";

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
          <div className="ai-actions">
            <button
              className="btn btn-secondary ai-action"
              type="button"
              disabled={downloading || !submission.artifacts.notebook?.available}
              onClick={() => void downloadNotebook(submission.artifacts.notebook)}
            >
              <DownloadIcon />
              {downloading ? "Đang tải…" : "Tải notebook"}
            </button>
            <button
              className="btn ai-action ai-action-primary"
              type="button"
              disabled={busy || !canRerun || pending}
              onClick={() => {
                setRerunError(null);
                setConfirmingRerun(true);
              }}
            >
              <RefreshIcon />
              Chạy lại AI
            </button>
          </div>

          {/* Lỗi nằm sát nút vừa sinh ra nó, không trôi xuống cuối modal. */}
          {downloadError && (
            <p className="ai-action-error" role="alert">
              {downloadError}
            </p>
          )}
          {rerunError ? <ErrorBox error={rerunError} /> : null}

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

          {pending && (
            <p className="ai-status" role="status">
              <span className="ai-spinner" aria-hidden="true" />
              AI đang kiểm tra notebook…
            </p>
          )}
          {state === null && !featured && (
            <p className="ai-empty text-muted">Bài nộp này chưa có kết quả kiểm tra AI.</p>
          )}
          {state === null && featured && (
            <p className="ai-notice">
              Bài nộp này hiện không có lượt kiểm tra AI nào đang chạy; kết quả dưới đây là lượt gần
              nhất được lưu lại.
            </p>
          )}
          {state === "COMPLETED" && !featured && (
            <p className="ai-empty text-muted">Không tìm thấy chi tiết kết quả AI.</p>
          )}
          {state === "ERROR" && !featured && (
            <p className="ai-empty text-muted">AI chưa thể hoàn tất kiểm tra.</p>
          )}

          {featured && <ResultCard heading={heading} record={featured} />}

          {others.length > 0 && (
            <section className="ai-history">
              <h3 className="ai-section-heading">Các lượt trước</h3>
              <ul className="ai-history-list">
                {others.map((record) => (
                  <HistoryItem key={record.id} record={record} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {confirmingRerun && (
        <ConfirmModal
          title="Chạy lại kiểm tra AI"
          body="Hệ thống sẽ tạo một lượt kiểm tra mới. Kết quả cũ vẫn được lưu trong lịch sử."
          confirmLabel="Chạy lại"
          onConfirm={rerun}
          onClose={() => setConfirmingRerun(false)}
        />
      )}
    </Modal>
  );
}

/**
 * Thẻ kết quả của đúng một lượt chạy: verdict, câu nhắc, bốn dữ kiện và mọi finding của lượt đó.
 * Không có nhánh nào ở đây lấy dữ liệu từ record khác.
 */
function ResultCard({ heading, record }: { heading: string; record: AiReviewRecord }) {
  const noFindingCopy =
    record.verdict === "CLEAR"
      ? "Không phát hiện nội dung vi phạm."
      : record.verdict === "INCONCLUSIVE"
        ? "Không có bằng chứng đủ để kết luận."
        : null;

  return (
    <section className={`ai-result-card tone-${AI_VERDICT_TONE[record.verdict]}`}>
      <header className="ai-result-head">
        <h3 className="ai-result-title">{heading}</h3>
        <span className={`status-badge ${AI_VERDICT_TONE[record.verdict]}`}>
          {AI_VERDICT_LABEL[record.verdict]}
        </span>
      </header>

      <p className="ai-result-disclaimer">{DISCLAIMER}</p>

      <RunFacts record={record} />

      {(record.summary || record.participant_summary) && (
        <div className="ai-notes">
          {record.summary && (
            <div className="ai-note">
              <h4 className="ai-note-label">Nhận xét của AI</h4>
              <ExpandableText text={record.summary} />
            </div>
          )}

          {record.participant_summary && (
            <div className="ai-note">
              <h4 className="ai-note-label">Gợi ý cho thí sinh</h4>
              <ExpandableText text={record.participant_summary} />
            </div>
          )}
        </div>
      )}

      {/* Kết luận thô khác kết luận cuối nghĩa là server đã hạ cấp. Câu này nói đủ hai vế - AI đề
          xuất gì và hậu kiểm kết luận gì - để admin không đọc pill ở header thành ý kiến của model;
          nó không dịch mã hạ cấp của backend thành văn xuôi. */}
      {record.model_verdict && record.model_verdict !== record.verdict && (
        <p className="ai-downgrade">
          AI đề xuất “{AI_VERDICT_LABEL[record.model_verdict]}”. Sau khi hậu kiểm quy định và bằng
          chứng, kết quả cuối là “{AI_VERDICT_LABEL[record.verdict]}”.
        </p>
      )}

      {record.notebook_stats?.truncated && (
        <p className="ai-note-warning">Notebook chưa được kiểm tra toàn bộ.</p>
      )}

      {record.error && (
        <p className="cell-error" role="alert">
          {record.error.message}
        </p>
      )}

      {record.findings.length > 0 ? (
        <ul className="ai-finding-list">
          {record.findings.map((finding, index) => (
            <FindingItem key={`${record.id}-${index}`} finding={finding} />
          ))}
        </ul>
      ) : (
        noFindingCopy && <p className="ai-finding-empty">{noFindingCopy}</p>
      )}
    </section>
  );
}

/** Đúng ba dữ kiện của một lượt, cộng verdict ở header thành bốn. */
function RunFacts({ record }: { record: AiReviewRecord }) {
  return (
    <dl className="ai-run-facts">
      <div className="ai-fact">
        <dt>Hoàn tất</dt>
        <dd>{formatLocal(record.completed_at ?? record.created_at)}</dd>
      </div>
      <div className="ai-fact">
        <dt>Thời gian chạy</dt>
        <dd>{formatDuration(record.duration_ms)}</dd>
      </div>
      <div className="ai-fact ai-fact-wide">
        <dt>Model</dt>
        <dd className="ai-fact-model">{record.model ?? "—"}</dd>
      </div>
    </dl>
  );
}

/**
 * Một lượt cũ. Đóng mặc định và khi đóng chỉ giữ bốn dữ kiện admin cần để quét nhanh; phần thân mở
 * ra mới có nhận xét và finding. Dùng `<details>` native nên bàn phím và screen reader đã đúng sẵn.
 */
function HistoryItem({ record }: { record: AiReviewRecord }) {
  return (
    <li>
      <details className="ai-history-item">
        <summary className="ai-history-summary">
          <span className={`status-badge ${AI_VERDICT_TONE[record.verdict]}`}>
            {AI_VERDICT_LABEL[record.verdict]}
          </span>
          <HistoryFact label="Hoàn tất" value={formatLocal(record.completed_at ?? record.created_at)} />
          <HistoryFact label="Thời gian chạy" value={formatDuration(record.duration_ms)} />
          <HistoryFact label="Model" value={record.model ?? "—"} />
        </summary>
        <div className="ai-history-body">
          {record.summary && <p>{record.summary}</p>}
          {record.error && (
            <p className="cell-error" role="alert">
              {record.error.message}
            </p>
          )}
          {record.findings.length > 0 && (
            <ul className="ai-finding-list">
              {record.findings.map((finding, index) => (
                <FindingItem key={`${record.id}-${index}`} finding={finding} />
              ))}
            </ul>
          )}
        </div>
      </details>
    </li>
  );
}

function HistoryFact({ label, value }: { label: string; value: string }) {
  return (
    <span className="ai-history-fact">
      <span className="ai-history-fact-label">{label}</span>
      <span className="ai-history-fact-value">{value}</span>
    </span>
  );
}

/**
 * Một đối chiếu giữa thể lệ và notebook. `rule_text` là nguyên văn thể lệ và `reason` là lời giải
 * thích của model - hai đoạn tách bạch, không trộn thành một khối. Bằng chứng hiển thị nguyên văn
 * trong `<pre>` vì đó là đoạn notebook server tự trích lại, không phải output của model.
 *
 * Badge hậu kiểm đứng cạnh badge trạng thái vì hai câu hỏi khác nhau: notebook đã làm gì, và nhận
 * định về nó đã được đối chiếu tới đâu. Với một finding `VIOLATION` chưa đối chiếu được, vế thứ hai
 * mới là vế quyết định người đọc có nên hành động hay không.
 */
function FindingItem({ finding }: { finding: AiFinding }) {
  const verification = findingVerification(finding);
  const unresolved = verification === "UNRESOLVED";
  const note = evidenceNote(finding);

  return (
    <li className="ai-finding">
      <div className="ai-finding-head">
        <span className={`status-badge ${FINDING_TONE[finding.status]}`}>
          {FINDING_STATUS_LABEL[finding.status]}
        </span>
        {FINDING_VERIFICATION_LABEL[verification] && (
          <span className={`status-badge ${VERIFICATION_TONE[verification]}`}>
            {FINDING_VERIFICATION_LABEL[verification]}
          </span>
        )}
        {/* Chỉ nói "ngoài notebook" khi đó là điều bất thường; còn lại là mặc định nên không cần chip. */}
        {finding.checkability === "NOT_CHECKABLE_FROM_NOTEBOOK" && (
          <span className="status-badge neutral">Ngoài notebook</span>
        )}
        {/* Không resolve được quy định thì backend để trống tên trang; ô rỗng không nói lên điều gì. */}
        {finding.source_content_title && (
          <strong className="ai-finding-title">{finding.source_content_title}</strong>
        )}
      </div>

      {(finding.rule_text || finding.reason) && (
        <div className="ai-finding-texts">
          {finding.rule_text && (
            <ExpandableText className="ai-finding-rule" text={finding.rule_text} />
          )}
          {finding.reason && (
            <ExpandableText className="ai-finding-reason" text={finding.reason} />
          )}
        </div>
      )}

      {/* Không có văn bản thể lệ nào để hiện, và bản sao model gửi cũng KHÔNG được dán vào đây: người
          đọc sẽ tưởng đó là trích dẫn từ bản thể lệ đã chốt, đúng thứ mà hậu kiểm vừa bác bỏ. */}
      {unresolved && (
        <p className="ai-finding-unresolved">
          Tham chiếu quy định của AI không khớp với bản thể lệ đã chốt tại thời điểm nộp, nên nhận
          định này chưa có căn cứ thể lệ.
        </p>
      )}

      {finding.evidence.map((evidence, index) => (
        <figure key={index} className="ai-evidence">
          <figcaption className="ai-evidence-meta">
            Dòng {evidence.start_line}–{evidence.end_line} · Cell {evidence.cell}
          </figcaption>
          <pre>{evidence.snippet}</pre>
        </figure>
      ))}
      {note && <p className="ai-evidence-missing">{note}</p>}
    </li>
  );
}

/**
 * Câu duy nhất nói về bằng chứng, hoặc `null` khi không có gì đáng nói.
 *
 * `evidence_count` và `valid_evidence_count` chỉ có ở row từ bản Hybrid B+D. Row cũ thiếu hai số đó
 * thì chỉ được nói điều hiển nhiên là danh sách bằng chứng rỗng, không được suy diễn là "AI có nêu
 * nhưng server bỏ" - đó là bịa thêm dữ kiện mà audit row không có.
 */
function evidenceNote(finding: AiFinding): string | null {
  const dropped =
    typeof finding.evidence_count === "number" &&
    typeof finding.valid_evidence_count === "number" &&
    finding.valid_evidence_count < finding.evidence_count;

  if (finding.evidence.length > 0) {
    return dropped ? "Một số đoạn trích AI nêu không khớp với notebook nên đã bị bỏ." : null;
  }
  if (dropped) return "Không đoạn trích nào của AI khớp với notebook.";
  // Chỉ cáo buộc mới bắt buộc phải có bằng chứng; thiếu ở mức khác là chuyện bình thường.
  return finding.status === "VIOLATION" || finding.status === "UNCLEAR"
    ? "Không có đoạn code được xác minh."
    : null;
}

/**
 * Văn bản dài có thể dài tới hàng nghìn ký tự, hiện thẳng sẽ đẩy finding khác ra khỏi tầm mắt. Thu
 * gọn bằng CSS clamp chứ không cắt chuỗi: toàn bộ nội dung vẫn nằm trong DOM, nên tìm kiếm trong
 * trang và screen reader vẫn thấy đủ.
 */
function ExpandableText({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const textId = useId();
  const long = text.length > EXPAND_THRESHOLD;

  return (
    <div className={`ai-expandable${className ? ` ${className}` : ""}`}>
      <p id={textId} className={`ai-expandable-text${long && !expanded ? " is-clamped" : ""}`}>
        {text}
      </p>
      {long && (
        <button
          type="button"
          className="ai-expand-toggle"
          aria-expanded={expanded}
          aria-controls={textId}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Thu gọn" : "Xem thêm"}
        </button>
      )}
    </div>
  );
}

/* Icon trang trí cạnh chữ đã có nghĩa: ẩn khỏi accessibility tree để không đọc thừa. */
function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M23 4v6h-6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
