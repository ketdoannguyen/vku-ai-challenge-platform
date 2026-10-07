import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import type { CompetitionDetail, ParticipantTrackView } from "../api/competitions";
import { flushTimers } from "../test/timers";
import { SubmissionPage } from "./SubmissionPage";

const COMPETITION: CompetitionDetail = {
  id: "64a000000000000000000001",
  slug: "submit-cup",
  name: "Submit Cup",
  short_description: "",
  status: "published",
  start_at: "2026-01-01T00:00:00Z",
  end_at: "2027-01-01T00:00:00Z",
  join_mode: "open",
  primary_metric: "f1",
  quota_per_day: 5,
  leaderboard_visible: true,
  resources: [],
  join_code_configured: false,
  primary_metric_label: "F1",
  access: { allowed: true, reason: null },
  membership: { active: true, joined_at: "2026-09-15T00:00:00Z" },
  submission_config: {
    ready: true,
    id_column: "id",
    prediction_column: "prediction",
    average: "binary",
    pos_label: "1",
    max_upload_mb: 10,
    max_notebook_mb: 20,
  },
};

/** Shell thật sẽ khóa gate khi được thông báo; ở đây chỉ cần ghi nhận lý do. */
const reportAccessLost = vi.fn();

function pageTree(
  competition: CompetitionDetail,
  entry: string,
  refreshCompetition: () => Promise<void> = async () => {},
) {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          element={
            <Outlet context={{ competition, contents: [], refreshCompetition, reportAccessLost }} />
          }
        >
          <Route path="/competitions/:slug/submit" element={<SubmissionPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function renderPage(
  competition: CompetitionDetail = COMPETITION,
  entry = "/competitions/submit-cup/submit",
) {
  const refreshCompetition = vi.fn(async () => {});
  const view = render(pageTree(competition, entry, refreshCompetition));
  return { ...view, refreshCompetition, reportAccessLost };
}

/** Notebook hợp lệ tối thiểu - mọi lượt nộp đều phải kèm tệp này. */
function selectNotebook(name = "solution.ipynb") {
  fireEvent.change(screen.getByLabelText("Chọn notebook"), {
    target: { files: [new File(["{}"], name, { type: "application/x-ipynb+json" })] },
  });
}

function selectCsv(name = "result.csv", body = "id,prediction\n1,1\n") {
  fireEvent.change(screen.getByLabelText("Chọn tệp CSV"), {
    target: { files: [new File([body], name, { type: "text/csv" })] },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  reportAccessLost.mockClear();
  vi.useRealTimers();
});

/** Nhịp trang hỏi trạng thái lượt chấm; `flushTimers` chia thời gian thành từng nhịp poll. */
const POLL_MS = 1_500;

/** Cuộc thi v2: có hàng đợi chấm nên trang tự tìm lại lượt còn dở khi mở lại. */
function v2Competition(): CompetitionDetail {
  return { ...COMPETITION, submission_config: { ...COMPETITION.submission_config, version: 2 } };
}

/** Payload chấm điểm đã xong, chưa ghép projection AI. */
const SCORED = {
  id: "submission-1",
  competition_id: COMPETITION.id,
  status: "completed",
  metrics: { f1: 0.5, precision: 0.5, recall: 0.5 },
  primary_score: 0.5,
  created_at: "2026-09-15T00:00:00Z",
  quota_remaining: 4,
};

/** Lượt vừa được nhận vào hàng đợi: backend trả payload này kèm 202. */
function queued(overrides: Record<string, unknown> = {}) {
  return {
    attempt_id: "attempt-1",
    status: "QUEUED",
    created_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    queue_position: 1,
    error: null,
    submission: null,
    ...overrides,
  };
}

/** Lượt đã chấm xong: kết quả nằm trong `submission`. */
function completed(overrides: Record<string, unknown> = {}) {
  return queued({ status: "COMPLETED", queue_position: null, submission: SCORED, ...overrides });
}

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface SentRequest {
  url: string;
  method: string;
  key: string | null;
}

/**
 * Giả lập backend chấm: POST nhận bài trả 202, mỗi lần hỏi trạng thái lấy lần lượt `reads` (hết thì
 * lặp lại lần cuối). Ghi lại từng request để test đối chiếu URL, method và `Idempotency-Key`.
 */
function mockScoring(queuedPayload: unknown, ...reads: unknown[]) {
  const sent: SentRequest[] = [];
  let readCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      sent.push({
        url,
        method,
        key: new Headers(init?.headers as HeadersInit).get("Idempotency-Key"),
      });
      if (method === "POST") return json(queuedPayload, 202);
      // Danh sách lượt chưa xong lúc mở trang: mặc định không có lượt nào.
      if (url.endsWith("/submissions/attempts")) return json({ attempts: [] }, 200);
      const payload = reads[Math.min(readCount, reads.length - 1)];
      readCount += 1;
      return json(payload, 200);
    }),
  );
  return sent;
}

function submitOnce() {
  selectCsv();
  selectNotebook();
  fireEvent.click(screen.getByRole("button", { name: "Nộp và chấm điểm" }));
}

test("hiển thị rule summary và chỉ mở nút nộp khi đã đủ hai tệp", () => {
  renderPage();
  const rules = screen.getByLabelText("Quy định tệp nộp bài");
  expect(rules).toHaveTextContent("ID: id");
  expect(rules).toHaveTextContent("Prediction: prediction");
  expect(rules).toHaveTextContent("Binary");
  expect(rules).toHaveTextContent("CSV 10 MiB");
  expect(rules).toHaveTextContent("notebook tối đa 20 MiB");
  expect(rules).toHaveTextContent("5 lượt/ngày");

  const file = new File(["id,prediction\n1,1\n"], "team-result.csv", { type: "text/csv" });
  fireEvent.change(screen.getByLabelText("Chọn tệp CSV"), { target: { files: [file] } });
  expect(screen.getByText("team-result.csv")).toBeTruthy();
  // Notebook là phần bắt buộc của mỗi lượt nộp: thiếu nó thì chưa nộp được.
  expect(screen.getByRole("button", { name: "Nộp và chấm điểm" })).toBeDisabled();

  selectNotebook();
  expect(screen.getByText("solution.ipynb")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Nộp và chấm điểm" })).toBeEnabled();
});

test("từ chối tệp sai định dạng và tệp vượt trần của từng slot", () => {
  renderPage();

  fireEvent.change(screen.getByLabelText("Chọn notebook"), {
    target: { files: [new File(["<html>"], "solution.zip", { type: "application/zip" })] },
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Chỉ chấp nhận notebook Jupyter (.ipynb).");
  expect(screen.queryByText("solution.zip")).toBeNull();

  // Trần notebook (20 MiB) cao hơn trần CSV (10 MiB) nên một file 12 MiB phải qua được.
  const notebook = new File([new Uint8Array(12 * 1024 * 1024)], "solution.ipynb");
  fireEvent.change(screen.getByLabelText("Chọn notebook"), { target: { files: [notebook] } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("solution.ipynb")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Chọn tệp CSV"), {
    target: { files: [new File([new Uint8Array(11 * 1024 * 1024)], "big.csv")] },
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "vượt quá giới hạn tối đa 10 MiB",
  );
  expect(screen.queryByText("big.csv")).toBeNull();
});

test("thanh hạn mức dài theo đúng tỉ lệ còn lại và hạ mức màu khi gần hết", () => {
  const withQuota = (remaining: number) =>
    renderPage({
      ...COMPETITION,
      quota: { per_day: 5, used_today: 5 - remaining, remaining, resets_at: "2026-09-18T00:00:00Z" },
    });

  const four = withQuota(4);
  const fill = document.querySelector(".sub-quota-fill") as HTMLElement;
  expect(fill.style.width).toBe("80%");
  expect(fill.dataset.level).toBe("ok");
  // Câu chữ trong ribbon là kênh thông tin chính; thẻ hướng dẫn bên phải lặp lại cùng
  // nhãn nên phải khoanh vùng trước khi đọc.
  expect(within(screen.getByLabelText("Quy định tệp nộp bài")).getByText("Còn 4/5 lượt hôm nay")).toBeTruthy();
  four.unmount();

  const one = withQuota(1);
  expect((document.querySelector(".sub-quota-fill") as HTMLElement).dataset.level).toBe("low");
  one.unmount();

  const none = withQuota(0);
  expect((document.querySelector(".sub-quota-fill") as HTMLElement).dataset.level).toBe("empty");
  expect((document.querySelector(".sub-quota-fill") as HTMLElement).style.width).toBe("0%");
  none.unmount();
});

test("chưa có số liệu quota thì không vẽ thanh, chỉ còn câu chữ", () => {
  renderPage();
  expect(document.querySelector(".sub-quota-track")).toBeNull();
  expect(within(screen.getByLabelText("Quy định tệp nộp bài")).getByText("5 lượt/ngày")).toBeTruthy();
});

test("nút chọn file CSV là <button> thật nên Tab/Enter mở được picker", () => {
  renderPage();
  const button = screen.getByRole("button", { name: "Chọn tệp CSV" });
  expect(button.tagName).toBe("BUTTON");
  expect(button).not.toBeDisabled();
  button.focus();
  expect(button).toHaveFocus();

  const input = screen.getByLabelText("Chọn tệp CSV") as HTMLInputElement;
  const openPicker = vi.spyOn(input, "click").mockImplementation(() => {});
  fireEvent.click(button);
  expect(openPicker).toHaveBeenCalledTimes(1);
  openPicker.mockRestore();
});

test("submit hiển thị loading, vào hàng đợi rồi ra metrics và quota còn lại", async () => {
  vi.useFakeTimers();
  let resolvePost: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolvePost = resolve;
        });
      }
      return Promise.resolve(json(completed(), 200));
    }),
  );
  renderPage();
  selectCsv();
  selectNotebook();
  fireEvent.click(screen.getByRole("button", { name: "Nộp và chấm điểm" }));
  expect(screen.getByRole("button", { name: "Đang gửi bài..." })).toBeDisabled();

  await act(async () => resolvePost?.(json(queued({ queue_position: 3 }), 202)));
  // Lượt đã vào hàng đợi: nút nộp biến mất nên không có cách nào nộp trùng.
  expect(screen.getByText("Bài đang chờ chấm")).toBeTruthy();
  expect(screen.getByText("Bạn đang ở vị trí thứ 3 trong hàng chờ.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Nộp và chấm điểm" })).toBeNull();

  await flushTimers(POLL_MS * 2);
  expect(screen.getByText("Kết quả chấm điểm")).toBeTruthy();
  // Số thập phân lấy theo hợp đồng kết quả (v1: 4 chữ số), không còn cứng 6 chữ số.
  expect(screen.getAllByText("0.5000")).toHaveLength(3);

  const f1Card = document.querySelector<HTMLElement>('[data-metric="f1"]');
  const precisionCard = document.querySelector<HTMLElement>('[data-metric="precision"]');
  const recallCard = document.querySelector<HTMLElement>('[data-metric="recall"]');
  expect([f1Card, precisionCard, recallCard].every(Boolean)).toBe(true);
  expect(f1Card).toHaveClass("primary");
  expect(precisionCard).not.toHaveClass("primary");
  expect(recallCard).not.toHaveClass("primary");
  expect(within(f1Card as HTMLElement).getByText("F1")).toBeTruthy();
  expect(within(precisionCard as HTMLElement).getByText("Precision")).toBeTruthy();
  expect(within(recallCard as HTMLElement).getByText("Recall")).toBeTruthy();
  expect(screen.getAllByText("Chỉ số chính")).toHaveLength(1);

  expect(screen.getByText("Còn 4 lượt nộp hôm nay.")).toBeTruthy();
});

test("cuộc thi bật norm: norm tạm là điểm nổi bật, metric gốc xuống hàng phụ", async () => {
  mockScoring(
    queued(),
    completed({
      submission: {
        ...SCORED,
        normalization_snapshot: { score: 37.5, calculated_at: "2026-09-15T08:00:00Z" },
      },
    }),
  );

  renderPage({ ...COMPETITION, normalization: { enabled: true, baseline: 0.4, version: 1 } });
  submitOnce();
  expect(await screen.findByText("Kết quả chấm điểm")).toBeTruthy();
  const normCard = document.querySelector<HTMLElement>('[data-metric="normalization"]');
  expect(normCard).toHaveClass("primary");
  expect(within(normCard as HTMLElement).getByText("Điểm chuẩn hóa tạm")).toBeTruthy();
  expect(within(normCard as HTMLElement).getByText("37.50")).toBeTruthy();

  // Điểm gốc và các metric vẫn xem được, nhưng không còn được nhấn là điểm chính.
  const f1Card = document.querySelector<HTMLElement>('[data-metric="f1"]');
  expect(f1Card).not.toHaveClass("primary");
  expect(screen.queryByText("Chỉ số chính")).toBeNull();

  // Chú thích nói rõ đây là ảnh chụp tạm kèm đường sang bảng xếp hạng để đối chiếu norm hiện tại.
  expect(screen.getByText(/Con số tạm tính lúc/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Xem bảng xếp hạng để đối chiếu" })).toBeTruthy();
});

test("quyền xem norm bị thu hồi giữa chừng: snapshot trong payload bị bỏ và nói đúng lý do", async () => {
  // Payload chấm vẫn mang snapshot (backend lọc theo quyền lúc trả), nhưng metadata hiện tại đã
  // tắt BXH: con số cũ trong state không được render lại như thể còn xem được.
  mockScoring(
    queued(),
    completed({
      submission: {
        ...SCORED,
        normalization_snapshot: { score: 37.5, calculated_at: "2026-09-15T08:00:00Z" },
      },
    }),
  );

  renderPage({
    ...COMPETITION,
    normalization: { enabled: true, baseline: 0.4, version: 1 },
    leaderboard_visible: false,
  });
  submitOnce();
  expect(await screen.findByText("Kết quả chấm điểm")).toBeTruthy();

  expect(document.querySelector('[data-metric="normalization"]')).toBeNull();
  expect(screen.queryByText("Điểm chuẩn hóa tạm")).toBeNull();
  expect(screen.queryByText(/Con số tạm tính lúc/)).toBeNull();
  expect(screen.getByText("BXH đang được BTC ẩn; điểm chuẩn hóa chưa được hiển thị")).toBeTruthy();
  // Norm xuống khỏi màn hình thì metric nguồn trở lại là chỉ số chính.
  const f1Card = document.querySelector<HTMLElement>('[data-metric="f1"]');
  expect(f1Card).toHaveClass("primary");
  expect(within(f1Card as HTMLElement).getByText("Chỉ số chính")).toBeTruthy();
});

/** Cuộc thi dual: lịch và capability norm của nhánh do backend quyết, FE chỉ đọc lại. */
function dualCompetition(overrides: Partial<ParticipantTrackView> = {}): CompetitionDetail {
  const track: ParticipantTrackView = {
    start_at: "2026-01-01T00:00:00Z",
    end_at: "2027-01-01T00:00:00Z",
    quota_per_day: 5,
    window_state: "open",
    results_released: true,
    resources: [],
    can_submit: true,
    blocked_reason: null,
    submission_ready: true,
    ...overrides,
  };
  return { ...COMPETITION, mode: "public_private", tracks: { public: track, private: track } };
}

test("dual: nhánh bị che norm thì snapshot cũ của nhánh đó không được render", async () => {
  mockScoring(
    queued(),
    completed({
      submission: {
        ...SCORED,
        normalization_snapshot: { score: 44, calculated_at: "2026-09-15T08:00:00Z" },
      },
    }),
  );

  renderPage(
    dualCompetition({
      normalization_visible: false,
      normalization_hidden_reason: "source_metric_hidden",
    }),
    "/competitions/submit-cup/submit?track=private",
  );
  selectCsv();
  selectNotebook();
  fireEvent.click(screen.getByRole("button", { name: "Nộp nhánh Private và chấm điểm" }));
  expect(await screen.findByText("Kết quả chấm điểm · Nhánh Private")).toBeTruthy();

  // Capability của nhánh là nguồn duy nhất: payload còn snapshot nhưng vẫn bị bỏ.
  expect(document.querySelector('[data-metric="normalization"]')).toBeNull();
  expect(screen.getByText("Điểm chuẩn hóa bị ẩn theo cấu hình hiển thị điểm")).toBeTruthy();
});

test("cuộc thi v1: kết quả trả ngay trong request vẫn hiện panel chấm điểm", async () => {
  // v1 chấm trong tiến trình: POST trả thẳng bài nộp đã xong (201) chứ không phải lượt hàng đợi,
  // nên không có `attempt_id` để hỏi trạng thái - trang phải nhận ra và render kết quả luôn.
  const sent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(`${init?.method ?? "GET"} ${String(input)}`);
      return init?.method === "POST" ? json(SCORED, 201) : json({ attempts: [] }, 200);
    }),
  );
  const { refreshCompetition } = renderPage();

  submitOnce();
  expect(await screen.findByText("Kết quả chấm điểm")).toBeTruthy();
  const f1Card = document.querySelector<HTMLElement>('[data-metric="f1"]');
  expect(within(f1Card as HTMLElement).getByText("0.5000")).toBeTruthy();
  expect(screen.getByText(/Còn 4 lượt nộp hôm nay/)).toBeTruthy();
  // Hạn mức ở header được tính lại sau khi nộp, giống đường v2.
  await waitFor(() => expect(refreshCompetition).toHaveBeenCalledTimes(1));
  // Không có lượt nào để theo dõi: chỉ một request POST, không hỏi trạng thái.
  expect(sent).toEqual(["POST /api/competitions/64a000000000000000000001/submissions"]);

  // "Nộp bài khác" đưa về form trống: tệp của lượt vừa rồi không được giữ lại.
  fireEvent.click(screen.getByRole("button", { name: "Nộp bài khác" }));
  expect(screen.getByRole("button", { name: "Nộp và chấm điểm" })).toBeDisabled();
});

test("dual: bài Private chưa công bố hiện lời giải thích chờ công bố thay vì chỉ ô trống", async () => {
  mockScoring(
    queued(),
    completed({
      submission: {
        ...SCORED,
        metrics: {},
        primary_score: null,
        result_visibility: "hidden",
      },
    }),
  );

  renderPage(
    dualCompetition({
      normalization_visible: false,
      normalization_hidden_reason: "private_unpublished",
    }),
    "/competitions/submit-cup/submit?track=private",
  );
  selectCsv();
  selectNotebook();
  fireEvent.click(screen.getByRole("button", { name: "Nộp nhánh Private và chấm điểm" }));
  expect(await screen.findByText("Kết quả chấm điểm · Nhánh Private")).toBeTruthy();

  // Các ô điểm để trống kèm lý do rõ ràng, không bỏ im lặng.
  expect(screen.getByText(/Đã chấm xong — chờ công bố/)).toBeTruthy();
  expect(screen.getByText(/Thời điểm công bố do BTC quyết định/)).toBeTruthy();
  const f1Card = document.querySelector<HTMLElement>('[data-metric="f1"]');
  expect(within(f1Card as HTMLElement).getByText("-")).toBeTruthy();
  expect(screen.queryByText(/0\.5/)).toBeNull();
});

test("quota còn lại hiển thị trước khi nộp và refetch sau khi nộp thành công", async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") {
        return json(completed({ submission: { ...SCORED, quota_remaining: 2 } }), 200);
      }
      bodies.push(init?.body);
      return json(queued(), 202);
    }),
  );
  const { refreshCompetition } = renderPage({
    ...COMPETITION,
    quota: {
      per_day: 5,
      used_today: 2,
      remaining: 3,
      resets_at: "2026-09-18T00:00:00Z",
    },
  });
  const rules = screen.getByLabelText("Quy định tệp nộp bài");
  expect(rules).toHaveTextContent("Còn 3/5 lượt hôm nay");

  selectCsv();
  selectNotebook();
  fireEvent.click(screen.getByRole("button", { name: "Nộp và chấm điểm" }));
  await screen.findByText("Kết quả chấm điểm");
  await waitFor(() => expect(refreshCompetition).toHaveBeenCalledTimes(1));

  // Một request multipart mang đủ hai part - backend từ chối nếu thiếu một trong hai.
  const form = bodies[0] as FormData;
  expect(form).toBeInstanceOf(FormData);
  expect([...form.keys()].sort()).toEqual(["file", "notebook"]);
  expect((form.get("notebook") as File).name).toBe("solution.ipynb");
});

test("hết quota thì khóa form và nêu giờ làm mới", () => {
  renderPage({
    ...COMPETITION,
    quota: {
      per_day: 5,
      used_today: 5,
      remaining: 0,
      resets_at: "2026-09-18T00:00:00Z",
    },
  });
  const banner = screen.getByText(/Bạn đã dùng hết 5 lượt nộp hôm nay/);
  expect(banner).toBeTruthy();
  expect(banner.textContent).toContain("Hạn mức làm mới lúc");
  expect(screen.getByLabelText("Chọn tệp CSV")).toBeDisabled();
  expect(screen.getByLabelText("Chọn notebook")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Nộp và chấm điểm" })).toBeDisabled();
});

test("validation error từ backend được hiển thị rõ", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "SUBMISSION_ID_MISMATCH",
            message: "Tập ID không khớp ground truth (thiếu 1, thừa 0).",
          },
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
  renderPage();
  selectCsv("bad.csv", "id,prediction\n");
  selectNotebook();
  fireEvent.click(screen.getByRole("button", { name: "Nộp và chấm điểm" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Tập ID không khớp ground truth");
  expect(screen.getAllByText("SUBMISSION_ID_MISMATCH")).toHaveLength(2);
});

test("khóa form trước giờ mở và sau deadline với lý do rõ", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const later = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const { unmount } = renderPage({ ...COMPETITION, start_at: future, end_at: later });
  expect(screen.getByText("Cuộc thi chưa mở nhận bài.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Nộp và chấm điểm" })).toBeDisabled();
  unmount();

  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  renderPage({
    ...COMPETITION,
    start_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    end_at: past,
  });
  expect(screen.getByText("Đã hết hạn nộp bài.")).toBeTruthy();
});

test("khóa form khi chưa là member hoặc scoring chưa ready", async () => {
  const { unmount } = renderPage({
    ...COMPETITION,
    membership: { active: false, joined_at: null },
  });
  expect(screen.getByText("Bạn cần tham gia cuộc thi trước khi nộp bài.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Nộp và chấm điểm" })).toBeDisabled();
  unmount();

  renderPage({
    ...COMPETITION,
    submission_config: { ...COMPETITION.submission_config, ready: false },
  });
  expect(await waitFor(() => screen.getByText("Cuộc thi chưa sẵn sàng chấm điểm."))).toBeTruthy();
});

test("lượt AI còn chạy chỉ là dòng nhắc: điểm đã có và trang không hỏi gì thêm về AI", async () => {
  const sent = mockScoring(
    queued(),
    completed({
      submission: {
        ...SCORED,
        ai_review: {
          state: "QUEUED",
          verdict: null,
          summary: "AI đang kiểm tra notebook.",
          updated_at: null,
        },
      },
    }),
  );
  renderPage();
  submitOnce();

  expect(await screen.findByText("Kết quả chấm điểm")).toBeTruthy();
  // Số thập phân lấy theo hợp đồng kết quả (v1: 4 chữ số), không còn cứng 6 chữ số.
  expect(screen.getAllByText("0.5000")).toHaveLength(3);
  expect(
    screen.getByText("AI đang kiểm tra notebook (kết quả sơ bộ, không ảnh hưởng điểm số)."),
  ).toBeTruthy();

  // Trang chỉ hỏi trạng thái lượt chấm; trạng thái AI xem ở lịch sử bài nộp nên không có request nào.
  expect(sent.every((call) => !call.url.includes("ai-review"))).toBe(true);
});

test("lượt AI đã xong hoặc chưa từng chạy thì không hiện dòng nhắc", async () => {
  mockScoring(
    queued(),
    completed({
      submission: {
        ...SCORED,
        ai_review: {
          state: "COMPLETED",
          verdict: "CLEAR",
          summary: "AI không phát hiện dấu hiệu vi phạm thể lệ trong notebook.",
          updated_at: "2026-09-15T00:01:00Z",
        },
      },
    }),
  );
  renderPage();
  submitOnce();

  expect(await screen.findByText("Kết quả chấm điểm")).toBeTruthy();
  expect(screen.queryByText(/AI đang kiểm tra notebook \(/)).toBeNull();
});

test("lượt AI hỏng không bị nói thành đang kiểm tra", async () => {
  mockScoring(
    queued(),
    completed({
      submission: {
        ...SCORED,
        ai_review: {
          state: "ERROR",
          verdict: "ERROR",
          summary: "AI chưa thể hoàn tất kiểm tra.",
          updated_at: "2026-09-15T00:01:00Z",
        },
      },
    }),
  );
  renderPage();
  submitOnce();

  expect(await screen.findByText("Kết quả chấm điểm")).toBeTruthy();
  // Lượt hỏng là chuyện đã xong, không phải đang chờ: nói "đang kiểm tra" ở đây là nói dối.
  expect(screen.queryByText(/AI đang kiểm tra notebook \(/)).toBeNull();
  // Trang kết quả chỉ nói về điểm; trạng thái AI nằm ở lịch sử bài nộp.
  expect(screen.queryByText("AI chưa thể hoàn tất kiểm tra.")).toBeNull();
});

test("một lần nhấn Nút là một Idempotency-Key: gửi lại sau khi mất mạng vẫn cùng key", async () => {
  const keys: (string | null)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(new Headers(init?.headers as HeadersInit).get("Idempotency-Key"));
      throw new TypeError("Failed to fetch");
    }),
  );
  renderPage();
  submitOnce();
  await waitFor(() => expect(keys).toHaveLength(1));
  expect(keys[0]).toBeTruthy();

  // Mất mạng rồi bấm lại: cùng key nên backend trả đúng lượt cũ, không tiêu thêm quota.
  fireEvent.click(screen.getByRole("button", { name: "Nộp và chấm điểm" }));
  await waitFor(() => expect(keys).toHaveLength(2));
  expect(keys[1]).toBe(keys[0]);

  // Đổi tệp nghĩa là lượt nộp khác: key mới, không dính vào lượt cũ.
  fireEvent.click(screen.getByRole("button", { name: "Bỏ chọn Tệp dự đoán (.csv)" }));
  selectCsv("other.csv");
  fireEvent.click(screen.getByRole("button", { name: "Nộp và chấm điểm" }));
  await waitFor(() => expect(keys).toHaveLength(3));
  expect(keys[2]).not.toBe(keys[0]);
});

test("mở lại trang thì nhận lại lượt đang chờ thay vì nộp mới", async () => {
  vi.useFakeTimers();
  const sent: SentRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, method: init?.method ?? "GET", key: null });
      if (url.endsWith("/submissions/attempts")) {
        return json({ attempts: [queued({ queue_position: 2 })] }, 200);
      }
      return json(queued({ queue_position: 2 }), 200);
    }),
  );
  renderPage(v2Competition());
  await flushTimers(0);

  expect(screen.getByText("Bạn đang ở vị trí thứ 2 trong hàng chờ.")).toBeTruthy();
  expect(sent.every((call) => call.method === "GET")).toBe(true);
});

test("mất quyền khi đang chờ chấm: báo shell khóa gate và dừng vòng hỏi trạng thái", async () => {
  vi.useFakeTimers();
  const urls: string[] = [];
  const { reportAccessLost: report } = renderPage(v2Competition());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (init?.method === "POST") return json(queued(), 202);
      if (url.endsWith("/submissions/attempts")) return json({ attempts: [] }, 200);
      return json(
        { error: { code: "MEMBERSHIP_REQUIRED", message: "Bạn cần tham gia cuộc thi trước." } },
        403,
      );
    }),
  );

  submitOnce();
  await flushTimers(0);
  expect(screen.getByText("Bài đang chờ chấm")).toBeTruthy();

  await flushTimers(POLL_MS);
  expect(report).toHaveBeenCalledWith("membership_required");

  // Vòng hỏi trạng thái dừng hẳn: shell đang xác minh quyền và sẽ thay cả trang.
  const polls = urls.filter((url) => url.includes("/attempts/")).length;
  expect(polls).toBe(1);
  await flushTimers(POLL_MS * 5);
  expect(urls.filter((url) => url.includes("/attempts/")).length).toBe(polls);
});

/** Nhánh Public vừa bị BTC dời lịch về tương lai: chưa mở, không nhận bài. */
const LOCKED_PUBLIC: Partial<ParticipantTrackView> = {
  start_at: "2026-11-01T00:00:00Z",
  window_state: "scheduled",
  can_submit: false,
  blocked_reason: "not_open",
};

test("dual nhánh bị dời lịch khi đang chờ chấm: 403 TRACK_NOT_OPEN bỏ lượt, không thành lỗi hệ thống", async () => {
  vi.useFakeTimers();
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (init?.method === "POST") return json(queued(), 202);
      if (url.endsWith("/submissions/attempts")) return json({ attempts: [] }, 200);
      return json(
        { error: { code: "TRACK_NOT_OPEN", message: "Nhánh này chưa mở nhận bài." } },
        403,
      );
    }),
  );

  const entry = "/competitions/submit-cup/submit?track=public";
  const view = renderPage(dualCompetition(), entry);
  selectCsv();
  selectNotebook();
  fireEvent.click(screen.getByRole("button", { name: "Nộp nhánh Public và chấm điểm" }));
  await flushTimers(0);
  expect(screen.getByText("Bài đang chờ chấm")).toBeTruthy();

  await flushTimers(POLL_MS);
  // Lượt biến mất khỏi màn hình, không có băng lỗi, và shell được nhắc làm mới metadata.
  expect(screen.queryByText("Bài đang chờ chấm")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(view.refreshCompetition).toHaveBeenCalled();
  // Vòng hỏi trạng thái dừng: lượt không còn trên màn hình thì không còn gì để hỏi.
  const polls = urls.filter((url) => url.includes("/attempts/")).length;
  await flushTimers(POLL_MS * 5);
  expect(urls.filter((url) => url.includes("/attempts/")).length).toBe(polls);

  // Nhịp làm mới kế tiếp của shell đưa lịch mới xuống: băng khóa hiện đúng lý do, nút nộp bị chặn.
  view.rerender(pageTree(dualCompetition(LOCKED_PUBLIC), entry, view.refreshCompetition));
  expect(screen.getByText("Đang khóa")).toBeTruthy();
  expect(screen.getByText("Nhánh này chưa mở nhận bài.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Nộp nhánh Public và chấm điểm" })).toBeDisabled();
});

test("dual nhánh bị dời lịch về sau: kết quả đang hiện bị bỏ và băng khóa thay chỗ", async () => {
  vi.useFakeTimers();
  mockScoring(queued(), completed());

  const entry = "/competitions/submit-cup/submit?track=public";
  const view = renderPage(dualCompetition(), entry);
  selectCsv();
  selectNotebook();
  fireEvent.click(screen.getByRole("button", { name: "Nộp nhánh Public và chấm điểm" }));
  // Hai nhịp hỏi: nhịp đầu còn QUEUED, nhịp sau mới COMPLETED - mỗi nhịp phải trọn một vòng render.
  await flushTimers(POLL_MS);
  await flushTimers(POLL_MS);
  expect(screen.getByText("Kết quả chấm điểm · Nhánh Public")).toBeTruthy();

  // BTC dời lịch nhánh Public về tương lai: shell thấy qua nhịp làm mới và đẩy metadata mới xuống.
  view.rerender(pageTree(dualCompetition(LOCKED_PUBLIC), entry, view.refreshCompetition));

  // Điểm cũ không được giữ lại trên màn hình dù backend đã trả payload lúc còn mở.
  expect(screen.queryByText("Kết quả chấm điểm · Nhánh Public")).toBeNull();
  expect(screen.queryByText("0.5000")).toBeNull();
  expect(screen.getByText("Đang khóa")).toBeTruthy();
  expect(screen.getByText("Nhánh này chưa mở nhận bài.")).toBeTruthy();
});

test("quá 60 giây thì báo không tính lượt và cho nộp lại bằng key mới", async () => {
  vi.useFakeTimers();
  const sent = mockScoring(queued(), queued());
  renderPage();
  submitOnce();
  await flushTimers(0);
  await flushTimers(POLL_MS * 2);
  expect(screen.getByText(/Lượt này còn tối đa \d+ giây\./)).toBeTruthy();

  await flushTimers(60_000);
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Bài nộp quá hạn chờ chấm nên không bị tính lượt.");
  expect(alert).toHaveTextContent("Lượt này không bị tính vào hạn mức nộp.");
  // Form trở lại cùng hai tệp đã chọn: một lần bấm là nộp lại được.
  expect(screen.getByText("result.csv")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Nộp và chấm điểm" })).toBeEnabled();

  fireEvent.click(screen.getByRole("button", { name: "Nộp và chấm điểm" }));
  await flushTimers(0);
  const posts = sent.filter((call) => call.method === "POST");
  expect(posts).toHaveLength(2);
  // Lượt cũ đã chết: nộp lại phải là lượt mới, không phải trả về lượt quá hạn.
  expect(posts[1].key).not.toBe(posts[0].key);
});

test("lượt hỏng thì hiện lý do, không tính lượt và vẫn nộp lại được", async () => {
  vi.useFakeTimers();
  mockScoring(
    queued(),
    queued({
      status: "FAILED",
      queue_position: null,
      error: { code: "SUBMISSION_CLOSED", message: "Cuộc thi hiện không nhận bài nộp." },
    }),
  );
  renderPage();
  submitOnce();
  await flushTimers(0);
  await flushTimers(POLL_MS * 2);

  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Cuộc thi hiện không nhận bài nộp.");
  expect(alert).toHaveTextContent("SUBMISSION_CLOSED");
  expect(alert).toHaveTextContent("attempt-1");
  expect(alert).toHaveTextContent("Lượt này không bị tính vào hạn mức nộp.");
  expect(screen.getByText("result.csv")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Nộp và chấm điểm" })).toBeEnabled();
});

test("lượt đang đối soát thì vẫn chờ dù đã quá 60 giây", async () => {
  vi.useFakeTimers();
  mockScoring(
    queued(),
    queued({
      status: "RESOLVING",
      queue_position: null,
      deadline_at: new Date(Date.now() - 5_000).toISOString(),
      error: { code: "SUBMISSION_RESOLVING", message: "Không thể chấm điểm bài nộp này." },
    }),
  );
  renderPage();
  submitOnce();
  await flushTimers(0);
  await flushTimers(POLL_MS * 2);

  // Hệ thống còn nợ kết luận: chưa được nói là hỏng, cũng chưa được nói là hết hạn.
  expect(screen.getByText("Đang đối soát kết quả")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
