import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import type { CompetitionDetail } from "../api/competitions";
import { setDocumentHidden } from "../test/timers";
import { LeaderboardPage } from "./LeaderboardPage";

/** Nhịp tự làm mới ngầm của bảng. */
const AUTO_REFRESH_MS = 3_000;

/**
 * Chạy đồng hồ ảo kèm flush microtask. Hook cộng jitter ±10% vào nhịp, nên các test đọc mốc
 * thời gian phải cố định `Math.random` về 0.5 (hệ số 1.0) để nhịp không trôi.
 */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const COMPETITION: CompetitionDetail = {
  id: "64a000000000000000000001",
  slug: "results-cup",
  name: "Results Cup",
  short_description: "",
  status: "published",
  start_at: "2026-01-01T00:00:00Z",
  end_at: "2027-01-01T00:00:00Z",
  join_mode: "open",
  primary_metric: "f1",
  quota_per_day: 5,
  leaderboard_visible: true,
  join_code_configured: false,
  primary_metric_label: "F1",
  membership: { active: true, joined_at: "2026-09-15T00:00:00Z" },
  access: { allowed: true, reason: null },
  resources: [],
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

/**
 * Cuộc thi v2 khai báo metric riêng. `primary_metric` của document vẫn là "f1" (field v1 còn sót
 * lại) nên test này chứng minh bảng đọc hợp đồng chứ không đọc field cũ đó.
 */
const V2_COMPETITION: CompetitionDetail = {
  ...COMPETITION,
  submission_config: {
    ready: true,
    version: 2,
    max_upload_mb: 50,
    max_notebook_mb: 20,
    id_column: null,
    primary_metric: "loss",
    result_contract: {
      metrics: [{ key: "loss", label: "Loss", decimals: 3 }],
      primary_metric: "loss",
      higher_is_better: false,
    },
  },
};

/** Bản nháp v2 chưa khai báo metric: hợp đồng rỗng, không metric nào là chỉ số chính. */
const V2_DRAFT_COMPETITION: CompetitionDetail = {
  ...COMPETITION,
  submission_config: {
    ready: false,
    version: 2,
    max_upload_mb: 50,
    max_notebook_mb: 20,
    id_column: null,
    primary_metric: null,
    result_contract: { metrics: [], primary_metric: null, higher_is_better: true },
  },
};

/** Shell thật sẽ khóa gate khi được thông báo; ở đây chỉ cần ghi nhận lý do. */
const reportAccessLost = vi.fn();

/** Cây trang đủ để `rerender` đổi metadata như shell thật làm khi poll. */
function tree(competition: CompetitionDetail) {
  return (
    <MemoryRouter initialEntries={["/competitions/results-cup/leaderboard"]}>
      <Routes>
        <Route element={<Outlet context={{ competition, contents: [], reportAccessLost }} />}>
          <Route path="/competitions/:slug/leaderboard" element={<LeaderboardPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function renderPage(competition: CompetitionDetail = COMPETITION) {
  return render(tree(competition));
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockResponse(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, status)));
}

/** Fetch phân trang thật; `gateOffset` giữ response của một trang lại để kiểm tra lúc đang tải. */
function mockPagedFetch({ total = 30, gateOffset }: { total?: number; gateOffset?: number } = {}) {
  const urls: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") ?? 0);
      if (offset === gateOffset) await gate;
      return jsonResponse(
        page({
          total,
          offset,
          has_more: offset + 25 < total,
          entries: [entry(offset + 1, `Người ${offset + 1}`)],
        }),
      );
    }),
  );
  return { urls, release };
}

/** Payload nền cho một trang leaderboard; test nào quan tâm field nào thì override field đó. */
function page(overrides: Record<string, unknown> = {}) {
  return {
    competition_id: COMPETITION.id,
    primary_metric: "f1",
    entries: [],
    total: 0,
    limit: 25,
    offset: 0,
    has_more: false,
    me: null,
    ...overrides,
  };
}

function entry(rank: number, name: string, overrides: Record<string, unknown> = {}) {
  const score = 1 - rank / 100;
  return {
    rank,
    display_name: name,
    // Backend luôn đặt `primary_score` bằng giá trị metric chính trong `metrics`; fixture giữ đúng
    // quan hệ đó để dòng dữ liệu không tự mâu thuẫn khi bảng chỉ đọc `metrics`.
    primary_score: score,
    metrics: { f1: score, precision: 0.5, recall: 0.5 },
    best_submission_id: `s${rank}`,
    best_submission_at: "2026-09-15T08:00:00Z",
    total_submissions: 1,
    is_current_user: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  reportAccessLost.mockClear();
  vi.useRealTimers();
  setDocumentHidden(false);
});

test("leaderboard visible hiển thị rank, score và highlight current user", async () => {
  mockResponse(
    page({
      total: 2,
      entries: [
        entry(1, "Đội Sớm", { total_submissions: 3 }),
        entry(2, "Thí Sinh", { is_current_user: true, total_submissions: 2 }),
      ],
    }),
  );

  renderPage();

  expect(await screen.findByText("Đội Sớm")).toBeTruthy();
  const current = screen.getByText("Thí Sinh").closest("tr") as HTMLElement;
  expect(current).toHaveClass("current-user-row");
  // Bốn chữ số theo hợp đồng v1 (trước đây là sáu chữ số của formatScore).
  expect(current).toHaveTextContent("0.9800");
  // Không còn cột "Điểm chính" trùng: F1 là metric chính nên chỉ có đúng một cột mang giá trị đó.
  expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
    "Hạng",
    "Đội / tài khoản",
    "F1",
    "Precision",
    "Recall",
    "Đạt lúc",
  ]);
  // Điểm chính của metric chính được nhấn ngay trong ô, không chỉ bằng màu chữ.
  expect(within(current).getByText("0.9800").closest("td")).toHaveClass("primary-score");
  expect(screen.getByText(/Xếp theo F1 tốt nhất/)).toBeTruthy();
});

/** Metadata norm của một lần dựng bảng; test nào cần thì chèn vào payload trang. */
const NORM_BOARD = {
  version: 1,
  source_metric: "f1",
  higher_is_better: true,
  baseline: 0.5,
  max_score: 50,
  decimals: 2,
  reference_best: 0.9,
  calculated_at: "2026-09-15T08:00:00Z",
};

test("cuộc thi bật norm: norm là cột điểm chính, metric gốc vẫn ở cột phụ", async () => {
  mockResponse(
    page({
      total: 2,
      normalization: NORM_BOARD,
      entries: [
        entry(1, "Đội Sớm", { normalized_score: 50 }),
        entry(2, "Thí Sinh", { is_current_user: true, normalized_score: 12.5 }),
      ],
      me: entry(2, "Thí Sinh", { is_current_user: true, normalized_score: 12.5 }),
    }),
  );

  // Metadata của cuộc thi phải bật chuẩn hóa: cột norm là quyết định theo state hiện tại,
  // không phải cứ payload có metadata norm là render.
  renderPage({ ...COMPETITION, normalization: { enabled: true, baseline: 0.5, version: 1 } });

  expect(await screen.findByText("Đội Sớm")).toBeTruthy();
  // Cột norm đứng trước các metric của hợp đồng và nêu rõ thang 0–50.
  expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
    "Hạng",
    "Đội / tài khoản",
    "Điểm chuẩn hóa (0–50)",
    "F1",
    "Precision",
    "Recall",
    "Đạt lúc",
  ]);

  const top = screen.getByText("Đội Sớm").closest("tr") as HTMLElement;
  // Hai ô điểm của dòng cùng được nhấn: norm quyết định hạng, điểm gốc của metric chính đối chiếu.
  expect(within(top).getByText("50.00").closest("td")).toHaveClass("primary-score", "lb-norm-score");
  expect(within(top).getByText("0.9900").closest("td")).toHaveClass("primary-score", "lb-raw-score");

  // Quy tắc đọc gọn: công thức norm, rồi từng số liệu mẫu số tách thành ô riêng.
  expect(screen.getByText(/Tính theo điểm chuẩn hóa \(norm score\) · 50 ×/)).toBeTruthy();
  expect(screen.getByText(/\(điểm gốc − baseline\) \/ \(điểm tốt nhất − baseline\)/)).toBeTruthy();
  const normFacts = document.querySelector(".lb-norm-facts") as HTMLElement;
  expect(within(normFacts).getByText(/Baseline · F1/)).toBeTruthy();
  expect(within(normFacts).getByText("0.5000")).toBeTruthy();
  expect(within(normFacts).getByText("Điểm gốc tốt nhất")).toBeTruthy();
  expect(within(normFacts).getByText("0.9000")).toBeTruthy();
  // Ô giới hạn thay cho mốc dựng bảng cũ: ba số liệu mẫu số là baseline, điểm tốt nhất, thang điểm.
  expect(within(normFacts).getByText("Giới hạn điểm")).toBeTruthy();
  expect(within(normFacts).getByText("0–50")).toBeTruthy();
  expect(normFacts.querySelectorAll("[data-tone]")).toHaveLength(3);

  // Dải cá nhân dùng norm hiện tại từ bảng, kèm điểm gốc đối chiếu; không chỉ điểm gốc.
  const meStrip = screen.getByText("Hạng của bạn").closest(".lb-me-strip") as HTMLElement;
  expect(within(meStrip).getByText("Điểm chuẩn hóa")).toBeTruthy();
  expect(within(meStrip).getByText("12.50")).toBeTruthy();
  expect(within(meStrip).getByText(/Điểm gốc · F1/)).toBeTruthy();
  expect(within(meStrip).getByText("0.9800")).toBeTruthy();
});

test("norm bị ẩn (metadata null): giữ nguyên giao diện điểm gốc", async () => {
  mockResponse(
    page({
      total: 1,
      normalization: null,
      entries: [entry(1, "Đội Sớm", { normalized_score: null })],
      me: entry(1, "Đội Sớm", { is_current_user: true, normalized_score: null }),
    }),
  );

  renderPage();

  expect(await screen.findByText("Đội Sớm")).toBeTruthy();
  expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
    "Hạng",
    "Đội / tài khoản",
    "F1",
    "Precision",
    "Recall",
    "Đạt lúc",
  ]);
  // Không rò mẫu số của người khác khi quyền xem đã bị thu hồi.
  expect(screen.queryByText(/Baseline/)).toBeNull();
  expect(screen.queryByText("Điểm chuẩn hóa")).toBeNull();
  const meStrip = screen.getByText("Hạng của bạn").closest(".lb-me-strip") as HTMLElement;
  expect(within(meStrip).getByText("Điểm chính")).toBeTruthy();
  expect(within(meStrip).getByText("0.9900")).toBeTruthy();
});

test("norm bị ẩn theo capability dù payload còn metadata: không render cột, nêu đúng lý do", async () => {
  mockResponse(
    page({
      total: 1,
      // Response đã tải từ lúc còn quyền: metadata norm vẫn nằm trong state cũ.
      normalization: NORM_BOARD,
      entries: [entry(1, "Đội Sớm", { normalized_score: 50 })],
      me: entry(1, "Đội Sớm", { is_current_user: true, normalized_score: 50 }),
    }),
  );

  // Metadata hiện tại đã ẩn metric nguồn (điều kiện M): số norm cũ không được coi là còn xem được.
  renderPage({
    ...COMPETITION,
    normalization: { enabled: true, baseline: 0.5, version: 1 },
    primary_metric_label: null,
  });

  expect(await screen.findByText("Đội Sớm")).toBeTruthy();
  expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
    "Hạng",
    "Đội / tài khoản",
    "F1",
    "Precision",
    "Recall",
    "Đạt lúc",
  ]);
  // Không rò mẫu số hay điểm norm khi quyền xem đã bị thu hồi.
  expect(screen.queryByText("50.00")).toBeNull();
  expect(screen.queryByText(/Baseline/)).toBeNull();
  expect(screen.getByText("Điểm chuẩn hóa bị ẩn theo cấu hình hiển thị điểm")).toBeTruthy();
  const meStrip = screen.getByText("Hạng của bạn").closest(".lb-me-strip") as HTMLElement;
  expect(within(meStrip).getByText("Điểm chính")).toBeTruthy();
});

test("master BXH tắt giữa chừng: bỏ dòng đang giữ, bật lại phải tải mới", async () => {
  let calls = 0;
  let releaseBack: (() => void) | undefined;
  const backGate = new Promise<void>((resolve) => {
    releaseBack = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1;
      // Lượt tải sau khi bật lại bị giữ để chứng minh trang không hiện lại dữ liệu cũ trong lúc chờ.
      if (calls > 1) await backGate;
      return jsonResponse(
        page({
          total: 1,
          normalization: NORM_BOARD,
          entries: [entry(1, calls > 1 ? "Người mới" : "Người 1", { normalized_score: 30 })],
        }),
      );
    }),
  );

  const visible = { ...COMPETITION, normalization: { enabled: true, baseline: 0.5, version: 1 } };
  const { rerender } = renderPage(visible);
  expect(await screen.findByText("Người 1")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Điểm chuẩn hóa (0–50)" })).toBeTruthy();

  // Shell poll thấy master vừa tắt: dòng và cột norm đang giữ bị bỏ ngay, không chờ request nào.
  rerender(tree({ ...visible, leaderboard_visible: false }));
  expect(screen.getByText("Bảng xếp hạng hiện chưa được công bố.")).toBeTruthy();
  expect(screen.queryByText("Người 1")).toBeNull();

  // Bật lại: lượt tải mới chưa về thì dữ liệu cũ không được sống dậy.
  rerender(tree(visible));
  expect(screen.queryByText("Người 1")).toBeNull();
  await act(async () => releaseBack?.());
  expect(await screen.findByText("Người mới")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Điểm chuẩn hóa (0–50)" })).toBeTruthy();
});

test("master BXH tắt khi request đang bay: response trễ bị bỏ", async () => {
  const { release } = mockPagedFetch({ gateOffset: 25 });
  const { rerender } = renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  rerender(tree({ ...COMPETITION, leaderboard_visible: false }));
  await act(async () => release());

  // Response của trang 2 về sau khi bảng đã bị tắt: không được ghi ngược lên màn hình.
  expect(screen.queryByText("Người 26")).toBeNull();
  expect(screen.getByText("Bảng xếp hạng hiện chưa được công bố.")).toBeTruthy();
});

test("leaderboard hidden hiển thị thông báo và không gọi API", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  renderPage({ ...COMPETITION, leaderboard_visible: false });
  expect(screen.getByText("Bảng xếp hạng hiện chưa được công bố.")).toBeTruthy();
  // Chưa công bố thì cả vòng tự làm mới ngầm cũng không được chạy.
  await advance(AUTO_REFRESH_MS * 5);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("mất quyền đọc cuộc thi: báo shell khóa gate thay vì hiện lỗi tải bảng", async () => {
  mockResponse({ error: { code: "UNAUTHORIZED", message: "Chưa đăng nhập." } }, 401);

  renderPage();

  await waitFor(() => expect(reportAccessLost).toHaveBeenCalledWith("login_required"));
  // Lỗi phân quyền không phải lỗi tải: không hiện băng báo lỗi, shell sẽ thay cả trang.
  expect(screen.queryByRole("alert")).toBeNull();
});

test("leaderboard visible nhưng chưa có điểm hiển thị empty state", async () => {
  mockResponse(page());
  renderPage();
  expect(await screen.findByText("Chưa có kết quả xếp hạng.")).toBeTruthy();
  // Chưa có dòng nào thì mô tả lấy metric chính từ hợp đồng của cuộc thi.
  expect(screen.getByText(/Xếp theo F1 tốt nhất/)).toBeTruthy();
});

test("hạng của bạn vẫn hiện khi nằm ngoài trang đang xem", async () => {
  mockResponse(
    page({
      total: 30,
      has_more: true,
      entries: [entry(1, "Đội Sớm"), entry(2, "Đội Nhì")],
      me: entry(27, "Thí Sinh", { is_current_user: true, total_submissions: 4 }),
    }),
  );

  renderPage();

  expect(await screen.findByText("Đội Sớm")).toBeTruthy();
  const strip = screen.getByText("Hạng của bạn").closest(".lb-me-strip") as HTMLElement;
  expect(strip).toHaveTextContent("#27");
  expect(strip).toHaveTextContent("/30");
  // Điểm chính của thẻ hạng cũng theo số thập phân của metric chính (f1: 4).
  expect(strip).toHaveTextContent("0.7300");
  expect(strip).toHaveTextContent("Hạng của bạn nằm ngoài trang này.");
  // Không có dòng nào của mình trong trang thì không được giả highlight.
  expect(document.querySelectorAll(".current-user-row")).toHaveLength(0);
});

test("chưa có bài hoàn thành thì không hiện thẻ hạng", async () => {
  mockResponse(page({ total: 1, entries: [entry(1, "Đội Sớm")] }));

  renderPage();

  expect(await screen.findByText("Đội Sớm")).toBeTruthy();
  expect(screen.queryByText("Hạng của bạn")).toBeNull();
});

test("phân trang gửi limit/offset và khóa nút ở hai biên", async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const secondPage = url.includes("offset=25");
      return new Response(
        JSON.stringify(
          page({
            total: 30,
            offset: secondPage ? 25 : 0,
            has_more: !secondPage,
            entries: [entry(secondPage ? 26 : 1, secondPage ? "Người 26" : "Người 1")],
          }),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();
  expect(urls[0]).toContain("limit=25");
  expect(urls[0]).toContain("offset=0");
  // Biên dùng aria-disabled (không phải `disabled`) để nút đang giữ focus không bị rơi focus.
  expect(screen.getByRole("button", { name: "Trang trước" })).toHaveAttribute("aria-disabled", "true");

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  expect(await screen.findByText("Người 26")).toBeTruthy();
  expect(urls.at(-1)).toContain("offset=25");
  expect(screen.getByRole("button", { name: "Trang sau" })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("button", { name: "Trang trước" })).toHaveAttribute("aria-disabled", "false");
});

test("bảng xếp hạng là vùng cuộn focus được bằng bàn phím", async () => {
  mockPagedFetch();

  renderPage();
  const region = await screen.findByRole("region", { name: "Bảng xếp hạng" });
  expect(region).toHaveAttribute("tabindex", "0");
  expect(within(region).getByRole("table")).toBeTruthy();
});

test("đổi trang vẫn giữ bảng cũ, pager và aria-busy trong lúc chờ", async () => {
  const { release } = mockPagedFetch({ gateOffset: 25 });

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  // Trang mới chưa về: bảng cũ và pager phải còn nguyên, vùng kết quả báo đang bận.
  const wrap = document.querySelector(".lb-table-wrap") as HTMLElement;
  expect(wrap).toHaveAttribute("aria-busy", "true");
  expect(screen.getByText("Người 1")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Trang sau" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Trang trước" })).toBeTruthy();
  expect(screen.getByRole("status")).toHaveTextContent("Đang cập nhật…");

  release();
  expect(await screen.findByText("Người 26")).toBeTruthy();
  expect(screen.queryByText("Người 1")).toBeNull();
  expect(wrap).toHaveAttribute("aria-busy", "false");
});

test("dải đang hiển thị và hạng của trang cập nhật theo trang mới", async () => {
  const { urls } = mockPagedFetch();

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();
  expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 1–25 trong số 30 thí sinh có điểm");

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  expect(await screen.findByText("Người 26")).toBeTruthy();
  expect(urls.at(-1)).toContain("offset=25");
  expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 26–30 trong số 30 thí sinh có điểm");
  // Hạng vẫn là hạng toàn cục do backend trả về, không đánh lại theo trang.
  const row = screen.getByText("Người 26").closest("tr") as HTMLElement;
  expect(row).toHaveTextContent("26");
});

test("bấm pager không làm focus rơi về body", async () => {
  const { release } = mockPagedFetch({ gateOffset: 25 });

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();

  const next = screen.getByRole("button", { name: "Trang sau" });
  next.focus();
  fireEvent.click(next);
  // Nút đang giữ focus không được unmount hay bị disabled cứng.
  expect(next).toBeInTheDocument();
  expect(document.activeElement).toBe(next);
  expect(next).toHaveAttribute("aria-disabled", "true");

  release();
  expect(await screen.findByText("Người 26")).toBeTruthy();
  expect(document.activeElement).toBe(next);
});

test("bấm trang liên tiếp chỉ phát một request và render trang cuối", async () => {
  const { urls, release } = mockPagedFetch({ gateOffset: 25 });

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();

  const next = screen.getByRole("button", { name: "Trang sau" });
  fireEvent.click(next);
  fireEvent.click(next);

  release();
  expect(await screen.findByText("Người 26")).toBeTruthy();
  expect(urls.filter((url) => url.includes("offset=25"))).toHaveLength(1);
  expect(screen.queryByText("Người 1")).toBeNull();
});

test("lỗi khi sang trang hai giữ nguyên trang một và cho thử lại", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("offset=25")) {
        return jsonResponse({ error: { code: "INTERNAL_ERROR", message: "Lỗi hệ thống." } }, 500);
      }
      return jsonResponse(
        page({ total: 30, offset: 0, has_more: true, entries: [entry(1, "Người 1")] }),
      );
    }),
  );

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Lỗi hệ thống.");
  expect(screen.getByText("Người 1")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Thử lại" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Trang sau" })).toBeTruthy();
  expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 1–25 trong số 30 thí sinh có điểm");
});

test("total co lại làm trang hiện tại vượt range thì lùi về trang cuối còn dữ liệu", async () => {
  const urls: string[] = [];
  let firstPageCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") ?? 0);
      if (offset === 25) {
        return jsonResponse(page({ total: 10, offset: 25, entries: [], has_more: false }));
      }
      firstPageCalls += 1;
      const total = firstPageCalls === 1 ? 30 : 10;
      return jsonResponse(page({ total, offset: 0, has_more: total > 25, entries: [entry(1, "Người 1")] }));
    }),
  );

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();
  expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 1–25 trong số 30 thí sinh có điểm");

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));

  // Trang 2 giờ vượt range: phải tự tải lại trang cuối hợp lệ thay vì bỏ trắng bảng.
  await waitFor(() => {
    expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 1–10 trong số 10 thí sinh có điểm");
  });
  expect(urls.filter((url) => url.includes("offset=0")).length).toBe(2);
  expect(screen.getByText("Người 1")).toBeTruthy();
});

test("trang rỗng nhưng vẫn còn dữ liệu thì mời quay lại, không báo chưa có kết quả", async () => {
  mockResponse(page({ total: 30, offset: 25, entries: [], has_more: true }));

  renderPage();

  expect(await screen.findByText("Trang này không có dữ liệu.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Về trang trước" })).toBeTruthy();
  expect(screen.queryByText("Chưa có kết quả xếp hạng.")).toBeNull();
});

test("cuộc thi v2 hiển thị cột theo hợp đồng, đúng số thập phân và đánh dấu chỉ số chính", async () => {
  const lossEntry = entry(1, "Đội Loss", {
    primary_score: 0.1234,
    metrics: { loss: 0.1234 },
    is_current_user: true,
  });
  mockResponse(page({ primary_metric: "loss", total: 1, entries: [lossEntry], me: lossEntry }));

  renderPage(V2_COMPETITION);

  expect(await screen.findByText("Đội Loss")).toBeTruthy();
  // Cột lấy từ hợp đồng: không còn F1/Precision/Recall của bộ chấm v1.
  expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
    "Hạng",
    "Đội / tài khoản",
    "Loss",
    "Đạt lúc",
  ]);
  const row = screen.getByText("Đội Loss").closest("tr") as HTMLElement;
  // Ba chữ số theo khai báo của admin, không phải bốn mặc định; nhấn đặt ở ô chứa giá trị.
  expect(within(row).getByText("0.123").closest("td")).toHaveClass("primary-score");
  // Thẻ hạng của người xem dùng cùng số thập phân của metric chính.
  const strip = screen.getByText("Hạng của bạn").closest(".lb-me-strip") as HTMLElement;
  expect(strip).toHaveTextContent("0.123");
  expect(screen.getByText(/Xếp theo Loss tốt nhất/)).toBeTruthy();
});

test("cuộc thi v2 chưa khai báo metric: không nêu tên metric, không đánh dấu chính, lùi 4 số thập phân", async () => {
  const draftEntry = entry(1, "Đội Nháp", { metrics: {}, primary_score: 0.5 });
  mockResponse(page({ primary_metric: null, total: 1, entries: [draftEntry], me: draftEntry }));

  renderPage(V2_DRAFT_COMPETITION);

  expect(await screen.findByText("Đội Nháp")).toBeTruthy();
  expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
    "Hạng",
    "Đội / tài khoản",
    "Đạt lúc",
  ]);
  expect(document.querySelector(".primary-score")).toBeNull();
  // Không có định nghĩa metric chính để đọc số thập phân thì lùi về 4 như bộ chấm v1.
  const strip = screen.getByText("Hạng của bạn").closest(".lb-me-strip") as HTMLElement;
  expect(strip).toHaveTextContent("0.5000");
  // Chưa chọn metric chính thì câu mô tả không được lộ "null"/"undefined".
  const lead = screen.getByText(/Xếp theo điểm chấm của cuộc thi/);
  expect(lead.textContent).not.toMatch(/null|undefined/);
});

/* ---------------------------------------------------------------------------
   Tự làm mới ngầm
   --------------------------------------------------------------------------- */

test("đang xem thì bảng tự làm mới ngầm theo nhịp, không nháy trạng thái tải", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  let name = "Người 1";
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse(page({ total: 30, has_more: true, entries: [entry(1, name)] }));
    }),
  );

  renderPage();
  await advance(0);
  expect(urls).toHaveLength(1);
  expect(screen.getByText("Người 1")).toBeTruthy();

  name = "Người mới";
  await advance(AUTO_REFRESH_MS);
  expect(urls).toHaveLength(2);
  expect(screen.getByText("Người mới")).toBeTruthy();
  expect(screen.queryByText("Người 1")).toBeNull();
  // Lượt ngầm không đụng trạng thái tải: bảng không bật aria-busy và pager vẫn đọc số dòng.
  expect(document.querySelector(".lb-table-wrap")).toHaveAttribute("aria-busy", "false");
  expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 1–25 trong số 30 thí sinh có điểm");
});

test("làm mới ngầm giữ nguyên trang đang xem và focus của pager", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { urls } = mockPagedFetch();

  renderPage();
  await advance(0);
  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  await advance(0);
  expect(screen.getByText("Người 26")).toBeTruthy();

  const next = screen.getByRole("button", { name: "Trang sau" });
  next.focus();
  await advance(AUTO_REFRESH_MS);
  // Lượt ngầm hỏi đúng trang đang xem, không kéo người dùng về trang một.
  expect(urls.at(-1)).toContain("offset=25");
  expect(screen.getByText("Người 26")).toBeTruthy();
  expect(document.activeElement).toBe(next);
  expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 26–30 trong số 30 thí sinh có điểm");
});

test("bảng bị ẩn giữa chừng: 403 xoá điểm đã tải thay vì để điểm cũ trên màn hình", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  let hidden = false;
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (hidden) {
        return jsonResponse(
          {
            error: {
              code: "LEADERBOARD_HIDDEN",
              message: "Bảng xếp hạng hiện chưa được công bố.",
            },
          },
          403,
        );
      }
      return jsonResponse(page({ total: 1, entries: [entry(1, "Người 1")] }));
    }),
  );

  renderPage();
  await advance(0);
  expect(screen.getByText("Người 1")).toBeTruthy();

  hidden = true;
  await advance(AUTO_REFRESH_MS);
  // Bảng vừa bị ẩn: điểm cũ không được nằm lại trên màn hình. Shell sẽ phát hiện qua lượt
  // làm mới của chính nó và thay bằng thẻ "chưa công bố", nên trang bảng không báo lỗi.
  expect(screen.queryByText("Người 1")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  // Ẩn bảng không phải mất quyền đọc cuộc thi - không được khóa cả gate.
  expect(reportAccessLost).not.toHaveBeenCalled();

  // 403 là lỗi quyền: vòng tự làm mới dừng hẳn, không quay lại hỏi nữa.
  const calls = urls.length;
  await advance(AUTO_REFRESH_MS * 5);
  expect(urls).toHaveLength(calls);
});

test("lượt ngầm lỗi mạng giữ bảng và báo đang thử lại, sau đó tự phục hồi", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  let failing = false;
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (failing) {
        return jsonResponse({ error: { code: "INTERNAL_ERROR", message: "Lỗi hệ thống." } }, 500);
      }
      return jsonResponse(page({ total: 1, entries: [entry(1, "Người 1")] }));
    }),
  );

  renderPage();
  await advance(0);
  expect(screen.getByText("Người 1")).toBeTruthy();

  failing = true;
  await advance(AUTO_REFRESH_MS);
  // Bảng cũ vẫn hiện, nhưng thông báo cho biết lượt làm mới đang thử lại.
  expect(screen.getByText("Người 1")).toBeTruthy();
  expect(screen.getByText(/Hệ thống đang tự thử lại/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();

  // Backoff sau lỗi đầu: 3000 * 2^1 = 6000ms (jitter đã cố định về hệ số 1.0).
  await advance(5_999);
  expect(urls).toHaveLength(2);
  failing = false;
  await advance(1);
  expect(urls).toHaveLength(3);
  expect(screen.getByText("Người 1")).toBeTruthy();
  expect(screen.queryByText(/Hệ thống đang tự thử lại/)).toBeNull();
});

test("tab bị ẩn thì ngừng hỏi, quay lại thì cập nhật ngay", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { urls } = mockPagedFetch();

  renderPage();
  await advance(0);
  expect(urls).toHaveLength(1);

  setDocumentHidden(true);
  await advance(AUTO_REFRESH_MS * 3);
  expect(urls).toHaveLength(1);

  setDocumentHidden(false);
  await advance(0);
  expect(urls).toHaveLength(2);
});
