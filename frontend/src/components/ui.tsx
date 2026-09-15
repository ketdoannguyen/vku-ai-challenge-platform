import { ApiClientError } from "../api/client";

export function Loading({ label = "Đang tải..." }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden />
      {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
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
