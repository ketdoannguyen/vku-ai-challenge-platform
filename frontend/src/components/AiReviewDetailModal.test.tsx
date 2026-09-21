/**
 * Modal chi tiết AI. Điều quan trọng nhất ở đây là ranh giới trách nhiệm: modal chỉ đọc và
 * chạy lại lượt kiểm tra, tuyệt đối không được chứa thao tác duyệt bài - quyết định đó thuộc
 * về con người và nằm ở chỗ khác.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { AiReviewDetail, AiReviewRecord } from "../api/aiReview";
import type { AdminSubmissionItem } from "../api/results";
import { AiReviewDetailModal } from "./AiReviewDetailModal";

const SUBMISSION_ID = "64a000000000000000000009";

const SUBMISSION: AdminSubmissionItem = {
  id: SUBMISSION_ID,
  competition_id: "c1",
  status: "completed",
  metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
  primary_score: 0.9,
  created_at: "2026-09-15T09:00:00Z",
  artifacts: {
    prediction: { filename: "prediction.csv", size_bytes: 128, available: true },
    notebook: { filename: "solution.ipynb", size_bytes: 4096, available: true },
  },
  account: { id: "a1", name: "Đội Một", email: "doi1@vku.vn" },
  review: null,
  ai_review: {
    state: "COMPLETED",
    verdict: "FLAGGED",
    summary: "Có một dấu hiệu cần xem lại.",
    generation: 2,
    run_id: "run-2",
    latest_review_id: "r2",
    requested_at: "2026-09-15T09:10:00Z",
    updated_at: "2026-09-15T09:11:00Z",
  },
};

function record(overrides: Partial<AiReviewRecord> = {}): AiReviewRecord {
  return {
    id: "r1",
    run_id: "run-1",
    generation: 1,
    status: "COMPLETED",
    verdict: "CLEAR",
    model_verdict: "CLEAR",
    summary: "Không thấy vi phạm.",
    findings: [],
    notebook_stats: {
      cells: 12,
      code_cells: 8,
      markdown_cells: 4,
      lines: 210,
      truncated: false,
      omitted_cells: 0,
    },
    provider: "openai-compatible",
    provider_host: "api.example.com",
    model: "gpt-oss-120b",
    versions: { prompt: "v3", normalization: "v1", context_policy: "v2" },
    source: "PROVIDER",
    reused_from_review_id: null,
    bypass_cache: false,
    manual: false,
    attempts: 1,
    downgrade_codes: [],
    error: null,
    started_at: "2026-09-15T09:10:00Z",
    completed_at: "2026-09-15T09:10:02Z",
    duration_ms: 2000,
    created_at: "2026-09-15T09:10:02Z",
    ...overrides,
  };
}

const FLAGGED_RUN = record({
  id: "r2",
  run_id: "run-2",
  generation: 2,
  verdict: "INCONCLUSIVE",
  model_verdict: "FLAGGED",
  manual: true,
  bypass_cache: true,
  source: "PROVIDER",
  downgrade_codes: ["EVIDENCE_MISSING"],
  summary: "Model nghi ngờ nhưng không trích được bằng chứng.",
  findings: [
    {
      source_content_title: "Thể lệ",
      source_content_slug: "rules",
      rule_text: "Không được dùng dữ liệu ngoài cuộc thi.",
      checkability: "CHECKABLE_FROM_NOTEBOOK",
      status: "VIOLATION",
      reason: "Notebook đọc tệp ngoài.",
      evidence: [{ cell: 3, start_line: 12, end_line: 14, snippet: "df = read_csv('/data/extra.csv')" }],
    },
  ],
});

const DETAIL: AiReviewDetail = {
  submission: {
    id: SUBMISSION_ID,
    submission_no: 7,
    status: "completed",
    created_at: "2026-09-15T09:00:00Z",
    account: { id: "a1", name: "Đội Một", email: "doi1@vku.vn" },
    competition: { id: "c1", slug: "cup-1", name: "Cup 1" },
  },
  ai_review: SUBMISSION.ai_review,
  content_snapshot: {
    state: "CAPTURED",
    revision_id: "rev-1",
    content_hash: "a".repeat(64),
    error_code: null,
    captured_at: "2026-09-15T09:00:00Z",
  },
  history: [record(), FLAGGED_RUN],
};

interface Request {
  url: string;
  method: string;
}

/** Router hai lời gọi của modal: đọc chi tiết và chạy lại. */
function mockApi(
  handler: (url: string, init: RequestInit) => Response,
  detail: AiReviewDetail = DETAIL,
) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/rerun")) return handler(url, init ?? {}) ;
      return json(detail);
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

function renderModal(props: { onChanged?: () => void } = {}) {
  return render(
    <AiReviewDetailModal
      submission={SUBMISSION}
      onChanged={props.onChanged ?? (() => {})}
      onClose={() => {}}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("lịch sử xếp mới nhất lên đầu và chỉ hiện số phiên bản, không hiện prompt thô", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Lần #2");
  const runs = screen.getAllByText(/^Lần #\d$/);
  expect(runs.map((node) => node.textContent)).toEqual(["Lần #2", "Lần #1"]);

  // Chỉ phiên bản prompt được nhắc tới: backend không lưu nội dung prompt nên modal không có gì để hiện.
  expect(screen.getAllByText("prompt v3")).toHaveLength(2);
  expect(screen.getAllByText("api.example.com")).toHaveLength(2);
});

test("finding hiện nguyên văn thể lệ, mức kiểm chứng và bằng chứng trong pre", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Lần #2");
  expect(screen.getByText("Không được dùng dữ liệu ngoài cuộc thi.")).toBeTruthy();
  expect(screen.getByText("Kiểm tra được từ notebook")).toBeTruthy();
  expect(screen.getByText("Notebook đọc tệp ngoài.")).toBeTruthy();
  expect(screen.getByText("Thể lệ")).toBeTruthy();
  expect(screen.getByText("rules")).toBeTruthy();
  expect(screen.getByText("Có dấu hiệu vi phạm")).toBeTruthy();

  // Bằng chứng là đoạn notebook server trích lại, hiển thị nguyên văn.
  const evidence = screen.getByText("df = read_csv('/data/extra.csv')");
  expect(evidence.tagName).toBe("PRE");
  expect(screen.getByText("Cell 3 · dòng 12–14")).toBeTruthy();
});

test("kết luận bị hạ cấp được nói rõ vì sao khác kết luận của model", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Lần #2");
  expect(
    screen.getByText(/Model trả về “Có dấu hiệu”, đã hạ cấp thành “Chưa đủ căn cứ”/),
  ).toBeTruthy();
  expect(screen.getByText("Hạ cấp: EVIDENCE_MISSING")).toBeTruthy();
});

test("modal không chứa bất kỳ thao tác duyệt bài nào của con người", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Lần #2");
  expect(screen.queryByRole("button", { name: "Không chấp nhận" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Khôi phục" })).toBeNull();
  // Câu nhắc đứng ngay cạnh verdict, không nằm cuối modal.
  expect(screen.getByText(/Chỉ quyết định của Ban Tổ chức/)).toBeTruthy();
});

test("chạy lại phải qua xác nhận, gửi POST và đọc lại chi tiết", async () => {
  const onChanged = vi.fn();
  const requests = mockApi(() => json({ submission: DETAIL.submission }));
  renderModal({ onChanged });

  await screen.findByText("Lần #2");
  const before = requests.filter((item) => item.method === "GET").length;

  fireEvent.click(screen.getByRole("button", { name: "Chạy lại AI" }));
  const dialog = await screen.findByRole("dialog", { name: "Chạy lại kiểm tra AI" });
  // Chưa xác nhận thì chưa có request nào.
  expect(requests.some((item) => item.url.endsWith("/rerun"))).toBe(false);

  fireEvent.click(within(dialog).getByRole("button", { name: "Chạy lại" }));
  await waitFor(() =>
    expect(requests.some((item) => item.url.endsWith("/rerun") && item.method === "POST")).toBe(true),
  );
  await waitFor(() =>
    expect(requests.filter((item) => item.method === "GET").length).toBeGreaterThan(before),
  );
  expect(onChanged).toHaveBeenCalled();
});

test("thiếu bản thể lệ đã chụp thì không chạy lại được và nói rõ lý do", async () => {
  const requests = mockApi(
    () => json({ submission: DETAIL.submission }),
    {
      ...DETAIL,
      content_snapshot: {
        state: "ERROR",
        revision_id: null,
        content_hash: null,
        error_code: "AI_CONTENT_SNAPSHOT_UNAVAILABLE",
        captured_at: null,
      },
    },
  );
  renderModal();

  await screen.findByText("Lần #2");
  expect(screen.getByText(/Không chụp được bản thể lệ tại thời điểm nộp/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Chạy lại AI" })).toBeDisabled();
  expect(requests.some((item) => item.url.endsWith("/rerun"))).toBe(false);
});

test("tải notebook đi đúng endpoint của admin", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/notebook")) {
        return new Response(new Blob(["{}"]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return json(DETAIL);
    }),
  );
  // jsdom không tải được blob; chỉ cần biết URL đã đúng.
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

  renderModal();
  await screen.findByText("Lần #2");
  fireEvent.click(screen.getByRole("button", { name: "Tải notebook" }));

  await waitFor(() =>
    expect(requests.some((url) => url.endsWith(`/api/admin/submissions/${SUBMISSION_ID}/notebook`))).toBe(
      true,
    ),
  );
});

test("lượt hỏng hiện lỗi đã che và không vẽ danh sách finding rỗng", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    {
      ...DETAIL,
      history: [
        record({
          id: "r9",
          generation: 9,
          status: "FAILED",
          verdict: "ERROR",
          model_verdict: null,
          summary: "Chưa có kết luận.",
          error: { code: "AI_PROVIDER_UNAUTHORIZED", message: "Nhà cung cấp từ chối API key.", occurred_at: "2026-09-15T09:20:00Z" },
        }),
      ],
    },
  );
  renderModal();

  await screen.findByText("Lần #9");
  expect(screen.getByText("Nhà cung cấp từ chối API key.")).toBeTruthy();
  expect(screen.queryByText("Có dấu hiệu vi phạm")).toBeNull();
});

test("bài chưa từng được kiểm tra thì nói rõ thay vì hiện kết luận rỗng", async () => {
  mockApi(() => json({ submission: DETAIL.submission }), {
    ...DETAIL,
    ai_review: null,
    history: [],
  });
  renderModal();

  expect(
    await screen.findByText(/Bài nộp này không có lượt kiểm tra AI nào/),
  ).toBeTruthy();
  expect(screen.getByText("Chưa có lượt nào được ghi lại.")).toBeTruthy();
});

test("bấm 'Thử lại' sau lỗi quay về trạng thái đang tải thay vì báo không có lượt kiểm tra", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1;
      return calls === 1 ? json({ detail: "lỗi tạm" }, 500) : json(DETAIL);
    }),
  );
  renderModal();

  fireEvent.click(await screen.findByRole("button", { name: "Thử lại" }));
  expect(screen.getByText("Đang tải chi tiết kiểm tra AI...")).toBeTruthy();

  await screen.findByText("Lần #2");
  expect(screen.queryByRole("button", { name: "Thử lại" })).toBeNull();
});
