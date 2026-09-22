/**
 * Panel cấu hình AI: ba chuyện dễ làm sai nhất là để lộ API key, để một cấu hình chưa từng gọi
 * được provider trông như đã xác minh, và để nút xoá key không có bước chặn nào. Mọi test ở đây
 * xoay quanh ba chuyện đó.
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
      verified_at: null,
      updated_at: "2026-09-15T09:00:00Z",
      ...overrides,
    },
    runtime: { encryption_available: true },
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

/**
 * Router của bốn lời gọi panel phát ra; mặc định trả cấu hình đã lưu và một probe thành công.
 *
 * Nó giữ vết xác minh giữa các request đúng như cột `verified_at` thật (ADR-043): probe bằng cấu
 * hình đã lưu thì ghi vết, xoá key thì vết hết hiệu lực, và mọi lần đọc cấu hình sau đó đều mang
 * theo vết ấy. Nhờ vậy test hỏi được câu "quay lại tab thì chip còn xanh không" mà không phải tự
 * dựng lại luật của server ở phía client.
 */
function route(overrides: {
  get?: () => Response;
  put?: () => Response;
  test?: () => Response;
  del?: () => Response;
}) {
  let verifiedAt: string | null = null;
  const current = () => settings({ verified_at: verifiedAt });
  return (url: string, init: RequestInit) => {
    if (url === TEST_URL) {
      if (overrides.test) return overrides.test();
      verifiedAt = "2026-09-22T10:00:00Z";
      return json({ ok: true, host: "api.example.com", model: "gpt-oss-120b", latency_ms: 412 });
    }
    if (url === KEY_URL) {
      // Không còn key thì vân tay cấu hình đổi, nên vết cũ không còn nói được gì.
      verifiedAt = null;
      return (
        overrides.del?.() ?? json({ config: settings({ api_key_configured: false }).config })
      );
    }
    if (url === CONFIG_URL && init.method === "PUT") {
      return overrides.put?.() ?? json({ config: current().config });
    }
    return overrides.get?.() ?? json(current());
  };
}

function renderPanel() {
  return render(<AiReviewSettingsPanel competitionId={COMPETITION_ID} />);
}

/** Lưu cấu hình và chờ cả PUT lẫn lượt probe kết thúc. */
async function saveAndSettle(requests: Request[]) {
  fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
  await waitFor(() => expect(requests.some((item) => item.url === TEST_URL)).toBe(true));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Lưu cấu hình" })).not.toBeDisabled(),
  );
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
  expect(screen.getByRole("switch", { name: "Bật kiểm tra bằng AI" })).toBeChecked();
  // Vết xác minh nằm ở server: cuộc thi này chưa lần nào gọi được provider, kể cả ở phiên trước.
  expect(screen.getByText("Chưa xác minh")).toBeTruthy();
});

test("lưu cấu hình: giữ nguyên key khi ô nhập trống, gửi key khi admin gõ key mới", async () => {
  const requests = mockApi(route({}));
  renderPanel();
  await screen.findByLabelText("API key");

  await saveAndSettle(requests);

  const kept = requests.find((item) => item.method === "PUT")!;
  expect(kept.body).not.toHaveProperty("api_key");
  expect(kept.body).toMatchObject({
    enabled: true,
    auto_review: true,
    participant_visible: true,
    base_url: "https://api.example.com/v1",
    model: "gpt-oss-120b",
  });

  fireEvent.change(screen.getByLabelText("API key"), { target: { value: SAVED_KEY } });
  fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
  await waitFor(() => expect(requests.filter((item) => item.method === "PUT")).toHaveLength(2));
  expect(requests.filter((item) => item.method === "PUT")[1].body?.api_key).toBe(SAVED_KEY);

  // Key không bao giờ quay lại DOM, kể cả sau khi vừa gửi lên.
  expect(document.body.textContent).not.toContain(SAVED_KEY);
});

test("lưu cấu hình chạy luôn kiểm tra kết nối và bật chip xác minh", async () => {
  const requests = mockApi(route({}));
  renderPanel();
  await screen.findByLabelText("API key");

  await saveAndSettle(requests);

  // Không còn nút "Kiểm tra kết nối" riêng: lưu là lần duy nhất admin cần bấm.
  expect(screen.queryByRole("button", { name: "Kiểm tra kết nối" })).toBeNull();
  const probe = requests.find((item) => item.url === TEST_URL)!;
  expect(probe.method).toBe("POST");
  // Body rỗng: server kiểm bằng chính cấu hình vừa lưu, không bằng giá trị trên form.
  expect(probe.body).toEqual({});
  expect(
    await screen.findByText(/Đã lưu cấu hình và kết nối thành công tới api\.example\.com/),
  ).toBeTruthy();
  expect(screen.getByText("Đã xác minh")).toBeTruthy();
});

test("probe thất bại thì chip ở lại vàng và hiện lỗi thay vì im lặng", async () => {
  mockApi(
    route({
      test: () =>
        json(
          {
            error: {
              code: "AI_CONNECTION_FAILED",
              message: "Không kết nối được tới provider.",
            },
          },
          502,
        ),
    }),
  );
  renderPanel();
  await screen.findByLabelText("API key");

  fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));

  expect(await screen.findByText("Không kết nối được tới provider.")).toBeTruthy();
  expect(screen.getByText(/Đã lưu cấu hình, nhưng chưa kết nối được tới provider\./)).toBeTruthy();
  expect(screen.getByText("Chưa xác minh")).toBeTruthy();
});

test("chip xác minh sống qua lần quay lại tab vì vết nằm ở server", async () => {
  const requests = mockApi(route({}));
  const opened = renderPanel();
  await screen.findByLabelText("API key");

  await saveAndSettle(requests);
  expect(screen.getByText("Đã xác minh")).toBeTruthy();

  // Rời tab làm panel unmount; quay lại là một phiên hoàn toàn mới, không giữ state nào.
  opened.unmount();
  renderPanel();

  expect(await screen.findByText("Đã xác minh")).toBeTruthy();
  expect(screen.queryByText("Chưa xác minh")).toBeNull();
});

test("sửa Base URL sau khi đã xác minh thì chip về chưa xác minh", async () => {
  const requests = mockApi(route({}));
  renderPanel();
  await screen.findByLabelText("API key");

  await saveAndSettle(requests);
  expect(screen.getByText("Đã xác minh")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Base URL (OpenAI-compatible)"), {
    target: { value: "https://llm.other-host.test/v1" },
  });
  expect(screen.getByText("Chưa xác minh")).toBeTruthy();
});

test("trả một trường kết nối về giá trị đã lưu thì chip xanh lại mà không gọi provider", async () => {
  const requests = mockApi(route({}));
  renderPanel();
  await screen.findByLabelText("API key");

  await saveAndSettle(requests);
  const probes = requests.filter((item) => item.url === TEST_URL).length;
  const baseUrl = screen.getByLabelText("Base URL (OpenAI-compatible)");

  fireEvent.change(baseUrl, { target: { value: "https://llm.other-host.test/v1" } });
  expect(screen.getByText("Chưa xác minh")).toBeTruthy();

  fireEvent.change(baseUrl, { target: { value: "https://api.example.com/v1" } });
  // Chip là suy luận từ cấu hình đang lưu, không phải một lời gọi mạng mới.
  expect(screen.getByText("Đã xác minh")).toBeTruthy();
  expect(requests.filter((item) => item.url === TEST_URL)).toHaveLength(probes);
});

test("xoá API key thì vết xác minh cũng hết hiệu lực", async () => {
  const requests = mockApi(route({}));
  renderPanel();
  await screen.findByLabelText("API key");

  await saveAndSettle(requests);
  expect(screen.getByText("Đã xác minh")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Xóa API key" }));
  const dialog = await screen.findByRole("dialog", { name: "Xóa API key" });
  fireEvent.change(within(dialog).getByLabelText(/Gõ/), { target: { value: "delete" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Xóa key" }));

  await waitFor(() => expect(screen.queryByRole("button", { name: "Xóa API key" })).toBeNull());
  expect(screen.getByText("Chưa xác minh")).toBeTruthy();
});

test("tắt công tắc thì vô hiệu hoá toàn bộ phần cấu hình, nút lưu vẫn bấm được", async () => {
  mockApi(route({}));
  renderPanel();
  await screen.findByLabelText("API key");

  fireEvent.click(screen.getByRole("switch", { name: "Bật kiểm tra bằng AI" }));

  expect(screen.getByLabelText("Base URL (OpenAI-compatible)")).toBeDisabled();
  expect(screen.getByLabelText("Model")).toBeDisabled();
  expect(screen.getByLabelText("API key")).toBeDisabled();
  expect(screen.getByLabelText(/Tự động kiểm tra notebook/)).toBeDisabled();
  expect(screen.getByLabelText(/Hiển thị kết quả AI sơ bộ/)).toBeDisabled();
  expect(screen.getByRole("button", { name: "Xóa API key" })).toBeDisabled();
  // Không còn gì để xác minh khi AI đang tắt.
  expect(screen.queryByText("Chưa xác minh")).toBeNull();
  expect(screen.getByRole("button", { name: "Lưu cấu hình" })).not.toBeDisabled();
});

test("tắt AI thì lưu thẳng trạng thái tắt và không gọi provider", async () => {
  const requests = mockApi(route({}));
  renderPanel();
  await screen.findByLabelText("API key");

  fireEvent.click(screen.getByRole("switch", { name: "Bật kiểm tra bằng AI" }));
  fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));

  await waitFor(() => expect(requests.some((item) => item.method === "PUT")).toBe(true));
  expect(requests.find((item) => item.method === "PUT")!.body).toMatchObject({ enabled: false });
  expect(requests.some((item) => item.url === TEST_URL)).toBe(false);
});

test("xóa API key chỉ chạy khi gõ đúng chữ xác nhận", async () => {
  const requests = mockApi(
    route({ del: () => json({ config: settings({ api_key_configured: false }).config }) }),
  );
  renderPanel();
  await screen.findByLabelText("API key");

  fireEvent.click(screen.getByRole("button", { name: "Xóa API key" }));
  const dialog = await screen.findByRole("dialog", { name: "Xóa API key" });
  const confirm = within(dialog).getByRole("button", { name: "Xóa key" });
  expect(confirm).toBeDisabled();

  const guard = within(dialog).getByLabelText(/Gõ/);
  fireEvent.change(guard, { target: { value: "delet" } });
  expect(confirm).toBeDisabled();
  expect(requests.filter((item) => item.method === "DELETE")).toHaveLength(0);

  fireEvent.change(guard, { target: { value: "delete" } });
  expect(confirm).not.toBeDisabled();
  fireEvent.click(confirm);

  await waitFor(() => expect(requests.filter((item) => item.method === "DELETE")).toHaveLength(1));
  // Sau khi xóa, nút xóa biến mất vì không còn key để xóa.
  await waitFor(() => expect(screen.queryByRole("button", { name: "Xóa API key" })).toBeNull());
});

test("danh sách nguồn nội dung chỉ liệt kê trang sẽ được gửi cho AI", async () => {
  mockApi(route({}));
  renderPanel();

  await screen.findByText("Thể lệ");
  // Trang bị bỏ qua không hiện, và không còn badge trạng thái lẫn dòng đếm số trang.
  expect(screen.queryByText("Ghi chú nội bộ")).toBeNull();
  expect(screen.queryByText("Sẽ được kiểm tra")).toBeNull();
  expect(screen.queryByText(/trang sẽ được gửi kèm/)).toBeNull();
});

test("chưa có trang nào có Markdown thì danh sách nói rõ vì sao trống", async () => {
  const empty = settings();
  mockApi(
    route({
      get: () =>
        json({
          ...empty,
          content_source: {
            included_count: 0,
            excluded_count: 1,
            total_bytes: 0,
            pages: [empty.content_source.pages[1]],
          },
        }),
    }),
  );
  renderPanel();

  expect(
    await screen.findByText("Chưa trang nội dung nào có Markdown để gửi cho AI."),
  ).toBeTruthy();
});

test("thiếu khoá mã hoá thì cảnh báo trước khi admin bật AI", async () => {
  mockApi(
    route({
      get: () => json({ ...settings(), runtime: { encryption_available: false } }),
    }),
  );
  renderPanel();

  expect(await screen.findByText(/Máy chủ chưa có khoá mã hoá/)).toBeTruthy();
  expect(screen.queryByText(/allowlist/)).toBeNull();
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

test("hai tuỳ chọn hành vi đi thẳng vào payload", async () => {
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
