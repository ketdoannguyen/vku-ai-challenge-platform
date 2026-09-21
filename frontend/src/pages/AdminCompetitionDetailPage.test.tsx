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

const SCORING = {
  ready: true,
  not_ready_reason: null,
  locked: false,
  config: {
    id_column: "id",
    prediction_column: "prediction",
    label_column: "label",
    average: "binary",
    pos_label: "1",
    higher_is_better: true,
  },
  ground_truth: {
    row_count: 4,
    columns: ["id", "label"],
    uploaded_at: "2026-09-15T00:00:00Z",
  },
  primary_metric: "f1",
  quota_per_day: 5,
  max_upload_mb: 10,
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

/** Mock đủ endpoint của cả 6 panel để đổi tab không phụ thuộc shape dữ liệu. */
async function renderRail() {
  mockApi((url) => {
    if (url.includes("/join-code")) return { body: { join_code_configured: true }, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (url.includes("/assets")) return { body: { assets: [] }, status: 200 };
    if (url.includes("/members")) return { body: MEMBERS, status: 200 };
    if (url.includes("/scoring")) return { body: SCORING, status: 200 };
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

test("rail quản trị: đủ 6 khu vực, panel gắn đúng tab đang mở", async () => {
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
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "Nội dung",
    "Hình ảnh",
    "Tài nguyên",
    "Chấm điểm",
    "Kết quả",
    "Thành viên & mã tham gia",
  ]);
  expect(tabs.filter((tab) => tab.getAttribute("aria-selected") === "true")).toHaveLength(1);

  // React dùng lại chính nút DOM đó qua mỗi lần render nên phải chốt id trước khi bấm.
  const contentsPanelId = screen.getByRole("tabpanel", { name: "Nội dung" }).id;
  expect(tabs[0].getAttribute("aria-controls")).toBe(contentsPanelId);

  // Chuyển khu vực: panel cũ biến mất, panel mới do đúng tab đó điều khiển.
  const members = within(rail).getByRole("tab", { name: "Thành viên & mã tham gia" });
  fireEvent.click(members);
  const next = await screen.findByRole("tabpanel", { name: "Thành viên & mã tham gia" });
  expect(next.id).not.toBe(contentsPanelId);
  expect(members.getAttribute("aria-controls")).toBe(next.id);
  expect(screen.queryByRole("tabpanel", { name: "Nội dung" })).toBeNull();
});

test("rail quản trị: roving tabindex - chỉ focused tab có tabIndex=0, Arrow/Home/End wrap đúng", async () => {
  await renderRail();
  expect(tabIndexes()).toEqual(["0", "-1", "-1", "-1", "-1", "-1"]);

  fireEvent.keyDown(railTab("Nội dung"), { key: "ArrowRight" });
  expect(railTab("Hình ảnh")).toHaveFocus();
  expect(tabIndexes()).toEqual(["-1", "0", "-1", "-1", "-1", "-1"]);

  fireEvent.keyDown(railTab("Hình ảnh"), { key: "ArrowRight" });
  expect(railTab("Tài nguyên")).toHaveFocus();
  expect(tabIndexes()).toEqual(["-1", "-1", "0", "-1", "-1", "-1"]);

  fireEvent.keyDown(railTab("Tài nguyên"), { key: "ArrowRight" });
  expect(railTab("Chấm điểm")).toHaveFocus();
  expect(tabIndexes()).toEqual(["-1", "-1", "-1", "0", "-1", "-1"]);

  fireEvent.keyDown(railTab("Chấm điểm"), { key: "ArrowLeft" });
  expect(railTab("Tài nguyên")).toHaveFocus();
  expect(tabIndexes()).toEqual(["-1", "-1", "0", "-1", "-1", "-1"]);

  fireEvent.keyDown(railTab("Tài nguyên"), { key: "End" });
  expect(railTab("Thành viên & mã tham gia")).toHaveFocus();
  expect(tabIndexes()).toEqual(["-1", "-1", "-1", "-1", "-1", "0"]);

  fireEvent.keyDown(railTab("Thành viên & mã tham gia"), { key: "Home" });
  expect(railTab("Nội dung")).toHaveFocus();
  expect(tabIndexes()).toEqual(["0", "-1", "-1", "-1", "-1", "-1"]);

  // Wrap ở biên: trái từ tab đầu về tab cuối, phải từ tab cuối về tab đầu.
  fireEvent.keyDown(railTab("Nội dung"), { key: "ArrowLeft" });
  expect(railTab("Thành viên & mã tham gia")).toHaveFocus();
  fireEvent.keyDown(railTab("Thành viên & mã tham gia"), { key: "ArrowRight" });
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
  expect(railTab("Thành viên & mã tham gia")).toHaveFocus();
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
    expect(tabIndexes()).toEqual(["0", "-1", "-1", "-1", "-1", "-1"]);
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
  fireEvent.click(await screen.findByRole("tab", { name: "Thành viên & mã tham gia" }));
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
    if (url.includes("/members")) return { body: MEMBERS, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Thành viên & mã tham gia" }));
  const input = await screen.findByLabelText("Mã tham gia mới");
  fireEvent.change(input, { target: { value: "new-secret-2026" } });
  fireEvent.submit(input.closest("form")!);
  expect(screen.getByRole("dialog", { name: "Đổi mã tham gia" })).toBeTruthy();
  expect(calls.some((call) => call.url.includes("/join-code") && call.init?.method === "PUT")).toBe(false);
  fireEvent.click(screen.getAllByRole("button", { name: "Đổi mã" })[1]);
  await waitFor(() => screen.getByText("Đã cập nhật mã tham gia."));
  expect(screen.queryByDisplayValue("new-secret-2026")).toBeNull();
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
  fireEvent.click(await screen.findByRole("tab", { name: "Thành viên & mã tham gia" }));
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

test("lưu scoring config chỉ gửi schema metric, không gửi quota/primary/upload limit", async () => {
  mockApi((url, init) => {
    if (url.endsWith("/scoring") && init?.method === "PUT") {
      return { body: SCORING, status: 200 };
    }
    if (url.endsWith("/scoring")) return { body: { ...SCORING, ready: false, ground_truth: null }, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  fireEvent.change(await screen.findByLabelText("Cột prediction"), { target: { value: "answer" } });
  fireEvent.submit(screen.getByRole("button", { name: "Lưu cấu hình" }).closest("form")!);
  await waitFor(() => {
    const put = calls.find((call) => call.url.endsWith("/scoring") && call.init?.method === "PUT");
    expect(put).toBeTruthy();
    expect(JSON.parse(put!.init!.body as string)).toEqual({
      id_column: "id",
      prediction_column: "answer",
      label_column: "label",
      average: "binary",
      pos_label: "1",
      higher_is_better: true,
    });
  });
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

test("banner chặn vì thiếu mã tham gia mở tab Thành viên chứ không phải tab Chấm điểm", async () => {
  mockApi((url) => {
    if (url.endsWith("/scoring")) return { body: SCORING, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (url.includes("/members")) return { body: MEMBERS, status: 200 };
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
  fireEvent.click(within(banner).getByRole("button", { name: "Mở tab Thành viên" }));

  expect(screen.getByRole("tab", { name: "Thành viên & mã tham gia" })).toHaveAttribute(
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
  expect(screen.getByRole("button", { name: "Lưu cấu hình" })).toBeDisabled();
  expect(screen.getByLabelText("Upload ground truth CSV")).toBeDisabled();
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
  // Hai bảng kết quả cuộn ngang được nên phải là vùng focus được bằng bàn phím.
  for (const name of ["Bảng xếp hạng của cuộc thi", "Bảng bài nộp của cuộc thi"]) {
    const region = screen.getByRole("region", { name });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getByRole("table")).toBeTruthy();
  }
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
  const region = await screen.findByRole("region", { name: "Bảng bài nộp của cuộc thi" });

  // Cuộc thi đã biết sẵn nên bảng ẩn cả ô lọc lẫn cột cuộc thi, và không gọi endpoint toàn cục.
  expect(screen.queryByLabelText("Lọc theo cuộc thi")).toBeNull();
  expect(within(region).queryByRole("columnheader", { name: "Cuộc thi" })).toBeNull();
  expect(calls.some((call) => call.url.includes("/api/admin/submissions?"))).toBe(false);

  // Không có thẻ thống kê toàn cục và không còn nút Lọc; cột Điểm chính vẫn được nhấn.
  expect(screen.queryByRole("region", { name: "Tổng quan bài nộp" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Lọc" })).toBeNull();
  expect(within(region).getByRole("columnheader", { name: /Điểm chính/ }).className).toContain(
    "primary-col",
  );

  // Sắp xếp vẫn chạy phía server, qua chính endpoint của cuộc thi.
  fireEvent.click(within(screen.getByRole("columnheader", { name: /Đội/ })).getByRole("button"));
  await waitFor(() => {
    const sorted = calls.find(
      (call) => new URL(call.url, "http://localhost").searchParams.get("sort") === "team",
    );
    expect(sorted?.url).toContain(`/admin/competitions/${COMPETITION.id}/submissions?`);
  });

  for (const field of ["f1", "precision", "recall"]) {
    fireEvent.click(
      within(
        within(region).getByRole("columnheader", { name: new RegExp(`^${field}$`, "i") }),
      ).getByRole("button"),
    );
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
  const region = await screen.findByRole("region", { name: "Bảng bài nộp của cuộc thi" });
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
  expect(screen.getByText("Cấu hình CSV")).toBeTruthy();
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
  fireEvent.click(await screen.findByRole("tab", { name: "Thành viên & mã tham gia" }));
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
  fireEvent.click(await screen.findByRole("tab", { name: "Thành viên & mã tham gia" }));
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
  fireEvent.click(await screen.findByRole("tab", { name: "Thành viên & mã tham gia" }));

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

  const labels = [
    "Nội dung",
    "Hình ảnh",
    "Tài nguyên",
    "Chấm điểm",
    "Kết quả",
    "Thành viên & mã tham gia",
  ];
  const tabs = within(rail()).getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual(labels);

  for (const [index, tab] of tabs.entries()) {
    const icon = tab.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveAttribute("focusable", "false");
    // Nếu icon lọt vào accessible name thì truy vấn theo tên chính xác sẽ trượt.
    expect(within(rail()).getByRole("tab", { name: labels[index] })).toBe(tab);
  }
});

test("nhịp màu theo tab: mỗi panel dùng đúng chuỗi data-tone, không suy từ dữ liệu", async () => {
  await renderRail();

  expect(cardTones(screen.getByRole("tabpanel", { name: "Nội dung" }))).toEqual(["blue", "yellow"]);

  for (const [name, tones] of [
    ["Hình ảnh", ["blue", "yellow", "red"]],
    ["Tài nguyên", ["yellow"]],
    ["Chấm điểm", ["blue", "red", "yellow"]],
    ["Kết quả", ["yellow", "blue"]],
    ["Thành viên & mã tham gia", ["red", "blue"]],
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

  // Chấm điểm: không có bảng; form cấu hình vẫn nằm trong tabpanel.
  fireEvent.click(railTab("Chấm điểm"));
  const scoringPanel = await screen.findByRole("tabpanel", { name: "Chấm điểm" });
  expect(within(scoringPanel).queryByRole("region")).toBeNull();

  fireEvent.click(railTab("Kết quả"));
  await expectRegion("Bảng xếp hạng của cuộc thi");
  await expectRegion("Bảng bài nộp của cuộc thi");

  fireEvent.click(railTab("Thành viên & mã tham gia"));
  await expectRegion("Bảng thành viên cuộc thi");
});

test("Hướng dẫn định dạng chỉ phản ánh cấu hình backend đang lưu", async () => {
  mockApi((url) => {
    if (url.endsWith("/scoring")) return { body: SCORING, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  const first = renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));

  const binaryGuide = (await screen.findByRole("heading", { name: "Hướng dẫn định dạng" })).closest(
    "section",
  ) as HTMLElement;
  expect(within(binaryGuide).getByText("prediction")).toBeTruthy();
  expect(within(binaryGuide).getByText("binary")).toBeTruthy();
  expect(within(binaryGuide).getByText("Positive label")).toBeTruthy();
  first.unmount();

  // average khác binary: không còn dòng positive label.
  mockApi((url) => {
    if (url.endsWith("/scoring")) {
      return {
        body: { ...SCORING, config: { ...SCORING.config, average: "macro", pos_label: null } },
        status: 200,
      };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  const second = renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  const macroGuide = (await screen.findByRole("heading", { name: "Hướng dẫn định dạng" })).closest(
    "section",
  ) as HTMLElement;
  expect(within(macroGuide).getByText("macro")).toBeTruthy();
  expect(within(macroGuide).queryByText("Positive label")).toBeNull();
  second.unmount();

  // Chưa lưu cấu hình: form đang giữ giá trị mặc định nên không được coi là cấu hình đang áp dụng.
  mockApi((url) => {
    if (url.endsWith("/scoring")) {
      return { body: { ...SCORING, ready: false, config: null, ground_truth: null }, status: 200 };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Chấm điểm" }));
  expect(await screen.findByText("Lưu cấu hình CSV trước khi upload.")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Hướng dẫn định dạng" })).toBeNull();
});
