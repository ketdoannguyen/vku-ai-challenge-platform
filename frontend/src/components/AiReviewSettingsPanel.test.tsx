/**
 * Panel cấu hình AI: hai điều dễ làm sai nhất là để lộ API key và để lời xác nhận host
 * sống lâu hơn host nó thuộc về. Mọi test ở đây đều xoay quanh hai chuyện đó, cộng thêm
 * việc panel không được hành xử như một công cụ soạn luật.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { AiReviewSettings } from "../api/aiReview";
import { AiReviewSettingsPanel } from "./AiReviewSettingsPanel";

const COMPETITION_ID = "64a000000000000000000001";
const SAVED_KEY = "sk-live-do-not-leak-me";

function settings(overrides: Partial<AiReviewSettings["config"]> = {}): AiReviewSettings {
  return {
    config: {
      enabled: true,
      auto_review: true,
      participant_visible: true,
      provider: "openai-compatible",
      base_url: "https://api.example.com/v1",
      model: "gpt-oss-120b",
      api_key_configured: true,
      acknowledged_host: "api.example.com",
      updated_at: "2026-09-15T09:00:00Z",
      ...overrides,
    },
    runtime: { encryption_available: true, allowed_hosts_configured: true },
    content_source: {
      included_count: 1,
      excluded_count: 1,
      total_bytes: 2048,
      pages: [
        {
          content_id: "c1",
          title: "Thể lệ",
          slug: "rules",
          order: 1,
          visibility: "public",
          included: true,
          reason: "OK",
        },
        {
          content_id: "c2",
          title: "Ghi chú nội bộ",
          slug: "notes",
          order: 2,
          visibility: "private",
          included: false,
          reason: "NO_MARKDOWN",
        },
      ],
    },
  };
}

interface Request {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** Mock fetch ghi lại mọi request để test soi được payload đã gửi. */
function mockApi(handler: (url: string, init: RequestInit) => Response) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return handler(url, init ?? {});
    }),
  );
  return requests;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CONFIG_URL = `/api/admin/competitions/${COMPETITION_ID}/ai-review`;
const TEST_URL = `${CONFIG_URL}/test`;
const KEY_URL = `${CONFIG_URL}/api-key`;

/** Router của bốn lời gọi panel phát ra; mặc định trả cấu hình đã lưu. */
function route(overrides: {
  get?: () => Response;
  put?: () => Response;
  test?: () => Response;
  del?: () => Response;
}) {
  return (url: string, init: RequestInit) => {
    if (url === TEST_URL) return overrides.test?.() ?? json({});
    if (url === KEY_URL) return overrides.del?.() ?? json({ config: settings().config });
    if (url === CONFIG_URL && init.method === "PUT") {
      return overrides.put?.() ?? json({ config: settings().config });
    }
    return overrides.get?.() ?? json(settings());
  };
}

function renderPanel() {
  return render(<AiReviewSettingsPanel competitionId={COMPETITION_ID} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("nạp cấu hình đã lưu và không bao giờ đưa API key trở lại form", async () => {
  mockApi(route({}));
  renderPanel();

  const keyInput = (await screen.findByLabelText("API key")) as HTMLInputElement;
  // Key nằm lại trên server: form chỉ biết là đã có key, và ô nhập luôn rỗng.
  expect(keyInput.value).toBe("");
  expect(keyInput.placeholder).toBe("Đã cấu hình");
  expect(keyInput.type).toBe("password");

  const baseUrl = screen.getByLabelText("Base URL (OpenAI-compatible)") as HTMLInputElement;
  expect(baseUrl.value).toBe("https://api.example.com/v1");
  expect(screen.getByLabelText("Model")).toHaveValue("gpt-oss-120b");
  expect(screen.getByLabelText(/Bật kiểm tra notebook bằng AI/)).toBeChecked();
  expect(screen.getByText("Đang bật")).toBeTruthy();
});

test("lưu cấu hình: giữ nguyên key khi ô nhập trống, gửi key khi admin gõ key mới", async () => {
  const requests = mockApi(route({}));
  renderPanel();
  await screen.findByLabelText("API key");

  fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
  await waitFor(() => expect(requests.some((item) => item.method === "PUT")).toBe(true));

  const kept = requests.find((item) => item.method === "PUT")!;
  expect(kept.body).not.toHaveProperty("api_key");
  expect(kept.body).toMatchObject({
    enabled: true,
    auto_review: true,
    participant_visible: true,
    base_url: "https://api.example.com/v1",
    model: "gpt-oss-120b",
    // Host này đã được xác nhận từ trước nên không phải xác nhận lại.
    acknowledge_transfer: true,
  });

  fireEvent.change(screen.getByLabelText("API key"), { target: { value: SAVED_KEY } });
  fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
  await waitFor(() =>
    expect(requests.filter((item) => item.method === "PUT")).toHaveLength(2),
  );
  expect(requests.filter((item) => item.method === "PUT")[1].body?.api_key).toBe(SAVED_KEY);

  // Key không bao giờ quay lại DOM, kể cả sau khi vừa gửi lên.
  expect(document.body.textContent).not.toContain(SAVED_KEY);
});

test("đổi Base URL sang host khác thì lời xác nhận cũ hết hiệu lực", async () => {
  mockApi(route({}));
  renderPanel();
  await screen.findByLabelText("API key");

  const acknowledge = screen.getByLabelText(/Tôi hiểu notebook/) as HTMLInputElement;
  expect(acknowledge.checked).toBe(true);

  fireEvent.change(screen.getByLabelText("Base URL (OpenAI-compatible)"), {
    target: { value: "https://llm.other-host.test/v1" },
  });

  expect(acknowledge.checked).toBe(false);
  expect(screen.getByText(/llm\.other-host\.test/)).toBeTruthy();
});

test("Base URL chưa hợp lệ thì chưa xác nhận được host nào", async () => {
  mockApi(route({ get: () => json(settings({ base_url: "", acknowledged_host: null })) }));
  renderPanel();
  await screen.findByLabelText("API key");

  const acknowledge = screen.getByLabelText(/Nhập Base URL hợp lệ/) as HTMLInputElement;
  expect(acknowledge).toBeDisabled();
  expect(acknowledge.checked).toBe(false);
});

test("xóa API key phải qua bước xác nhận rồi mới gọi DELETE", async () => {
  const requests = mockApi(
    route({ del: () => json({ config: settings({ api_key_configured: false }).config }) }),
  );
  renderPanel();
  await screen.findByLabelText("API key");

  fireEvent.click(screen.getByRole("button", { name: "Xóa API key" }));
  const dialog = await screen.findByRole("dialog", { name: "Xóa API key" });
  expect(requests.filter((item) => item.method === "DELETE")).toHaveLength(0);

  fireEvent.click(within(dialog).getByRole("button", { name: "Xóa key" }));
  await waitFor(() =>
    expect(requests.filter((item) => item.method === "DELETE")).toHaveLength(1),
  );
  // Sau khi xóa, nút xóa biến mất vì không còn key để xóa.
  await waitFor(() => expect(screen.queryByRole("button", { name: "Xóa API key" })).toBeNull());
});

test("kiểm tra kết nối báo host, model và độ trễ khi thành công", async () => {
  const requests = mockApi(
    route({
      test: () => json({ ok: true, host: "api.example.com", model: "gpt-oss-120b", latency_ms: 412 }),
    }),
  );
  renderPanel();
  await screen.findByLabelText("API key");

  fireEvent.click(screen.getByRole("button", { name: "Kiểm tra kết nối" }));

  expect(
    await screen.findByText(/Kết nối thành công tới api\.example\.com với model gpt-oss-120b/),
  ).toBeTruthy();
  const call = requests.find((item) => item.url === TEST_URL)!;
  expect(call.method).toBe("POST");
  // Không gửi key khi ô nhập trống: server dùng key đã lưu.
  expect(call.body).not.toHaveProperty("api_key");
});

test("kiểm tra kết nối thất bại hiện lỗi thay vì im lặng", async () => {
  mockApi(
    route({
      test: () =>
        json({ error: { code: "AI_HOST_NOT_ALLOWED", message: "Host không nằm trong allowlist." } }, 502),
    }),
  );
  renderPanel();
  await screen.findByLabelText("API key");

  fireEvent.click(screen.getByRole("button", { name: "Kiểm tra kết nối" }));

  expect(await screen.findByText("Host không nằm trong allowlist.")).toBeTruthy();
});

test("danh sách nguồn nội dung nói rõ page nào sẽ được gửi cho AI", async () => {
  mockApi(route({}));
  renderPanel();

  await screen.findByText("Thể lệ");
  expect(screen.getByText("Ghi chú nội bộ")).toBeTruthy();
  expect(screen.getByText("Sẽ được kiểm tra")).toBeTruthy();
  expect(screen.getByText("Chưa có nội dung Markdown")).toBeTruthy();
  expect(screen.getByText(/1 trang sẽ được gửi kèm \(2\.0 KB\), 1 trang bị bỏ qua\./)).toBeTruthy();
});

test("thiếu khoá mã hoá hoặc allowlist thì cảnh báo trước khi admin bật AI", async () => {
  mockApi(
    route({
      get: () =>
        json({
          ...settings(),
          runtime: { encryption_available: false, allowed_hosts_configured: false },
        }),
    }),
  );
  renderPanel();

  expect(await screen.findByText(/Máy chủ chưa có khoá mã hoá/)).toBeTruthy();
  expect(screen.getByText(/Máy chủ chưa cấu hình allowlist host/)).toBeTruthy();
});

test("panel nói rõ đây không phải công cụ soạn luật và chỉ về tab Nội dung", async () => {
  mockApi(route({}));
  renderPanel();

  const note = await screen.findByText(/không phải công cụ soạn luật/);
  expect(note).toHaveTextContent("Nội dung");
  expect(screen.queryByText(/Rule Builder/)).toBeNull();
});

test("tải cấu hình lỗi thì hiện lỗi và cho thử lại", async () => {
  let attempts = 0;
  mockApi(
    route({
      get: () => {
        attempts += 1;
        return attempts === 1
          ? json({ error: { code: "UNKNOWN", message: "Máy chủ lỗi." } }, 500)
          : json(settings());
      },
    }),
  );
  renderPanel();

  expect(await screen.findByText("Máy chủ lỗi.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
  expect(await screen.findByLabelText("API key")).toHaveValue("");
});

test("bật/tắt AI và công khai cho thí sinh đi thẳng vào payload", async () => {
  const requests = mockApi(route({}));
  renderPanel();
  await screen.findByLabelText("API key");

  fireEvent.click(screen.getByLabelText(/Tự động kiểm tra notebook sau mỗi bài nộp/));
  fireEvent.click(screen.getByLabelText(/Hiển thị kết quả AI sơ bộ cho thí sinh/));
  fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));

  await waitFor(() => expect(requests.some((item) => item.method === "PUT")).toBe(true));
  expect(requests.find((item) => item.method === "PUT")!.body).toMatchObject({
    auto_review: false,
    participant_visible: false,
  });
});
