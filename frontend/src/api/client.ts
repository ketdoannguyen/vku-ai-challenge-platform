/** API client nhỏ dùng relative `/api` - same-origin qua Nginx (ADR-002). */

export interface ApiError {
  code: string;
  message: string;
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = error.code;
  }
}

export interface DownloadResult {
  blob: Blob;
  /** Tên file backend gợi ý; null khi header vắng hoặc không đọc được. */
  filename: string | null;
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      return null;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

/**
 * Tải file qua fetch thay vì để trình duyệt điều hướng anchor: response lỗi
 * (401/500) vẫn là JSON envelope nên phải bắt được trong SPA.
 */
async function download(path: string): Promise<DownloadResult> {
  const resp = await fetch(`/api${path}`, {
    credentials: "same-origin",
    headers: { Accept: "*/*" },
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    const error = body?.error ?? { code: "UNKNOWN", message: `Lỗi HTTP ${resp.status}` };
    throw new ApiClientError(resp.status, error);
  }

  return {
    blob: await resp.blob(),
    filename: filenameFromDisposition(resp.headers.get("Content-Disposition")),
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
  });

  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    const error = body?.error ?? { code: "UNKNOWN", message: `Lỗi HTTP ${resp.status}` };
    throw new ApiClientError(resp.status, error);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, json?: unknown) =>
    request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    }),
  patch: <T>(path: string, json: unknown) =>
    request<T>(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(json),
    }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  put: <T>(path: string, json?: unknown) =>
    request<T>(path, {
      method: "PUT",
      headers: json === undefined ? undefined : { "Content-Type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    }),
  download,
  upload: <T>(path: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<T>(path, { method: "PUT", body: form });
  },
  postFile: <T>(path: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<T>(path, { method: "POST", body: form });
  },
};
