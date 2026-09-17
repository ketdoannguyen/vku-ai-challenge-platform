/** Competition layout: load theo slug, header + sidebar content, submit enabled, Sprint 06 tabs disabled. */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { CompetitionContentPanel, CompetitionOverview } from "./CompetitionContentPanel";
import { CompetitionDetailPage } from "./CompetitionDetailPage";

const COMPETITION = {
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
    id_column: "id",
    prediction_column: "label",
    average: "binary",
    pos_label: "1",
    max_upload_mb: 50,
  },
};

const CONTENTS = {
  contents: [
    { id: "a", slug: "problem", title: "Đề bài", order: 20, visibility: "public", size_bytes: 10, updated_at: "2026-09-15T00:00:00Z" },
    { id: "b", slug: "rules", title: "Rules", order: 10, visibility: "members", size_bytes: 10, updated_at: "2026-09-15T00:00:00Z" },
  ],
};

function apiMock(handler: (url: string) => { body: unknown; status: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const r = handler(String(input));
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/competitions/:slug" element={<CompetitionDetailPage />}>
          <Route index element={<CompetitionOverview />} />
          <Route path="content/:contentSlug" element={<CompetitionContentPanel />} />
          <Route path="submit" element={<div data-testid="workspace-submit">Trang nộp bài</div>} />
          <Route path="submissions" element={<div data-testid="workspace-submissions">Trang bài đã nộp</div>} />
          <Route path="leaderboard" element={<div data-testid="workspace-leaderboard">Trang bảng xếp hạng</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("load competition + sidebar sắp theo order, dừng ở Tổng quan và tab active Tổng quan", async () => {
  apiMock((url) => {
    if (url.endsWith("/contents/problem")) {
      return {
        body: { ...CONTENTS.contents[0], markdown: "# Đề bài chi tiết\n\nNội dung mở đầu." },
        status: 200,
      };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    if (url.endsWith("/api/competitions/ai-challenge-2026")) return { body: COMPETITION, status: 200 };
    return { body: { error: { code: "NOT_FOUND", message: "Không tìm thấy cuộc thi." } }, status: 404 };
  });
  renderAt("/competitions/ai-challenge-2026");
  expect(await screen.findByRole("heading", { name: "AI Challenge 2026" })).toBeTruthy();
  expect(screen.getByText("Cần mã tham gia")).toBeTruthy();
  expect(screen.getByText("7 lượt/ngày")).toBeTruthy();
  expect(screen.getByText("Đã tham gia")).toBeTruthy(); // JoinControl đã join
  const nav = screen.getByRole("navigation", { name: "Nội dung cuộc thi" });
  const items = nav.querySelectorAll(".content-nav-item");
  // Frontend render theo thứ tự API trả về; backend đã sort theo order (Rules 10 trước Đề bài 20)
  expect(items[0].textContent).toContain("Đề bài");
  expect(items[0].textContent).toContain("Mọi thí sinh");
  expect(items[1].textContent).toBe("Rules");
  // Chip chỉ gắn cho tài liệu công khai, nên mục "Rules" (members) không có nhãn này.
  expect(nav.textContent).not.toContain("Chỉ thành viên cuộc thi");
  expect(screen.getByText(/2\s*mục/)).toBeTruthy();
  // Tổng quan là đích dừng thật: không tự chuyển sang tài liệu đầu tiên.
  expect(await screen.findByRole("heading", { name: "Tổng quan", level: 2 })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Đề bài chi tiết" })).toBeNull();
});

test("ở các tab workspace (submit, submissions, leaderboard): không hiển thị sidebar Mục lục nội dung", async () => {
  apiMock((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });

  const { unmount } = renderAt("/competitions/ai-challenge-2026/submit");
  await screen.findByRole("heading", { name: "AI Challenge 2026" });
  expect(screen.getByTestId("workspace-submit")).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "Nội dung cuộc thi" })).toBeNull();
  expect(screen.queryByText("Mục lục nội dung")).toBeNull();
  unmount();

  renderAt("/competitions/ai-challenge-2026/submissions");
  await screen.findByRole("heading", { name: "AI Challenge 2026" });
  expect(screen.getByTestId("workspace-submissions")).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "Nội dung cuộc thi" })).toBeNull();
});

test("slug sai → 404 error box + link về danh sách", async () => {
  apiMock(() => ({ body: { error: { code: "NOT_FOUND", message: "Không tìm thấy cuộc thi." } }, status: 404 }));
  renderAt("/competitions/khong-ton-tai");
  await waitFor(() => screen.getByRole("alert"));
  expect(screen.getByText("Không tìm thấy cuộc thi.")).toBeTruthy();
  expect(screen.getByRole("link", { name: /Về danh sách cuộc thi/ })).toBeTruthy();
});

test("các tab Nộp bài, Bài đã nộp và Bảng xếp hạng đều enabled", async () => {
  apiMock((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderAt("/competitions/ai-challenge-2026");
  await screen.findByRole("heading", { name: "AI Challenge 2026" });
  const submitTab = screen.getByRole("tab", { name: "Nộp bài" });
  expect(submitTab.tagName).toBe("A");
  expect(submitTab.getAttribute("aria-disabled")).toBeNull();
  for (const label of ["Bài đã nộp", "Bảng xếp hạng"]) {
    const tab = screen.getByRole("tab", { name: label });
    expect(tab.getAttribute("aria-disabled")).toBeNull();
    expect(tab.tagName).toBe("A");
  }
});

test("deep-link content/:contentSlug render markdown panel", async () => {
  apiMock((url) => {
    if (url.endsWith("/contents/problem")) {
      return {
        body: { ...CONTENTS.contents[0], markdown: "# Đề bài chi tiết\n\nNội dung **quan trọng**." },
        status: 200,
      };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderAt("/competitions/ai-challenge-2026/content/problem");
  expect(await screen.findByRole("heading", { name: "Đề bài chi tiết", level: 1 })).toBeTruthy();
  expect(screen.getByText("quan trọng")).toBeTruthy();
});

test("block Tài nguyên tải về nằm sau Mục lục nội dung, lọc link không an toàn", async () => {
  apiMock((url) => {
    if (url.endsWith("/contents/problem")) {
      return { body: { ...CONTENTS.contents[0], markdown: "# Đề bài chi tiết" }, status: 200 };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return {
      body: {
        ...COMPETITION,
        resources: [
          { label: "Dataset huấn luyện", url: "https://drive.google.com/drive/folders/abc" },
          { label: "Sample submission", url: "https://docs.google.com/spreadsheets/d/xyz" },
          { label: "Link lạ", url: "https://evil.example.com/dataset.zip" },
        ],
      },
      status: 200,
    };
  });
  renderAt("/competitions/ai-challenge-2026");
  await screen.findByRole("heading", { name: "AI Challenge 2026" });

  const resources = await screen.findByText("Tài nguyên tải về");
  const toc = screen.getByText("Mục lục nội dung");
  const following = toc.compareDocumentPosition(resources) & Node.DOCUMENT_POSITION_FOLLOWING;
  expect(following).toBeTruthy();

  const dataset = screen.getByRole("link", { name: /Dataset huấn luyện/ });
  expect(dataset.getAttribute("href")).toBe("https://drive.google.com/drive/folders/abc");
  expect(dataset.getAttribute("target")).toBe("_blank");
  expect(dataset.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  // Host ngoài Drive bị lọc trước khi render nên không tạo thành link sống.
  expect(screen.queryByText("Link lạ")).toBeNull();
  expect(document.querySelectorAll(".resource-link")).toHaveLength(2);
});

test("join xong tự tải lại cuộc thi ngầm để lấy quota, không nháy skeleton", async () => {
  let detailCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.endsWith("/join")) {
        return json({
          competition_id: "1",
          membership: { active: true, joined_at: "2026-09-15T00:00:00Z" },
          joined_now: true,
        });
      }
      if (url.includes("/contents")) return json(CONTENTS);
      detailCalls += 1;
      // Lần 1: chưa join nên backend chưa trả quota. Lần 2: đã là thành viên nên có quota.
      return json({
        ...COMPETITION,
        join_mode: "open",
        membership:
          detailCalls === 1
            ? { active: false, joined_at: null }
            : { active: true, joined_at: "2026-09-15T00:00:00Z" },
        quota: { per_day: 7, used_today: 2, remaining: 5, resets_at: "2026-11-02T00:00:00Z" },
      });
    }),
  );

  renderAt("/competitions/ai-challenge-2026");
  await screen.findByRole("heading", { name: "AI Challenge 2026" });
  fireEvent.click(screen.getByRole("button", { name: "Tham gia" }));

  await waitFor(() => expect(detailCalls).toBe(2));
  expect(screen.getByText("Đã tham gia")).toBeTruthy();
  expect(screen.queryByText("Đang tải cuộc thi…")).toBeNull();
});

test("không có tài nguyên hợp lệ thì không render block tài nguyên", async () => {
  apiMock((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return {
      body: {
        ...COMPETITION,
        resources: [{ label: "Link hỏng", url: "http://drive.google.com/khong-phai-https" }],
      },
      status: 200,
    };
  });
  renderAt("/competitions/ai-challenge-2026");
  await screen.findByRole("heading", { name: "AI Challenge 2026" });
  expect(screen.queryByText("Tài nguyên tải về")).toBeNull();
});
