/**
 * Hướng dẫn nộp bài: nội dung lấy từ cấu hình thật của cuộc thi và dùng chung nguồn với
 * tab Nộp bài; cuộc thi chưa cấu hình vẫn phải đọc được, không lộ null/undefined.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import type { Competition } from "../api/competitions";
import { CompetitionDetailPage } from "./CompetitionDetailPage";
import { CompetitionGuidePage } from "./CompetitionGuidePage";

const BASE: Competition = {
  id: "1",
  slug: "ai-challenge-2026",
  name: "AI Challenge 2026",
  short_description: "Cuộc thi AI lần 1",
  status: "published",
  start_at: "2026-10-01T00:00:00Z",
  end_at: "2026-11-01T00:00:00Z",
  join_mode: "code",
  primary_metric: "f1",
  quota_per_day: 7,
  leaderboard_visible: true,
  join_code_configured: true,
  resources: [],
  membership: { active: true, joined_at: "2026-09-15T00:00:00Z" },
  submission_config: {
    ready: true,
    id_column: "record_id",
    prediction_column: "label",
    average: "binary",
    pos_label: "1",
    max_upload_mb: 50,
    max_notebook_mb: 20,
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockApi(competition: Competition = BASE) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/contents")) return jsonResponse({ contents: [] });
      if (url.includes("/starter-notebook")) {
        return jsonResponse(
          {
            error: {
              code: "STARTER_NOTEBOOK_MISSING",
              message: "Notebook khung chưa được cài đặt trên máy chủ.",
            },
          },
          503,
        );
      }
      return jsonResponse(competition);
    }),
  );
  return { urls };
}

function renderGuide() {
  return render(
    <MemoryRouter initialEntries={["/competitions/ai-challenge-2026/huong-dan"]}>
      <Routes>
        <Route path="/competitions/:slug" element={<CompetitionDetailPage />}>
          <Route path="huong-dan" element={<CompetitionGuidePage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("bốn khối hướng dẫn dùng đúng cấu hình của cuộc thi", async () => {
  mockApi();
  renderGuide();

  await screen.findByRole("heading", { name: "Hướng dẫn nộp bài", level: 2 });
  const blocks = [
    "Hai tệp bắt buộc trong mỗi lượt nộp",
    "Định dạng tệp prediction.csv",
    "Notebook tái lập (.ipynb)",
    "Notebook khởi đầu",
  ];
  expect(
    screen.getAllByRole("heading", { level: 3 }).map((node) => node.textContent),
  ).toEqual(blocks);

  // Tên cột, dung lượng và cách tính điểm lấy từ cấu hình thật chứ không hardcode.
  const required = screen
    .getByRole("heading", { name: "Hai tệp bắt buộc trong mỗi lượt nộp", level: 3 })
    .closest("section") as HTMLElement;
  expect(within(required).getByText("record_id")).toBeTruthy();
  expect(within(required).getByText("label")).toBeTruthy();
  expect(within(required).getByText(/tối đa 50 MiB/)).toBeTruthy();
  expect(within(required).getByText(/tối đa 20 MiB/)).toBeTruthy();
  expect(within(required).getByText("Binary")).toBeTruthy();
  expect(within(required).getByText("1")).toBeTruthy();

  // Ví dụ CSV dùng đúng hai cột của cuộc thi và có nhiều dòng mẫu.
  const sample = screen.getByLabelText("Ví dụ nội dung prediction.csv");
  expect(sample.textContent?.split("\n")).toEqual([
    "record_id,label",
    "sample_0001,1",
    "sample_0002,0",
    "sample_0003,0",
    "sample_0004,1",
  ]);
});

test("cuộc thi chưa cấu hình chấm điểm vẫn đọc được hướng dẫn, không lộ null/undefined", async () => {
  mockApi({
    ...BASE,
    submission_config: {
      ready: false,
      id_column: null,
      prediction_column: "",
      average: null,
      pos_label: null,
      max_upload_mb: 50,
      max_notebook_mb: 20,
    },
  });
  renderGuide();

  await screen.findByRole("heading", { name: "Hướng dẫn nộp bài", level: 2 });
  expect(screen.getByText(/chưa cấu hình/)).toBeTruthy();
  // Ví dụ CSV rơi về tên cột mặc định của nền tảng thay vì hở giá trị rỗng.
  expect(screen.getByLabelText("Ví dụ nội dung prediction.csv").textContent).toContain("id,prediction");
  expect(document.body.textContent).not.toContain("null");
  expect(document.body.textContent).not.toContain("undefined");
});

test("CTA tải notebook khung gọi endpoint công khai và báo lỗi bằng alert", async () => {
  mockApi();
  renderGuide();

  const button = await screen.findByRole("button", { name: "Tải notebook khung (.ipynb)" });
  fireEvent.click(button);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Notebook khung chưa được cài đặt trên máy chủ.",
  );
  // Thất bại không được khoá nút: thí sinh còn thử lại được.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Tải notebook khung (.ipynb)" })).not.toBeDisabled(),
  );
});
