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

/** Nhóm action ở header trang chi tiết — tách khỏi nút "Xóa" của từng dòng nội dung. */
function headerActions(): HTMLElement {
  return document.querySelector(".admin-detail-actions") as HTMLElement;
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

afterEach(() => {
  vi.unstubAllGlobals();
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
              filename: "result.csv",
              status: "completed",
              metrics: { f1: 0.9, precision: 0.8, recall: 0.7 },
              primary_score: 0.9,
              created_at: "2026-09-15T09:00:00Z",
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
  expect(await screen.findByText("result.csv")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Bảng xếp hạng" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Xuất Excel" })).toHaveAttribute(
    "href",
    `/api/admin/competitions/${COMPETITION.id}/export.xlsx`,
  );
  expect(screen.getByLabelText("Lọc theo đội")).toBeTruthy();
  expect(screen.getByLabelText("Lọc theo trạng thái")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
  await waitFor(() => {
    expect(calls.some((call) => call.url.includes("/submissions?limit=50&offset=50"))).toBe(true);
  });
});

test("header hiển thị action theo status: draft có Publish, published có Kết thúc, closed disable Sửa", async () => {
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
  expect(within(closedHeaderActions).getByRole("button", { name: "Sửa" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Kết thúc" })).toBeNull();
  renderClosed.unmount();
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

test("tab Assets render Bento 8/4, inventory table 5 cột, copy markdown và upload/delete", async () => {
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
  fireEvent.click(await screen.findByRole("tab", { name: "Assets" }));

  // Bento 8/4 items
  expect(await screen.findByText("Kho lưu trữ hình ảnh (Assets)")).toBeTruthy();
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

test("chỉ draft mới có nút Xóa cuộc thi", async () => {
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
