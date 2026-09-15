/** API client nhỏ dùng relative `/api` — same-origin qua Nginx (ADR-002). */

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
