/** Competition layout: load theo slug, header + sidebar content, submit enabled, Sprint 06 tabs disabled. */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { setDocumentHidden } from "../test/timers";
import { CompetitionContentPanel, CompetitionOverview } from "./CompetitionContentPanel";
import { CompetitionDetailPage } from "./CompetitionDetailPage";
import { CompetitionGuidePage } from "./CompetitionGuidePage";

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
  primary_metric_label: "F1",
  access: { allowed: true, reason: null },
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
    { id: "a", slug: "problem", title: "Đề bài", order: 20, size_bytes: 10, updated_at: "2026-09-15T00:00:00Z" },
    { id: "b", slug: "rules", title: "Rules", order: 10, size_bytes: 10, updated_at: "2026-09-15T00:00:00Z" },
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
          <Route path="huong-dan" element={<CompetitionGuidePage />} />
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
  vi.useRealTimers();
  setDocumentHidden(false);
});

/** Chạy hết timer giả trong `ms` và để chuỗi fetch → setState render xong. */
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
}

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
  // Masthead nằm ngay trong cuộc thi nên link "Vào cuộc thi" trỏ về chính trang đang mở.
  expect(screen.queryByRole("link", { name: "Vào cuộc thi" })).toBeNull();
  // Danh sách đã bỏ nút rời (showLeave=false); trang chi tiết vẫn phải giữ thao tác này.
  expect(screen.getByRole("button", { name: "Rời cuộc thi" })).toBeTruthy();
  const nav = await screen.findByRole("navigation", { name: "Nội dung cuộc thi" });
  const items = nav.querySelectorAll(".content-nav-item");
  // Frontend render theo thứ tự API trả về; backend đã sort theo order (Rules 10 trước Đề bài 20)
  expect(items[0].textContent).toContain("Đề bài");
  expect(items[1].textContent).toBe("Rules");
  // Badge đếm của mục lục chỉ còn đúng con số, không còn hậu tố "mục"; scope vào
  // section chứa nav để không dính badge của block Tài nguyên cùng class.
  expect(within(nav.closest("section") as HTMLElement).getByText("2")).toBeTruthy();
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

test("các mục Nộp bài, Bài đã nộp và Bảng xếp hạng đều là link điều hướng dùng được", async () => {
  apiMock((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderAt("/competitions/ai-challenge-2026");
  await screen.findByRole("heading", { name: "AI Challenge 2026" });
  // "Nộp bài" còn xuất hiện ở CTA trong Tổng quan nên phải khoanh vùng đúng mục lục.
  const tabs = screen.getByRole("navigation", { name: "Mục lục cuộc thi" });
  for (const label of ["Nộp bài", "Bài đã nộp", "Bảng xếp hạng"]) {
    const tab = within(tabs).getByRole("link", { name: label });
    expect(tab.getAttribute("aria-disabled")).toBeNull();
  }
});

test("mục lục cuộc thi là điều hướng route, không giả lập tab", async () => {
  apiMock((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  const overview = renderAt("/competitions/ai-challenge-2026");
  await screen.findByRole("heading", { name: "AI Challenge 2026" });

  const nav = screen.getByRole("navigation", { name: "Mục lục cuộc thi" });
  expect(nav.getAttribute("role")).toBeNull();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryAllByRole("tab")).toHaveLength(0);

  // Chỉ mục đang mở có aria-current; đổi route thì dấu chuyển theo.
  expect(within(nav).getByRole("link", { name: "Tổng quan" }).getAttribute("aria-current")).toBe("page");
  expect(within(nav).getByRole("link", { name: "Nộp bài" }).getAttribute("aria-current")).toBeNull();
  overview.unmount();

  renderAt("/competitions/ai-challenge-2026/leaderboard");
  await screen.findByTestId("workspace-leaderboard");
  const leaderboardNav = screen.getByRole("navigation", { name: "Mục lục cuộc thi" });
  expect(within(leaderboardNav).getByRole("link", { name: "Bảng xếp hạng" }).getAttribute("aria-current")).toBe("page");
  expect(within(leaderboardNav).getByRole("link", { name: "Tổng quan" }).getAttribute("aria-current")).toBeNull();
});

test("mục Hướng dẫn đứng ngay sau Tổng quan và mở được với thành viên", async () => {
  apiMock((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderAt("/competitions/ai-challenge-2026");

  const nav = await screen.findByRole("navigation", { name: "Mục lục cuộc thi" });
  const labels = Array.from(nav.querySelectorAll(".comp-tab")).map((tab) =>
    (tab.textContent ?? "").trim(),
  );
  expect(labels).toEqual(["Tổng quan", "Hướng dẫn", "Nộp bài", "Bài đã nộp", "Bảng xếp hạng"]);
  expect(within(nav).getByRole("link", { name: "Hướng dẫn" }).getAttribute("aria-current")).toBeNull();
});

test("trang Hướng dẫn mở ở route riêng với thành viên, không hiện sidebar mục lục nội dung", async () => {
  apiMock((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderAt("/competitions/ai-challenge-2026/huong-dan");
  await screen.findByRole("heading", { name: "Hướng dẫn nộp bài", level: 2 });

  // Đây là trang workspace nên không có rail trái; gate membership đã mở từ shell.
  expect(screen.queryByRole("navigation", { name: "Nội dung cuộc thi" })).toBeNull();
  const nav = screen.getByRole("navigation", { name: "Mục lục cuộc thi" });
  expect(within(nav).getByRole("link", { name: "Hướng dẫn" }).getAttribute("aria-current")).toBe("page");
  await waitFor(() => expect(document.title).toBe("Hướng dẫn - AI Challenge"));
});

test("slug sai: chỉ gọi chi tiết cuộc thi, không gọi mục lục nội dung", async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({ error: { code: "NOT_FOUND", message: "Không tìm thấy cuộc thi." } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  renderAt("/competitions/khong-ton-tai");
  await screen.findByRole("heading", { level: 1, name: "Không tìm thấy cuộc thi" });

  expect(urls.some((url) => url.includes("/competitions/khong-ton-tai"))).toBe(true);
  expect(urls.some((url) => url.includes("/contents"))).toBe(false);
});

test("slug đúng: mục lục nội dung vẫn được tải sau khi cuộc thi xong", async () => {
  const urls: string[] = [];
  apiMock((url) => {
    urls.push(url);
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderAt("/competitions/ai-challenge-2026");
  await screen.findByRole("navigation", { name: "Nội dung cuộc thi" });

  const detailAt = urls.findIndex((url) => url.endsWith("/api/competitions/ai-challenge-2026"));
  const contentsAt = urls.findIndex((url) => url.includes("/contents"));
  expect(detailAt).toBeGreaterThanOrEqual(0);
  expect(contentsAt).toBeGreaterThan(detailAt);
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
  // Heading do tác giả viết bị hạ một bậc: H1 của trang là tên cuộc thi trên masthead.
  expect(await screen.findByRole("heading", { name: "Đề bài chi tiết", level: 2 })).toBeTruthy();
  expect(screen.getByText("quan trọng")).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
});

test("header nội dung chỉ còn tiêu đề", async () => {
  apiMock((url) => {
    if (url.endsWith("/contents/problem")) {
      return {
        body: {
          ...CONTENTS.contents[0],
          markdown: "Nội dung tài liệu.",
        },
        status: 200,
      };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });

  renderAt("/competitions/ai-challenge-2026/content/problem");

  const title = await screen.findByRole("heading", { name: "Đề bài", level: 2 });
  const header = title.closest("header");
  expect(header).toHaveClass("article-head");
  // Ngày cập nhật và nhãn hiển thị đều đã bỏ, header chỉ còn đúng một tiêu đề.
  expect(header?.children).toHaveLength(1);
  expect(header?.querySelector("time")).toBeNull();
  // Nền sọc chéo là lớp trang trí thuần CSS, không tiêu tốn phần tử DOM nào.
  expect(header?.querySelector(".vku-accent")).toBeNull();
  expect(within(header as HTMLElement).queryByText(/^Cập nhật /)).toBeNull();
});

test("block Tài nguyên nằm sau Mục lục nội dung, lọc link không an toàn", async () => {
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
          { label: "Link lạ", url: "http://evil.example.com/dataset.zip" },
        ],
      },
      status: 200,
    };
  });
  renderAt("/competitions/ai-challenge-2026");
  await screen.findByRole("heading", { name: "AI Challenge 2026" });

  const resources = await screen.findByText("Tài nguyên");
  const toc = screen.getByText("Mục lục nội dung");
  const following = toc.compareDocumentPosition(resources) & Node.DOCUMENT_POSITION_FOLLOWING;
  expect(following).toBeTruthy();

  const resourceSection = resources.closest("section");
  expect(resourceSection).toHaveClass("content-card-vku", "content-card-resources");
  expect(resourceSection).toHaveAttribute("aria-labelledby", "competition-resources-title");
  expect(resources).toHaveAttribute("id", "competition-resources-title");
  // Đếm tài nguyên phải scope vào chính section này: mục lục nội dung dùng cùng class
  // `.content-card-count` và cũng đang hiện "2" nên query toàn cục sẽ khớp hai phần tử.
  // Hai link hợp lệ + notebook khung built-in.
  expect(within(resourceSection as HTMLElement).getByText("3")).toBeTruthy();

  const dataset = screen.getByRole("link", { name: /Dataset huấn luyện/ });
  expect(dataset.getAttribute("href")).toBe("https://drive.google.com/drive/folders/abc");
  expect(dataset.getAttribute("target")).toBe("_blank");
  expect(dataset.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  // Link không phải https bị lọc trước khi render nên không tạo thành link sống.
  expect(screen.queryByText("Link lạ")).toBeNull();
  expect(document.querySelectorAll(".resource-link")).toHaveLength(3);
  // Notebook khung là thao tác tải tại chỗ nên phải là button, không phải link ra ngoài.
  expect(screen.getByRole("button", { name: /Notebook khởi đầu/ })).toBeTruthy();
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
      // Lần 1: chưa tham gia nên backend chỉ trả landing khóa. Lần 2: đã là thành viên
      // nên payload đầy đủ (quota) và gate mở.
      return json({
        ...COMPETITION,
        join_mode: "open",
        membership:
          detailCalls === 1
            ? { active: false, joined_at: null }
            : { active: true, joined_at: "2026-09-15T00:00:00Z" },
        access:
          detailCalls === 1
            ? { allowed: false, reason: "membership_required" }
            : { allowed: true, reason: null },
        quota: { per_day: 7, used_today: 2, remaining: 5, resets_at: "2026-11-02T00:00:00Z" },
      });
    }),
  );

  renderAt("/competitions/ai-challenge-2026");
  await screen.findByRole("heading", { name: "AI Challenge 2026" });
  // Masthead cũng có nút tham gia; bấm đúng nút trong landing khóa.
  const locked = document.querySelector(".comp-locked-card") as HTMLElement;
  fireEvent.click(within(locked).getByRole("button", { name: "Tham gia" }));

  await waitFor(() => expect(detailCalls).toBe(2));
  // Join chỉ vá membership; gate chỉ mở bằng payload đầy đủ từ lượt tải lại.
  await screen.findByRole("navigation", { name: "Mục lục cuộc thi" });
  expect(screen.getByText("Đã tham gia")).toBeTruthy();
  expect(screen.queryByText("Đang tải cuộc thi…")).toBeNull();
});

test("khách chưa đăng nhập: landing khóa kèm lối đăng nhập, URL sâu cũng không mở nội dung", async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          ...COMPETITION,
          membership: { active: false, joined_at: null },
          access: { allowed: false, reason: "login_required" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  renderAt("/competitions/ai-challenge-2026/submit");

  expect(
    await screen.findByText("Vui lòng đăng nhập và tham gia cuộc thi để xem nội dung."),
  ).toBeTruthy();
  expect(screen.getByRole("link", { name: "Đăng nhập" })).toBeTruthy();
  // Gate đóng ở shell nên URL sâu không mount được trang con, cũng không hỏi mục lục.
  expect(screen.queryByTestId("workspace-submit")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Mục lục cuộc thi" })).toBeNull();
  expect(urls.some((url) => url.includes("/contents"))).toBe(false);
});

test("người chưa tham gia: landing khóa mời tham gia, không lộ tab lẫn mục lục", async () => {
  const urls: string[] = [];
  apiMock((url) => {
    urls.push(url);
    return {
      body: {
        ...COMPETITION,
        join_mode: "open",
        membership: { active: false, joined_at: null },
        access: { allowed: false, reason: "membership_required" },
      },
      status: 200,
    };
  });
  renderAt("/competitions/ai-challenge-2026");

  expect(await screen.findByText("Hãy tham gia cuộc thi trước để xem nội dung.")).toBeTruthy();
  const locked = document.querySelector(".comp-locked-card") as HTMLElement;
  expect(within(locked).getByRole("button", { name: "Tham gia" })).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "Mục lục cuộc thi" })).toBeNull();
  expect(screen.queryByText("Mục lục nội dung")).toBeNull();
  expect(urls.some((url) => url.includes("/contents"))).toBe(false);
});

test("cuộc thi chỉ theo lời mời: landing khóa nói rõ chưa được phép, không mời bấm join", async () => {
  apiMock(() => ({
    body: {
      ...COMPETITION,
      join_mode: "invite_only",
      membership: { active: false, joined_at: null },
      access: { allowed: false, reason: "membership_required" },
    },
    status: 200,
  }));
  renderAt("/competitions/ai-challenge-2026");

  expect(
    await screen.findByText(
      "Bạn chưa được phép tham gia cuộc thi này. Vui lòng liên hệ Ban Tổ chức để được mời.",
    ),
  ).toBeTruthy();
  const locked = document.querySelector(".comp-locked-card") as HTMLElement;
  expect(within(locked).queryByRole("button")).toBeNull();
});

test("membership bị vô hiệu hóa: landing khóa nói lý do và không tự mời tham gia lại", async () => {
  apiMock(() => ({
    body: {
      ...COMPETITION,
      membership: { active: false, joined_at: "2026-09-15T00:00:00Z" },
      access: { allowed: false, reason: "membership_inactive" },
    },
    status: 200,
  }));
  renderAt("/competitions/ai-challenge-2026");

  expect(
    await screen.findByText(
      "Quyền tham gia cuộc thi của bạn đã bị vô hiệu hóa. Vui lòng liên hệ Ban Tổ chức.",
    ),
  ).toBeTruthy();
  const locked = document.querySelector(".comp-locked-card") as HTMLElement;
  expect(within(locked).queryByRole("button")).toBeNull();
});

test("cuộc thi đã kết thúc: người chưa tham gia chỉ thấy landing khóa, không còn nút tham gia", async () => {
  apiMock(() => ({
    body: {
      ...COMPETITION,
      status: "closed",
      join_mode: "open",
      membership: { active: false, joined_at: null },
      access: { allowed: false, reason: "membership_required" },
    },
    status: 200,
  }));
  renderAt("/competitions/ai-challenge-2026");

  expect(
    await screen.findByText(
      "Cuộc thi đã hết thời gian tham gia. Nội dung chỉ dành cho thành viên đã tham gia.",
    ),
  ).toBeTruthy();
  const locked = document.querySelector(".comp-locked-card") as HTMLElement;
  expect(within(locked).queryByRole("button")).toBeNull();
});

test("tài liệu trả 401 giữa chừng: shell đóng gate thay vì hiện lỗi tải nội dung", async () => {
  let detailCalls = 0;
  apiMock((url) => {
    if (url.endsWith("/contents/problem")) {
      return { body: { error: { code: "UNAUTHORIZED", message: "Chưa đăng nhập." } }, status: 401 };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    detailCalls += 1;
    // Lượt xác minh lại sau khi mất quyền: backend trả landing khóa.
    return detailCalls === 1
      ? { body: COMPETITION, status: 200 }
      : {
          body: {
            ...COMPETITION,
            membership: { active: false, joined_at: null },
            access: { allowed: false, reason: "login_required" },
          },
          status: 200,
        };
  });
  renderAt("/competitions/ai-challenge-2026/content/problem");

  expect(
    await screen.findByText("Vui lòng đăng nhập và tham gia cuộc thi để xem nội dung."),
  ).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "Mục lục cuộc thi" })).toBeNull();
  // Mất quyền không phải tài liệu hỏng: không hiện lỗi tải kèm nút thử lại.
  expect(screen.queryByText("Thử lại")).toBeNull();
  expect(detailCalls).toBe(2);
});

test("rời cuộc thi: gate đóng ngay, mục lục bị xoá và không còn tab", async () => {
  let detailCalls = 0;
  apiMock((url) => {
    if (url.endsWith("/leave")) {
      return {
        body: {
          competition_id: "1",
          membership: { active: false, joined_at: "2026-09-15T00:00:00Z" },
          left_now: true,
        },
        status: 200,
      };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    detailCalls += 1;
    return {
      body:
        detailCalls === 1
          ? COMPETITION
          : {
              ...COMPETITION,
              membership: { active: false, joined_at: "2026-09-15T00:00:00Z" },
              access: { allowed: false, reason: "membership_inactive" },
            },
      status: 200,
    };
  });
  renderAt("/competitions/ai-challenge-2026");
  await screen.findByRole("navigation", { name: "Nội dung cuộc thi" });

  fireEvent.click(screen.getByRole("button", { name: "Rời cuộc thi" }));
  const dialog = screen.getByRole("dialog", { name: "Rời cuộc thi" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Rời cuộc thi" }));

  expect(
    await screen.findByText(
      "Quyền tham gia cuộc thi của bạn đã bị vô hiệu hóa. Vui lòng liên hệ Ban Tổ chức.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "Mục lục cuộc thi" })).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Nội dung cuộc thi" })).toBeNull();
});

test("cuộc thi không có link ngoài vẫn thấy block tài nguyên với notebook khung", async () => {
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

  const resources = await screen.findByText("Tài nguyên");
  const resourceSection = resources.closest("section") as HTMLElement;
  expect(within(resourceSection).getByText("1")).toBeTruthy();
  // Link sai giao thức vẫn bị lọc, nhưng notebook khung là tài nguyên built-in nên luôn có.
  expect(screen.queryByText("Link hỏng")).toBeNull();
  expect(within(resourceSection).getByRole("button", { name: /Notebook khởi đầu/ })).toBeTruthy();
});

test("tải notebook khung gọi đúng endpoint và báo lỗi tại chỗ khi máy chủ từ chối", async () => {
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  URL.createObjectURL = vi.fn(() => "blob:starter");
  URL.revokeObjectURL = vi.fn();
  const downloads: string[] = [];
  let fail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/starter-notebook")) {
        downloads.push(url);
        if (fail) {
          return new Response(
            JSON.stringify({ error: { code: "STARTER_NOTEBOOK_MISSING", message: "Thiếu tệp." } }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("notebook-bytes", {
          status: 200,
          headers: {
            "Content-Type": "application/x-ipynb+json",
            "Content-Disposition": 'attachment; filename="starter-notebook.ipynb"',
          },
        });
      }
      if (url.includes("/contents")) {
        return new Response(JSON.stringify(CONTENTS), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(COMPETITION), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  renderAt("/competitions/ai-challenge-2026");
  await screen.findByRole("heading", { name: "AI Challenge 2026" });

  fireEvent.click(screen.getByRole("button", { name: /Notebook khởi đầu/ }));
  await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
  expect(downloads).toEqual(["/api/starter-notebook"]);

  // Lỗi tải hiện ngay trong block, không làm mất các link tài nguyên còn lại.
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: /Notebook khởi đầu/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Thiếu tệp.");
  expect(screen.getByRole("button", { name: /Notebook khởi đầu/ })).not.toBeDisabled();
  anchorClick.mockRestore();
});

test("tiêu đề tab theo khu vực đang mở và giữ đúng khi đổi route", async () => {
  apiMock((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });

  const overview = renderAt("/competitions/ai-challenge-2026");
  await screen.findByRole("heading", { name: "AI Challenge 2026" });
  // Title do cuộc thi đã fetch quyết định; effect ghi title chạy sau commit nên phải chờ.
  await waitFor(() => expect(document.title).toBe("AI Challenge 2026 - AI Challenge"));
  overview.unmount();

  renderAt("/competitions/ai-challenge-2026/leaderboard");
  await screen.findByTestId("workspace-leaderboard");
  expect(document.title).toBe("Bảng xếp hạng - AI Challenge");
});

test("route nội dung tự đặt tiêu đề theo tài liệu, khung cuộc thi không ghi đè", async () => {
  apiMock((url) => {
    if (url.endsWith("/contents/problem")) {
      return { body: { ...CONTENTS.contents[0], markdown: "# Đề bài chi tiết" }, status: 200 };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });

  renderAt("/competitions/ai-challenge-2026/content/problem");
  await screen.findByRole("heading", { name: "Đề bài chi tiết", level: 2 });
  await waitFor(() => expect(document.title).toBe("Đề bài - AI Challenge"));
  // H1 duy nhất trên trang là tên cuộc thi, không phải heading do tác giả viết.
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
});

test("trang lỗi có H1 mô tả trạng thái và tiêu đề tab tương ứng", async () => {
  apiMock(() => ({
    body: { error: { code: "NOT_FOUND", message: "Không tìm thấy cuộc thi." } },
    status: 404,
  }));
  renderAt("/competitions/khong-ton-tai");

  expect(await screen.findByRole("heading", { level: 1, name: "Không tìm thấy cuộc thi" })).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  await waitFor(() => expect(document.title).toBe("Không tìm thấy cuộc thi - AI Challenge"));
});

test("trạng thái cuộc thi đổi từ phía Ban Tổ chức tự hiện, không nháy skeleton", async () => {
  vi.useFakeTimers();
  const competition = { ...COMPETITION };
  apiMock((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: competition, status: 200 };
  });
  renderAt("/competitions/ai-challenge-2026");
  await advance();
  expect(screen.getByText("Đang diễn ra")).toBeTruthy();

  competition.status = "closed";
  await advance(6_000);

  expect(screen.getByText("Đã kết thúc")).toBeTruthy();
  expect(screen.queryByText("Đang diễn ra")).toBeNull();
  // Cập nhật tại chỗ: masthead đổi badge nhưng không unmount trang để nháy skeleton.
  expect(screen.queryByText("Đang tải cuộc thi…")).toBeNull();
  expect(screen.getByRole("heading", { name: "AI Challenge 2026" })).toBeTruthy();
});

test("lượt làm mới ngầm lỗi thì giữ nguyên nội dung đang xem, không hiện trang lỗi", async () => {
  vi.useFakeTimers();
  let detailCalls = 0;
  apiMock((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    detailCalls += 1;
    return detailCalls === 1
      ? { body: COMPETITION, status: 200 }
      : { body: { error: { code: "INTERNAL", message: "Máy chủ lỗi." } }, status: 500 };
  });
  renderAt("/competitions/ai-challenge-2026");
  await advance();
  expect(screen.getByRole("heading", { name: "AI Challenge 2026" })).toBeTruthy();

  await advance(6_000);
  expect(detailCalls).toBe(2);
  expect(screen.getByRole("heading", { name: "AI Challenge 2026" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Không thể tải cuộc thi" })).toBeNull();
  expect(screen.queryByText("Đang tải cuộc thi…")).toBeNull();
});

test("modal xác nhận rời cuộc thi đang mở thì tạm dừng tự làm mới", async () => {
  vi.useFakeTimers();
  let detailCalls = 0;
  apiMock((url) => {
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    detailCalls += 1;
    return { body: COMPETITION, status: 200 };
  });
  renderAt("/competitions/ai-challenge-2026");
  await advance();
  expect(detailCalls).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Rời cuộc thi" }));
  const dialog = screen.getByRole("dialog", { name: "Rời cuộc thi" });
  await advance(20_000);
  // Hộp thoại xác nhận đang mở: dữ liệu bên dưới không bị ghi đè.
  expect(detailCalls).toBe(1);

  fireEvent.click(within(dialog).getByRole("button", { name: "Hủy" }));
  await advance(6_000);
  expect(detailCalls).toBe(2);
});
