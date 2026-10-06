/**
 * Modal từ chối một bài đã chấm điểm. Lý do là bắt buộc vì participant sẽ đọc chính nó,
 * nên nút xác nhận chỉ bật khi lý do sau khi trim còn nội dung.
 */

import { useState, type FormEvent, type RefObject } from "react";
import type { AdminSubmissionItem, ReviewPayload } from "../api/results";
import { Modal } from "./Modal";

const MAX_NOTE_LENGTH = 1000;

/**
 * Câu yêu cầu cố định, gắn vào lý do khi nguồn dữ liệu có dấu hiệu ngoài cuộc thi hoặc chưa xác
 * minh được. Đây là chữ của hệ thống chứ không phải của model, cố định để admin không phải gõ lại
 * mỗi lần từ chối.
 */
const BTC_RESOURCE_REQUIREMENT = "Code phải tải dữ liệu từ link tài nguyên của BTC.";

interface Prefill {
  text: string;
  /** Bản nháp của model có mặt trong `text`. */
  aiDraft: boolean;
  /** Câu yêu cầu cố định có mặt trong `text`. */
  resourceRequirement: boolean;
}

/**
 * Dựng sẵn nội dung ô lý do từ dữ liệu của lượt kiểm tra gần nhất.
 *
 * Gợi ý của model chỉ điền sẵn khi verdict là FLAGGED: đó là lượt đã có ít nhất một vi phạm được
 * server kiểm chứng. Một verdict bị hạ cấp xuống INCONCLUSIVE nghĩa là máy chủ vừa bác bỏ chính
 * cáo buộc đó, nên điền sẵn lúc ấy là tự động hoá một lời buộc tội chưa được xác minh.
 *
 * Câu yêu cầu tải dữ liệu từ link tài nguyên của BTC thì độc lập với verdict: nguồn có dấu hiệu
 * dùng nguồn ngoài hoặc chưa xác minh được là đủ để nhắc thí sinh, kể cả khi AI không thấy vi phạm
 * thể lệ. `NOT_EVALUATED` không kích hoạt câu này - nó thường nghĩa là cuộc thi không có tài
 * nguyên BTC để đối chiếu, nên nhắc thí sinh dùng link tài nguyên BTC lúc ấy là sai đối tượng. Hai
 * phần nối với nhau thành một lý do duy nhất.
 *
 * Chữ được lưu và gửi đi vẫn là chữ admin đọc lại và sửa trong ô này - không phải bản của model.
 */
function prefillNote(submission: AdminSubmissionItem): Prefill {
  const review = submission.ai_review;
  const aiDraft =
    review?.verdict === "FLAGGED" ? (review.participant_summary?.trim() ?? "") : "";
  const source = review?.source_status ?? null;
  const resourceRequirement = source === "EXTERNAL" || source === "UNCLEAR";
  return {
    text: [aiDraft, resourceRequirement ? BTC_RESOURCE_REQUIREMENT : ""].filter(Boolean).join("\n\n"),
    aiDraft: aiDraft !== "",
    resourceRequirement,
  };
}

export function SubmissionRejectModal({
  submission,
  onConfirm,
  onClose,
  returnFocusRef,
}: {
  submission: AdminSubmissionItem;
  onConfirm: (payload: ReviewPayload) => Promise<void>;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const prefill = prefillNote(submission);
  const [note, setNote] = useState(prefill.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmed = note.trim();
  const suggested = prefill.text !== "";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm({ status: "rejected", note: trimmed });
    } catch (err) {
      // Giữ modal mở và giữ nguyên lý do đã gõ để admin thử lại.
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Không chấp nhận bài nộp"
      onClose={onClose}
      variant="account-form"
      returnFocusRef={returnFocusRef}
    >
      <form className="account-form-modal" onSubmit={submit}>
        <p className="text-muted">
          Bài nộp của <strong>{submission.account.name}</strong> vẫn được lưu cùng tệp đã nộp và
          vẫn tính là một lượt nộp, nhưng sẽ không được tính vào kết quả, bảng xếp hạng và file
          xuất.
        </p>
        {suggested && (
          <p className="text-muted" id="review-note-suggestion">
            {prefill.aiDraft && prefill.resourceRequirement
              ? "Lý do dưới đây do AI soạn nháp từ lượt kiểm tra gần nhất, nối thêm câu yêu cầu tải dữ liệu từ link tài nguyên của BTC."
              : prefill.aiDraft
                ? "Lý do dưới đây do AI soạn nháp từ lượt kiểm tra gần nhất."
                : "Lý do dưới đây được điền sẵn câu yêu cầu tải dữ liệu từ link tài nguyên của BTC vì nguồn dữ liệu chưa xác minh hoặc có dấu hiệu dùng nguồn ngoài."}{" "}
            Hãy đọc lại và sửa trước khi gửi: thí sinh chỉ nhận đúng chữ bạn để lại trong ô này.
          </p>
        )}
        <div className="form-field account-form-wide">
          <label className="field-label account-required" htmlFor="review-note">
            Lý do không chấp nhận
          </label>
          <textarea
            id="review-note"
            className="input"
            rows={4}
            maxLength={MAX_NOTE_LENGTH}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            required
            autoFocus
            aria-invalid={Boolean(error)}
            aria-describedby={suggested ? "review-note-suggestion review-note-help" : "review-note-help"}
            disabled={busy}
          />
          <span className="text-muted" id="review-note-help">
            Thí sinh đọc được lý do này. Còn {MAX_NOTE_LENGTH - note.length} ký tự.
          </span>
        </div>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions account-form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button className="btn btn-danger" type="submit" disabled={busy || !trimmed}>
            {busy ? "Đang xử lý..." : "Không chấp nhận"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
