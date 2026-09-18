import { useRef, type ReactNode } from "react";
import { ApiClientError } from "../api/client";

/** Nút chọn file dùng chung.
 *
 * `<button>` thật nên Tab tới được và Enter/Space mở hộp chọn file; input bị ẩn
 * (aria-label giữ nguyên để trình đọc màn hình và test vẫn tham chiếu được) chỉ
 * đóng vai trò cầu nối tới hộp thoại hệ điều hành. */
export function FileButton({
  children,
  onFile,
  inputLabel,
  accept,
  disabled = false,
  className = "btn",
}: {
  children: ReactNode;
  onFile: (file: File) => void;
  inputLabel: string;
  accept?: string;
  disabled?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {children}
      </button>
      <input
        ref={inputRef}
        aria-label={inputLabel}
        type="file"
        accept={accept}
        hidden
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = "";
        }}
      />
    </>
  );
}

export function Loading({ label = "Đang tải..." }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden />
      {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (error == null) return null;

  const message =
    error instanceof ApiClientError || error instanceof Error
      ? error.message
      : "Đã xảy ra lỗi không xác định.";
  return (
    <div className="error-box" role="alert">
      {message}
    </div>
  );
}
