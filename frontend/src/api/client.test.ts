import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, api } from "./client";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Body là chuỗi, KHÔNG phải `new Blob([...])`: trong môi trường jsdom của vitest, `Blob` toàn cục là
// Blob của jsdom và `Blob.prototype.stream` không tồn tại, nên undici đi kèm Node 22.23.2 (bản CI
// dùng) gọi `.stream()` trên nó và ném `TypeError: object.stream is not a function`. Node 24 không
// tái hiện nên lỗi chỉ lộ trên CI. `Response` vẫn tự sinh blob thật cho `api.download` đọc.
function blobResponse(headers: Record<string, string> = {}) {
  return new Response("xlsx-bytes", {
    status: 200,
    headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ...headers },
  });
}

describe("api.get", () => {
  it("hủy GET bị treo khi hết hạn thay vì dừng vòng tự cập nhật", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, options?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }),
    ));

    const request = api.get("/competitions");
    expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000);
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBe(controller.signal);
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("không coi GET timeout khi đang đọc body là thành công", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const response = new Response("", { status: 200 });
    vi.spyOn(response, "json").mockImplementation(() => new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const request = api.get("/competitions");
    await vi.waitFor(() => expect(response.json).toHaveBeenCalled());
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("không coi body JSON hỏng của GET thành công là dữ liệu rỗng", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));

    await expect(api.get("/competitions")).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("api.download", () => {
  it("trả blob và đọc filename từ Content-Disposition", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        blobResponse({ "Content-Disposition": 'attachment; filename="ket-qua.xlsx"' }),
      ),
    );

    const result = await api.download("/admin/competitions/1/export.xlsx");

    expect(result.filename).toBe("ket-qua.xlsx");
    expect(result.blob.size).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledWith("/api/admin/competitions/1/export.xlsx", {
      credentials: "same-origin",
      headers: { Accept: "*/*" },
      signal: undefined,
    });
  });

  it("truyền signal của trình xem, không tự đặt hạn cho lượt tải file", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(blobResponse()));

    await api.download("/x", controller.signal);

    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it("giải mã filename* UTF-8 khi backend dùng dạng encoded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        blobResponse({ "Content-Disposition": "attachment; filename*=UTF-8''k%E1%BA%BFt-qu%E1%BA%A3.xlsx" }),
      ),
    );

    const result = await api.download("/admin/competitions/1/export.xlsx");

    expect(result.filename).toBe("kết-quả.xlsx");
  });

  it("không có Content-Disposition thì filename là null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(blobResponse()));

    await expect(api.download("/x")).resolves.toMatchObject({ filename: null });
  });

  it("lỗi 401 ném ApiClientError từ JSON envelope, không trả blob", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Chưa đăng nhập." } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(api.download("/x")).rejects.toMatchObject({
      name: "ApiClientError",
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  it("lỗi 500 không có JSON envelope vẫn ném ApiClientError với code UNKNOWN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>boom</html>", { status: 500 })),
    );

    const error = await api.download("/x").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).status).toBe(500);
    expect((error as ApiClientError).code).toBe("UNKNOWN");
  });
});
