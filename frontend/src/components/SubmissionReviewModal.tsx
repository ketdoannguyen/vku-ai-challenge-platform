/**
 * Modal từ chối một bài đã chấm điểm. Lý do là bắt buộc vì participant sẽ đọc chính nó,
 * nên nút xác nhận chỉ bật khi lý do sau khi trim còn nội dung.
 */

import { useState, type FormEvent, type RefObject } from "react";
import type { AdminSubmissionItem, ReviewPayload } from "../api/results";
import { Modal } from "./Modal";

const MAX_NOTE_LENGTH = 1000;

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
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmed = note.trim();

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
            aria-describedby="review-note-help"
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
