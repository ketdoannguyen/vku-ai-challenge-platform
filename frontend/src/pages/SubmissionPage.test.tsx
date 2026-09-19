import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import type { Competition } from "../api/competitions";
import { SubmissionPage } from "./SubmissionPage";

const COMPETITION: Competition = {
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

function renderPage(competition: Competition = COMPETITION) {
  const refreshCompetition = vi.fn(async () => {});
  const view = render(
    <MemoryRouter initialEntries={["/competitions/submit-cup/submit"]}>
      <Routes>
        <Route element={<Outlet context={{ competition, contents: [], refreshCompetition }} />}>
          <Route path="/competitions/:slug/submit" element={<SubmissionPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return { ...view, refreshCompetition };
}

/** Notebook hợp lệ tối thiểu - mọi lượt nộp đều phải kèm tệp này. */
function selectNotebook(name = "solution.ipynb") {
  fireEvent.change(screen.getByLabelText("Chọn notebook"), {
    target: { files: [new File(["{}"], name, { type: "application/x-ipynb+json" })] },
  });
}

function selectCsv(name = "result.csv", body = "id,prediction\n1,1\n") {
  fireEvent.change(screen.getByLabelText("Chọn file CSV"), {
    target: { files: [new File([body], name, { type: "text/csv" })] },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("hiển thị rule summary và chỉ mở nút nộp khi đã đủ hai tệp", () => {
  renderPage();
  const rules = screen.getByLabelText("Quy định file submission");
  expect(rules).toHaveTextContent("ID: id");
  expect(rules).toHaveTextContent("Prediction: prediction");
  expect(rules).toHaveTextContent("Binary");
  expect(rules).toHaveTextContent("CSV 10 MiB");
  expect(rules).toHaveTextContent("notebook tối đa 20 MiB");
  expect(rules).toHaveTextContent("5 lượt/ngày");

  const file = new File(["id,prediction\n1,1\n"], "team-result.csv", { type: "text/csv" });
  fireEvent.change(screen.getByLabelText("Chọn file CSV"), { target: { files: [file] } });
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

  fireEvent.change(screen.getByLabelText("Chọn file CSV"), {
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
  expect(within(screen.getByLabelText("Quy định file submission")).getByText("Còn 4/5 lượt hôm nay")).toBeTruthy();
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
  expect(within(screen.getByLabelText("Quy định file submission")).getByText("5 lượt/ngày")).toBeTruthy();
});

test("nút chọn file CSV là <button> thật nên Tab/Enter mở được picker", () => {
  renderPage();
  const button = screen.getByRole("button", { name: "Chọn file CSV" });
  expect(button.tagName).toBe("BUTTON");
  expect(button).not.toBeDisabled();
  button.focus();
  expect(button).toHaveFocus();

  const input = screen.getByLabelText("Chọn file CSV") as HTMLInputElement;
  const openPicker = vi.spyOn(input, "click").mockImplementation(() => {});
  fireEvent.click(button);
  expect(openPicker).toHaveBeenCalledTimes(1);
  openPicker.mockRestore();
});

test("submit hiển thị loading rồi metrics và quota còn lại", async () => {
  let resolveRequest: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        }),
    ),
  );
  renderPage();
  selectCsv();
  selectNotebook();
  fireEvent.click(screen.getByRole("button", { name: "Nộp và chấm điểm" }));
  expect(await screen.findByRole("button", { name: "Đang chấm điểm..." })).toBeDisabled();

  resolveRequest?.(
    new Response(
      JSON.stringify({
        id: "submission-1",
        competition_id: COMPETITION.id,
        status: "completed",
        metrics: { f1: 0.5, precision: 0.5, recall: 0.5 },
        primary_score: 0.5,
        created_at: "2026-09-15T00:00:00Z",
        quota_remaining: 4,
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ),
  );
  expect(await screen.findByText("Kết quả chấm điểm")).toBeTruthy();
  expect(screen.getAllByText("0.500000")).toHaveLength(3);

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

test("quota còn lại hiển thị trước khi nộp và refetch sau khi nộp thành công", async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body);
      return new Response(
        JSON.stringify({
          id: "submission-1",
          competition_id: COMPETITION.id,
          status: "completed",
          metrics: { f1: 0.5, precision: 0.5, recall: 0.5 },
          primary_score: 0.5,
          created_at: "2026-09-15T00:00:00Z",
          quota_remaining: 2,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
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
  const rules = screen.getByLabelText("Quy định file submission");
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
  expect(screen.getByLabelText("Chọn file CSV")).toBeDisabled();
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
  expect(await screen.findByRole("alert")).toHaveTextContent("Tập ID không khớp ground truth");
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
