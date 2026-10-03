/** Admin competition detail: content table, member actions, join code không hiện trong DOM. */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { AdminCompetitionDetailPage } from "./AdminCompetitionDetailPage";

const COMPETITION = {
  id: "64a000000000000000000001",
  slug: "code-cup",
  name: "Code Cup",
  short_description: "",
  status: "published",
  start_at: "2026-10-01T00:00:00Z",
  end_at: "2026-11-01T00:00:00Z",
  join_mode: "code",
  primary_metric: "f1" as const,
  quota_per_day: 5,
  leaderboard_visible: true,
  created_by: "admin@vku.vn",
  join_code_configured: true,
  resources: [],
  publish_ready: true,
  publish_blocked_reason: null,
  membership: { active: false, joined_at: null },
};

const CONTENTS = {
  contents: [
    { id: "c1", slug: "problem", title: "Đề bài", order: 10, visibility: "public", size_bytes: 128, updated_at: "2026-09-15T00:00:00Z" },
    { id: "c2", slug: "rules", title: "Rules", order: 20, visibility: "members", size_bytes: null, updated_at: "2026-09-15T00:00:00Z" },
  ],
};

const MEMBERS = {
  members: [
    {
      account_id: "u1",
      email: "thi.sinh@vku.vn",
      name: "Thí Sinh",
      role: "participant",
      active: true,
      joined_at: "2026-09-15T00:00:00Z",
    },
  ],
  total: 1,
  active_total: 1,
};

const CONTRACT_METRICS = [
  { key: "f1", label: "F1", decimals: 4 },
  { key: "precision", label: "Precision", decimals: 4 },
  { key: "recall", label: "Recall", decimals: 4 },
];

/** Cấu hình v2 đã lưu đủ: schema, source, ground truth, hợp đồng metric và bằng chứng chạy thử. */
const SCORING = {
  ready: true,
  not_ready_reason: null,
  locked: false,
  version: 2,
  config: null,
  scoring: {
    revision: 3,
    input_schema: {
      ground_truth: {
        id_column: "id",
        allow_extra_columns: true,
        columns: [
          { name: "id", type: "integer", nullable: false, allowed_values: null },
          { name: "label", type: "integer", nullable: false, allowed_values: [0, 1] },
        ],
      },
      submission: {
        id_column: "id",
        allow_extra_columns: false,
        columns: [
          { name: "id", type: "integer", nullable: false, allowed_values: null },
          { name: "predict_label", type: "integer", nullable: false, allowed_values: [0, 1] },
        ],
      },
    },
    evaluator: {
      name: "Bộ chấm nhị phân",
      source_sha256: "a".repeat(64),
      runtime_id: "python-3.12",
      source_code: "def evaluate(ground_truth_path, submission_path):\n    return {'f1': 1.0}\n",
    },
    output_contract: {
      metrics: CONTRACT_METRICS,
      primary_metric: "f1",
      higher_is_better: true,
      visible_metrics: null,
    },
    verified: true,
    verification: {
      tested_at: "2026-09-15T00:00:00Z",
      tested_by: "admin@vku.vn",
      observed_keys: ["f1", "precision", "recall"],
    },
  },
  ground_truth: {
    row_count: 4,
    columns: ["id", "label"],
    uploaded_at: "2026-09-15T00:00:00Z",
  },
  primary_metric: "f1",
  higher_is_better: true,
  result_contract: {
    metrics: CONTRACT_METRICS,
    primary_metric: "f1",
    higher_is_better: true,
  },
  quota_per_day: 5,
  max_upload_mb: 10,
  source_limit_kb: 256,
};

/** Cuộc thi còn chấm bằng bộ chấm sklearn: chỉ có cấu hình v1, chưa có bộ chấm Python. */
const V1_SCORING = {
  ...SCORING,
  version: 1,
  config: {
    id_column: "id",
    prediction_column: "prediction",
    label_column: "label",
    average: "binary",
    pos_label: "1",
    higher_is_better: true,
  },
  scoring: null,
};

const AI_REVIEW_SETTINGS = {
  config: {
    enabled: true,
    auto_review: true,
    participant_visible: true,
    provider: "openai-compatible",
    base_url: "https://api.example.com/v1",
    model: "gpt-oss-120b",
    api_key_configured: true,
    verified_at: "2026-09-15T09:05:00Z",
    updated_at: "2026-09-15T09:00:00Z",
  },
  runtime: { encryption_available: true },
  content_source: {
    included_count: 1,
    excluded_count: 0,
    total_bytes: 120,
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
    ],
  },
};

const calls: Array<{ url: string; init?: RequestInit }> = [];

function mockApi(handler: (url: string, init?: RequestInit) => { body: unknown; status: number }) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const r = handler(url, init);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

/** Nhóm action ở header trang chi tiết - tách khỏi nút "Xóa" của từng dòng nội dung. */
function headerActions(): HTMLElement {
  return document.querySelector(".admin-detail-actions") as HTMLElement;
}

/** Sáu ô của dải tóm tắt; `data-tone` phải theo vị trí render chứ không theo nghiệp vụ. */
function summaryFacts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".admin-detail-fact"));
}

/** Chuỗi `data-tone` của các block trong một panel - kiểm tra nhịp màu, không kiểm tra CSS. */
function cardTones(panel: HTMLElement): Array<string | null> {
  return Array.from(panel.querySelectorAll<HTMLElement>("[data-tone]")).map((el) =>
    el.getAttribute("data-tone"),
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/competitions/64a000000000000000000001"]}>
      <Routes>
        <Route path="/admin/competitions/:id" element={<AdminCompetitionDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Mock đủ endpoint của cả 7 panel để đổi tab không phụ thuộc shape dữ liệu. */
async function renderRail() {
  mockApi((url) => {
    if (url.includes("/join-code")) return { body: { join_code_configured: true }, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (url.includes("/assets")) return { body: { assets: [] }, status: 200 };
    if (url.includes("/members")) return { body: MEMBERS, status: 200 };
    if (url.includes("/scoring")) return { body: SCORING, status: 200 };
    if (url.includes("/ai-review")) return { body: AI_REVIEW_SETTINGS, status: 200 };
    if (url.includes("/leaderboard")) {
      return {
        body: { competition_id: COMPETITION.id, primary_metric: "f1", total: 0, entries: [] },
        status: 200,
      };
    }
    if (url.includes("/submissions")) {
      return { body: { submissions: [], total: 0, limit: 50, offset: 0 }, status: 200 };
    }
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");
}

function rail(): HTMLElement {
  return screen.getByRole("tablist", { name: "Quản lý cuộc thi" });
}

/** Thứ tự tab của rail quản trị; dùng chung để thêm tab mới chỉ phải sửa một chỗ. */
const TAB_LABELS = [
  "Nội dung",
  "Hình ảnh",
  "Tài nguyên",
  "Chấm điểm",
  "Kết quả",
  "Thành viên",
  "Cài đặt",
];

/** Danh sách tabindex kỳ vọng khi chỉ tab ở vị trí `focusedIndex` nhận focus. */
function tabsWithFocusAt(focusedIndex: number): string[] {
  return TAB_LABELS.map((_, index) => (index === focusedIndex ? "0" : "-1"));
}

function railTab(name: string): HTMLElement {
  return within(rail()).getByRole("tab", { name });
}

function tabIndexes(): Array<string | null> {
  return within(rail())
    .getAllByRole("tab")
    .map((tab) => tab.getAttribute("tabindex"));
}

/** Control chọn file phải là <button> thật (Tab/Enter dùng được) mở input ẩn. */
function expectKeyboardFilePicker(buttonName: string | RegExp, inputLabel: string | RegExp) {
  const button = screen.getByRole("button", { name: buttonName });
  expect(button.tagName).toBe("BUTTON");
  expect(button).not.toBeDisabled();
  button.focus();
  expect(button).toHaveFocus();

  const input = screen.getByLabelText(inputLabel) as HTMLInputElement;
  const openPicker = vi.spyOn(input, "click").mockImplementation(() => {});
  fireEvent.click(button);
  expect(openPicker).toHaveBeenCalledTimes(1);
  openPicker.mockRestore();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("tab Nội dung render table theo order + trạng thái file", async () => {
  mockApi((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  expect(await screen.findByText("Đề bài")).toBeTruthy();
  expect(screen.getByLabelText("Thông tin chung cuộc thi")).toHaveTextContent("01/10/2026");
  expect(screen.getByLabelText("Thông tin chung cuộc thi")).toHaveTextContent("5 lượt/ngày");
  expect(screen.getByText("Chưa có file")).toBeTruthy();
  expect(screen.getByText("Đã upload")).toBeTruthy();
  expect(screen.getByText("Chỉ thành viên")).toBeTruthy();
});

test("nút upload .md trong tab Nội dung là <button> thật nên Tab/Enter mở được picker", async () => {
  mockApi((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");
  expectKeyboardFilePicker(/^Upload \.md/, 'Upload file Markdown cho "Rules"');
});

test("rail quản trị: đủ 7 khu vực, panel gắn đúng tab đang mở", async () => {
  mockApi((url) => {
    if (url.includes("/join-code")) return { body: { join_code_configured: true }, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (url.includes("/members")) return { body: MEMBERS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");

  const rail = screen.getByRole("tablist", { name: "Quản lý cuộc thi" });
  const tabs = within(rail).getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual(TAB_LABELS);
  expect(tabs.filter((tab) => tab.getAttribute("aria-selected") === "true")).toHaveLength(1);

  // React dùng lại chính nút DOM đó qua mỗi lần render nên phải chốt id trước khi bấm.
  const contentsPanelId = screen.getByRole("tabpanel", { name: "Nội dung" }).id;
  expect(tabs[0].getAttribute("aria-controls")).toBe(contentsPanelId);

  // Chuyển khu vực: panel cũ biến mất, panel mới do đúng tab đó điều khiển.
  const members = within(rail).getByRole("tab", { name: "Thành viên" });
  fireEvent.click(members);
  const next = await screen.findByRole("tabpanel", { name: "Thành viên" });
  expect(next.id).not.toBe(contentsPanelId);
  expect(members.getAttribute("aria-controls")).toBe(next.id);
  expect(screen.queryByRole("tabpanel", { name: "Nội dung" })).toBeNull();
});

test("rail quản trị: roving tabindex - chỉ focused tab có tabIndex=0, Arrow/Home/End wrap đúng", async () => {
  await renderRail();
  expect(tabIndexes()).toEqual(tabsWithFocusAt(0));

  fireEvent.keyDown(railTab("Nội dung"), { key: "ArrowRight" });
  expect(railTab("Hình ảnh")).toHaveFocus();
  expect(tabIndexes()).toEqual(tabsWithFocusAt(1));

  fireEvent.keyDown(railTab("Hình ảnh"), { key: "ArrowRight" });
  expect(railTab("Tài nguyên")).toHaveFocus();
  expect(tabIndexes()).toEqual(tabsWithFocusAt(2));

  fireEvent.keyDown(railTab("Tài nguyên"), { key: "ArrowRight" });
  expect(railTab("Chấm điểm")).toHaveFocus();
  expect(tabIndexes()).toEqual(tabsWithFocusAt(3));

  fireEvent.keyDown(railTab("Chấm điểm"), { key: "ArrowLeft" });
  expect(railTab("Tài nguyên")).toHaveFocus();
  expect(tabIndexes()).toEqual(tabsWithFocusAt(2));

  fireEvent.keyDown(railTab("Tài nguyên"), { key: "End" });
  expect(railTab("Cài đặt")).toHaveFocus();
  expect(tabIndexes()).toEqual(tabsWithFocusAt(TAB_LABELS.length - 1));

  fireEvent.keyDown(railTab("Cài đặt"), { key: "Home" });
  expect(railTab("Nội dung")).toHaveFocus();
  expect(tabIndexes()).toEqual(tabsWithFocusAt(0));

  // Wrap ở biên: trái từ tab đầu về tab cuối, phải từ tab cuối về tab đầu.
  fireEvent.keyDown(railTab("Nội dung"), { key: "ArrowLeft" });
  expect(railTab("Cài đặt")).toHaveFocus();
  fireEvent.keyDown(railTab("Cài đặt"), { key: "ArrowRight" });
  expect(railTab("Nội dung")).toHaveFocus();
});

test("rail quản trị: Arrow/Home/End dời focus nhưng chưa đổi panel đang render", async () => {
  await renderRail();
  const contentsPanel = screen.getByRole("tabpanel", { name: "Nội dung" });

  fireEvent.keyDown(railTab("Nội dung"), { key: "ArrowRight" });
  expect(railTab("Hình ảnh")).toHaveFocus();
  expect(screen.getByRole("tabpanel", { name: "Nội dung" })).toBe(contentsPanel);
  expect(screen.queryByRole("tabpanel", { name: "Hình ảnh" })).toBeNull();
  expect(railTab("Nội dung")).toHaveAttribute("aria-selected", "true");
  expect(railTab("Hình ảnh")).toHaveAttribute("aria-selected", "false");

  fireEvent.keyDown(railTab("Hình ảnh"), { key: "End" });
  expect(railTab("Cài đặt")).toHaveFocus();
  expect(screen.getByRole("tabpanel", { name: "Nội dung" })).toBe(contentsPanel);
});

test("rail quản trị: Enter và Space activate focused tab", async () => {
  await renderRail();

  fireEvent.keyDown(railTab("Nội dung"), { key: "ArrowRight" });
  fireEvent.keyDown(railTab("Hình ảnh"), { key: "Enter" });
  expect(await screen.findByRole("tabpanel", { name: "Hình ảnh" })).toBeTruthy();
  expect(railTab("Hình ảnh")).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("tabpanel", { name: "Nội dung" })).toBeNull();

  fireEvent.keyDown(railTab("Hình ảnh"), { key: "ArrowRight" });
  expect(railTab("Tài nguyên")).toHaveFocus();
  fireEvent.keyDown(railTab("Tài nguyên"), { key: " " });
  expect(await screen.findByRole("tabpanel", { name: "Tài nguyên" })).toBeTruthy();
  expect(railTab("Tài nguyên")).toHaveAttribute("aria-selected", "true");
});

test("rail quản trị: chỉ selected tab có aria-controls, không trỏ tới panel không tồn tại", async () => {
  await renderRail();

  // Chỉ một node tham chiếu panel và id đó phải giải được trong DOM.
  const referencing = document.querySelectorAll("[aria-controls^='admin-tabpanel-']");
  expect(referencing).toHaveLength(1);
  expect(document.getElementById(referencing[0].getAttribute("aria-controls")!)).not.toBeNull();

  within(rail())
    .getAllByRole("tab")
    .slice(1)
    .forEach((tab) => expect(tab).not.toHaveAttribute("aria-controls"));

  fireEvent.click(railTab("Kết quả"));
  const results = await screen.findByRole("tabpanel", { name: "Kết quả" });

  const after = document.querySelectorAll("[aria-controls^='admin-tabpanel-']");
  expect(after).toHaveLength(1);
  expect(after[0]).toBe(railTab("Kết quả"));
  expect(after[0].getAttribute("aria-controls")).toBe(results.id);
  expect(document.getElementById(results.id)).not.toBeNull();
  within(rail())
    .getAllByRole("tab")
    .filter((tab) => tab !== after[0])
    .forEach((tab) => expect(tab).not.toHaveAttribute("aria-controls"));
});

test("rail quản trị: tablist nằm ngang nên ArrowUp/ArrowDown để trang cuộn, không dời focus", async () => {
  await renderRail();
  const first = railTab("Nội dung");
  first.focus();

  for (const key of ["ArrowDown", "ArrowUp"]) {
    fireEvent.keyDown(first, { key });
    expect(first).toHaveFocus();
    expect(tabIndexes()).toEqual(tabsWithFocusAt(0));
  }
});

test("tab Tài nguyên hiển thị dữ liệu hiện có và PATCH đúng field resources", async () => {
  const current = {
    ...COMPETITION,
    resources: [
      { label: "Dataset", url: "https://drive.google.com/drive/folders/old" },
    ],
  };
  mockApi((url, init) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (url.endsWith(`/admin/competitions/${COMPETITION.id}`) && init?.method === "PATCH") {
      const resources = JSON.parse(String(init.body)).resources;
      return { body: { ...current, resources }, status: 200 };
    }
    return { body: current, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Tài nguyên" }));

  expect(screen.getByLabelText("Tên tài nguyên 1")).toHaveValue("Dataset");
  fireEvent.change(screen.getByLabelText("Tên tài nguyên 1"), {
    target: { value: "  Dataset cập nhật  " },
  });
  fireEvent.change(screen.getByLabelText("Link tài nguyên 1"), {
    target: { value: "  https://docs.google.com/document/d/new  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

  await waitFor(() => {
    const request = calls.find((call) => call.init?.method === "PATCH");
    expect(request).toBeTruthy();
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      resources: [
        { label: "Dataset cập nhật", url: "https://docs.google.com/document/d/new" },
      ],
    });
  });
  expect(await screen.findByRole("status")).toHaveTextContent("Đã cập nhật tài nguyên.");
  expect(screen.getByLabelText("Tên tài nguyên 1")).toHaveValue("Dataset cập nhật");
});

test("tab Tài nguyên giữ draft khi chuyển tab và cho hủy thay đổi", async () => {
  const current = {
    ...COMPETITION,
    resources: [
      { label: "Dataset", url: "https://drive.google.com/drive/folders/old" },
    ],
  };
  mockApi((url) =>
    url.includes("/contents")
      ? { body: CONTENTS, status: 200 }
      : { body: current, status: 200 },
  );
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Tài nguyên" }));

  expect(screen.getByRole("button", { name: "Lưu thay đổi" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Tên tài nguyên 1"), {
    target: { value: "Bản nháp" },
  });
  expect(screen.getByRole("button", { name: "Lưu thay đổi" })).toBeEnabled();

  fireEvent.click(railTab("Nội dung"));
  fireEvent.click(railTab("Tài nguyên"));
  expect(screen.getByLabelText("Tên tài nguyên 1")).toHaveValue("Bản nháp");

  fireEvent.click(screen.getByRole("button", { name: "Hủy thay đổi" }));
  expect(screen.getByLabelText("Tên tài nguyên 1")).toHaveValue("Dataset");
  expect(screen.getByRole("button", { name: "Lưu thay đổi" })).toBeDisabled();
});

test("tab Tài nguyên chặn link ngoài Drive và hỗ trợ xóa toàn bộ", async () => {
  const current = {
    ...COMPETITION,
    resources: [
      { label: "Dataset", url: "https://drive.google.com/drive/folders/old" },
    ],
  };
  mockApi((url, init) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (init?.method === "PATCH") {
      return { body: { ...current, resources: JSON.parse(String(init.body)).resources }, status: 200 };
    }
    return { body: current, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Tài nguyên" }));

  fireEvent.change(screen.getByLabelText("Link tài nguyên 1"), {
    target: { value: "https://example.com/data.csv" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Link tài nguyên phải là https://drive.google.com hoặc https://docs.google.com.",
  );
  expect(calls.some((call) => call.init?.method === "PATCH")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Xóa tài nguyên 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }));
  await waitFor(() => {
    const request = calls.find((call) => call.init?.method === "PATCH");
    expect(JSON.parse(String(request?.init?.body))).toEqual({ resources: [] });
  });
});

test("tab Tài nguyên giới hạn 10 dòng và khóa chỉnh sửa khi cuộc thi đã kết thúc", async () => {
  const closed = { ...COMPETITION, status: "closed", resources: [] };
  mockApi((url) =>
    url.includes("/contents")
      ? { body: CONTENTS, status: 200 }
      : { body: closed, status: 200 },
  );
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Tài nguyên" }));

  expect(screen.getByText("Cuộc thi đã kết thúc - không thể sửa tài nguyên.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Thêm tài nguyên" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Lưu thay đổi" })).toBeDisabled();
});

test("tab Tài nguyên giữ draft và hiện lỗi backend khi lưu thất bại", async () => {
  mockApi((url, init) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (init?.method === "PATCH") {
      return {
        body: { error: { code: "VALIDATION_ERROR", message: "Không thể lưu tài nguyên." } },
        status: 422,
      };
    }
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Tài nguyên" }));
  fireEvent.click(screen.getByRole("button", { name: "Thêm tài nguyên" }));
  fireEvent.change(screen.getByLabelText("Tên tài nguyên 1"), {
    target: { value: "Dataset" },
  });
  fireEvent.change(screen.getByLabelText("Link tài nguyên 1"), {
    target: { value: "https://drive.google.com/file/d/abc" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Không thể lưu tài nguyên.");
  expect(screen.getByLabelText("Tên tài nguyên 1")).toHaveValue("Dataset");
});

test("tab Tài nguyên khóa nút thêm khi đủ 10 dòng", async () => {
  mockApi((url) =>
    url.includes("/contents")
      ? { body: CONTENTS, status: 200 }
      : { body: COMPETITION, status: 200 },
  );
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Tài nguyên" }));

  const add = screen.getByRole("button", { name: "Thêm tài nguyên" });
  for (let index = 0; index < 10; index += 1) fireEvent.click(add);
  expect(screen.getByLabelText("Tên tài nguyên 10")).toBeTruthy();
  expect(add).toBeDisabled();
});

test("thêm thành viên gửi email đúng endpoint", async () => {
  mockApi((url, init) => {
    if (url.endsWith("/members") && init?.method === "POST") {
      return { body: { member: MEMBERS.members[0], created: false, reactivated: false }, status: 200 };
    }
    if (url.includes("/members")) return { body: MEMBERS, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Thành viên" }));
  await waitFor(() => expect(calls.some((call) => call.url.includes("/members?limit=200"))).toBe(true));
  const input = await screen.findByLabelText("Email thành viên");
  fireEvent.change(input, { target: { value: "thi.sinh@vku.vn" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => {
    const addCall = calls.find((c) => c.url.endsWith("/members") && c.init?.method === "POST");
    expect(addCall).toBeTruthy();
  });
  await screen.findByText("thi.sinh@vku.vn");
});

test("đổi mã tham gia không bao giờ hiển thị mã trong DOM", async () => {
  mockApi((url) => {
    if (url.includes("/join-code")) return { body: { join_code_configured: true }, status: 200 };
    if (url.includes("/ai-review")) return { body: AI_REVIEW_SETTINGS, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Cài đặt" }));
  const input = await screen.findByLabelText("Mã tham gia mới");
  fireEvent.change(input, { target: { value: "new-secret-2026" } });
  fireEvent.submit(input.closest("form")!);
  expect(screen.getByRole("dialog", { name: "Đổi mã tham gia" })).toBeTruthy();
  expect(calls.some((call) => call.url.includes("/join-code") && call.init?.method === "PUT")).toBe(false);
  fireEvent.click(screen.getAllByRole("button", { name: "Đổi mã" })[1]);
  await waitFor(() => screen.getByText("Đã cập nhật mã tham gia."));
  expect(screen.queryByDisplayValue("new-secret-2026")).toBeNull();
});

test("đặt mã ở Cài đặt cập nhật trạng thái publish; Thành viên không còn form mã", async () => {
  let codeConfigured = false;
  mockApi((url, init) => {
    if (url.endsWith("/join-code") && init?.method === "PUT") {
      codeConfigured = true;
      return { body: { join_code_configured: true }, status: 200 };
    }
    if (url.includes("/ai-review")) return { body: AI_REVIEW_SETTINGS, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (url.includes("/members")) return { body: MEMBERS, status: 200 };
    return {
      body: {
        ...COMPETITION,
        status: "draft",
        join_code_configured: codeConfigured,
        publish_blocked_reason: codeConfigured
          ? null
          : { code: "JOIN_CODE_REQUIRED", message: "Cần cấu hình mã tham gia trước khi publish cuộc thi." },
      },
      status: 200,
    };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Thành viên" }));
  expect(screen.queryByLabelText("Mã tham gia mới")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Cài đặt" }));

  const input = await screen.findByLabelText("Mã tham gia mới");
  expect(input).toHaveAttribute("type", "password");
  fireEvent.change(input, { target: { value: "first-secret-2026" } });
  fireEvent.submit(input.closest("form")!);

  await screen.findByText("Đã đặt mã tham gia.");
  await waitFor(() => expect(screen.queryByText("Chưa thể publish.")).toBeNull());
  expect(screen.getByRole("button", { name: "Publish" })).not.toBeDisabled();
  expect(screen.queryByDisplayValue("first-secret-2026")).toBeNull();
  expect(JSON.parse(calls.find((call) => call.url.endsWith("/join-code"))!.init!.body as string))
    .toEqual({ join_code: "first-secret-2026" });
});

test("đổi mã thất bại giữ hộp xác nhận để thử lại, hủy không gửi PUT", async () => {
  let attempts = 0;
  mockApi((url, init) => {
    if (url.endsWith("/join-code") && init?.method === "PUT") {
      attempts += 1;
      return attempts === 1
        ? { body: { detail: "Không thể đổi mã" }, status: 500 }
        : { body: { join_code_configured: true }, status: 200 };
    }
    if (url.includes("/ai-review")) return { body: AI_REVIEW_SETTINGS, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Cài đặt" }));
  const input = await screen.findByLabelText("Mã tham gia mới");
  fireEvent.change(input, { target: { value: "new-secret-2026" } });
  fireEvent.submit(input.closest("form")!);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Đổi mã tham gia" })).getByRole("button", { name: "Hủy" }));
  expect(attempts).toBe(0);
  fireEvent.submit(input.closest("form")!);
  const dialog = screen.getByRole("dialog", { name: "Đổi mã tham gia" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Đổi mã" }));
  await within(dialog).findByRole("alert");
  expect(input).toHaveValue("new-secret-2026");
  fireEvent.click(within(dialog).getByRole("button", { name: "Đổi mã" }));
  await screen.findByText("Đã cập nhật mã tham gia.");
  expect(attempts).toBe(2);
  expect(screen.queryByRole("dialog", { name: "Đổi mã tham gia" })).toBeNull();
});

test.each([
  ["open", "tự do"],
  ["invite_only", "chỉ mời"],
])("chế độ %s hiển thị nhắc không dùng mã ở Cài đặt", async (joinMode, label) => {
  mockApi((url) => {
    if (url.includes("/ai-review")) return { body: AI_REVIEW_SETTINGS, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: { ...COMPETITION, join_mode: joinMode }, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Cài đặt" }));
  expect(screen.getByText(`Cuộc thi này dùng chế độ tham gia ${label} - không dùng mã.`)).toBeTruthy();
  expect(screen.queryByLabelText("Mã tham gia mới")).toBeNull();
});

test("đổi trạng thái member yêu cầu xác nhận rồi mới PATCH", async () => {
  mockApi((url, init) => {
    if (url.includes("/members/") && init?.method === "PATCH") {
      return { body: { member: { ...MEMBERS.members[0], active: false } }, status: 200 };
    }
    if (url.includes("/members")) return { body: MEMBERS, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Thành viên" }));
  const toggle = await screen.findByRole("button", { name: "Vô hiệu hóa" });
  fireEvent.click(toggle);
  expect(screen.getByRole("dialog", { name: "Vô hiệu hóa thành viên" })).toBeTruthy();
  expect(calls.some((c) => c.init?.method === "PATCH" && c.url.includes("/members/u1"))).toBe(false);
  fireEvent.click(screen.getAllByRole("button", { name: "Vô hiệu hóa" })[1]);
  await waitFor(() => {
    const patch = calls.find((c) => c.init?.method === "PATCH" && c.url.includes("/members/u1"));
    expect(patch).toBeTruthy();
    expect(JSON.parse(patch!.init!.body as string)).toEqual({ active: false });
  });
});

test("tab Chấm điểm hiển thị readiness và metadata ground truth an toàn", async () => {
  mockApi((url) => {
    if (url.endsWith("/scoring")) return { body: SCORING, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  expect(await screen.findByText("Sẵn sàng chấm điểm")).toBeTruthy();
  expect(screen.getByText("4 dòng")).toBeTruthy();
  expect(screen.getByText("id, label")).toBeTruthy();
  expect(screen.getByText("10 MiB")).toBeTruthy();
  expect(screen.queryByText("ground truth labels")).toBeNull();
});

test("lưu cấu hình chấm điểm gửi đủ schema, source và hợp đồng metric", async () => {
  mockApi((url, init) => {
    if (url.endsWith("/scoring") && init?.method === "PUT") return { body: SCORING, status: 200 };
    if (url.endsWith("/scoring")) return { body: SCORING, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));

  // Sửa một cột của submission: lượt lưu phải mang theo cả schema hai phía, source và metric.
  fireEvent.change(await screen.findByLabelText("Submission: cột 2: tên"), {
    target: { value: "answer" },
  });
  fireEvent.submit(screen.getByRole("button", { name: "Lưu cấu hình chấm điểm" }).closest("form")!);

  await waitFor(() => {
    const put = calls.find((call) => call.url.endsWith("/scoring") && call.init?.method === "PUT");
    expect(put).toBeTruthy();
    expect(JSON.parse(put!.init!.body as string)).toEqual({
      version: 2,
      // Revision đang lưu là 3, gửi lại đúng số đó để backend phát hiện lượt sửa từ nơi khác.
      expected_revision: 3,
      input_schema: {
        ground_truth: {
          id_column: "id",
          allow_extra_columns: true,
          columns: [
            { name: "id", type: "integer", nullable: false, allowed_values: null },
            { name: "label", type: "integer", nullable: false, allowed_values: [0, 1] },
          ],
        },
        submission: {
          id_column: "id",
          allow_extra_columns: false,
          columns: [
            { name: "id", type: "integer", nullable: false, allowed_values: null },
            { name: "answer", type: "integer", nullable: false, allowed_values: [0, 1] },
          ],
        },
      },
      evaluator: {
        name: "Bộ chấm nhị phân",
        source_code: SCORING.scoring.evaluator.source_code,
      },
      output_contract: {
        metrics: CONTRACT_METRICS,
        primary_metric: "f1",
        higher_is_better: true,
        // Tích hết là mặc định cũ: gửi `null` để backend giữ nguyên hành vi không giới hạn.
        visible_metrics: null,
      },
    });
  });
});

test("card định dạng dữ liệu có nút Lưu ở cuối card, nằm cùng form với nút cuối trang", async () => {
  mockApi((url, init) => {
    if (url.endsWith("/scoring") && init?.method === "PUT") return { body: SCORING, status: 200 };
    if (url.endsWith("/scoring")) return { body: SCORING, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));

  // Nút là phần tử cuối card (sau hai bảng cột và khối khớp ID): sửa xong là bấm ngay,
  // không phải cuộn ngược lên hàng tiêu đề.
  const card = (await screen.findByText("Định dạng dữ liệu")).closest("section") as HTMLElement;
  const save = within(card).getByRole("button", { name: "Lưu" });
  expect(card.lastElementChild).toBe(save.parentElement);
  expect(save.closest(".admin-detail-card-head")).toBeNull();
  expect(save).toHaveAttribute("type", "submit");

  fireEvent.click(save);
  expect(await screen.findByText("Đã lưu cấu hình chấm điểm.")).toBeTruthy();
  const puts = calls.filter((call) => call.url.endsWith("/scoring") && call.init?.method === "PUT");
  expect(puts).toHaveLength(1);
});

test("upload ground truth dùng endpoint private và form data", async () => {
  mockApi((url, init) => {
    if (url.endsWith("/ground-truth") && init?.method === "PUT") {
      return { body: SCORING, status: 200 };
    }
    if (url.endsWith("/scoring")) return { body: { ...SCORING, ready: false, ground_truth: null }, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  const input = await screen.findByLabelText("Upload ground truth CSV");
  fireEvent.change(input, { target: { files: [new File(["id,label\n1,1"], "truth.csv", { type: "text/csv" })] } });
  await waitFor(() => {
    const put = calls.find((call) => call.url.endsWith("/ground-truth") && call.init?.method === "PUT");
    expect(put?.init?.body).toBeInstanceOf(FormData);
  });
});

test("chưa lưu cấu hình vẫn chọn trước được ground truth, tệp tải lên ngay sau lượt lưu", async () => {
  const UNSAVED = { ...SCORING, ready: false, scoring: null, config: null, ground_truth: null };
  // Lượt lưu đầu trả revision mới; upload nối theo phải dùng đúng revision đó chứ không phải bản cũ.
  const SAVED = { ...SCORING, ready: false, scoring: { ...SCORING.scoring, revision: 1 }, ground_truth: null };
  mockApi((url, init) => {
    if (url.endsWith("/ground-truth") && init?.method === "PUT") {
      return { body: { ...SAVED, ground_truth: SCORING.ground_truth }, status: 200 };
    }
    if (url.endsWith("/scoring") && init?.method === "PUT") return { body: SAVED, status: 200 };
    if (url.endsWith("/scoring")) return { body: UNSAVED, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));

  fireEvent.change(await screen.findByLabelText("Upload ground truth CSV"), {
    target: { files: [new File(["id,label\n1,1"], "truth.csv", { type: "text/csv" })] },
  });

  // Chưa lưu cấu hình: tệp nằm chờ trong form, chưa có request nào rời trình duyệt.
  expect(await screen.findByText("truth.csv")).toBeTruthy();
  expect(calls.some((call) => call.url.endsWith("/ground-truth"))).toBe(false);

  fireEvent.submit(screen.getByRole("button", { name: "Lưu cấu hình chấm điểm" }).closest("form")!);

  expect(await screen.findByText("Đã lưu cấu hình và tải lên ground truth.")).toBeTruthy();
  const saveIndex = calls.findIndex((call) => call.url.endsWith("/scoring") && call.init?.method === "PUT");
  const uploadIndex = calls.findIndex(
    (call) => call.url.endsWith("/ground-truth") && call.init?.method === "PUT",
  );
  expect(saveIndex).toBeGreaterThanOrEqual(0);
  expect(uploadIndex).toBeGreaterThan(saveIndex);
  // Form chưa có gì: tên trống và source trống đi đúng dạng bản nháp. `null` là "không đổi
  // source", không phải chuỗi rỗng để backend báo lỗi cú pháp - nhờ vậy lưu được schema trước.
  expect(JSON.parse(calls[saveIndex]!.init!.body as string).evaluator).toEqual({
    name: "",
    source_code: null,
  });
  const uploadBody = calls[uploadIndex]?.init?.body as FormData | undefined;
  expect(uploadBody?.get("expected_revision")).toBe("1");
  // Tệp đã lên: hàng chờ tan, metadata ground truth thay chỗ dòng "đã chọn".
  expect(screen.queryByText("truth.csv")).toBeNull();
  expect(screen.getByText("4 dòng")).toBeTruthy();
});

test("upload ground truth xong thì banner publish biến mất và nút Publish mở khóa", async () => {
  const blocked = {
    code: "GROUND_TRUTH_REQUIRED",
    message: "Cần tải lên ground truth trước khi publish cuộc thi.",
  };
  // Backend là bên quyết định: sau upload, detail trả readiness mới. Test bám vào đó để
  // bắt lỗi panel cấu hình xong mà không đọc lại state trang.
  let uploaded = false;
  mockApi((url, init) => {
    if (url.endsWith("/ground-truth") && init?.method === "PUT") {
      uploaded = true;
      return { body: SCORING, status: 200 };
    }
    if (url.endsWith("/scoring")) {
      return {
        body: { ...SCORING, ready: false, ground_truth: null, not_ready_reason: blocked },
        status: 200,
      };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return uploaded
      ? {
          body: { ...COMPETITION, status: "draft", publish_ready: true, publish_blocked_reason: null },
          status: 200,
        }
      : {
          body: { ...COMPETITION, status: "draft", publish_ready: false, publish_blocked_reason: blocked },
          status: 200,
        };
  });
  renderPage();

  expect(await screen.findByText("Chưa thể publish.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();

  fireEvent.click(screen.getByRole("tab", { name: "Chấm điểm" }));
  fireEvent.change(await screen.findByLabelText("Upload ground truth CSV"), {
    target: { files: [new File(["id,label\n1,1"], "truth.csv", { type: "text/csv" })] },
  });

  await waitFor(() => {
    expect(screen.queryByText("Chưa thể publish.")).toBeNull();
  });
  expect(screen.getByRole("button", { name: "Publish" })).not.toBeDisabled();
});

test("banner chặn vì thiếu mã tham gia mở tab Cài đặt chứ không phải tab Chấm điểm", async () => {
  mockApi((url) => {
    if (url.endsWith("/scoring")) return { body: SCORING, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (url.includes("/ai-review")) return { body: AI_REVIEW_SETTINGS, status: 200 };
    return {
      body: {
        ...COMPETITION,
        status: "draft",
        join_code_configured: false,
        publish_ready: false,
        publish_blocked_reason: {
          code: "JOIN_CODE_REQUIRED",
          message: "Cần cấu hình mã tham gia trước khi publish cuộc thi.",
        },
      },
      status: 200,
    };
  });
  renderPage();

  const banner = (await screen.findByText("Chưa thể publish.")).closest(
    ".status-banner",
  ) as HTMLElement;
  fireEvent.click(within(banner).getByRole("button", { name: "Mở tab Cài đặt" }));

  expect(screen.getByRole("tab", { name: "Cài đặt" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await screen.findByText("Mã tham gia")).toBeTruthy();
});

test("nút upload ground truth là <button> thật nên Tab/Enter mở được picker", async () => {
  mockApi((url) => {
    if (url.endsWith("/scoring")) return { body: SCORING, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  await screen.findByText("Thay ground truth CSV");
  expectKeyboardFilePicker("Thay ground truth CSV", "Upload ground truth CSV");
});

test("scoring controls bị khóa khi backend báo locked", async () => {
  mockApi((url) => {
    if (url.endsWith("/scoring")) return { body: { ...SCORING, locked: true }, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  expect(await screen.findByText(/đã bị khóa/i)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Lưu cấu hình chấm điểm" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Lưu" })).toBeDisabled();
  expect(screen.getByLabelText("Upload ground truth CSV")).toBeDisabled();
  expect(screen.getByLabelText("Chọn CSV mẫu để chạy thử")).toBeDisabled();
  expect(screen.getByLabelText("Submission: cột 2: tên")).toBeDisabled();
});

test("tab Kết quả hiển thị ranking, filter submission và link export", async () => {
  mockApi((url) => {
    if (url.endsWith("/leaderboard")) {
      return {
        body: {
          competition_id: COMPETITION.id,
          primary_metric: "f1",
          total: 1,
          entries: [
            {
              rank: 1,
              account_id: "u1",
              display_name: "Thí Sinh",
              primary_score: 0.9,
              metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
              best_submission_id: "s1",
              best_submission_at: "2026-09-15T09:00:00Z",
              total_submissions: 2,
            },
          ],
        },
        status: 200,
      };
    }
    if (url.includes("/submissions")) {
      return {
        body: {
          submissions: [
            {
              id: "s1",
              competition_id: COMPETITION.id,
              status: "completed",
              metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
              primary_score: 0.9,
              created_at: "2026-09-15T09:00:00Z",
              artifacts: {
                prediction: { filename: "result.csv", size_bytes: 128, available: true },
                notebook: { filename: "solution.ipynb", size_bytes: 4096, available: true },
              },
              account: { id: "u1", name: "Thí Sinh", email: "thi.sinh@vku.vn" },
            },
          ],
          total: 51,
          limit: 50,
          offset: 0,
        },
        status: 200,
      };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();

  fireEvent.click(await screen.findByRole("tab", { name: "Kết quả" }));
  expect(await screen.findByTitle("result.csv")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Bảng xếp hạng" })).toBeTruthy();
  // Bảng xếp hạng vẫn cuộn ngang nên phải là vùng focus được bằng bàn phím.
  const leaderboard = screen.getByRole("region", { name: "Bảng xếp hạng của cuộc thi" });
  expect(leaderboard).toHaveAttribute("tabindex", "0");
  expect(within(leaderboard).getByRole("table")).toBeTruthy();
  // Danh sách bài nộp thì không: thẻ tự dồn cột nên không còn vùng cuộn nào để tab vào.
  const submissions = screen.getByRole("region", { name: "Danh sách bài nộp của cuộc thi" });
  expect(submissions).not.toHaveAttribute("tabindex");
  expect(within(submissions).getByRole("listitem")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Xuất Excel" })).toBeEnabled();
  expect(screen.getByLabelText("Lọc theo đội")).toBeTruthy();
  // Hai trục tách biệt: trạng thái chấm điểm và trạng thái duyệt của admin.
  expect(screen.getByLabelText("Lọc theo trạng thái chấm")).toBeTruthy();
  expect(screen.getByLabelText("Lọc theo trạng thái duyệt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  await waitFor(() => {
    // Bảng dùng chung luôn gửi kèm sắp xếp, nên đọc tham số thay vì so khớp cả query string.
    const paged = calls.find(
      (call) =>
        call.url.includes("/submissions?") &&
        new URL(call.url, "http://localhost").searchParams.get("offset") === "50",
    );
    expect(paged).toBeTruthy();
    expect(new URL(paged!.url, "http://localhost").searchParams.get("sort")).toBe("created_at");
  });
});

test("tab Kết quả khóa bảng bài nộp vào cuộc thi đang mở", async () => {
  mockApi((url) => {
    if (url.includes("/leaderboard")) {
      return {
        body: { competition_id: COMPETITION.id, primary_metric: "f1", total: 0, entries: [] },
        status: 200,
      };
    }
    if (url.includes("/submissions")) {
      return {
        body: {
          submissions: [
            {
              id: "s1",
              competition_id: COMPETITION.id,
              status: "completed",
              metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
              primary_score: 0.9,
              created_at: "2026-09-15T09:00:00Z",
              artifacts: {
                prediction: { filename: "result.csv", size_bytes: 128, available: true },
                notebook: { filename: "solution.ipynb", size_bytes: 4096, available: true },
              },
              account: { id: "u1", name: "Thí Sinh", email: "thi.sinh@vku.vn" },
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        },
        status: 200,
      };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Kết quả" }));
  const region = await screen.findByRole("region", { name: "Danh sách bài nộp của cuộc thi" });

  // Cuộc thi đã biết sẵn nên danh sách ẩn cả ô lọc lẫn trường cuộc thi, và không gọi endpoint toàn cục.
  expect(screen.queryByLabelText("Lọc theo cuộc thi")).toBeNull();
  expect(
    Array.from(region.querySelectorAll("dt")).some((dt) => dt.textContent === "Cuộc thi"),
  ).toBe(false);
  expect(calls.some((call) => call.url.includes("/api/admin/submissions?"))).toBe(false);

  // Không có thẻ thống kê toàn cục và không còn nút Lọc; Điểm chính vẫn được nhấn.
  expect(screen.queryByRole("region", { name: "Tổng quan bài nộp" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Lọc" })).toBeNull();
  expect(region.querySelector(".subm-result-primary-score")).toHaveTextContent("0.9000");

  // Cuộc thi đã khóa thì sắp xếp theo cuộc thi là trường hằng số: lựa chọn đó bị bỏ hẳn. F1 là
  // chỉ số chính nên nằm ở "Điểm chính", không lặp lại thành một lựa chọn metric phụ.
  const sortField = screen.getByLabelText("Sắp xếp theo");
  expect(Array.from(sortField.querySelectorAll("option")).map((option) => option.textContent)).toEqual(
    ["Thời gian", "Đội", "Điểm chính", "Precision", "Recall"],
  );

  // Sắp xếp vẫn chạy phía server, qua chính endpoint của cuộc thi.
  fireEvent.change(sortField, { target: { value: "team" } });
  await waitFor(() => {
    const sorted = calls.find(
      (call) => new URL(call.url, "http://localhost").searchParams.get("sort") === "team",
    );
    expect(sorted?.url).toContain(`/admin/competitions/${COMPETITION.id}/submissions?`);
  });

  for (const field of ["precision", "recall"]) {
    fireEvent.change(sortField, { target: { value: field } });
    await waitFor(() => {
      const sorted = calls.find(
        (call) => new URL(call.url, "http://localhost").searchParams.get("sort") === field,
      );
      expect(sorted?.url).toContain(`/admin/competitions/${COMPETITION.id}/submissions?`);
    });
  }

  // Lọc trạng thái áp dụng ngay, không cần bấm nút.
  fireEvent.change(screen.getByLabelText("Lọc theo trạng thái chấm"), {
    target: { value: "rejected" },
  });
  await waitFor(() => {
    const filtered = calls.find(
      (call) => new URL(call.url, "http://localhost").searchParams.get("status") === "rejected",
    );
    expect(filtered?.url).toContain(`/admin/competitions/${COMPETITION.id}/submissions?`);
  });
});

test("tab Kết quả xét duyệt qua endpoint toàn cục nhưng tải lại danh sách của cuộc thi", async () => {
  mockApi((url, init) => {
    if (url.includes("/leaderboard")) {
      return {
        body: { competition_id: COMPETITION.id, primary_metric: "f1", total: 0, entries: [] },
        status: 200,
      };
    }
    if (init?.method === "PATCH") return { body: { submission: {} }, status: 200 };
    if (url.includes("/submissions")) {
      return {
        body: {
          submissions: [
            {
              id: "s1",
              competition_id: COMPETITION.id,
              status: "completed",
              metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
              primary_score: 0.9,
              created_at: "2026-09-15T09:00:00Z",
              artifacts: {
                prediction: { filename: "result.csv", size_bytes: 128, available: true },
                notebook: { filename: "solution.ipynb", size_bytes: 4096, available: true },
              },
              account: { id: "u1", name: "Thí Sinh", email: "thi.sinh@vku.vn" },
              review: null,
              ai_review: null,
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        },
        status: 200,
      };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Kết quả" }));
  const region = await screen.findByRole("region", { name: "Danh sách bài nộp của cuộc thi" });
  await within(region).findByText("Thí Sinh");

  fireEvent.click(within(region).getByRole("button", { name: "Không chấp nhận" }));
  const dialog = await screen.findByRole("dialog", { name: "Không chấp nhận bài nộp" });
  fireEvent.change(within(dialog).getByLabelText("Lý do không chấp nhận"), {
    target: { value: "Sai kiến trúc." },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Không chấp nhận" }));

  // Bài nộp là tài nguyên chung nên endpoint xét duyệt luôn là route toàn cục.
  await waitFor(() =>
    expect(calls.find((call) => call.init?.method === "PATCH")?.url).toBe(
      "/api/admin/submissions/s1/review",
    ),
  );
  // Nhưng refetch vẫn nằm trong cuộc thi đang mở, không kéo bảng về phạm vi toàn hệ thống.
  await waitFor(() =>
    expect(calls.filter((call) => call.url.includes("/submissions?")).at(-1)?.url).toContain(
      `/admin/competitions/${COMPETITION.id}/submissions?`,
    ),
  );
  expect(calls.filter((call) => call.url.includes("/submissions?")).length).toBeGreaterThan(1);
  expect(calls.some((call) => call.url.includes("/api/admin/submissions?"))).toBe(false);
});

test("header hiển thị action theo status: draft có Publish, published có Kết thúc, closed có Mở lại và Xóa", async () => {
  // 1. Published
  mockApi((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  const { unmount, container } = renderPage();
  expect(await screen.findByRole("button", { name: "Kết thúc" })).toBeTruthy();
  const headerActions = container.querySelector(".admin-detail-actions") as HTMLElement;
  expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  expect(within(headerActions).getByRole("button", { name: "Sửa" })).not.toBeDisabled();
  expect(screen.getByRole("button", { name: "Clone" })).toBeTruthy();
  // Cuộc thi đang chạy phải Kết thúc trước khi xoá.
  expect(within(headerActions).queryByRole("button", { name: "Xóa" })).toBeNull();
  unmount();

  // 2. Draft
  mockApi((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: { ...COMPETITION, status: "draft" }, status: 200 };
  });
  const renderDraft = renderPage();
  expect(await screen.findByRole("button", { name: "Publish" })).toBeTruthy();
  const draftHeaderActions = renderDraft.container.querySelector(".admin-detail-actions") as HTMLElement;
  expect(screen.queryByRole("button", { name: "Kết thúc" })).toBeNull();
  expect(within(draftHeaderActions).getByRole("button", { name: "Sửa" })).not.toBeDisabled();
  renderDraft.unmount();

  // 3. Closed
  mockApi((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: { ...COMPETITION, status: "closed" }, status: 200 };
  });
  const renderClosed = renderPage();
  expect(await screen.findByRole("button", { name: "Clone" })).toBeTruthy();
  const closedHeaderActions = renderClosed.container.querySelector(".admin-detail-actions") as HTMLElement;
  // Sửa vẫn khoá khi đã kết thúc - phải Mở lại trước.
  expect(within(closedHeaderActions).getByRole("button", { name: "Sửa" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Kết thúc" })).toBeNull();
  expect(within(closedHeaderActions).getByRole("button", { name: "Mở lại" })).toBeTruthy();
  expect(within(closedHeaderActions).getByRole("button", { name: "Xóa" })).toBeTruthy();
  renderClosed.unmount();
});

test("closed: Mở lại gọi POST /reopen qua modal xác nhận", async () => {
  mockApi((url, init) => {
    if (url.endsWith("/reopen") && init?.method === "POST") {
      return { body: { ...COMPETITION, status: "published" }, status: 200 };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: { ...COMPETITION, status: "closed" }, status: 200 };
  });
  renderPage();

  fireEvent.click(await screen.findByRole("button", { name: "Mở lại" }));
  const dialog = screen.getByRole("dialog", { name: "Mở lại cuộc thi" });
  // Chưa bấm xác nhận thì chưa được gọi API.
  expect(calls.some((c) => c.url.endsWith("/reopen"))).toBe(false);

  fireEvent.click(within(dialog).getByRole("button", { name: "Mở lại" }));
  await waitFor(() => {
    expect(calls.some((c) => c.url.endsWith("/reopen") && c.init?.method === "POST")).toBe(true);
  });
  expect(await screen.findByText("Đã mở lại cuộc thi.")).toBeTruthy();
});

test("header publish/close/clone gọi đúng endpoint modal xác nhận", async () => {
  mockApi((url, init) => {
    if (url.endsWith("/publish") && init?.method === "POST") {
      return { body: { ...COMPETITION, status: "published" }, status: 200 };
    }
    if (url.endsWith("/clone") && init?.method === "POST") {
      return { body: { ...COMPETITION, id: "cloned-id", name: "Code Cup (Bản sao)" }, status: 201 };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: { ...COMPETITION, status: "draft" }, status: 200 };
  });
  renderPage();

  // Publish
  const publishBtn = await screen.findByRole("button", { name: "Publish" });
  fireEvent.click(publishBtn);
  const publishDialog = screen.getByRole("dialog", { name: "Publish cuộc thi" });
  expect(publishDialog).toBeTruthy();
  expect(calls.some((c) => c.url.endsWith("/publish"))).toBe(false);
  fireEvent.click(within(publishDialog).getByRole("button", { name: "Publish" }));
  await waitFor(() => {
    expect(calls.some((c) => c.url.endsWith("/publish") && c.init?.method === "POST")).toBe(true);
  });

  // Clone
  const cloneBtn = screen.getByRole("button", { name: "Clone" });
  fireEvent.click(cloneBtn);
  const cloneDialog = screen.getByRole("dialog", { name: "Clone cuộc thi" });
  expect(cloneDialog).toBeTruthy();
  fireEvent.click(within(cloneDialog).getByRole("button", { name: "Clone" }));
  await waitFor(() => {
    expect(calls.some((c) => c.url.endsWith("/clone") && c.init?.method === "POST")).toBe(true);
  });
});

test("draft chưa sẵn sàng chấm điểm: banner lý do, disable Publish, nhảy sang tab Chấm điểm", async () => {
  const blocked = {
    code: "GROUND_TRUTH_REQUIRED",
    message: "Cần tải lên ground truth trước khi publish cuộc thi.",
  };
  mockApi((url) => {
    if (url.endsWith("/scoring")) {
      return {
        body: { ...SCORING, ready: false, ground_truth: null, not_ready_reason: blocked },
        status: 200,
      };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return {
      body: { ...COMPETITION, status: "draft", publish_ready: false, publish_blocked_reason: blocked },
      status: 200,
    };
  });
  renderPage();

  // Loading cũng mang role="status" nên bám vào nội dung banner thay vì role.
  const banner = (await screen.findByText("Chưa thể publish.")).closest(
    ".status-banner",
  ) as HTMLElement;
  expect(banner).not.toBeNull();
  expect(banner).toHaveTextContent(blocked.message);
  expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();

  fireEvent.click(within(banner).getByRole("button", { name: "Mở tab Chấm điểm" }));
  // Cùng một nguồn readiness: tab Chấm điểm nhắc lại đúng lý do đang chặn publish.
  expect(await screen.findByText(blocked.message)).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Chấm điểm" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("Định dạng dữ liệu")).toBeTruthy();
});

test("publish trả 422 vẫn hiển thị lỗi trong modal xác nhận", async () => {
  mockApi((url, init) => {
    if (url.endsWith("/publish") && init?.method === "POST") {
      return {
        body: {
          error: {
            code: "GROUND_TRUTH_REQUIRED",
            message: "Cần tải lên ground truth trước khi publish cuộc thi.",
          },
        },
        status: 422,
      };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    // Detail luôn mang readiness; nút vẫn bấm được khi backend là bên quyết định cuối cùng.
    return { body: { ...COMPETITION, status: "draft" }, status: 200 };
  });
  renderPage();

  fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
  const dialog = screen.getByRole("dialog", { name: "Publish cuộc thi" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Cần tải lên ground truth trước khi publish cuộc thi.",
  );
});

test("tab Hình ảnh render Bento 8/4, inventory table 5 cột, copy markdown và upload/delete", async () => {
  const ASSETS = {
    assets: [
      {
        name: "banner.png",
        content_type: "image/png",
        size_bytes: 204800,
        url: "/api/competitions/code-cup/assets/banner.png",
      },
      {
        name: "architecture.jpg",
        content_type: "image/jpeg",
        size_bytes: 512000,
        url: "/api/competitions/code-cup/assets/architecture.jpg",
      },
    ],
  };

  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, {
    clipboard: { writeText: clipboardWrite },
  });

  mockApi((url, init) => {
    if (url.endsWith("/assets") && init?.method === "POST") {
      return {
        body: {
          asset: {
            name: "diagram.png",
            content_type: "image/png",
            size_bytes: 102400,
            url: "/api/competitions/code-cup/assets/diagram.png",
          },
        },
        status: 201,
      };
    }
    if (url.includes("/assets/banner.png") && init?.method === "DELETE") {
      return { body: { ok: true }, status: 200 };
    }
    if (url.includes("/assets")) return { body: ASSETS, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });

  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Hình ảnh" }));

  // Bento 8/4 items
  expect(await screen.findByText("Kho lưu trữ hình ảnh")).toBeTruthy();
  expect(screen.getByText("2 tệp")).toBeTruthy();
  expect(screen.getByText("Quy chuẩn nhúng Markdown")).toBeTruthy();
  expect(screen.getByText("assets/ten-file.png")).toBeTruthy();

  // Table items
  expect(screen.getByText("banner.png")).toBeTruthy();
  expect(screen.getByText("architecture.jpg")).toBeTruthy();
  expect(screen.getByText("PNG")).toBeTruthy();
  expect(screen.getByText("JPEG")).toBeTruthy();
  expect(screen.getByText("200 KB")).toBeTruthy();
  expect(screen.getByText("500 KB")).toBeTruthy();
  expect(screen.getByText("assets/banner.png")).toBeTruthy();
  expect(screen.getByText("assets/architecture.jpg")).toBeTruthy();

  // Copy action
  const copyBtns = screen.getAllByRole("button", { name: "Copy tham chiếu" });
  fireEvent.click(copyBtns[0]); // first asset row copy
  expect(clipboardWrite).toHaveBeenCalledWith("assets/banner.png");

  // Delete action with confirm modal
  const deleteBtns = screen.getAllByRole("button", { name: "Xóa" });
  fireEvent.click(deleteBtns[0]);
  const deleteDialog = screen.getByRole("dialog", { name: "Xóa asset" });
  expect(deleteDialog).toBeTruthy();
  expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
  fireEvent.click(within(deleteDialog).getByRole("button", { name: "Xóa" })); // modal confirm button
  await waitFor(() => {
    expect(calls.some((c) => c.url.includes("/assets/banner.png") && c.init?.method === "DELETE")).toBe(true);
  });

  // Upload action
  const uploadInput = screen.getByLabelText("Chọn tệp ảnh");
  fireEvent.change(uploadInput, {
    target: { files: [new File(["dummy"], "diagram.png", { type: "image/png" })] },
  });
  await waitFor(() => {
    const uploadCall = calls.find((c) => c.url.endsWith("/assets") && c.init?.method === "POST");
    expect(uploadCall).toBeTruthy();
    expect(uploadCall?.init?.body).toBeInstanceOf(FormData);
  });
});

test("nút upload ảnh trong tab Hình ảnh là <button> thật nên Tab/Enter mở được picker", async () => {
  mockApi((url) => {
    if (url.includes("/assets")) return { body: { assets: [] }, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Hình ảnh" }));
  await screen.findByText(/Upload ảnh/);
  expectKeyboardFilePicker(/^Upload ảnh/, "Chọn tệp ảnh");
});

test("xóa thành viên: xác nhận rồi mới DELETE", async () => {
  mockApi((url, init) => {
    if (url.includes("/members/") && init?.method === "DELETE") {
      return { body: { deleted: true, account_id: "u1" }, status: 200 };
    }
    if (url.includes("/members")) return { body: MEMBERS, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Thành viên" }));
  fireEvent.click(await screen.findByRole("button", { name: "Xóa" }));

  const dialog = screen.getByRole("dialog", { name: "Xóa thành viên" });
  expect(within(dialog).getByText(/chưa từng có bài nộp được chấm điểm/)).toBeTruthy();
  expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);

  fireEvent.click(within(dialog).getByRole("button", { name: "Xóa" }));
  await waitFor(() => {
    const call = calls.find((c) => c.init?.method === "DELETE");
    expect(call?.url).toContain("/members/u1");
  });
});

test("xóa thành viên đã có bài chấm điểm: 409 hiện ngay trong modal, không xóa gì", async () => {
  mockApi((url, init) => {
    if (url.includes("/members/") && init?.method === "DELETE") {
      return {
        body: {
          error: {
            code: "MEMBER_HAS_SUBMISSIONS",
            message: "Thành viên đã có bài nộp được chấm điểm. Hãy dùng Vô hiệu hóa thay vì xoá.",
          },
        },
        status: 409,
      };
    }
    if (url.includes("/members")) return { body: MEMBERS, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Thành viên" }));
  fireEvent.click(await screen.findByRole("button", { name: "Xóa" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Xóa thành viên" })).getByRole("button", { name: "Xóa" }));

  expect(await screen.findByText(/Hãy dùng Vô hiệu hóa thay vì xoá/)).toBeTruthy();
  // Danh sách chỉ được tải lại sau khi xóa thành công.
  expect(screen.getByRole("dialog", { name: "Xóa thành viên" })).toBeTruthy();
  expect(screen.getByText("thi.sinh@vku.vn")).toBeTruthy();
});

test("đếm thành viên tách người đang hoạt động khỏi người đã vô hiệu hóa", async () => {
  mockApi((url) => {
    if (url.includes("/members")) {
      return {
        body: {
          members: [
            { ...MEMBERS.members[0], active: false },
            { ...MEMBERS.members[0], account_id: "u2", email: "khac@vku.vn", name: "Khác" },
          ],
          total: 2,
          active_total: 1,
        },
        status: 200,
      };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Thành viên" }));

  expect(await screen.findByText("1 đang hoạt động · 2 tổng cộng")).toBeTruthy();
});

test("draft có nút Xóa cuộc thi ở header", async () => {
  mockApi((url) =>
    url.includes("/contents")
      ? { body: CONTENTS, status: 200 }
      : { body: { ...COMPETITION, status: "draft" }, status: 200 },
  );
  renderPage();
  await screen.findByText("Code Cup");
  // Bảng nội dung cũng có nút "Xóa" cho từng dòng nên chỉ soi đúng nhóm action ở header.
  expect(within(headerActions()).getByRole("button", { name: "Xóa" })).toBeTruthy();
});

test("published không hiện nút Xóa cuộc thi", async () => {
  mockApi((url) => (url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: COMPETITION, status: 200 }));
  renderPage();
  await screen.findByText("Code Cup");
  expect(within(headerActions()).queryByRole("button", { name: "Xóa" })).toBeNull();
});

test("xóa draft từ trang chi tiết: gõ đúng slug, gọi DELETE rồi về danh sách", async () => {
  mockApi((url, init) => {
    if (init?.method === "DELETE") {
      return { body: { deleted: true, competition_id: COMPETITION.id, slug: COMPETITION.slug, files_removed: true }, status: 200 };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: { ...COMPETITION, status: "draft" }, status: 200 };
  });
  render(
    <MemoryRouter initialEntries={[`/admin/competitions/${COMPETITION.id}`]}>
      <Routes>
        <Route path="/admin/competitions/:id" element={<AdminCompetitionDetailPage />} />
        <Route path="/admin/competitions" element={<div>DANH SÁCH CUỘC THI</div>} />
      </Routes>
    </MemoryRouter>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Xóa" }));
  const dialog = screen.getByRole("dialog", { name: "Xóa cuộc thi" });
  const confirm = within(dialog).getByRole("button", { name: "Xóa vĩnh viễn" });
  fireEvent.change(within(dialog).getByLabelText(/Gõ chính xác slug/), { target: { value: COMPETITION.slug } });
  fireEvent.click(confirm);

  await waitFor(() => {
    const call = calls.find((c) => c.init?.method === "DELETE");
    expect(call?.url).toContain(`confirm_slug=${COMPETITION.slug}`);
  });
  expect(await screen.findByText("DANH SÁCH CUỘC THI")).toBeTruthy();
});

/** Mock tab Kết quả; export đi qua fetch blob nên nhận handler riêng để ép status/lỗi. */
function mockResultsWithExport(exportResponse: () => Response) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/export.xlsx")) return exportResponse();
      const body = url.includes("/leaderboard")
        ? { competition_id: COMPETITION.id, primary_metric: "f1", total: 0, entries: [] }
        : url.includes("/submissions")
          ? { submissions: [], total: 0, limit: 50, offset: 0 }
          : url.includes("/contents")
            ? CONTENTS
            : COMPETITION;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

/** jsdom thiếu cả hai API này; đồng thời chặn anchor.click() để không thử điều hướng blob:. */
function stubBlobDownload() {
  const createObjectURL = vi.fn(() => "blob:mock-download");
  const revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return { createObjectURL, revokeObjectURL, anchorClick };
}

async function openResultsTab() {
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Kết quả" }));
  return await screen.findByRole("button", { name: "Xuất Excel" });
}

test("xuất Excel: dùng filename từ Content-Disposition rồi thu hồi object URL", async () => {
  const { createObjectURL, revokeObjectURL, anchorClick } = stubBlobDownload();
  mockResultsWithExport(
    () =>
      new Response("xlsx-bytes", {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": "attachment; filename*=UTF-8''ket%20qua.xlsx",
        },
      }),
  );

  fireEvent.click(await openResultsTab());

  await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
  expect(anchorClick).toHaveBeenCalledTimes(1);
  const anchor = anchorClick.mock.instances[0] as unknown as HTMLAnchorElement;
  expect(anchor.download).toBe("ket qua.xlsx");
  expect(anchor.isConnected).toBe(false); // link tạm đã được gỡ khỏi DOM

  // revoke nằm trong macrotask kế tiếp để trình duyệt kịp đọc blob.
  await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-download"));
  expect(screen.getByRole("button", { name: "Xuất Excel" })).toBeEnabled();
});

test("xuất Excel: header vắng thì fallback tên file theo slug cuộc thi", async () => {
  const { createObjectURL, anchorClick } = stubBlobDownload();
  mockResultsWithExport(() => new Response("xlsx-bytes", { status: 200 }));

  fireEvent.click(await openResultsTab());

  await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
  expect((anchorClick.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe(
    `${COMPETITION.slug}-ket-qua.xlsx`,
  );
});

test("xuất Excel lỗi 401: hiện ErrorBox, không tạo object URL và bật lại nút", async () => {
  const { createObjectURL, anchorClick } = stubBlobDownload();
  mockResultsWithExport(
    () =>
      new Response(
        JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Phiên đăng nhập đã hết hạn." } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
  );

  fireEvent.click(await openResultsTab());

  expect(await screen.findByText(/Phiên đăng nhập đã hết hạn/)).toBeTruthy();
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(anchorClick).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Xuất Excel" })).toBeEnabled();
});

test("xuất Excel lỗi 500 không phải JSON vẫn ở lại SPA", async () => {
  const { createObjectURL } = stubBlobDownload();
  mockResultsWithExport(() => new Response("<html>boom</html>", { status: 500 }));

  fireEvent.click(await openResultsTab());

  expect(await screen.findByText(/Lỗi HTTP 500/)).toBeTruthy();
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Xuất Excel" })).toBeEnabled();
});

test("bấm Xuất Excel hai lần khi request đang chờ chỉ phát một request", async () => {
  stubBlobDownload();
  let releaseExport: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    releaseExport = resolve;
  });
  mockResultsWithExport(() => new Response("xlsx-bytes", { status: 200 }));
  // Chặn response đầu tiên để nút còn ở trạng thái pending khi bấm lần hai.
  const originalFetch = fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (!url.includes("/export.xlsx")) return originalFetch(input, init);
      return pending.then(() => new Response("xlsx-bytes", { status: 200 }));
    }),
  );

  const button = await openResultsTab();
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  fireEvent.click(button);

  expect(calls.filter((call) => call.url.includes("/export.xlsx"))).toHaveLength(1);
  releaseExport();
  await waitFor(() =>
    expect(calls.filter((call) => call.url.includes("/export.xlsx"))).toHaveLength(1),
  );
});

test("tiêu đề tab theo tên cuộc thi, chuyển sang mô tả lỗi khi tải hỏng", async () => {
  mockApi((url) =>
    url.includes("/contents")
      ? { body: CONTENTS, status: 200 }
      : { body: COMPETITION, status: 200 },
  );
  const first = renderPage();
  await screen.findByRole("heading", { name: "Code Cup", level: 1 });
  // Effect ghi title chạy sau commit, nên phải chờ thay vì đọc ngay khi heading vừa xuất hiện.
  await waitFor(() => expect(document.title).toBe("Code Cup - AI Challenge"));
  first.unmount();

  mockApi(() => ({ body: { error: { code: "NOT_FOUND", message: "Không thấy cuộc thi." } }, status: 404 }));
  renderPage();
  expect(await screen.findByRole("heading", { level: 1, name: "Không thể tải cuộc thi" })).toBeTruthy();
  await waitFor(() => expect(document.title).toBe("Không thể tải cuộc thi - AI Challenge"));
});

/** File với dung lượng định sẵn để test precheck ở client mà không tạo buffer lớn. */
function fileOf(name: string, size: number, type = "text/markdown"): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

test("trần upload lấy từ backend: hint render giá trị runtime, không hardcode", async () => {
  mockApi((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (url.includes("/assets")) return { body: { assets: [] }, status: 200 };
    return { body: { ...COMPETITION, upload_limits: { submission_mb: 11, content_mb: 7, asset_mb: 9 } }, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");

  expect(screen.getByRole("button", { name: /Upload \.md/ }).textContent).toContain("≤ 7 MiB");

  fireEvent.click(screen.getByRole("tab", { name: "Hình ảnh" }));
  const uploadButton = await screen.findByRole("button", { name: /Upload ảnh/ });
  expect(uploadButton.textContent).toContain("9 MiB");
  expect(screen.getByText(/Tối đa 9 MiB \/ tệp/)).toBeTruthy();
});

test("backend cũ chưa trả upload_limits: rơi về mặc định thay vì ẩn hint", async () => {
  mockApi((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (url.includes("/assets")) return { body: { assets: [] }, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");

  expect(screen.getByRole("button", { name: /Upload \.md/ }).textContent).toContain("≤ 2 MiB");

  fireEvent.click(screen.getByRole("tab", { name: "Hình ảnh" }));
  expect(await screen.findByText(/Tối đa 2 MiB \/ tệp/)).toBeTruthy();
});

test("nút upload tách nhãn khỏi giới hạn dung lượng trong tên truy cập", async () => {
  mockApi((url) => (url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: COMPETITION, status: 200 }));
  renderPage();
  await screen.findByText("Đề bài");

  // Khoảng cách thị giác giữa nhãn và hint đến từ `gap` của flex, không phải từ
  // ký tự trắng - thiếu dấu cách thì trình đọc màn hình đọc liền "Upload .md≤ 2 MiB".
  expect(screen.getByRole("button", { name: "Upload .md ≤ 2 MiB" }).textContent).toBe("Upload .md ≤ 2 MiB");
});

test("Markdown vượt trần bị chặn ở client, không phát request upload", async () => {
  mockApi((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: { ...COMPETITION, upload_limits: { submission_mb: 11, content_mb: 2, asset_mb: 9 } }, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");

  const input = screen.getByLabelText('Upload file Markdown cho "Rules"') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fileOf("rules.md", 3 * 1024 * 1024)] } });

  expect(await screen.findByRole("alert")).toHaveTextContent("File vượt quá giới hạn 2 MiB.");
  expect(calls.some((call) => call.url.includes("/contents/c2/file"))).toBe(false);
});

test("ảnh asset vượt trần bị chặn ở client, không phát request upload", async () => {
  mockApi((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (url.includes("/assets")) return { body: { assets: [] }, status: 200 };
    return { body: { ...COMPETITION, upload_limits: { submission_mb: 10, content_mb: 2, asset_mb: 3 } }, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");
  fireEvent.click(screen.getByRole("tab", { name: "Hình ảnh" }));
  await screen.findByRole("button", { name: /Upload ảnh/ });

  const input = screen.getByLabelText("Chọn tệp ảnh") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fileOf("banner.png", 4 * 1024 * 1024, "image/png")] } });

  expect(await screen.findByRole("alert")).toHaveTextContent("File vượt quá giới hạn 3 MiB.");
  expect(calls.some((call) => call.url.endsWith("/assets") && call.init?.method === "POST")).toBe(false);
});

/** Dữ liệu tối thiểu để cả năm panel render đủ bảng, dùng cho test cấu trúc chung. */
function mockFullDetail() {
  mockApi((url) => {
    if (url.includes("/join-code")) return { body: { join_code_configured: true }, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (url.includes("/assets")) {
      return {
        body: {
          assets: [
            {
              name: "banner.png",
              content_type: "image/png",
              size_bytes: 204800,
              url: "/api/competitions/code-cup/assets/banner.png",
            },
          ],
        },
        status: 200,
      };
    }
    if (url.includes("/members")) return { body: MEMBERS, status: 200 };
    if (url.includes("/scoring")) return { body: SCORING, status: 200 };
    if (url.includes("/leaderboard")) {
      return {
        body: {
          competition_id: COMPETITION.id,
          primary_metric: "f1",
          total: 1,
          entries: [
            {
              rank: 1,
              account_id: "u1",
              display_name: "Thí Sinh",
              primary_score: 0.9,
              metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
              best_submission_id: "s1",
              best_submission_at: "2026-09-15T09:00:00Z",
              total_submissions: 2,
            },
          ],
        },
        status: 200,
      };
    }
    if (url.includes("/submissions")) {
      return {
        body: {
          submissions: [
            {
              id: "s1",
              competition_id: COMPETITION.id,
              status: "completed",
              metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
              primary_score: 0.9,
              created_at: "2026-09-15T09:00:00Z",
              artifacts: {
                prediction: { filename: "result.csv", size_bytes: 128, available: true },
                notebook: { filename: "solution.ipynb", size_bytes: 4096, available: true },
              },
              account: { id: "u1", name: "Thí Sinh", email: "thi.sinh@vku.vn" },
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        },
        status: 200,
      };
    }
    return { body: COMPETITION, status: 200 };
  });
}

test("header chi tiết: một h1 duy nhất, status có nhãn chữ và accent thuần trang trí", async () => {
  mockApi((url) => (url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: COMPETITION, status: 200 }));
  renderPage();
  await screen.findByText("Đề bài");

  const headings = screen.getAllByRole("heading", { level: 1 });
  expect(headings).toHaveLength(1);
  expect(headings[0]).toHaveTextContent("Code Cup");

  // Trạng thái không bao giờ chỉ dựa vào màu: badge luôn kèm nhãn chữ.
  const status = document.querySelector(".admin-detail-status") as HTMLElement;
  expect(status).toHaveTextContent("Đang diễn ra");
  expect(status.classList.contains("success")).toBe(true);

  const accent = document.querySelector(".admin-detail-page .vku-accent") as HTMLElement;
  expect(accent).toHaveAttribute("aria-hidden", "true");
});

test("header chi tiết: status closed dùng lớp xám chung, không phải lớp trạng thái chết", async () => {
  mockApi((url) =>
    url.includes("/contents")
      ? { body: CONTENTS, status: 200 }
      : { body: { ...COMPETITION, status: "closed" }, status: 200 },
  );
  renderPage();
  await screen.findByText("Đề bài");

  const status = document.querySelector(".admin-detail-status") as HTMLElement;
  expect(status).toHaveTextContent("Đã kết thúc");
  expect(status.classList.contains("closed")).toBe(true);
});

test("dải tóm tắt: đủ sáu field theo formatter hiện có, tone xoay theo vị trí render", async () => {
  mockApi((url) => (url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: COMPETITION, status: 200 }));
  const first = renderPage();
  await screen.findByText("Đề bài");

  const summary = screen.getByLabelText("Thông tin chung cuộc thi");
  expect(summary.tagName).toBe("SECTION");

  const facts = summaryFacts();
  expect(facts).toHaveLength(6);
  expect(facts.map((fact) => fact.querySelector("dt")!.textContent)).toEqual([
    "Slug",
    "Bắt đầu",
    "Kết thúc",
    "Tham gia",
    "Chỉ số chính",
    "Quota",
  ]);

  const values = facts.map((fact) => fact.querySelector("dd")!.textContent ?? "");
  expect(values[0]).toBe("code-cup");
  expect(values[1]).toContain("01/10/2026");
  expect(values[2]).toContain("01/11/2026");
  expect(values[3]).toBe("Cần mã tham gia");
  expect(values[4]).toBe("F1");
  expect(values[5]).toBe("5 lượt/ngày");

  // Tone suy từ vị trí render, không đọc status/join_mode/metric.
  const tones = facts.map((fact) => fact.getAttribute("data-tone"));
  expect(tones).toEqual(["blue", "red", "yellow", "blue", "red", "yellow"]);
  first.unmount();

  mockApi((url) =>
    url.includes("/contents")
      ? { body: CONTENTS, status: 200 }
      : {
          body: {
            ...COMPETITION,
            status: "closed",
            join_mode: "invite_only",
            primary_metric: "recall",
            quota_per_day: 9,
          },
          status: 200,
        },
  );
  renderPage();
  await screen.findByText("Đề bài");

  const after = summaryFacts();
  expect(after.map((fact) => fact.getAttribute("data-tone"))).toEqual(tones);
  // Giá trị đổi theo dữ liệu mới, chứng minh tone không bám nghiệp vụ.
  expect(after[3].querySelector("dd")).toHaveTextContent("Chỉ theo lời mời");
  expect(after[4].querySelector("dd")).toHaveTextContent("Recall");
  expect(after[5].querySelector("dd")).toHaveTextContent("9 lượt/ngày");
});

test("tab rail: icon decorative aria-hidden, accessible name vẫn đúng bằng nhãn chữ", async () => {
  await renderRail();

  const tabs = within(rail()).getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual(TAB_LABELS);

  for (const [index, tab] of tabs.entries()) {
    const icon = tab.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveAttribute("focusable", "false");
    // Nếu icon lọt vào accessible name thì truy vấn theo tên chính xác sẽ trượt.
    expect(within(rail()).getByRole("tab", { name: TAB_LABELS[index] })).toBe(tab);
  }
});

test("nhịp màu theo tab: mỗi panel dùng đúng chuỗi data-tone, không suy từ dữ liệu", async () => {
  await renderRail();

  expect(cardTones(screen.getByRole("tabpanel", { name: "Nội dung" }))).toEqual(["blue", "yellow"]);

  for (const [name, tones] of [
    ["Hình ảnh", ["blue", "yellow", "red"]],
    ["Tài nguyên", ["yellow"]],
    ["Chấm điểm", ["blue", "red", "yellow", "blue", "red"]],
    ["Kết quả", ["yellow", "blue"]],
    ["Thành viên", ["blue"]],
    ["Cài đặt", ["red", "blue", "yellow"]],
  ] as Array<[string, string[]]>) {
    fireEvent.click(railTab(name));
    const panel = await screen.findByRole("tabpanel", { name });
    expect(cardTones(panel)).toEqual(tones);
  }
});

test("tab Nội dung có heading khối mới và CTA mở đúng modal tạo trang", async () => {
  mockApi((url) => (url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: COMPETITION, status: 200 }));
  renderPage();
  await screen.findByText("Đề bài");

  expect(screen.getByRole("heading", { level: 2, name: "Quản lý nội dung" })).toBeTruthy();

  const cta = screen.getByRole("button", { name: "Thêm trang nội dung" });
  expect(cta).not.toBeDisabled();
  fireEvent.click(cta);
  expect(screen.getByRole("dialog", { name: "Thêm trang nội dung" })).toBeTruthy();
});

test("modal thêm trang nội dung tự điền slug theo tiêu đề", async () => {
  mockApi((url) => (url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: COMPETITION, status: 200 }));
  renderPage();
  await screen.findByText("Đề bài");

  fireEvent.click(screen.getByRole("button", { name: "Thêm trang nội dung" }));
  const dialog = screen.getByRole("dialog", { name: "Thêm trang nội dung" });

  fireEvent.change(within(dialog).getByLabelText("Tiêu đề"), {
    target: { value: "Đề bài vòng 2" },
  });
  expect(within(dialog).getByLabelText("Slug")).toHaveValue("de-bai-vong-2");
});

test("sửa trang nội dung: slug cũ bị thay khi tiêu đề đổi", async () => {
  mockApi((url) => (url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: COMPETITION, status: 200 }));
  renderPage();
  await screen.findByText("Đề bài");

  const row = Array.from(document.querySelectorAll("tbody tr")).find((tr) =>
    tr.textContent?.includes("problem"),
  ) as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Sửa" }));

  const dialog = screen.getByRole("dialog", { name: /Sửa nội dung/ });
  const slug = within(dialog).getByLabelText(/^Slug/) as HTMLInputElement;
  expect(slug).toHaveValue("problem");

  fireEvent.change(within(dialog).getByLabelText("Tiêu đề"), {
    target: { value: "Đề bài vòng 2" },
  });
  expect(slug).toHaveValue("de-bai-vong-2");
});

test("cột Thứ tự đọc theo vị trí 1..n thay vì giá trị order thô của API", async () => {
  // Fixture giữ order 10/20 đúng như dữ liệu backend đang trả về.
  mockApi((url) => (url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: COMPETITION, status: 200 }));
  renderPage();
  await screen.findByText("Đề bài");

  const numbers = Array.from(document.querySelectorAll(".order-num")).map((el) => el.textContent);
  expect(numbers).toEqual(["1", "2"]);
});

test("khối hướng dẫn dưới Quản lý nội dung liệt kê năm phần nội dung thường có", async () => {
  mockApi((url) => (url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: COMPETITION, status: 200 }));
  renderPage();
  await screen.findByText("Đề bài");

  const heading = screen.getByRole("heading", { level: 2, name: "Các phần nội dung thường có" });
  const card = heading.closest(".admin-detail-card") as HTMLElement;
  expect(card.getAttribute("data-tone")).toBe("yellow");

  const names = within(card)
    .getAllByRole("listitem")
    .map((item) => item.querySelector("strong")?.textContent);
  expect(names).toEqual([
    "Thể lệ",
    "Lịch trình",
    "Dataset / Tài nguyên",
    "Giải thưởng / Kết quả",
    "Ban Tổ chức & Liên hệ",
  ]);
});

/** Nội dung chi tiết chỉ có ở GET từng trang; list không trả `markdown`. */
const C1_MARKDOWN = "# Đề bài\n\nDòng cuối";

/** Mở dialog Sửa MD của row chứa tiêu đề và trả về dialog để thao tác tiếp. */
function openMarkdownEditor(title: string): HTMLElement {
  const row = Array.from(document.querySelectorAll("tbody tr")).find((tr) =>
    tr.textContent?.includes(title),
  ) as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Sửa MD" }));
  return screen.getByRole("dialog", { name: `Sửa Markdown - ${title}` });
}

test("nút Sửa MD hiện ở mọi row, kể cả trang chưa có file", async () => {
  mockApi((url) => (url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: COMPETITION, status: 200 }));
  renderPage();
  await screen.findByText("Đề bài");

  for (const title of ["Đề bài", "Rules"]) {
    const row = Array.from(document.querySelectorAll("tbody tr")).find((tr) =>
      tr.textContent?.includes(title),
    ) as HTMLElement;
    expect(within(row).getByRole("button", { name: "Sửa MD" })).toBeTruthy();
  }
});

test("Sửa MD trang có file: tải nội dung qua GET chi tiết, gutter đánh số theo dòng", async () => {
  mockApi((url) => {
    if (url.endsWith("/contents/c1")) return { body: { ...CONTENTS.contents[0], markdown: C1_MARKDOWN }, status: 200 };
    if (url.endsWith("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");

  const dialog = openMarkdownEditor("Đề bài");
  const textarea = await within(dialog).findByLabelText("Nội dung Markdown");
  expect(textarea).toHaveValue(C1_MARKDOWN);

  const gutter = dialog.querySelector(".md-editor-gutter") as HTMLElement;
  expect(gutter.getAttribute("aria-hidden")).toBe("true");
  // Ba dòng, tính cả dòng trống, thành ba số liền mạch.
  expect(gutter.textContent).toBe("1\n2\n3");

  // Dòng dài tự xuống hàng (không còn wrap="off"); mirror đo wrap có một khối mỗi dòng
  // logic và ẩn khỏi trình đọc màn hình.
  expect(textarea.getAttribute("wrap")).toBeNull();
  const mirror = dialog.querySelector(".md-editor-mirror") as HTMLElement;
  expect(mirror.getAttribute("aria-hidden")).toBe("true");
  expect(mirror.querySelectorAll("div")).toHaveLength(3);
});

test("Sửa MD: dòng trống cuối sau newline vẫn có số riêng trong gutter", async () => {
  mockApi((url) => {
    if (url.endsWith("/contents/c1")) return { body: { ...CONTENTS.contents[0], markdown: C1_MARKDOWN }, status: 200 };
    if (url.endsWith("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");

  const dialog = openMarkdownEditor("Đề bài");
  const textarea = await within(dialog).findByLabelText("Nội dung Markdown");
  fireEvent.change(textarea, { target: { value: "a\n\nb\n" } });

  // jsdom không layout nên mỗi dòng logic rơi về đúng một dòng thị giác; điều cần chốt ở
  // đây là dòng trống cuối vẫn được tính, mirror và gutter không cắt mất nó.
  const mirror = dialog.querySelector(".md-editor-mirror") as HTMLElement;
  expect(mirror.querySelectorAll("div")).toHaveLength(4);
  const gutter = dialog.querySelector(".md-editor-gutter") as HTMLElement;
  expect(gutter.textContent).toBe("1\n2\n3\n4");
});

test("Sửa MD trang chưa có file: editor trống, lưu tạo file .md qua đúng endpoint upload", async () => {
  mockApi((url, init) => {
    if (url.endsWith("/contents/c2/file") && init?.method === "PUT") return { body: CONTENTS.contents[1], status: 200 };
    if (url.endsWith("/contents/c2")) return { body: CONTENTS.contents[1], status: 200 };
    if (url.endsWith("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  await screen.findByText("Rules");

  const dialog = openMarkdownEditor("Rules");
  const textarea = await within(dialog).findByLabelText("Nội dung Markdown");
  expect(textarea).toHaveValue("");
  // Backend từ chối file rỗng nên client chặn trước bằng nút khóa.
  expect(within(dialog).getByRole("button", { name: "Lưu" })).toBeDisabled();

  fireEvent.change(textarea, { target: { value: "# Thể lệ\n\nNội dung mới" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Lưu" }));

  expect(await screen.findByText('Đã lưu Markdown cho "Rules".')).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: /Sửa Markdown/ })).toBeNull();

  const put = calls.find((call) => call.url.endsWith("/contents/c2/file"));
  expect(put?.init?.method).toBe("PUT");
  const body = put?.init?.body as FormData;
  const file = body.get("file") as File;
  expect(file.name).toBe("rules.md");
  expect(file.type).toBe("text/markdown");
  expect(await file.text()).toBe("# Thể lệ\n\nNội dung mới");
  // Danh sách được tải lại để badge "Chưa có file" chuyển trạng thái.
  expect(calls.filter((call) => call.url.endsWith("/contents")).length).toBeGreaterThan(1);
});

test("Sửa MD: nội dung rỗng hoặc chỉ khoảng trắng không lưu được", async () => {
  mockApi((url) => {
    if (url.endsWith("/contents/c1")) return { body: { ...CONTENTS.contents[0], markdown: C1_MARKDOWN }, status: 200 };
    if (url.endsWith("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");

  const dialog = openMarkdownEditor("Đề bài");
  const textarea = await within(dialog).findByLabelText("Nội dung Markdown");
  fireEvent.change(textarea, { target: { value: "   " } });

  expect(within(dialog).getByRole("button", { name: "Lưu" })).toBeDisabled();
  expect(calls.some((call) => call.url.endsWith("/file"))).toBe(false);
});

test("Sửa MD: nội dung vượt trần bị chặn ở client, không phát request", async () => {
  mockApi((url) => {
    if (url.endsWith("/contents/c1")) return { body: { ...CONTENTS.contents[0], markdown: "# Đề" }, status: 200 };
    if (url.endsWith("/contents")) return { body: CONTENTS, status: 200 };
    return { body: { ...COMPETITION, upload_limits: { submission_mb: 11, content_mb: 1, asset_mb: 9 } }, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");

  const dialog = openMarkdownEditor("Đề bài");
  const textarea = await within(dialog).findByLabelText("Nội dung Markdown");
  fireEvent.change(textarea, { target: { value: "x".repeat(1024 * 1024 + 1) } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Lưu" }));

  expect(await within(dialog).findByRole("alert")).toHaveTextContent("File vượt quá giới hạn 1 MiB.");
  expect(calls.some((call) => call.url.endsWith("/file"))).toBe(false);
});

test("Sửa MD: lỗi tải nội dung hiện lỗi và Thử lại tải được", async () => {
  let detailFails = true;
  mockApi((url) => {
    if (url.endsWith("/contents/c1")) {
      if (detailFails) {
        return { body: { error: { code: "CONTENT_FILE_MISSING", message: "File Markdown không tồn tại." } }, status: 404 };
      }
      return { body: { ...CONTENTS.contents[0], markdown: "# Đề bài" }, status: 200 };
    }
    if (url.endsWith("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");

  const dialog = openMarkdownEditor("Đề bài");
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("File Markdown không tồn tại.");

  detailFails = false;
  fireEvent.click(within(dialog).getByRole("button", { name: "Thử lại" }));

  expect(await within(dialog).findByLabelText("Nội dung Markdown")).toHaveValue("# Đề bài");
});

test("Sửa MD: lỗi khi lưu giữ nguyên nội dung để thử lại", async () => {
  mockApi((url, init) => {
    if (url.endsWith("/contents/c1/file") && init?.method === "PUT") {
      return { body: { error: { code: "FILE_WRITE_FAILED", message: "Không thể lưu file Markdown." } }, status: 500 };
    }
    if (url.endsWith("/contents/c1")) return { body: { ...CONTENTS.contents[0], markdown: C1_MARKDOWN }, status: 200 };
    if (url.endsWith("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");

  const dialog = openMarkdownEditor("Đề bài");
  const textarea = await within(dialog).findByLabelText("Nội dung Markdown");
  fireEvent.change(textarea, { target: { value: "# Bản sửa" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Lưu" }));

  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Không thể lưu file Markdown.");
  expect(textarea).toHaveValue("# Bản sửa");
  expect(within(dialog).getByRole("button", { name: "Lưu" })).not.toBeDisabled();
});

test("Sửa MD: gutter cuộn dọc theo textarea", async () => {
  mockApi((url) => {
    if (url.endsWith("/contents/c1")) return { body: { ...CONTENTS.contents[0], markdown: C1_MARKDOWN }, status: 200 };
    if (url.endsWith("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");

  const dialog = openMarkdownEditor("Đề bài");
  const textarea = await within(dialog).findByLabelText("Nội dung Markdown");
  const gutter = dialog.querySelector(".md-editor-gutter") as HTMLElement;

  fireEvent.scroll(textarea, { target: { scrollTop: 140 } });
  expect(gutter.scrollTop).toBe(140);
});

test("Sửa MD: đóng khi có thay đổi chưa lưu hỏi trước khi bỏ", async () => {
  mockApi((url) => {
    if (url.endsWith("/contents/c1")) return { body: { ...CONTENTS.contents[0], markdown: C1_MARKDOWN }, status: 200 };
    if (url.endsWith("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  await screen.findByText("Đề bài");

  // Chưa sửa gì thì đóng thẳng, không hỏi.
  const dialog = openMarkdownEditor("Đề bài");
  await within(dialog).findByLabelText("Nội dung Markdown");
  fireEvent.click(within(dialog).getByRole("button", { name: "Đóng" }));
  expect(screen.queryByRole("dialog", { name: /Sửa Markdown/ })).toBeNull();

  const dirtyDialog = openMarkdownEditor("Đề bài");
  const textarea = await within(dirtyDialog).findByLabelText("Nội dung Markdown");
  fireEvent.change(textarea, { target: { value: "# Đang sửa" } });

  // Escape cũng phải hỏi thay vì đóng im lặng bỏ mất phần đang gõ.
  fireEvent.keyDown(document, { key: "Escape" });
  expect(within(dirtyDialog).getByRole("alert")).toHaveTextContent(
    "Thay đổi chưa lưu sẽ bị bỏ nếu bạn đóng bây giờ.",
  );

  // Tiếp tục sửa: quay lại form, nội dung còn nguyên.
  fireEvent.click(within(dirtyDialog).getByRole("button", { name: "Tiếp tục sửa" }));
  expect(within(dirtyDialog).getByLabelText("Nội dung Markdown")).toHaveValue("# Đang sửa");

  fireEvent.click(within(dirtyDialog).getByRole("button", { name: "Đóng" }));
  fireEvent.click(within(dirtyDialog).getByRole("button", { name: "Bỏ thay đổi" }));
  expect(screen.queryByRole("dialog", { name: /Sửa Markdown/ })).toBeNull();
});

test("Sửa MD: đang lưu thì không đóng được dialog", async () => {
  calls.length = 0;
  let resolvePut!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/contents/c1/file")) {
        return new Promise<Response>((resolve) => {
          resolvePut = resolve;
        });
      }
      const body = url.endsWith("/contents/c1")
        ? { ...CONTENTS.contents[0], markdown: C1_MARKDOWN }
        : url.endsWith("/contents")
          ? CONTENTS
          : COMPETITION;
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    }),
  );
  renderPage();
  await screen.findByText("Đề bài");

  const dialog = openMarkdownEditor("Đề bài");
  const textarea = await within(dialog).findByLabelText("Nội dung Markdown");
  fireEvent.change(textarea, { target: { value: "# Đang lưu" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Lưu" }));

  expect(await within(dialog).findByRole("button", { name: "Đang lưu..." })).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Hủy" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Đóng" }));
  expect(screen.getByRole("dialog", { name: /Sửa Markdown/ })).toBeTruthy();

  resolvePut(new Response(JSON.stringify(CONTENTS.contents[0]), { status: 200, headers: { "Content-Type": "application/json" } }));
  expect(await screen.findByText('Đã lưu Markdown cho "Đề bài".')).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: /Sửa Markdown/ })).toBeNull();
});

test("năm bảng vẫn là vùng focus được và giữ nguyên accessible name", async () => {
  mockFullDetail();
  renderPage();
  await screen.findByText("Đề bài");

  async function expectRegion(name: string) {
    const region = await screen.findByRole("region", { name });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getByRole("table")).toBeTruthy();
  }

  await expectRegion("Bảng nội dung cuộc thi");

  fireEvent.click(railTab("Hình ảnh"));
  await expectRegion("Bảng tài nguyên cuộc thi");

  // Chấm điểm: bảng khai báo cột và metric không phải vùng focus (chỉ form cấu hình).
  fireEvent.click(railTab("Chấm điểm"));
  const scoringPanel = await screen.findByRole("tabpanel", { name: "Chấm điểm" });
  expect(within(scoringPanel).queryByRole("region")).toBeNull();

  fireEvent.click(railTab("Kết quả"));
  await expectRegion("Bảng xếp hạng của cuộc thi");
  // Danh sách bài nộp không còn là bảng cuộn ngang: region bọc một list các thẻ, không tab stop.
  const submissions = await screen.findByRole("region", {
    name: "Danh sách bài nộp của cuộc thi",
  });
  expect(submissions).not.toHaveAttribute("tabindex");
  expect(within(submissions).getByRole("listitem")).toBeTruthy();

  fireEvent.click(railTab("Thành viên"));
  await expectRegion("Bảng thành viên cuộc thi");
});

test("Định dạng dữ liệu chỉ phản ánh cấu hình backend đang lưu", async () => {
  mockApi((url) => {
    if (url.endsWith("/scoring")) return { body: SCORING, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  const first = renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  await screen.findByLabelText("Ground truth: cột 1: tên");

  // Đã có bộ chấm Python: không còn cảnh báo sklearn, cột khai báo được điền từ backend.
  expect(screen.queryByText(/bộ chấm sklearn cố định/)).toBeNull();
  expect(screen.getByLabelText("Ground truth: cột 2: tên")).toHaveProperty("value", "label");
  expect(screen.getByLabelText("Submission: cột 2: tên")).toHaveProperty("value", "predict_label");
  first.unmount();

  // Cuộc thi còn chấm bằng sklearn: cảnh báo và dòng cấu hình cũ nằm trong chính card đó.
  mockApi((url) => {
    if (url.endsWith("/scoring")) return { body: V1_SCORING, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  const second = renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  const v1Card = (await screen.findByText(/bộ chấm sklearn cố định/)).closest(
    "section",
  ) as HTMLElement;
  expect(within(v1Card).getByText("Cấu hình sklearn đang áp dụng")).toBeTruthy();
  expect(within(v1Card).getByText("prediction")).toBeTruthy();
  expect(within(v1Card).getByText("binary")).toBeTruthy();
  second.unmount();

  // Chưa lưu định dạng: chọn trước được ground truth (chờ lượt lưu), chạy thử vẫn phải chờ schema.
  mockApi((url) => {
    if (url.endsWith("/scoring")) {
      return { body: { ...SCORING, ready: false, scoring: null, config: null, ground_truth: null }, status: 200 };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  expect(
    await screen.findByText(
      "Chưa lưu cấu hình — tệp chọn trước được tải lên và kiểm tra ngay sau khi lưu.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Lưu cấu hình trước khi chạy thử.")).toBeTruthy();
  expect(screen.getByText("Chạy thử bộ chấm để nhận diện các khóa metric.")).toBeTruthy();
  expect((screen.getByLabelText("Upload ground truth CSV") as HTMLInputElement).disabled).toBe(false);
});

test("đã lưu định dạng nhưng chưa có source: nút chạy thử khóa kèm nhắc lưu source", async () => {
  await openScoring({
    ...SCORING,
    ready: false,
    not_ready_reason: {
      code: "SCORING_CONFIG_INVALID",
      message: "Bộ chấm cần có tên để hiển thị và đối chiếu.",
    },
    scoring: {
      ...SCORING.scoring,
      evaluator: { name: "", source_sha256: null, runtime_id: null, source_code: "" },
      output_contract: null,
      verified: false,
      verification: null,
    },
    primary_metric: null,
  });

  expect(screen.getByText("Lưu source bộ chấm trước khi chạy thử.")).toBeTruthy();
  expect(screen.getByLabelText("Chọn CSV mẫu để chạy thử")).toBeDisabled();
  // Chưa có source thì chưa có gì để chạy: bảng "khóa metric đã chạy" ẩn theo.
  expect(screen.queryByText("Khóa metric đã chạy")).toBeNull();
  // Bản nháp vẫn đọc đúng chỗ còn thiếu trên card trạng thái.
  expect(screen.getByText("Bộ chấm cần có tên để hiển thị và đối chiếu.")).toBeTruthy();
});

test("chạy thử gửi expected_revision và mở bảng metric từ khóa thật", async () => {
  const TESTED = {
    ...SCORING,
    scoring: {
      ...SCORING.scoring,
      // Chưa khai báo metric: bảng metric phải do kết quả chạy thử sinh ra.
      output_contract: null,
      verified: false,
      verification: null,
    },
    primary_metric: null,
  };
  mockApi((url) => {
    if (url.endsWith("/scoring/test")) {
      return {
        body: {
          ...TESTED,
          // Lượt chạy thử vừa rồi là bằng chứng đang hiệu lực: chưa có hợp đồng metric nên không
          // có gì để lệch fingerprint.
          scoring: {
            ...TESTED.scoring,
            verified: true,
            verification: {
              tested_at: "2026-09-15T00:00:00Z",
              tested_by: "admin@vku.vn",
              observed_keys: ["f1", "precision"],
            },
          },
          test: { observed_keys: ["f1", "precision"], metrics: { f1: 0.5, precision: 0.25 }, duration_ms: 120 },
        },
        status: 200,
      };
    }
    if (url.endsWith("/scoring")) return { body: TESTED, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));

  const input = await screen.findByLabelText("Chọn CSV mẫu để chạy thử");
  fireEvent.change(input, { target: { files: [new File(["id,f1"], "sample.csv", { type: "text/csv" })] } });

  expect(await screen.findByText("Khóa metric đã chạy")).toBeTruthy();
  expect(screen.getByText("f1, precision")).toBeTruthy();
  // Giá trị hiển thị theo số thập phân mặc định vì chưa có hợp đồng metric.
  expect(screen.getByText("f1 = 0.5000 · precision = 0.2500")).toBeTruthy();
  expect(screen.getByText("120 ms")).toBeTruthy();
  // Khóa mới vào bảng với tên hiển thị mặc định là chính khóa, admin tự đổi.
  expect(screen.getByLabelText("Tên hiển thị của precision")).toHaveProperty("value", "precision");
  // Khóa mới mặc định cho thí sinh thấy; admin bỏ tích nếu muốn ẩn.
  expect(screen.getByLabelText("Cho thí sinh thấy precision")).toHaveProperty("checked", true);

  const call = calls.find((item) => item.url.endsWith("/scoring/test"));
  expect(call?.init?.method).toBe("POST");
  const body = call?.init?.body as FormData;
  expect(body.get("expected_revision")).toBe("3");
  expect((body.get("file") as File).name).toBe("sample.csv");
});

test("chạy thử: dải đang chạy hiện trong lúc chờ và nút khóa cho tới khi xong", async () => {
  calls.length = 0;
  let resolveTest!: (response: Response) => void;
  // Lượt chạy thử mất hàng chục giây ở thật: giữ request treo để quan sát trạng thái đang chạy.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/scoring/test")) {
        return new Promise<Response>((resolve) => {
          resolveTest = resolve;
        });
      }
      const body = url.endsWith("/scoring")
        ? SCORING
        : url.includes("/contents")
          ? CONTENTS
          : COMPETITION;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  fireEvent.change(await screen.findByLabelText("Chọn CSV mẫu để chạy thử"), {
    target: { files: [new File(["id,f1\n1,0.5"], "sample.csv", { type: "text/csv" })] },
  });

  expect(await screen.findByText("Đang chạy thử bộ chấm…")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Đang chạy thử…" })).toBeDisabled();
  expect(screen.getByLabelText("Chọn CSV mẫu để chạy thử")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Lưu cấu hình chấm điểm" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Lưu" })).toBeDisabled();

  resolveTest(
    new Response(
      JSON.stringify({
        ...SCORING,
        test: { observed_keys: ["f1"], metrics: { f1: 0.5 }, duration_ms: 90 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  expect(await screen.findByText("Đã chạy thử bộ chấm.")).toBeTruthy();
  expect(screen.queryByText("Đang chạy thử bộ chấm…")).toBeNull();
});

test("lượt chạy thử lỗi hiện ngay trong khối phản hồi ghim", async () => {
  mockApi((url) => {
    if (url.endsWith("/scoring/test")) {
      return {
        body: { error: { code: "EVALUATOR_TIMEOUT", message: "Bộ chấm chạy quá thời gian cho phép." } },
        status: 422,
      };
    }
    if (url.endsWith("/scoring")) return { body: SCORING, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  fireEvent.change(await screen.findByLabelText("Chọn CSV mẫu để chạy thử"), {
    target: { files: [new File(["id,f1\n1,0.5"], "sample.csv", { type: "text/csv" })] },
  });

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Bộ chấm chạy quá thời gian cho phép.");
  expect(alert.closest(".scoring-feedback")).toBeTruthy();
});

/** Sáu mục checklist publish, kèm id vùng đích mà mỗi mục phải dẫn tới. */
const CHECKLIST_LINKS: Array<[string, string]> = [
  ["Định dạng dữ liệu đã lưu", "scoring-section-schema"],
  ["Ground truth hợp lệ", "scoring-section-ground-truth"],
  ["Đã lưu source bộ chấm", "scoring-section-evaluator"],
  ["Đã khai báo metric", "scoring-section-metrics"],
  ["Đã chạy thử và khớp cấu hình hiện tại", "scoring-section-test"],
  ["Đã chọn chỉ số chính", "scoring-section-metrics"],
];

/** Mở tab Chấm điểm và chờ bảng schema render xong; mặc định dùng SCORING đầy đủ. */
async function openScoring(scoring: unknown = SCORING) {
  mockApi((url) => {
    if (url.endsWith("/scoring")) return { body: scoring, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  await screen.findByLabelText("Ground truth: cột 1: tên");
}

test("chưa giới hạn metric thì cột Thí sinh thấy tích hết", async () => {
  await openScoring();

  for (const key of ["f1", "precision", "recall"]) {
    expect(screen.getByLabelText(`Cho thí sinh thấy ${key}`)).toHaveProperty("checked", true);
  }
});

test("hợp đồng có whitelist thì cột Thí sinh thấy chỉ tích đúng khóa được phép", async () => {
  await openScoring({
    ...SCORING,
    scoring: {
      ...SCORING.scoring,
      output_contract: { ...SCORING.scoring.output_contract, visible_metrics: ["f1"] },
    },
  });

  expect(screen.getByLabelText("Cho thí sinh thấy f1")).toHaveProperty("checked", true);
  expect(screen.getByLabelText("Cho thí sinh thấy precision")).toHaveProperty("checked", false);
  expect(screen.getByLabelText("Cho thí sinh thấy recall")).toHaveProperty("checked", false);
});

test("ẩn chỉ số chính thì bảng metric nhắc thí sinh không thấy điểm nhưng vẫn xếp hạng", async () => {
  await openScoring({
    ...SCORING,
    scoring: {
      ...SCORING.scoring,
      output_contract: { ...SCORING.scoring.output_contract, visible_metrics: ["precision"] },
    },
  });

  expect(screen.getByText(/Chỉ số chính đang bị ẩn/)).toBeTruthy();
});

test("bỏ tích một metric thì lượt lưu gửi whitelist chỉ gồm các khóa còn tích", async () => {
  mockApi((url, init) => {
    if (url.endsWith("/scoring") && init?.method === "PUT") return { body: SCORING, status: 200 };
    if (url.endsWith("/scoring")) return { body: SCORING, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));

  fireEvent.click(await screen.findByLabelText("Cho thí sinh thấy recall"));
  fireEvent.submit(screen.getByRole("button", { name: "Lưu cấu hình chấm điểm" }).closest("form")!);

  // Phản hồi thành công nằm trong khối ghim để nút lưu ở cuối trang vẫn thấy được.
  // Bám vào câu chữ của banner thành công, không phải role chung: dải "đang lưu" cũng là
  // role=status và biến mất sau khi lưu xong, phần tử bắt được sẽ là nút rời rạc.
  const success = await screen.findByText("Đã lưu cấu hình chấm điểm.");
  expect(success.closest(".scoring-feedback")).toBeTruthy();
  await waitFor(() => {
    const put = calls.find((call) => call.url.endsWith("/scoring") && call.init?.method === "PUT");
    expect(put).toBeTruthy();
    expect(JSON.parse(put!.init!.body as string).output_contract.visible_metrics).toEqual([
      "f1",
      "precision",
    ]);
  });
});

test("lưu cấu hình làm lượt chạy thử hết hiệu lực: banner nói rõ phải chạy lại", async () => {
  mockApi((url, init) => {
    if (url.endsWith("/scoring") && init?.method === "PUT") {
      // Khai báo metric sau lượt chạy thử: hợp đồng đổi nên bằng chứng cũ hết hiệu lực.
      return {
        body: { ...SCORING, ready: false, scoring: { ...SCORING.scoring, verified: false } },
        status: 200,
      };
    }
    if (url.endsWith("/scoring")) return { body: SCORING, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  fireEvent.submit(
    (await screen.findByRole("button", { name: "Lưu cấu hình chấm điểm" })).closest("form")!,
  );

  // Lượt chạy thử cũ vẫn còn số liệu trên màn hình, nên phải nói thẳng nó vừa mất hiệu lực
  // ngay tại lượt lưu thay vì để admin tự phát hiện qua badge Chưa đạt.
  expect(
    await screen.findByText(
      "Đã lưu cấu hình chấm điểm. Lượt chạy thử trước đã hết hiệu lực vì cấu hình vừa đổi; chạy thử lại trước khi publish.",
    ),
  ).toBeTruthy();
  // Checklist chỉ còn đúng mục chạy thử là chưa đạt; lý do nằm ở dòng hiệu lực trong card chạy thử.
  expect(screen.getAllByText("Chưa đạt")).toHaveLength(1);
  expect(
    screen.getByText(
      "Lượt chạy thử đã cũ vì cấu hình (schema, source, ground truth hoặc tập khóa metric) đã đổi sau đó; chạy thử lại trước khi publish.",
    ),
  ).toBeTruthy();
});

test("lưu thất bại thì lỗi backend hiện trong khối phản hồi của tab", async () => {
  mockApi((url, init) => {
    if (url.endsWith("/scoring") && init?.method === "PUT") {
      return {
        body: {
          error: {
            code: "EVALUATOR_INVALID",
            message: "Source phải định nghĩa hàm evaluate ở cấp cao nhất.",
          },
        },
        status: 422,
      };
    }
    if (url.endsWith("/scoring")) return { body: SCORING, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  fireEvent.submit(
    (await screen.findByRole("button", { name: "Lưu cấu hình chấm điểm" })).closest("form")!,
  );

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Source phải định nghĩa hàm evaluate ở cấp cao nhất.");
  expect(alert.closest(".scoring-feedback")).toBeTruthy();
});

test("checklist sẵn sàng publish đứng đầu tab và mỗi mục dẫn tới vùng cần xử lý", async () => {
  await openScoring();

  const panel = screen.getByRole("tabpanel", { name: "Chấm điểm" });
  const firstCard = panel.querySelector(".admin-detail-card") as HTMLElement;
  expect(within(firstCard).getByText("Trạng thái sẵn sàng publish")).toBeTruthy();
  // Checklist đọc trạng thái đã lưu: sửa trong form mà chưa bấm Lưu thì các mục vẫn "Chưa đạt".
  expect(within(firstCard).getByText(/thay đổi chưa lưu không được tính/)).toBeTruthy();

  expect(within(firstCard).getAllByRole("link")).toHaveLength(CHECKLIST_LINKS.length);
  for (const [label, target] of CHECKLIST_LINKS) {
    expect(within(firstCard).getByRole("link", { name: label })).toHaveAttribute("href", `#${target}`);
    const anchorTarget = document.getElementById(target) as HTMLElement;
    expect(anchorTarget).toBeTruthy();
    expect(anchorTarget).toHaveAttribute("tabindex", "-1");
  }
});

test("kích hoạt mục checklist chuyển focus vào vùng đích", async () => {
  await openScoring();

  for (const [label, target] of CHECKLIST_LINKS) {
    fireEvent.click(screen.getByRole("link", { name: label }));
    expect(document.getElementById(target)).toHaveFocus();
  }
});

test("hai bảng schema có heading riêng (kèm icon) và hướng dẫn giá trị hợp lệ gắn với ô nhập", async () => {
  await openScoring();

  // Heading đứng trên bảng, còn mô tả chữ nhỏ nằm cùng hàng bên phải.
  const gtHeading = screen.getByRole("heading", { level: 3, name: "Ground truth" });
  const subHeading = screen.getByRole("heading", { level: 3, name: "Submission" });
  expect(
    within(subHeading.closest(".scoring-file-heading") as HTMLElement).getByText(
      /source Python quyết định/,
    ),
  ).toBeTruthy();
  expect(gtHeading.closest(".scoring-file-heading")).toBeTruthy();
  // Badge icon giúp phân biệt ngay đang khai báo cho tệp nào.
  const gtIcon = gtHeading.closest(".scoring-file-ident")?.querySelector(".scoring-file-icon");
  const subIcon = subHeading.closest(".scoring-file-ident")?.querySelector(".scoring-file-icon");
  expect(gtIcon?.querySelector("svg")).toBeTruthy();
  expect(gtIcon?.classList.contains("scoring-file-icon-yellow")).toBe(true);
  expect(subIcon?.querySelector("svg")).toBeTruthy();
  expect(subIcon?.classList.contains("scoring-file-icon-yellow")).toBe(false);
  // Bảng gắn tên với heading của chính nó để trình đọc màn hình phân biệt hai bảng.
  expect(document.querySelector("table[aria-labelledby='scoring-title-gt']")).toBeTruthy();
  expect(document.querySelector("table[aria-labelledby='scoring-title-sub']")).toBeTruthy();

  // Ô giá trị hợp lệ trỏ tới hướng dẫn mô tả đúng ý nghĩa "bỏ trống = không giới hạn".
  const hint = document.getElementById("scoring-allowed-gt");
  expect(hint?.textContent).toContain("không giới hạn");
  const gtAllowed = screen.getByLabelText("Ground truth: cột 1: giá trị hợp lệ");
  expect(gtAllowed).toHaveAttribute("aria-describedby", "scoring-allowed-gt");
  expect(gtAllowed).toHaveAttribute("placeholder", "ví dụ: 0, 1");
  expect(screen.getByLabelText("Submission: cột 1: giá trị hợp lệ")).toHaveAttribute(
    "aria-describedby",
    "scoring-allowed-sub",
  );
});

test("nút thêm cột nằm ở hàng cuối bảng, thêm dòng và không gửi lượt lưu", async () => {
  await openScoring();

  const addButton = screen.getByRole("button", { name: "Ground truth: thêm cột" });
  // Nút nằm trong hàng cuối (tfoot) của bảng schema, không chiếm hàng riêng bên ngoài.
  expect(addButton.closest("tfoot")).toBeTruthy();
  expect(addButton.closest("table")).toBeTruthy();
  expect(addButton.querySelector("svg")).toBeTruthy();
  fireEvent.click(addButton);

  const newName = await screen.findByLabelText("Ground truth: cột 3: tên");
  expect(newName).toHaveProperty("value", "");
  // Dòng mới nằm trong bảng của chính editor đó.
  const editor = addButton.closest(".form-field") as HTMLElement;
  expect(editor.querySelector("table")?.contains(newName)).toBe(true);
  // Trong form: bấm chỉ thêm dòng trống, không kích hoạt submit/PUT.
  expect(calls.some((call) => call.init?.method === "PUT")).toBe(false);
});

test("khi cấu hình bị khóa, nút thêm cột bị vô hiệu nhưng checklist vẫn điều hướng", async () => {
  await openScoring({ ...SCORING, locked: true });

  expect(screen.getByRole("button", { name: "Submission: thêm cột" })).toBeDisabled();

  fireEvent.click(screen.getByRole("link", { name: "Đã khai báo metric" }));
  expect(document.getElementById("scoring-section-metrics")).toHaveFocus();
});

test("nút upload ground truth và nút chạy thử nằm cùng hàng tiêu đề thay vì hàng riêng", async () => {
  await openScoring();

  // Hai nút file ẩn nằm chung khối head với tiêu đề thẻ / nhãn khối.
  expect(
    screen.getByLabelText("Upload ground truth CSV").closest(".admin-detail-card-head"),
  ).toBeTruthy();
  expect(
    screen.getByLabelText("Chọn CSV mẫu để chạy thử").closest(".scoring-test-head"),
  ).toBeTruthy();
});

/** Nội dung tệp .py mẫu trong public/, đọc bằng glob gốc như designSystemGuard (không theo cwd). */
const SAMPLE_EVALUATOR = Object.values(
  import.meta.glob<string>("/public/*.py", { query: "?raw", import: "default", eager: true }),
)[0];

test("tệp .py mẫu tải được và đúng hợp đồng bộ chấm", async () => {
  await openScoring();

  const link = screen.getByRole("link", { name: "Tải tệp .py mẫu" });
  expect(link).toHaveAttribute("href", "/evaluator-mau.py");
  expect(link).toHaveAttribute("download", "evaluator-mau.py");

  // Link trỏ vào tệp tĩnh trong public/: thiếu tệp là link chết mà UI vẫn hiện.
  expect(SAMPLE_EVALUATOR).toContain("def evaluate(ground_truth_path, submission_path)");
  expect(SAMPLE_EVALUATOR).toContain("import pandas as pd");
  expect(SAMPLE_EVALUATOR).toContain("from sklearn.metrics import");
});
