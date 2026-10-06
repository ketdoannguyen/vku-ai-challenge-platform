/**
 * Nhánh Public/Private dưới mắt thí sinh (ADR-064, §12): nhánh nằm trong URL nên deep link và
 * back/forward giữ đúng context, đổi nhánh khi còn tệp phải hỏi trước, bảng Private tự mở khi BTC
 * công bố mà không phải tải lại trang, mất quyền đọc vẫn báo shell khóa gate, và cuộc thi một
 * nhánh không bị thêm bất kỳ UI nhánh nào.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { formatLocal, type CompetitionDetail, type ParticipantTrackView } from "../api/competitions";
import { DashboardPage } from "./DashboardPage";
import { LeaderboardPage } from "./LeaderboardPage";
import { MySubmissionsPage } from "./MySubmissionsPage";
import { SubmissionPage } from "./SubmissionPage";

const BASE: CompetitionDetail = {
  id: "64a000000000000000000001",
  slug: "dual-cup",
  name: "Dual Cup",
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

function trackView(overrides: Partial<ParticipantTrackView> = {}): ParticipantTrackView {
  return {
    start_at: "2026-01-01T00:00:00Z",
    end_at: "2026-03-01T00:00:00Z",
    quota_per_day: 5,
    window_state: "open",
    results_released: true,
    resources: [],
    can_submit: true,
    blocked_reason: null,
    submission_ready: true,
    quota: { per_day: 5, used_today: 2, remaining: 3, resets_at: "2026-10-07T00:00:00Z" },
    ...overrides,
  };
}

const PUBLIC_VIEW = trackView({
  resources: [{ label: "Dữ liệu Public", url: "https://example.com/public.zip" }],
});

/** Nhánh Private chưa công bố: nguồn xếp hạng chính thức nhưng điểm còn bị che. */
const PRIVATE_VIEW = trackView({
  start_at: "2026-02-01T00:00:00Z",
  end_at: "2026-04-01T00:00:00Z",
  quota_per_day: 3,
  results_released: false,
  resources: [{ label: "Dữ liệu Private", url: "https://example.com/private.zip" }],
  quota: { per_day: 3, used_today: 1, remaining: 2, resets_at: "2026-10-07T00:00:00Z" },
  result_policy: "manual",
  publish_condition: "admin_decides",
  results_published_at: null,
});

const DUAL: CompetitionDetail = {
  ...BASE,
  mode: "public_private",
  // Quota cấp cuộc thi không tồn tại ở dual; số lượt nằm trong từng nhánh.
  quota_per_day: null,
  tracks: { public: PUBLIC_VIEW, private: PRIVATE_VIEW },
};

/** Cùng cuộc thi nhưng BTC đã công bố kết quả Private. */
const DUAL_RELEASED: CompetitionDetail = {
  ...DUAL,
  tracks: {
    public: PUBLIC_VIEW,
    private: { ...PRIVATE_VIEW, results_released: true, results_published_at: "2026-10-01T00:00:00Z" },
  },
};

const reportAccessLost = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  reportAccessLost.mockClear();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      jsonResponse(handler(String(input), init), status),
    ),
  );
}

/** Chạy hết việc đang chờ trên hàng đợi microtask lẫn macrotask (response của fetch giả). */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Nút "quay lại" của trình duyệt để test back/forward qua history của router. */
function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      Quay lại
    </button>
  );
}

function renderSubmission(
  competition: CompetitionDetail,
  initialEntries: string[],
  initialIndex?: number,
) {
  const refreshCompetition = vi.fn(async () => {});
  return render(
    <MemoryRouter initialEntries={initialEntries} initialIndex={initialIndex}>
      <Routes>
        <Route
          element={
            <Outlet context={{ competition, contents: [], refreshCompetition, reportAccessLost }} />
          }
        >
          <Route
            path="/competitions/:slug/submit"
            element={
              <>
                <SubmissionPage />
                <BackButton />
              </>
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function leaderboardTree(competition: CompetitionDetail, entries: string[]) {
  return (
    <MemoryRouter initialEntries={entries}>
      <Routes>
        <Route element={<Outlet context={{ competition, contents: [], reportAccessLost }} />}>
          <Route path="/competitions/:slug/leaderboard" element={<LeaderboardPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function renderHistory(competition: CompetitionDetail, entries: string[]) {
  return render(
    <MemoryRouter initialEntries={entries}>
      <Routes>
        <Route element={<Outlet context={{ competition, contents: [], reportAccessLost }} />}>
          <Route path="/competitions/:slug/submissions" element={<MySubmissionsPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function board(entries: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    competition_id: BASE.id,
    primary_metric: "f1",
    entries,
    total: entries.length,
    limit: 25,
    offset: 0,
    has_more: false,
    me: null,
    ...overrides,
  };
}

function boardEntry(rank: number, name: string) {
  const score = 1 - rank / 100;
  return {
    rank,
    display_name: name,
    primary_score: score,
    metrics: { f1: score, precision: 0.5, recall: 0.5 },
    best_submission_id: `s${rank}`,
    best_submission_at: "2026-09-15T08:00:00Z",
    total_submissions: 1,
    is_current_user: false,
  };
}

function selectCsv() {
  fireEvent.change(screen.getByLabelText("Chọn file CSV"), {
    target: { files: [new File(["id,prediction\n1,1\n"], "result.csv", { type: "text/csv" })] },
  });
}

function selectNotebook() {
  fireEvent.change(screen.getByLabelText("Chọn notebook"), {
    target: { files: [new File(["{}"], "solution.ipynb", { type: "application/x-ipynb+json" })] },
  });
}

test("dual vào trang nộp thiếu nhánh: bắt chọn, không mặc định nhánh nào", () => {
  mockFetch(() => ({ attempts: [] }));
  renderSubmission(DUAL, ["/competitions/dual-cup/submit"]);

  expect(screen.getByRole("heading", { name: "Chọn nhánh để nộp bài" })).toBeTruthy();
  // Câu dẫn "Cuộc thi có hai nhánh..." đã bị bỏ - thẻ nhánh tự nói đủ lịch và lối nộp.
  expect(screen.queryByText(/Cuộc thi có hai nhánh/)).toBeNull();
  expect(screen.getByRole("link", { name: "Nộp Public" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Nộp Private" })).toBeTruthy();
  // Mỗi thẻ nhánh nêu đủ cửa sổ nộp: thời gian mở riêng lẫn hạn nộp riêng.
  expect(screen.getAllByText("Mở lúc")).toHaveLength(2);
  expect(screen.getByText(formatLocal(PUBLIC_VIEW.start_at))).toBeTruthy();
  expect(screen.getByText(formatLocal(PRIVATE_VIEW.start_at))).toBeTruthy();
  // Thẻ mang class nhánh + trạng thái (đổi màu viền), và trạng thái nằm chung dòng với tên nhánh.
  const publicCard = screen.getByText("Public").closest(".track-card") as HTMLElement;
  expect(publicCard).toHaveClass("public", "open");
  expect(
    within(publicCard.querySelector(".track-card-head") as HTMLElement).getByText("Đang nhận bài"),
  ).toBeTruthy();
  expect(screen.getByText("Private").closest(".track-card")).toHaveClass("private");
  // Nhánh chỉ được gọi đúng tên Public/Private, không kèm nhãn giá trị; chưa chọn nhánh thì chưa có form nộp nào.
  expect(screen.queryByText(/chính thức/)).toBeNull();
  expect(screen.queryByRole("button", { name: /và chấm điểm/ })).toBeNull();
});

test("dual deep link ?track=private giữ context của nhánh; back trở lại nhánh trước", async () => {
  mockFetch(() => ({ attempts: [] }));
  renderSubmission(
    DUAL,
    ["/competitions/dual-cup/submit?track=public", "/competitions/dual-cup/submit?track=private"],
    1,
  );

  // Tiêu đề, hạn nộp và hạn mức đều của nhánh Private - không trộn số của Public.
  expect(screen.getByRole("heading", { name: "Nộp bài dự đoán · Nhánh Private" })).toBeTruthy();
  expect(screen.getByText("Nhánh Private")).toBeTruthy();
  expect(screen.getByText(`Hạn nộp ${formatLocal(PRIVATE_VIEW.end_at)}`)).toBeTruthy();
  expect(document.querySelector(".sub-quota-count")).toHaveTextContent("Còn 2/3 lượt hôm nay");

  fireEvent.click(screen.getByRole("button", { name: "Quay lại" }));

  expect(screen.getByRole("heading", { name: "Nộp bài dự đoán · Nhánh Public" })).toBeTruthy();
  expect(document.querySelector(".sub-quota-count")).toHaveTextContent("Còn 3/5 lượt hôm nay");
  expect(screen.getByText(`Hạn nộp ${formatLocal(PUBLIC_VIEW.end_at)}`)).toBeTruthy();
});

test("dual đổi nhánh khi còn tệp đã chọn: phải xác nhận, xác nhận thì bỏ tệp cũ", async () => {
  mockFetch(() => ({ attempts: [] }));
  renderSubmission(DUAL, ["/competitions/dual-cup/submit?track=public"]);

  selectCsv();
  selectNotebook();
  expect(screen.getByText("result.csv")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Đổi nhánh" }));
  const dialog = await screen.findByRole("dialog", { name: "Chuyển sang nhánh Private?" });
  expect(dialog).toHaveTextContent("Các tệp đã chọn thuộc nhánh Public và sẽ bị bỏ");

  // Hủy thì giữ nguyên nhánh đang nộp lẫn tệp đã chọn.
  fireEvent.click(within(dialog).getByRole("button", { name: "Hủy" }));
  expect(screen.getByRole("heading", { name: "Nộp bài dự đoán · Nhánh Public" })).toBeTruthy();
  expect(screen.getByText("result.csv")).toBeTruthy();

  // Xác nhận thì sang nhánh mới và bộ tệp cũ bị bỏ, không tự dùng lại cho nhánh khác.
  fireEvent.click(screen.getByRole("button", { name: "Đổi nhánh" }));
  fireEvent.click(await screen.findByRole("button", { name: "Sang nhánh Private" }));

  expect(await screen.findByRole("heading", { name: "Nộp bài dự đoán · Nhánh Private" })).toBeTruthy();
  expect(screen.queryByText("result.csv")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("dual đổi nhánh bảng xếp hạng: response muộn của nhánh cũ không ghi đè", async () => {
  const urls: string[] = [];
  let releaseStalePublic = () => {};
  const staleGate = new Promise<void>((resolve) => {
    releaseStalePublic = resolve;
  });
  // Lượt Public kế tiếp bị giữ lại để nó về muộn, sau khi người dùng đã sang nhánh Private.
  let gateNextPublic = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const track = new URL(url, "http://localhost").searchParams.get("track");
      if (track === "public" && gateNextPublic) await staleGate;
      return jsonResponse(
        track === "private"
          ? board([boardEntry(1, "Đội Private")])
          : board([boardEntry(1, "Đội Public")], { total: 30, has_more: true }),
      );
    }),
  );

  render(leaderboardTree(DUAL_RELEASED, ["/competitions/dual-cup/leaderboard?track=public"]));
  expect(await screen.findByText("Đội Public")).toBeTruthy();

  gateNextPublic = true;
  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  await waitFor(() =>
    expect(urls.filter((url) => url.includes("track=public"))).toHaveLength(2),
  );

  fireEvent.click(screen.getByRole("button", { name: "Private" }));
  expect(await screen.findByText("Đội Private")).toBeTruthy();

  // Response Public về muộn: hàng của nhánh cũ không được chen vào bảng Private.
  releaseStalePublic();
  await flush();
  expect(screen.getByText("Đội Private")).toBeTruthy();
  expect(screen.queryByText("Đội Public")).toBeNull();
});

test("dual Private chưa công bố: bảng khóa; metadata công bố mở bảng không cần tải lại trang", async () => {
  const urls: string[] = [];
  mockFetch((url) => {
    urls.push(url);
    return board([boardEntry(1, "Đội Private")]);
  });

  const view = render(leaderboardTree(DUAL, ["/competitions/dual-cup/leaderboard?track=private"]));

  expect(screen.getByText("Kết quả nhánh Private chưa được công bố.")).toBeTruthy();
  expect(screen.getByText(/Thời điểm công bố do BTC quyết định\./)).toBeTruthy();
  // Chưa công bố thì không hỏi bảng làm gì.
  expect(urls).toHaveLength(0);

  // Shell tự làm mới metadata cuộc thi; lượt cập nhật kế tiếp mang dấu mốc công bố.
  view.rerender(leaderboardTree(DUAL_RELEASED, ["/competitions/dual-cup/leaderboard?track=private"]));

  expect(await screen.findByText("Đội Private")).toBeTruthy();
  expect(screen.queryByText("Kết quả nhánh Private chưa được công bố.")).toBeNull();
  // Nhánh chỉ được gọi đúng tên Private: không nhãn "chính thức", không badge "tạm thời".
  expect(screen.getByRole("heading", { name: "Bảng xếp hạng Private" })).toBeTruthy();
  expect(screen.queryByText(/chính thức|Tạm thời/)).toBeNull();
});

test("dual mất quyền đọc giữa chừng: báo shell khóa gate, không hiện băng lỗi tải bảng", async () => {
  mockFetch(
    () => ({ error: { code: "MEMBERSHIP_INACTIVE", message: "Tư cách thành viên đã hết." } }),
    403,
  );

  render(leaderboardTree(DUAL_RELEASED, ["/competitions/dual-cup/leaderboard?track=private"]));

  await waitFor(() => expect(reportAccessLost).toHaveBeenCalledWith("membership_inactive"));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("dual lịch sử: lọc theo nhánh, bài Private chưa công bố không lộ điểm", async () => {
  const hidden = {
    id: "sub-pri-0001",
    competition_id: BASE.id,
    status: "completed",
    metrics: {},
    primary_score: null,
    created_at: "2026-09-15T10:00:00Z",
    track: "private",
    result_visibility: "hidden",
    visibility_reason: "private_unpublished",
    artifacts: {
      prediction: { filename: "prediction.csv", size_bytes: 128, available: true },
      notebook: { filename: "notebook.ipynb", size_bytes: 4096, available: true },
    },
  };
  const shown = {
    ...hidden,
    id: "sub-pub-0001",
    track: "public",
    metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
    primary_score: 0.9,
    result_visibility: "visible",
  };
  mockFetch(() => ({ submissions: [shown, hidden], total: 2, limit: 50, offset: 0 }));

  renderHistory(DUAL, ["/competitions/dual-cup/submissions"]);

  // Mặc định mở nhánh Public; dòng Private nằm trong payload nhưng không thuộc nhánh đang xem.
  expect(await screen.findByText("#pub-0001")).toBeTruthy();
  expect(screen.queryByText("#pri-0001")).toBeNull();
  expect(screen.getByText("Tốt nhất")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Private" }));

  expect(await screen.findByText("#pri-0001")).toBeTruthy();
  expect(screen.queryByText("#pub-0001")).toBeNull();
  // Đã chấm nhưng chưa công bố là trạng thái riêng: không điểm, không highlight "Tốt nhất".
  expect(screen.getByText("Đã chấm xong — chờ công bố")).toBeTruthy();
  expect(screen.queryByText("Tốt nhất")).toBeNull();
  expect(screen.getByText(/Thời điểm công bố do BTC quyết định\./)).toBeTruthy();
});

test("dual lịch sử: trang chỉ có bài nhánh khác thì mời đổi nhánh thay vì bảng trống", async () => {
  mockFetch(() => ({
    submissions: [
      {
        id: "sub-pub-0002",
        competition_id: BASE.id,
        status: "completed",
        metrics: { f1: 0.5, precision: 0.5, recall: 0.5 },
        primary_score: 0.5,
        created_at: "2026-09-15T09:00:00Z",
        track: "public",
        result_visibility: "visible",
        artifacts: {
          prediction: { filename: "prediction.csv", size_bytes: 128, available: true },
          notebook: { filename: "notebook.ipynb", size_bytes: 4096, available: true },
        },
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  }));

  renderHistory(DUAL, ["/competitions/dual-cup/submissions?track=private"]);

  expect(
    await screen.findByText("Không có bài nộp nhánh Private trong phần đang hiển thị."),
  ).toBeTruthy();
  expect(screen.getByText("Trang này chỉ có bài nhánh Public.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Xem nhánh Public" }));

  expect(await screen.findByText("#pub-0002")).toBeTruthy();
});

test("dual thẻ dashboard: hai dòng nhãn theo nhánh, Private chưa công bố để '-', không mượn số Public", async () => {
  const ACCOUNT = { id: "9", email: "thi.sinh@vku.vn", name: "Thí sinh", role: "participant", active: true };
  mockFetch((url) => {
    if (url.endsWith("/auth/me")) return ACCOUNT;
    return {
      competitions: [
        {
          ...DUAL,
          membership: { active: true, joined_at: "2026-09-15T00:00:00Z" },
          my_stats_by_track: {
            public: {
              rank: 3,
              rank_total: 10,
              best_score: 0.8123,
              best_normalized_score: null,
              used_today: 2,
            },
            private: {
              rank: null,
              rank_total: null,
              best_score: null,
              best_normalized_score: null,
              used_today: 1,
            },
          },
        },
      ],
    };
  });

  render(
    <MemoryRouter>
      <AuthProvider>
        <DashboardPage />
      </AuthProvider>
    </MemoryRouter>,
  );

  await screen.findByRole("heading", { name: "Dual Cup", level: 3 });
  const rows = document.querySelectorAll(".comp-personal-track");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("Public");
  expect(rows[0]).toHaveTextContent("#3/10 · 0.81 · 2 lượt hôm nay");
  expect(rows[1]).toHaveTextContent("Private");
  expect(rows[1]).toHaveTextContent("- · - · 1 lượt hôm nay");
  // Vị trí của nhánh Private không được lấp bằng số của Public.
  expect(rows[1]).not.toHaveTextContent("0.81");
  expect(screen.getByText("Theo từng nhánh")).toBeTruthy();
});

test("single: trang nộp và bảng xếp hạng không thêm UI nhánh", async () => {
  mockFetch((url) =>
    url.includes("/leaderboard") ? board([boardEntry(1, "Đội Nhất")]) : { attempts: [] },
  );
  const submission = renderSubmission(BASE, ["/competitions/dual-cup/submit"]);

  expect(screen.getByRole("heading", { name: "Nộp bài dự đoán" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Đổi nhánh" })).toBeNull();
  expect(screen.queryByText(/chính thức/)).toBeNull();
  submission.unmount();

  render(leaderboardTree(BASE, ["/competitions/dual-cup/leaderboard"]));
  expect(await screen.findByText("Đội Nhất")).toBeTruthy();
  expect(screen.getByText("Bảng xếp hạng công bố")).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Chọn nhánh xếp hạng" })).toBeNull();
});

test("single: lịch sử và thẻ dashboard giữ nguyên số liệu gộp", async () => {
  // Dòng lịch sử của cuộc thi một nhánh không mang `track`/`result_visibility` - hợp đồng cũ.
  mockFetch(() => ({
    submissions: [
      {
        id: "sub-one-0001",
        competition_id: BASE.id,
        status: "completed",
        metrics: { f1: 0.7, precision: 0.7, recall: 0.7 },
        primary_score: 0.7,
        created_at: "2026-09-15T09:00:00Z",
        artifacts: {
          prediction: { filename: "prediction.csv", size_bytes: 128, available: true },
          notebook: { filename: "notebook.ipynb", size_bytes: 4096, available: true },
        },
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  }));
  const history = renderHistory(BASE, ["/competitions/dual-cup/submissions"]);

  expect(await screen.findByText("#one-0001")).toBeTruthy();
  expect(document.querySelector(".subm-summary-pills")).toHaveTextContent("Tổng cộng 1 bài nộp");
  expect(screen.queryByRole("group", { name: "Lọc lịch sử theo nhánh" })).toBeNull();
  expect(screen.getByText("Hạn ngạch")).toBeTruthy();
  history.unmount();

  const ACCOUNT = { id: "9", email: "thi.sinh@vku.vn", name: "Thí sinh", role: "participant", active: true };
  mockFetch((url) => {
    if (url.endsWith("/auth/me")) return ACCOUNT;
    return {
      competitions: [
        {
          ...BASE,
          membership: { active: true, joined_at: "2026-09-15T00:00:00Z" },
          my_stats: {
            rank: 2,
            rank_total: 3,
            best_score: 0.9123,
            best_normalized_score: null,
            used_today: 2,
          },
        },
      ],
    };
  });
  render(
    <MemoryRouter>
      <AuthProvider>
        <DashboardPage />
      </AuthProvider>
    </MemoryRouter>,
  );

  await screen.findByRole("heading", { name: "Dual Cup", level: 3 });
  expect(document.querySelectorAll(".comp-personal-track")).toHaveLength(0);
  const card = document.querySelector(".comp-card") as HTMLElement;
  expect(card).toHaveTextContent("Hạng hiện tại");
  expect(card).toHaveTextContent("#2/3");
  expect(card).toHaveTextContent("5 lượt / ngày");
  expect(screen.queryByText("Theo từng nhánh")).toBeNull();
});
