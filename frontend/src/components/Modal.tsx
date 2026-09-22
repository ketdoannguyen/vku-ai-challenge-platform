import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * Dùng chung cho Modal và drawer điều hướng để hai focus trap không lệch nhau.
 * `summary` nằm trong đây vì `<details>` là control bấm được: thiếu nó, focus trap tính sai phần
 * tử đầu/cuối và Tab sẽ nhảy khỏi dialog ở đúng chỗ có lịch sử.
 */
export const FOCUSABLE =
  "[autofocus], summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

export function Modal({
  title,
  onClose,
  children,
  large = true,
  variant,
  returnFocusRef,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  large?: boolean;
  variant?: "competition-form" | "account-form";
  /**
   * Nơi cần trả focus khi đóng. Dùng khi modal được mở từ menu ba chấm: menu
   * unmount trước khi modal kịp ghi nhận `document.activeElement`, nên focus
   * "trước đó" sẽ là `<body>`. Row vẫn mounted nên ref của nút trigger còn hiệu lực.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const returnFocusRefRef = useRef(returnFocusRef);
  const previousFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    onCloseRef.current = onClose;
    returnFocusRefRef.current = returnFocusRef;
  }, [onClose, returnFocusRef]);

  useEffect(() => {
    if (!dialogRef.current?.contains(document.activeElement)) {
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }

    // Nền phía sau không cuộn khi hộp thoại đang mở.
    const previousOverflow = document.body.style.overflow;
    const previousFocus = previousFocusRef.current;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const outside = !(active instanceof HTMLElement) || !dialog.contains(active);

      if (event.shiftKey && (outside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (outside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      (returnFocusRefRef.current?.current ?? previousFocus)?.focus();
    };
  }, []);

  return createPortal(
    <div
      className={`modal-overlay${variant ? ` modal-overlay-${variant}` : ""}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal${large ? " modal-lg" : ""}${variant ? ` modal-${variant}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button className="modal-close" aria-label="Đóng" onClick={onClose} type="button">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmModal({
  title,
  body,
  confirmLabel,
  danger = false,
  requireText,
  onConfirm,
  onClose,
  returnFocusRef,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  /**
   * Chữ phải gõ đúng mới bấm được nút xác nhận. Dành cho thao tác không hoàn tác được: một cú bấm
   * nhầm không thể lấy lại key đã xoá, còn gõ ra một từ thì phải có ý định.
   */
  requireText?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const blocked = requireText !== undefined && typed.trim().toLowerCase() !== requireText;

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose} large={false} returnFocusRef={returnFocusRef}>
      <div className={`confirm-modal${danger ? " confirm-modal-danger" : ""}`}>
        <div className="confirm-modal-body">
          <span className="confirm-modal-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
              <path d="M12 8v5m0 3.5v.01M10.3 3.84 2.82 17a2 2 0 0 0 1.74 3h14.88a2 2 0 0 0 1.74-3L13.7 3.84a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <p>{body}</p>
        </div>
        {requireText !== undefined && (
          <div className="confirm-modal-guard">
            <label className="field-label" htmlFor="confirm-modal-guard">
              Gõ <code>{requireText}</code> để xác nhận
            </label>
            <input
              id="confirm-modal-guard"
              className="input"
              autoComplete="off"
              value={typed}
              disabled={busy}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
        )}
        {error && (
          <div className="confirm-modal-error" role="alert">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
              <path d="M12 7.5v5m0 4v.01" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            <span>{error}</span>
          </div>
        )}
        <div className="modal-actions confirm-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button
            type="button"
            className={`btn ${danger ? "btn-danger" : ""}`}
            onClick={() => void confirm()}
            disabled={busy || blocked}
          >
            {busy ? "Đang xử lý..." : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
