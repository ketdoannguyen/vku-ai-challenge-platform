/**
 * Worker chạy trước cho `/api/*` (Workers Static Assets): chuyển tiếp nguyên trạng request sang
 * `API_ORIGIN` - Cloudflare Tunnel → Nginx `web:80` → FastAPI. Mọi path khác do lớp static
 * assets phục vụ, kèm fallback SPA cho route con của React Router.
 *
 * Browser vẫn thấy API là same-origin (`https://<public-host>/api/...`), nên ở đây không thêm
 * CORS, không đọc/đệm body và không chỉnh response: `Set-Cookie`, `Content-Disposition` và
 * stream upload/download phải đi qua nguyên vẹn. Không log cookie/token/secret.
 */

interface Env {
  /**
   * Runtime variable đặt trong Workers Dashboard (KHÔNG khai trong wrangler.jsonc), dạng
   * `https://origin-api.example.com`. Bắt buộc có, nếu thiếu thì fail closed.
   */
  API_ORIGIN?: string;
}

/** Envelope lỗi giống backend để `src/api/client.ts` đọc được thành `ApiClientError`. */
const ERROR_BODY = JSON.stringify({
  error: { code: "INTERNAL_ERROR", message: "Máy chủ gặp lỗi. Vui lòng thử lại sau." },
});

/**
 * Lỗi cấu hình (500) và lỗi không tới được backend (502) dùng chung một body generic - không
 * tiết lộ `API_ORIGIN` hay chi tiết cấu hình, nhưng vẫn phân biệt được khi soi metrics.
 */
function errorResponse(status: number): Response {
  return new Response(ERROR_BODY, { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Chuẩn hoá `API_ORIGIN` thành origin hợp lệ, hoặc `null` nếu cấu hình sai.
 *
 * Chỉ nhận origin thuần: scheme http/https, không credentials, không path (request gọi vào đã
 * có `/api/...` rồi), không query/fragment. Từ chối origin trùng host với request public để cấu
 * hình trỏ nhầm về chính Worker không tạo vòng lặp proxy vô hạn.
 */
function resolveUpstreamOrigin(raw: string | undefined, incomingHost: string): string | null {
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return null;
  if (parsed.host.toLowerCase() === incomingHost.toLowerCase()) return null;

  return parsed.origin;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incomingUrl = new URL(request.url);

    if (!incomingUrl.pathname.startsWith("/api/")) {
      return errorResponse(404);
    }

    const upstreamOrigin = resolveUpstreamOrigin(env.API_ORIGIN, incomingUrl.host);
    if (upstreamOrigin === null) {
      return errorResponse(500);
    }

    // Tạo Request mới từ chính request gọi vào rồi chỉ đổi URL: method, headers (Cookie,
    // Authorization, Content-Type), body stream và redirect mode được giữ nguyên.
    const upstreamRequest = new Request(
      `${upstreamOrigin}${incomingUrl.pathname}${incomingUrl.search}`,
      request,
    );

    try {
      return await fetch(upstreamRequest);
    } catch {
      return errorResponse(502);
    }
  },
};
