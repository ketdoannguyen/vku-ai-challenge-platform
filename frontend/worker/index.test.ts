// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";

const API_ORIGIN = "https://origin-api.example.com";
const PUBLIC_HOST = "vku-ai-challenge-platform.example.workers.dev";
const GENERIC_ERROR = {
  error: { code: "INTERNAL_ERROR", message: "Máy chủ gặp lỗi. Vui lòng thử lại sau." },
};

function incoming(path: string, init?: RequestInit): Request {
  return new Request(`https://${PUBLIC_HOST}${path}`, init);
}

/** Chặn `fetch` toàn cục và trả về spy nhận đúng `Request` mà Worker gửi lên upstream. */
function stubUpstream(response: Response = new Response("upstream", { status: 200 })) {
  const upstream = vi.fn(async (_request: Request) => response);
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

function call(request: Request, apiOrigin: string | undefined): Promise<Response> {
  return worker.fetch(request, { API_ORIGIN: apiOrigin });
}

async function expectGenericError(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(await response.json()).toEqual(GENERIC_ERROR);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("phạm vi proxy", () => {
  it("trả 404 và không gọi upstream cho path ngoài /api/", async () => {
    const upstream = stubUpstream();

    await expectGenericError(await call(incoming("/dashboard"), API_ORIGIN), 404);
    await expectGenericError(await call(incoming("/api"), API_ORIGIN), 404);

    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("cấu hình API_ORIGIN", () => {
  const invalidOrigins: Array<[string, string | undefined]> = [
    ["thiếu biến", undefined],
    ["chuỗi rỗng", ""],
    ["không phải URL", "origin-api.example.com"],
    ["scheme không phải http(s)", "ftp://origin-api.example.com"],
    ["có credentials", "https://user:pass@origin-api.example.com"],
    ["có kèm path", "https://origin-api.example.com/api"],
    ["có kèm query", "https://origin-api.example.com/?v=1"],
    ["có kèm fragment", "https://origin-api.example.com/#x"],
    ["trùng host với request public", `https://${PUBLIC_HOST}`],
  ];

  it.each(invalidOrigins)("fail closed với %s", async (_label, value) => {
    const upstream = stubUpstream();

    await expectGenericError(await call(incoming("/api/health"), value), 500);

    expect(upstream).not.toHaveBeenCalled();
  });

  it("chấp nhận origin có trailing slash", async () => {
    const upstream = stubUpstream();

    const response = await call(incoming("/api/health"), `${API_ORIGIN}/`);

    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0].url).toBe(`${API_ORIGIN}/api/health`);
  });
});

describe("chuyển tiếp request", () => {
  it("giữ nguyên pathname và query string", async () => {
    const upstream = stubUpstream();

    await call(incoming("/api/competitions/vku-2026/assets/bang-diem.png?raw=1"), API_ORIGIN);

    expect(upstream.mock.calls[0]?.[0].url).toBe(
      `${API_ORIGIN}/api/competitions/vku-2026/assets/bang-diem.png?raw=1`,
    );
  });

  it("giữ nguyên method và các header xác thực", async () => {
    const upstream = stubUpstream();

    await call(
      incoming("/api/admin/competitions/1/accounts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "aic_session=opaque-token",
          Authorization: "Bearer opaque-token",
        },
        body: JSON.stringify({ email: "a@vku.udn.vn" }),
      }),
      API_ORIGIN,
    );

    const forwarded = upstream.mock.calls[0]?.[0];
    expect(forwarded?.method).toBe("POST");
    expect(forwarded?.headers.get("cookie")).toBe("aic_session=opaque-token");
    expect(forwarded?.headers.get("authorization")).toBe("Bearer opaque-token");
    expect(forwarded?.headers.get("content-type")).toBe("application/json");
  });

  it("chuyển tiếp multipart upload dưới dạng stream, không đọc vào bộ nhớ", async () => {
    const upstream = stubUpstream();
    const form = new FormData();
    form.set("file", new Blob(["email,name\n"]), "accounts.csv");

    await call(
      incoming("/api/admin/competitions/1/accounts/import", { method: "POST", body: form }),
      API_ORIGIN,
    );

    const forwarded = upstream.mock.calls[0]?.[0];
    expect(forwarded?.body).toBeInstanceOf(ReadableStream);
    expect(forwarded?.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(await forwarded?.text()).toContain('filename="accounts.csv"');
  });

  it("không tự thêm body cho GET/HEAD", async () => {
    const upstream = stubUpstream();

    await call(incoming("/api/health"), API_ORIGIN);
    await call(incoming("/api/health", { method: "HEAD" }), API_ORIGIN);

    expect(upstream.mock.calls[0]?.[0].body).toBeNull();
    expect(upstream.mock.calls[1]?.[0].method).toBe("HEAD");
    expect(upstream.mock.calls[1]?.[0].body).toBeNull();
  });

  it("giữ redirect mode của request gọi vào, không tự follow 3xx", async () => {
    const upstream = stubUpstream();

    await call(incoming("/api/health", { redirect: "manual" }), API_ORIGIN);

    expect(upstream.mock.calls[0]?.[0].redirect).toBe("manual");
  });
});

describe("phản hồi từ upstream", () => {
  it("trả nguyên response, giữ Set-Cookie và Content-Disposition, không thêm CORS", async () => {
    const upstreamResponse = new Response("file", {
      status: 200,
      headers: [
        ["Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
        ["Content-Disposition", 'attachment; filename="export.xlsx"'],
      ],
    });
    upstreamResponse.headers.append("Set-Cookie", "aic_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax");
    upstreamResponse.headers.append("Set-Cookie", "other=1; Path=/");
    stubUpstream(upstreamResponse);

    const response = await call(incoming("/api/admin/competitions/1/export.xlsx"), API_ORIGIN);

    expect(response).toBe(upstreamResponse);
    expect(response.headers.getSetCookie()).toEqual([
      "aic_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax",
      "other=1; Path=/",
    ]);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="export.xlsx"');
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("trả 502 generic khi không gọi được upstream, không lộ API_ORIGIN", async () => {
    const upstream = stubUpstream();
    upstream.mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${API_ORIGIN}`));

    const response = await call(incoming("/api/health"), API_ORIGIN);

    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual(GENERIC_ERROR);
    expect(body).not.toContain(API_ORIGIN);
    expect(body).not.toContain("ECONNREFUSED");
  });
});
