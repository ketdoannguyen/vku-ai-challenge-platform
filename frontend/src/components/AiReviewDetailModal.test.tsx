/**
 * Modal chi tiết AI. Bốn thứ test ở đây bảo vệ:
 * - Ranh giới trách nhiệm: modal chỉ đọc và chạy lại, tuyệt đối không có thao tác duyệt bài.
 * - Tính toàn vẹn của kết luận: mỗi thẻ lấy verdict, nhận xét và finding từ ĐÚNG MỘT record.
 * - Chỉ bốn dữ kiện được hiện: chi tiết audit (cache, host, phiên bản prompt, thống kê notebook,
 *   slug nội dung, mã hạ cấp) không được quay lại UI tác nghiệp.
 * - Minh bạch hậu kiểm: một finding chỉ được trình bày như đã xác minh khi audit row thật sự nói
 *   thế. Row cũ thiếu field mới không có badge nào, và mã chẩn đoán không bao giờ lên UI.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { formatLocal } from "../api/competitions";
import type { AiReviewDetail, AiReviewRecord } from "../api/aiReview";
import type { AdminSubmissionItem } from "../api/results";
import { MAX_POLLS, POLL_INTERVAL_MS } from "../hooks/usePendingPolling";
import { flushTimers } from "../test/timers";
import { AiReviewDetailModal } from "./AiReviewDetailModal";
import { FOCUSABLE } from "./Modal";

const SUBMISSION_ID = "64a000000000000000000009";

/** Bản nháp model soạn cho thí sinh; admin đọc ở đây trước khi tự viết lý do gửi đi. */
const AI_HINT = "Dùng dữ liệu ngoài cuộc thi; bỏ tệp ngoài.";

const DISCLAIMER = "AI chỉ tham khảo, không ảnh hưởng điểm số. Ban Tổ chức quyết định cuối cùng.";

/* Dài hơn ngưỡng mở rộng 180 ký tự để chắc chắn có nút "Xem thêm"; ghép bằng `repeat` thay vì
   đếm tay để đổi câu chữ không âm thầm làm test mất ý nghĩa. `trim` để chuỗi khớp đúng dạng đã
   chuẩn hoá khoảng trắng mà testing-library dùng khi so văn bản. */
const LONG_SUMMARY = "Model nghi ngờ nhưng không trích được bằng chứng. ".repeat(5).trim();
const LONG_RULE = "Không được sử dụng dữ liệu ngoài cuộc thi. ".repeat(6).trim();
const LONG_REASON = "Notebook đọc tệp ngoài cuộc thi ở bước dựng đặc trưng. ".repeat(4).trim();

const EVIDENCE_SNIPPET = "df = read_csv('/data/extra.csv')";

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
    verdict: "INCONCLUSIVE",
    summary: "Model nghi ngờ nhưng không trích được bằng chứng.",
    participant_summary: AI_HINT,
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
    participant_summary: null,
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
    model: null,
    versions: {
      prompt: "ai-review-v3",
      normalization: "notebook-v1",
      context_policy: "context-v2",
      canonicalization: null,
      rule_ref: null,
      verifier: null,
    },
    source: "PROVIDER",
    reused_from_review_id: null,
    bypass_cache: false,
    manual: false,
    attempts: 1,
    downgrade_codes: [],
    error: null,
    started_at: "2026-09-15T09:10:00Z",
    completed_at: "2026-09-15T09:10:00Z",
    duration_ms: 850,
    created_at: "2026-09-15T09:10:00Z",
    ...overrides,
  };
}

/** Lượt canonical: `latest_review_id` trỏ vào đúng record này. */
const CANONICAL_RUN = record({
  id: "r2",
  run_id: "run-2",
  generation: 2,
  verdict: "INCONCLUSIVE",
  model_verdict: "FLAGGED",
  manual: true,
  bypass_cache: true,
  downgrade_codes: ["EVIDENCE_MISSING"],
  summary: LONG_SUMMARY,
  participant_summary: AI_HINT,
  model: "gpt-oss-120b",
  duration_ms: 2500,
  completed_at: "2026-09-15T09:12:05Z",
  created_at: "2026-09-15T09:12:05Z",
  findings: [
    {
      source_content_title: "Thể lệ vòng sơ loại",
      source_content_slug: "the-le-vong-so-loai",
      rule_text: LONG_RULE,
      checkability: "CHECKABLE_FROM_NOTEBOOK",
      status: "VIOLATION",
      reason: LONG_REASON,
      evidence: [{ cell: 3, start_line: 12, end_line: 14, snippet: EVIDENCE_SNIPPET }],
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
  history: [record(), CANONICAL_RUN],
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
      if (url.endsWith("/rerun")) return handler(url, init ?? {});
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

/** Chi tiết với projection bị thay; history giữ nguyên trừ khi test tự đổi. */
function detailWith(overrides: Partial<AiReviewDetail>): AiReviewDetail {
  return { ...DETAIL, ...overrides };
}

function resultCard(): HTMLElement {
  const dialog = screen.getByRole("dialog");
  const card = dialog.querySelector<HTMLElement>(".ai-result-card");
  if (!card) throw new Error("Không có thẻ kết quả trong modal.");
  return card;
}

/** Ba dữ kiện của lượt chạy, đọc thẳng từ `<dl>` để không phụ thuộc thứ tự câu chữ. */
function runFacts(scope: HTMLElement): Record<string, string> {
  const facts: Record<string, string> = {};
  scope.querySelectorAll("dt").forEach((term) => {
    facts[term.textContent?.trim() ?? ""] = term.nextElementSibling?.textContent?.trim() ?? "";
  });
  return facts;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------------------------
   Ma trận trạng thái
   --------------------------------------------------------------------------- */

test("COMPLETED dùng record canonical: mỗi kết luận chỉ xuất hiện một lần", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  // Kết luận của lượt canonical chỉ có một chỗ để đọc; lượt cũ nằm trong lịch sử.
  expect(screen.getAllByText("Chưa đủ căn cứ")).toHaveLength(1);
  expect(screen.getAllByText("Không phát hiện")).toHaveLength(1);
  // Verdict của lượt cũ chỉ được phép nằm trong lịch sử.
  expect(screen.getByText("Các lượt trước")).toBeTruthy();
});

test("lượt canonical lấy theo latest_review_id, không phải theo generation cao nhất", async () => {
  // Record generation 3 không được projection trỏ tới: nó là lượt cũ, không phải lượt đang xem.
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWith({
      history: [
        CANONICAL_RUN,
        record({ id: "r3", run_id: "run-3", generation: 3, verdict: "CLEAR" }),
      ],
    }),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  const card = resultCard();
  expect(within(card).getByText(LONG_SUMMARY)).toBeTruthy();

  const history = screen.getByRole("dialog").querySelector<HTMLElement>(".ai-history")!;
  expect(within(history).getByText("Không phát hiện")).toBeTruthy();
});

test("projection trỏ vào record không tồn tại thì lùi về lượt gần nhất và gọi đúng tên nó", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWith({
      ai_review: { ...SUBMISSION.ai_review!, latest_review_id: "khong-ton-tai" },
      history: [record({ id: "r5", run_id: "run-5", generation: 5 })],
    }),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(within(resultCard()).getByText("Không thấy vi phạm.")).toBeTruthy();
});

test("bài chưa từng được kiểm tra thì nói rõ thay vì hiện kết luận rỗng", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWith({ ai_review: null, history: [] }),
  );
  renderModal();

  expect(await screen.findByText("Bài nộp này chưa có kết quả kiểm tra AI.")).toBeTruthy();
  expect(screen.queryByText("Kết quả đánh giá")).toBeNull();
  expect(screen.queryByText("Các lượt trước")).toBeNull();
});

test("mất projection nhưng còn lịch sử: nói rõ nguồn và gọi là kết quả gần nhất", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWith({ ai_review: null, history: [CANONICAL_RUN] }),
  );
  renderModal();

  await screen.findByText("Kết quả gần nhất");
  expect(screen.getByText(/hiện không có lượt kiểm tra AI nào đang chạy/)).toBeTruthy();
});

test("COMPLETED mà không có record nào thì thú nhận thiếu chi tiết", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWith({ ai_review: SUBMISSION.ai_review, history: [] }),
  );
  renderModal();

  expect(await screen.findByText("Không tìm thấy chi tiết kết quả AI.")).toBeTruthy();
});

test("đang chờ lần đầu: chỉ có vùng trạng thái, không dựng kết quả hay lịch sử giả", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWith({
      ai_review: { ...SUBMISSION.ai_review!, state: "QUEUED", verdict: null, latest_review_id: null },
      history: [],
    }),
  );
  renderModal();

  await screen.findByText("AI đang kiểm tra notebook…");
  // `role="status"` cũng là role của hộp "đang tải", nên phải chờ nó rời DOM rồi mới hỏi.
  expect(screen.getByRole("status")).toHaveClass("ai-status");
  expect(screen.queryByText("Kết quả đánh giá")).toBeNull();
  expect(screen.queryByText(/^Kết quả gần nhất$/)).toBeNull();
  expect(screen.queryByText("Các lượt trước")).toBeNull();
});

test("chạy lại xong đang chờ: kết quả cũ phải được gọi là kết quả gần nhất", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWith({
      ai_review: { ...SUBMISSION.ai_review!, state: "RUNNING", verdict: null, latest_review_id: null },
      history: [record({ id: "r1", run_id: "run-1", generation: 1 })],
    }),
  );
  renderModal();

  await screen.findByText("Kết quả gần nhất");
  expect(screen.getByRole("status")).toHaveTextContent("AI đang kiểm tra notebook…");
  // Kết quả cũ vẫn đọc được, nhưng không được gọi là kết quả hiện tại.
  expect(within(resultCard()).getByText("Không thấy vi phạm.")).toBeTruthy();
  expect(screen.queryByText("Kết quả đánh giá")).toBeNull();
});

test("lượt hỏng: hiện lỗi đã che và không vẽ danh sách finding rỗng", async () => {
  const failed = record({
    id: "r9",
    run_id: "run-9",
    generation: 9,
    status: "FAILED",
    verdict: "ERROR",
    model_verdict: null,
    summary: "Chưa có kết luận.",
    error: {
      code: "AI_PROVIDER_UNAUTHORIZED",
      message: "Nhà cung cấp từ chối API key.",
      occurred_at: "2026-09-15T09:20:00Z",
    },
  });
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWith({
      ai_review: { ...SUBMISSION.ai_review!, state: "ERROR", verdict: "ERROR", latest_review_id: null },
      history: [failed],
    }),
  );
  renderModal();

  await screen.findByText("Chi tiết lượt không hoàn tất");
  expect(screen.getByText("Nhà cung cấp từ chối API key.")).toBeTruthy();
  // Lượt hỏng không có finding nào để đối chiếu, nên không có câu "không phát hiện" nào cả.
  expect(screen.queryByText("Không phát hiện nội dung vi phạm.")).toBeNull();
  expect(screen.queryByText("Không có bằng chứng đủ để kết luận.")).toBeNull();
});

test("ERROR mà không còn record nào thì chỉ nói AI chưa hoàn tất", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWith({
      ai_review: { ...SUBMISSION.ai_review!, state: "ERROR", verdict: "ERROR", latest_review_id: null },
      history: [],
    }),
  );
  renderModal();

  expect(await screen.findByText("AI chưa thể hoàn tất kiểm tra.")).toBeTruthy();
});

/* ---------------------------------------------------------------------------
   Bốn dữ kiện, và những thứ không được quay lại
   --------------------------------------------------------------------------- */

test("thẻ kết quả chỉ hiện bốn dữ kiện: verdict, hoàn tất, thời gian chạy, model", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  const card = resultCard();
  expect(runFacts(card)).toEqual({
    "Hoàn tất": formatLocal(CANONICAL_RUN.completed_at!),
    "Thời gian chạy": "2,5 giây",
    Model: "gpt-oss-120b",
  });
});

test("chi tiết audit không quay lại UI: không phiên bản prompt, host, cache, slug hay mã hạ cấp", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  for (const forbidden of [
    /prompt v3/,
    /api\.example\.com/,
    /Lần #\d/,
    /Chạy tay/,
    /Bỏ qua cache/,
    /Dùng lại kết quả cũ/,
    /Pipeline tự kết luận/,
    /EVIDENCE_MISSING/,
    /RULE_REF_UNKNOWN/,
    /RULE_QUOTE_UNMATCHED/,
    /the-le-vong-so-loai/,
    /Notebook: \d+ cell/,
    /Kiểm tra được từ notebook/,
  ]) {
    expect(screen.queryByText(forbidden)).toBeNull();
  }
});

test("thông điệp hạ cấp tách đề xuất của AI khỏi kết quả sau hậu kiểm", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  // Cả hai vế phải có mặt: chỉ nói "đã hạ xuống" thì admin không biết model đã đề xuất gì.
  expect(
    screen.getByText(
      "AI đề xuất “Có dấu hiệu”. Sau khi hậu kiểm quy định và bằng chứng, kết quả cuối là “Chưa đủ căn cứ”.",
    ),
  ).toBeTruthy();
});

test("notebook bị cắt bớt thì nói riêng, không lặp lại nguyên nhân kỹ thuật", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWith({
      history: [
        record({
          id: "r2",
          generation: 2,
          verdict: "CLEAR",
          notebook_stats: { ...CANONICAL_RUN.notebook_stats, truncated: true, omitted_cells: 4 },
        }),
      ],
    }),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(screen.getByText("Notebook chưa được kiểm tra toàn bộ.")).toBeTruthy();
  expect(screen.queryByText(/đã lược bớt/)).toBeNull();
});

test("câu nhắc trách nhiệm giữ nguyên văn trong thẻ kết quả", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(within(resultCard()).getByText(DISCLAIMER)).toBeTruthy();
});

test("bản nháp model soạn cho thí sinh đứng riêng dưới một nhãn của nó", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  const card = resultCard();
  // Hai nhãn khác nhau: admin phải phân biệt được nhận xét của AI với câu gợi ý sẽ gửi cho thí sinh.
  expect(within(card).getByText("Nhận xét của AI")).toBeTruthy();
  expect(within(card).getByText("Gợi ý cho thí sinh")).toBeTruthy();
  expect(within(card).getByText(LONG_SUMMARY)).toBeTruthy();
  expect(within(card).getByText(AI_HINT)).toBeTruthy();
  expect(within(card).getByText(LONG_SUMMARY)).not.toBe(within(card).getByText(AI_HINT));
});

test("hai nhận xét nằm chung một khối để lên hai cột khi đủ chỗ", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  // Cùng một phần tử bọc: ở bề rộng đủ lớn chính nó thành lưới hai cột, không phải đổi DOM.
  const notes = resultCard().querySelector<HTMLElement>(".ai-notes");
  expect(notes).toBeTruthy();
  expect(notes!.querySelectorAll(".ai-note").length).toBe(2);
});

test("model không soạn gợi ý thì không có nhãn gợi ý nào", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    // Thẻ kết quả đọc gợi ý từ đúng record canonical, không phải từ projection.
    detailWith({ history: [{ ...CANONICAL_RUN, participant_summary: null }] }),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(within(resultCard()).queryByText("Gợi ý cho thí sinh")).toBeNull();
  // Khối bọc vẫn còn, chỉ còn một cột chữ.
  const notes = resultCard().querySelector<HTMLElement>(".ai-notes");
  expect(notes!.querySelectorAll(".ai-note").length).toBe(1);
});

test("modal không chứa bất kỳ thao tác duyệt bài nào của con người", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).queryByRole("button", { name: "Không chấp nhận" })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Khôi phục" })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Chấp nhận" })).toBeNull();
});

/* ---------------------------------------------------------------------------
   Lịch sử
   --------------------------------------------------------------------------- */

test("lịch sử đóng mặc định, xếp lượt mới lên đầu và không lặp lượt đang xem", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWith({
      history: [
        record({ id: "r1", run_id: "run-1", generation: 1 }),
        record({
          id: "r3",
          run_id: "run-3",
          generation: 3,
          verdict: "CLEAR",
          completed_at: "2026-09-15T09:14:00Z",
          created_at: "2026-09-15T09:14:00Z",
        }),
        CANONICAL_RUN,
      ],
    }),
  );
  renderModal();

  await screen.findByText("Các lượt trước");
  const dialog = screen.getByRole("dialog");
  const summaries = Array.from(dialog.querySelectorAll(".ai-history-summary"));
  // Lượt canonical đang mở ở thẻ kết quả nên chỉ còn hai lượt cũ, mới nhất đứng đầu.
  expect(summaries).toHaveLength(2);

  const details = Array.from(dialog.querySelectorAll<HTMLDetailsElement>("details.ai-history-item"));
  expect(details).toHaveLength(2);
  expect(details.every((item) => item.open)).toBe(false);
  // Generation 3 đứng trước generation 1.
  expect(summaries[0]).toHaveTextContent(formatLocal("2026-09-15T09:14:00Z"));
  expect(summaries[1]).toHaveTextContent(formatLocal("2026-09-15T09:10:00Z"));
});

test("dòng đóng của lịch sử chỉ mang bốn dữ kiện", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Các lượt trước");
  const dialog = screen.getByRole("dialog");
  const summary = dialog.querySelector<HTMLElement>(".ai-history-summary")!;

  // Bốn dữ kiện: verdict ở pill, ba cái còn lại ở ba cặp nhãn/giá trị.
  expect(summary).toHaveTextContent("Không phát hiện");
  const facts = Array.from(summary.querySelectorAll<HTMLElement>(".ai-history-fact"));
  expect(
    facts.map((fact) => [
      fact.querySelector(".ai-history-fact-label")?.textContent,
      fact.querySelector(".ai-history-fact-value")?.textContent,
    ]),
  ).toEqual([
    ["Hoàn tất", formatLocal("2026-09-15T09:10:00Z")],
    ["Thời gian chạy", "850 ms"],
    // `model` của lượt cũ là null: hiện gạch, không hiện khoảng trắng.
    ["Model", "—"],
  ]);

  for (const forbidden of [/prompt/, /api\.example\.com/, /Lần #/, /cell/, /Không chấp nhận/]) {
    expect(summary.textContent ?? "").not.toMatch(forbidden);
  }
});

/* ---------------------------------------------------------------------------
   Finding
   --------------------------------------------------------------------------- */

type AiFindingFixture = AiReviewRecord["findings"][number];

const THREE_FINDINGS: AiFindingFixture = {
  source_content_title: "Thể lệ vòng sơ loại",
  source_content_slug: "the-le-vong-so-loai",
  rule_text: "Không được sử dụng dữ liệu ngoài cuộc thi.",
  checkability: "CHECKABLE_FROM_NOTEBOOK",
  status: "VIOLATION",
  reason: "Notebook đọc tệp ngoài.",
  evidence: [{ cell: 3, start_line: 12, end_line: 14, snippet: EVIDENCE_SNIPPET }],
};

function detailWithFindings(findings: AiFindingFixture[]): AiReviewDetail {
  return detailWith({
    history: [{ ...CANONICAL_RUN, findings }],
  });
}

/**
 * Finding của row Hybrid B+D: có đủ số đo hậu kiểm mà badge dựa vào. Mặc định là ca lành mạnh -
 * quy định resolve được và bằng chứng hợp lệ - để mỗi test chỉ phải nói ra đúng thứ nó muốn phá.
 */
function checked(overrides: Partial<AiFindingFixture> = {}): AiFindingFixture {
  return {
    ...THREE_FINDINGS,
    rule_ref: "the-le-vong-so-loai#0123456789abcdef01234567",
    model_rule_ref: "the-le-vong-so-loai#0123456789abcdef01234567",
    rule_resolution: "REFERENCE",
    rule_verified: true,
    evidence_count: 1,
    valid_evidence_count: 1,
    evidence_verified: true,
    verified: true,
    traceable: true,
    verification_codes: [],
    ...overrides,
  };
}

const UNCHECKED_LABEL = "Không đối chiếu được quy định";
const RULE_ONLY_LABEL = "Đã tìm thấy quy định, chưa xác minh bằng chứng";

test("ba mức finding có ba tông khác nhau, và vi phạm thì đỏ", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWithFindings([
      { ...THREE_FINDINGS, status: "VIOLATION" },
      { ...THREE_FINDINGS, status: "UNCLEAR", evidence: [] },
      { ...THREE_FINDINGS, status: "COMPLIANT", evidence: [] },
    ]),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(screen.getByText("Có dấu hiệu vi phạm")).toHaveClass("danger");
  expect(screen.getByText("Chưa rõ")).toHaveClass("warning");
  expect(screen.getByText("Không vi phạm")).toHaveClass("success");
});

test("chip ngoài notebook chỉ hiện khi finding không kiểm chứng được từ notebook", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWithFindings([{ ...THREE_FINDINGS, checkability: "NOT_CHECKABLE_FROM_NOTEBOOK" }]),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(screen.getByText("Ngoài notebook")).toBeTruthy();
});

test("finding hiện nguyên văn thể lệ, lý do và bằng chứng trong pre", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(screen.getByText(LONG_RULE)).toBeTruthy();
  expect(screen.getByText(LONG_REASON)).toBeTruthy();
  expect(screen.getByText("Thể lệ vòng sơ loại")).toBeTruthy();

  // Bằng chứng là đoạn notebook server trích lại, hiển thị nguyên văn trong `<pre>`.
  const evidence = screen.getByText(EVIDENCE_SNIPPET);
  expect(evidence.tagName).toBe("PRE");
  expect(screen.getByText("Dòng 12–14 · Cell 3")).toBeTruthy();
});

test("hai đoạn của một finding nằm chung một khối để lên hai cột khi đủ chỗ", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  const texts = resultCard().querySelector<HTMLElement>(".ai-finding-texts");
  expect(texts).toBeTruthy();
  expect(texts!.querySelector(".ai-finding-rule")).toBeTruthy();
  expect(texts!.querySelector(".ai-finding-reason")).toBeTruthy();
});

test("đoạn nào không có chữ thì không dựng, và không để lại khối hai cột rỗng", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWithFindings([
      { ...THREE_FINDINGS, rule_text: "" },
      { ...THREE_FINDINGS, reason: "" },
      { ...THREE_FINDINGS, rule_text: "", reason: "" },
    ]),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  const card = resultCard();
  expect(card.querySelectorAll(".ai-finding-texts").length).toBe(2);
  expect(card.querySelectorAll(".ai-finding-rule").length).toBe(1);
  expect(card.querySelectorAll(".ai-finding-reason").length).toBe(1);
});

test("vi phạm không có bằng chứng thì nói rõ chưa xác minh được đoạn code nào", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWithFindings([{ ...THREE_FINDINGS, evidence: [] }]),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(screen.getByText("Không có đoạn code được xác minh.")).toBeTruthy();
});

test("finding COMPLIANT không có bằng chứng thì không có câu nhắc nào", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWithFindings([{ ...THREE_FINDINGS, status: "COMPLIANT", evidence: [] }]),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(screen.queryByText("Không có đoạn code được xác minh.")).toBeNull();
});

test("finding đối chiếu được cả quy định lẫn bằng chứng mang badge trung tính", async () => {
  mockApi(() => json({ submission: DETAIL.submission }), detailWithFindings([checked()]));
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  // Trung tính chứ không xanh: "đã đối chiếu" là mặc định lành mạnh, không phải một kết luận.
  expect(screen.getByText("Đã đối chiếu")).toHaveClass("neutral");
  expect(screen.queryByText(/khớp với notebook/)).toBeNull();
});

test("đối chiếu được quy định nhưng không xác minh được bằng chứng thì nói rõ vế còn thiếu", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWithFindings([
      checked({
        evidence: [],
        evidence_count: 1,
        valid_evidence_count: 0,
        evidence_verified: false,
        verified: false,
        traceable: false,
      }),
    ]),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(screen.getByText(RULE_ONLY_LABEL)).toHaveClass("warning");
  expect(screen.getByText("Không đoạn trích nào của AI khớp với notebook.")).toBeTruthy();
});

test("không đối chiếu được quy định thì nói ra, và không dán bản sao của model vào chỗ thể lệ", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWithFindings([
      checked({
        // Backend để trống provenance khi không resolve được; UI không được lấp chỗ trống đó.
        source_content_title: "",
        source_content_slug: "",
        rule_text: "",
        rule_ref: null,
        rule_resolution: "UNRESOLVED",
        rule_verified: false,
        verified: false,
        traceable: false,
        verification_codes: ["RULE_REF_UNKNOWN", "RULE_QUOTE_UNMATCHED"],
      }),
    ]),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(screen.getByText(UNCHECKED_LABEL)).toHaveClass("warning");
  expect(screen.getByText(/không khớp với bản thể lệ đã chốt/)).toBeTruthy();
  // Không có văn bản thể lệ nào để hiện, và mã chẩn đoán của backend cũng không được lên UI.
  expect(resultCard().querySelector(".ai-finding-rule")).toBeNull();
  for (const code of ["RULE_REF_UNKNOWN", "RULE_QUOTE_UNMATCHED"]) {
    expect(screen.queryByText(new RegExp(code))).toBeNull();
  }
});

test("range bị bỏ được đếm ra thay vì im lặng coi như finding không có bằng chứng", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWithFindings([checked({ evidence_count: 3, valid_evidence_count: 1 })]),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(
    screen.getByText("Một số đoạn trích AI nêu không khớp với notebook nên đã bị bỏ."),
  ).toBeTruthy();
});

test("row lịch sử thiếu field hậu kiểm thì không có badge nào, không suy diễn là đã xác minh", async () => {
  // `THREE_FINDINGS` đúng là hình dạng row cũ: không có field hậu kiểm nào cả.
  mockApi(() => json({ submission: DETAIL.submission }), detailWithFindings([THREE_FINDINGS]));
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  for (const label of ["Đã đối chiếu", RULE_ONLY_LABEL, UNCHECKED_LABEL]) {
    expect(screen.queryByText(label)).toBeNull();
  }
  // Văn bản thể lệ và bằng chứng của row cũ vẫn hiện nguyên vẹn.
  expect(screen.getByText("Không được sử dụng dữ liệu ngoài cuộc thi.")).toBeTruthy();
});

test("không có finding và kết luận là CLEAR thì nói không phát hiện nội dung vi phạm", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWith({ history: [record({ id: "r2", generation: 2, verdict: "CLEAR", findings: [] })] }),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(screen.getByText("Không phát hiện nội dung vi phạm.")).toBeTruthy();
});

test("không có finding và kết luận là INCONCLUSIVE thì nói thiếu bằng chứng", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWith({
      history: [record({ id: "r2", generation: 2, verdict: "INCONCLUSIVE", findings: [] })],
    }),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(screen.getByText("Không có bằng chứng đủ để kết luận.")).toBeTruthy();
});

/* ---------------------------------------------------------------------------
   Mở rộng / thu gọn
   --------------------------------------------------------------------------- */

test("nhận xét và điều khoản dài có nút mở rộng đổi trạng thái đúng", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  const toggles = screen.getAllByRole("button", { name: "Xem thêm" });
  expect(toggles).toHaveLength(3); // nhận xét, thể lệ, lý do

  const [first] = toggles;
  const text = document.getElementById(first.getAttribute("aria-controls")!)!;
  expect(text).toHaveClass("is-clamped");
  // Toàn bộ nội dung vẫn nằm trong DOM chứ không bị cắt chuỗi.
  expect(text.textContent).toBe(LONG_SUMMARY);

  fireEvent.click(first);
  expect(first).toHaveAttribute("aria-expanded", "true");
  expect(first).toHaveTextContent("Thu gọn");
  expect(text).not.toHaveClass("is-clamped");

  fireEvent.click(first);
  expect(first).toHaveAttribute("aria-expanded", "false");
  expect(first).toHaveTextContent("Xem thêm");
  expect(text).toHaveClass("is-clamped");
});

test("câu ngắn không có nút mở rộng", async () => {
  mockApi(
    () => json({ submission: DETAIL.submission }),
    detailWith({
      history: [
        {
          ...CANONICAL_RUN,
          summary: "Ngắn.",
          findings: [{ ...THREE_FINDINGS, rule_text: "Ngắn.", reason: "Ngắn." }],
        },
      ],
    }),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  expect(screen.queryByRole("button", { name: "Xem thêm" })).toBeNull();
});

/* ---------------------------------------------------------------------------
   Bàn phím và focus
   --------------------------------------------------------------------------- */

test("tab order trong modal: đóng, hai hành động, các nút mở rộng, rồi lịch sử", async () => {
  mockApi(() => json({ submission: DETAIL.submission }));
  renderModal();

  await screen.findByText("Kết quả đánh giá");
  const dialog = screen.getByRole("dialog");
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));

  expect(focusable[0]).toHaveAccessibleName("Đóng");
  expect(focusable[1]).toHaveTextContent("Tải notebook");
  expect(focusable[2]).toHaveTextContent("Chạy lại AI");
  // `summary` phải nằm trong tập focusable, nếu không focus trap tính sai phần tử cuối và Tab
  // sẽ nhảy ra khỏi dialog ngay tại khối lịch sử.
  expect(focusable.at(-1)?.tagName).toBe("SUMMARY");
  expect(focusable.at(-1)).toHaveTextContent("Không phát hiện");
});

/* ---------------------------------------------------------------------------
   Hành động: tải notebook, chạy lại, polling
   --------------------------------------------------------------------------- */

test("chạy lại phải qua xác nhận, gửi POST và đọc lại chi tiết", async () => {
  const onChanged = vi.fn();
  const requests = mockApi(() => json({ submission: DETAIL.submission }));
  renderModal({ onChanged });

  await screen.findByText("Kết quả đánh giá");
  fireEvent.click(screen.getByRole("button", { name: "Chạy lại AI" }));
  const dialog = await screen.findByRole("dialog", { name: "Chạy lại kiểm tra AI" });
  expect(within(dialog).getByText(/Kết quả cũ vẫn được lưu trong lịch sử/)).toBeTruthy();
  // Chưa xác nhận thì chưa có request nào.
  expect(requests.some((item) => item.url.endsWith("/rerun"))).toBe(false);

  const before = requests.filter((item) => item.method === "GET").length;
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
    detailWith({
      content_snapshot: {
        state: "ERROR",
        revision_id: null,
        content_hash: null,
        error_code: "AI_CONTENT_SNAPSHOT_UNAVAILABLE",
        captured_at: null,
      },
    }),
  );
  renderModal();

  await screen.findByText("Kết quả đánh giá");
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
  await screen.findByText("Kết quả đánh giá");
  fireEvent.click(screen.getByRole("button", { name: "Tải notebook" }));

  await waitFor(() =>
    expect(requests.some((url) => url.endsWith(`/api/admin/submissions/${SUBMISSION_ID}/notebook`))).toBe(
      true,
    ),
  );
});

test("lượt đang chờ được poll có trần, và dừng lại thì báo cho admin biết", async () => {
  vi.useFakeTimers();
  try {
    const requests = mockApi(
      () => json({ submission: DETAIL.submission }),
      detailWith({
        ai_review: { ...SUBMISSION.ai_review!, state: "QUEUED", verdict: null, latest_review_id: null },
        history: [],
      }),
    );
    renderModal();

    await flushTimers(0);
    expect(screen.getByRole("status")).toBeTruthy();

    await flushTimers(POLL_INTERVAL_MS * (MAX_POLLS + 2));
    // Ngân sách đếm theo lượt thật sự gọi: lượt tải đầu cộng MAX_POLLS lượt poll, rồi dừng.
    expect(requests.filter((item) => item.method === "GET")).toHaveLength(MAX_POLLS + 1);
    expect(screen.getByText(/Đã tạm dừng tự động làm mới/)).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
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

  await screen.findByText("Kết quả đánh giá");
  expect(screen.queryByRole("button", { name: "Thử lại" })).toBeNull();
});
