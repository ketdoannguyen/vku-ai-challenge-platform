import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  created_by: "admin@vku.vn",
  join_code_configured: false,
  membership: { active: true, joined_at: "2026-09-15T00:00:00Z" },
  submission_config: {
    ready: true,
    id_column: "id",
    prediction_column: "prediction",
    average: "binary",
    pos_label: "1",
    max_upload_mb: 10,
  },
};

function renderPage(competition: Competition = COMPETITION) {
  return render(
    <MemoryRouter initialEntries={["/competitions/submit-cup/submit"]}>
      <Routes>
        <Route element={<Outlet context={{ competition, contents: [] }} />}>
          <Route path="/competitions/:slug/submit" element={<SubmissionPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("hiển thị rule summary và file đã chọn", () => {
  renderPage();
  const rules = screen.getByLabelText("Quy định file submission");
  expect(rules).toHaveTextContent("ID: id");
  expect(rules).toHaveTextContent("Prediction: prediction");
  expect(rules).toHaveTextContent("Binary");
  expect(rules).toHaveTextContent("10 MiB");
  expect(rules).toHaveTextContent("5 lượt/ngày");

  const file = new File(["id,prediction\n1,1\n"], "team-result.csv", { type: "text/csv" });
  fireEvent.change(screen.getByLabelText("Chọn file CSV"), { target: { files: [file] } });
  expect(screen.getByText("team-result.csv")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Nộp và chấm điểm" })).toBeEnabled();
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
  const file = new File(["id,prediction\n1,1\n"], "result.csv", { type: "text/csv" });
  fireEvent.change(screen.getByLabelText("Chọn file CSV"), { target: { files: [file] } });
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
  expect(screen.getByText("Còn 4 lượt nộp hôm nay.")).toBeTruthy();
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
  fireEvent.change(screen.getByLabelText("Chọn file CSV"), {
    target: { files: [new File(["id,prediction\n"], "bad.csv")] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Nộp và chấm điểm" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Tập ID không khớp ground truth");
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
