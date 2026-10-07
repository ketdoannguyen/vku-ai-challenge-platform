/**
 * Bảng xếp hạng tổng hợp cho thí sinh: cột riêng từng nguồn theo cấu hình admin, trạng thái chờ
 * nguồn, đổi nhánh Public/Private, phân trang và hành vi mất quyền giữa chừng.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { AggregateLeaderboardPage } from "./AggregateLeaderboardPage";

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SOURCES = [
  {
    competition_id: "c1",
    slug: "cv-a",
    name: "CV A",
    weight: 0.6,
    score_kind: "normalized",
    metric_label: "Accuracy",
    ready: true,
    reason: null,
  },
  {
    competition_id: "c2",
    slug: "nlp-b",
    name: "NLP B",
    weight: 0.4,
    score_kind: "normalized",
    metric_label: "F1",
    ready: true,
    reason: null,
  },
];

function component(competitionId: string, score: number | null) {
  return { competition_id: competitionId, score };
}

function entry(rank: number, name: string, overrides: Record<string, unknown> = {}) {
  return {
    rank,
    display_name: name,
    is_current_user: false,
    total_score: 80,
    components: [component("c1", 80), component("c2", 80)],
    ...overrides,
  };
}

/** Payload nền cho một lượt đọc bảng; test nào quan tâm field nào thì override field đó. */
function board(overrides: Record<string, unknown> = {}) {
  return {
    slug: "tong-hop-cup",
    name: "Tổng hợp Cup",
    view: "public",
    has_private: false,
    updated_at: "2026-10-06T03:00:00Z",
    status: "ready",
    sources: SOURCES,
    entries: [],
    total: 0,
    limit: 25,
    offset: 0,
    has_more: false,
    me: null,
    ...overrides,
  };
}

const READY_BOARD = board({
  total: 3,
  entries: [
    entry(1, "An", { total_score: 84, components: [component("c1", 80), component("c2", 90)] }),
    entry(2, "Bình", {
      total_score: 48,
      components: [component("c1", 80), component("c2", null)],
    }),
    entry(2, "Chi", { total_score: 48, components: [component("c1", 80), component("c2", 0)] }),
  ],
});

const WAITING_BOARD = board({
  status: "waiting",
  sources: [
    SOURCES[0],
    { ...SOURCES[1], ready: false, reason: "private_unpublished", score_kind: null, metric_label: null },
  ],
  total: null,
});

function mockResponse(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, status)));
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/tong-hop/tong-hop-cup"]}>
      <Routes>
        <Route path="/tong-hop/:slug" element={<AggregateLeaderboardPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("bảng sẵn sàng: cột riêng từng nguồn kèm nhãn metric, thiếu kết quả khác điểm 0", async () => {
  mockResponse(READY_BOARD);
  renderPage();

  expect(await screen.findByText("An")).toBeTruthy();
  expect(screen.getAllByRole("columnheader")).toHaveLength(5);
  expect(screen.getByRole("columnheader", { name: "Điểm tổng (0–100)" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: /CV A/ })).toHaveTextContent("Accuracy");
  expect(screen.getByRole("columnheader", { name: /NLP B/ })).toHaveTextContent("F1");
  expect(screen.queryByRole("columnheader", { name: /Có kết quả/ })).toBeNull();

  // Tên nguồn ở chip dưới tiêu đề và ở đầu cột đều dẫn về cuộc thi nguồn.
  const sourceLinks = screen.getAllByRole("link", { name: "CV A" });
  expect(sourceLinks).toHaveLength(2);
  for (const link of sourceLinks) {
    expect(link).toHaveAttribute("href", "/competitions/cv-a");
  }
  expect(screen.getByText("60% · Accuracy")).toBeTruthy();

  const binh = screen.getByText("Bình").closest("tr") as HTMLElement;
  // Thiếu kết quả: ô gạch, đóng góp 0 điểm vào tổng.
  expect(within(binh).getByText("-")).toBeTruthy();
  expect(within(binh).getByText("48.00")).toBeTruthy();

  const chi = screen.getByText("Chi").closest("tr") as HTMLElement;
  // Điểm 0 thật là một con số, không phải ô gạch.
  expect(within(chi).getByText("0.00")).toBeTruthy();

  // Bằng điểm thật thì cùng hạng: hai dòng 48.00, không có hạng 3.
  expect(screen.getAllByText("48.00")).toHaveLength(2);
  expect(screen.getByText(/hạng theo điểm đầy đủ/)).toBeTruthy();
});

test("có nguồn dùng điểm gốc: cột tổng bỏ nhãn 0–100", async () => {
  mockResponse(
    board({
      sources: [SOURCES[0], { ...SOURCES[1], score_kind: "primary" }],
      total: 1,
      entries: [entry(1, "An")],
    }),
  );
  renderPage();

  expect(await screen.findByText("An")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Điểm tổng" })).toBeTruthy();
});

test("dải hạng của tôi: hạng, điểm tổng và ghi chú ngoài trang", async () => {
  mockResponse(
    board({
      total: 30,
      entries: [entry(1, "An")],
      me: entry(4, "Thí Sinh", {
        is_current_user: true,
        total_score: 60,
        components: [component("c1", 60), component("c2", null)],
      }),
    }),
  );
  renderPage();

  const strip = (await screen.findByText("Hạng của bạn")).closest(".lb-me-strip") as HTMLElement;
  expect(strip).toHaveTextContent("#4/30");
  expect(within(strip).getByText("Điểm tổng")).toBeTruthy();
  expect(within(strip).getByText("60.00")).toBeTruthy();
  // Người xem không nằm trong trang hiện tại thì phải nói rõ, không để họ tưởng mất hạng.
  expect(within(strip).getByText("Hạng của bạn nằm ngoài trang này.")).toBeTruthy();
});

test("chờ nguồn: nêu từng nguồn chưa sẵn sàng, không hiện dòng hay hạng", async () => {
  mockResponse(WAITING_BOARD);
  renderPage();

  expect(await screen.findByText("Bảng tổng hợp đang chờ đủ nguồn.")).toBeTruthy();
  // Chỉ nguồn chưa sẵn sàng vào danh sách lý do; nguồn đã sẵn sàng không bị nêu tên.
  const items = screen.getAllByRole("listitem");
  expect(items).toHaveLength(1);
  expect(items[0]).toHaveTextContent("Kết quả nhánh Private của nguồn chưa được công bố.");
  expect(screen.queryByText("Hạng của bạn")).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
});

test("đang chờ: bảng tự làm mới ngầm và tự mở khi nguồn sẵn sàng", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  let waiting = true;
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return waiting ? jsonResponse(WAITING_BOARD) : jsonResponse(READY_BOARD);
    }),
  );

  renderPage();
  await advance(0);
  expect(screen.getByText("Bảng tổng hợp đang chờ đủ nguồn.")).toBeTruthy();

  waiting = false;
  await advance(AUTO_REFRESH_MS);
  expect(urls).toHaveLength(2);
  expect(screen.getByText("An")).toBeTruthy();
  expect(screen.queryByText("Bảng tổng hợp đang chờ đủ nguồn.")).toBeNull();
});

test("đổi sang nhánh Private: lượt đọc Public đang bay không lọt vào bảng Private", async () => {
  let releasePublic = () => {};
  const publicGate = new Promise<void>((resolve) => {
    releasePublic = resolve;
  });
  let held = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const view = new URL(url, "http://localhost").searchParams.get("view");
      if (view === "private") {
        return jsonResponse(
          board({ view: "private", has_private: true, total: 1, entries: [entry(1, "Riêng")] }),
        );
      }
      if (held) await publicGate;
      return jsonResponse(board({ has_private: true, total: 1, entries: [entry(1, "An")] }));
    }),
  );

  renderPage();
  expect(await screen.findByText("An")).toBeTruthy();

  // Lượt làm mới Public bị giữ lại, rồi người dùng đổi sang Private trước khi nó kịp về.
  held = true;
  fireEvent.click(screen.getByRole("button", { name: "Làm mới" }));
  fireEvent.click(screen.getByRole("button", { name: "Private" }));
  expect(await screen.findByText("Riêng")).toBeTruthy();

  releasePublic();
  await act(async () => {
    await publicGate;
  });
  // Response Public cũ đã bị bỏ: không dòng Public nào hiện dưới nhãn Private.
  expect(screen.queryByText("An")).toBeNull();
  expect(screen.getByText("Riêng")).toBeTruthy();
});

test("mất quyền giữa chừng: xoá dữ liệu đã tải, dừng làm mới và chỉ đường về danh sách", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  let denied = false;
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (denied) {
        return jsonResponse(
          {
            error: {
              code: "AGGREGATE_MEMBERSHIP_REQUIRED",
              message: "Bảng tổng hợp chỉ mở cho thành viên của cuộc thi nguồn.",
            },
          },
          403,
        );
      }
      return jsonResponse(board({ total: 1, entries: [entry(1, "An")] }));
    }),
  );

  renderPage();
  await advance(0);
  expect(screen.getByText("An")).toBeTruthy();

  denied = true;
  await advance(AUTO_REFRESH_MS);
  expect(screen.getByText("Bạn không xem được bảng tổng hợp này.")).toBeTruthy();
  expect(screen.getByText("Bảng tổng hợp chỉ mở cho thành viên của cuộc thi nguồn.")).toBeTruthy();
  // Điểm cũ không được nằm lại trên màn hình sau khi mất quyền.
  expect(screen.queryByText("An")).toBeNull();
  expect(screen.getByRole("link", { name: "Về danh sách bảng tổng hợp" })).toHaveAttribute(
    "href",
    "/tong-hop",
  );

  // 403 là lỗi quyền: vòng tự làm mới dừng hẳn, không quay lại hỏi nữa.
  const calls = urls.length;
  await advance(AUTO_REFRESH_MS * 5);
  expect(urls).toHaveLength(calls);
});

test("bảng chưa công bố: lần tải đầu bị từ chối thì hiện thẻ từ chối, không phải lỗi chung", async () => {
  mockResponse(
    { error: { code: "AGGREGATE_NOT_PUBLISHED", message: "Bảng tổng hợp chưa được công bố." } },
    403,
  );
  renderPage();

  expect(await screen.findByText("Bạn không xem được bảng tổng hợp này.")).toBeTruthy();
  expect(screen.getByText("Bảng tổng hợp chưa được công bố.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("phân trang: Trang sau hỏi offset kế tiếp, Trang trước quay lại trang đầu", async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") ?? 0);
      return jsonResponse(
        board({
          total: 30,
          offset,
          has_more: offset + 25 < 30,
          entries: [entry(offset + 1, `Người ${offset + 1}`)],
        }),
      );
    }),
  );

  renderPage();
  expect(await screen.findByText("Người 1")).toBeTruthy();
  expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 1–25 trong số 30 thí sinh");

  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  expect(await screen.findByText("Người 26")).toBeTruthy();
  expect(urls.at(-1)).toContain("offset=25");
  expect(screen.getByRole("status")).toHaveTextContent("Đã hiển thị 26–30 trong số 30 thí sinh");

  fireEvent.click(screen.getByRole("button", { name: "Trang trước" }));
  expect(await screen.findByText("Người 1")).toBeTruthy();
  expect(urls.at(-1)).toContain("offset=0");
});
