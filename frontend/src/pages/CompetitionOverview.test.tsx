/**
 * Tổng quan là trang thật: không còn tự chuyển hướng sang tài liệu đầu tiên,
 * lỗi mục lục chỉ ảnh hưởng khối tài liệu, và cấu hình thiếu hiển thị "Chưa cấu hình".
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { formatLocal, type CompetitionDetail, type ParticipantTrackView } from "../api/competitions";
import { CompetitionContentPanel, CompetitionOverview } from "./CompetitionContentPanel";
import { CompetitionDetailPage } from "./CompetitionDetailPage";

const BASE: CompetitionDetail = {
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
    max_notebook_mb: 20,
  },
};

const CONTENTS = {
  contents: [
    { id: "a", slug: "problem", title: "Đề bài", order: 20, size_bytes: 10, updated_at: "2026-09-15T00:00:00Z" },
    { id: "b", slug: "rules", title: "Rules", order: 10, size_bytes: 10, updated_at: "2026-09-15T00:00:00Z" },
  ],
};

/** Nhánh cho cuộc thi dual: chỉ khai báo phần masthead và thẻ nhánh đọc tới. */
function trackView(overrides: Partial<ParticipantTrackView> = {}): ParticipantTrackView {
  return {
    start_at: "2026-10-02T00:00:00Z",
    end_at: "2026-10-10T18:07:00Z",
    quota_per_day: 10,
    window_state: "open",
    results_released: true,
    resources: [],
    can_submit: true,
    blocked_reason: null,
    submission_ready: true,
    ...overrides,
  };
}

const PUBLIC_VIEW = trackView();

const PRIVATE_VIEW = trackView({
  end_at: "2026-10-13T18:07:00Z",
  quota_per_day: 3,
  results_released: false,
});

const DUAL_NORMED: CompetitionDetail = {
  ...BASE,
  mode: "public_private",
  // Quota cấp cuộc thi không tồn tại ở dual - số lượt nằm trong từng nhánh.
  quota_per_day: null,
  normalization: { enabled: true, baseline: 0.4, version: 1 },
  tracks: { public: PUBLIC_VIEW, private: PRIVATE_VIEW },
};

function apiMock(handler: (url: string, call: number) => { body: unknown; status: number }) {
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const r = handler(String(input), call++);
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      });
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
          <Route path="submit" element={<div>Trang nộp bài</div>} />
          <Route path="leaderboard" element={<div>Trang bảng xếp hạng</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Khối tài liệu của Tổng quan - tách khỏi mục lục cùng tên ở rail trái. */
function docList() {
  return within(screen.getByRole("navigation", { name: "Tài liệu cuộc thi" }));
}

test("/competitions/:slug dừng ở Tổng quan, không tự chuyển sang tài liệu đầu tiên", async () => {
  apiMock((url) => {
    if (url.endsWith("/contents/problem")) {
      return { body: { ...CONTENTS.contents[0], markdown: "# Đề bài chi tiết" }, status: 200 };
    }
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: BASE, status: 200 };
  });
  renderAt("/competitions/ai-challenge-2026");

  expect(await screen.findByRole("heading", { name: "Tổng quan", level: 2 })).toBeTruthy();
  // Markdown của tài liệu đầu tiên không được render - trang tổng quan là đích dừng thật.
  expect(screen.queryByRole("heading", { name: "Đề bài chi tiết" })).toBeNull();
  // Mục lục chỉ được tải sau khi chi tiết cuộc thi xong, nên phải chờ nó xuất hiện.
  await screen.findByRole("navigation", { name: "Tài liệu cuộc thi" });
  expect(docList().getByRole("link", { name: /^Đề bài/ })).toBeTruthy();
  expect(docList().getByRole("link", { name: /^Rules/ })).toBeTruthy();
});

test("Tổng quan nêu thể lệ và quy cách bài nộp bằng dữ liệu thật của cuộc thi", async () => {
  apiMock((url) =>
    url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: BASE, status: 200 },
  );
  renderAt("/competitions/ai-challenge-2026");

  expect(await screen.findByRole("heading", { name: "Tổng quan", level: 2 })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Thể lệ & cách tham gia", level: 3 })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Quy cách bài nộp", level: 3 })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Tài liệu cuộc thi", level: 3 })).toBeTruthy();

  expect(
    screen.getByText(`Diễn ra từ ${formatLocal(BASE.start_at)} đến ${formatLocal(BASE.end_at)}.`),
  ).toBeTruthy();
  expect(screen.getByText("Cần mã do Ban Tổ chức cấp.")).toBeTruthy();
  expect(screen.getByText("Tối đa 7 lượt mỗi ngày.")).toBeTruthy();
  expect(screen.getByText("Cột ID.")).toBeTruthy();
  expect(screen.getByText("Binary")).toBeTruthy();
  expect(screen.getByText("CSV 50 MiB, notebook 20 MiB.")).toBeTruthy();
  // Chưa bật chuẩn hóa thì không được nói gì về norm.
  expect(screen.queryByText("Xếp hạng.")).toBeNull();
  // Masthead cuộc thi một nhánh giữ giá trị gộp: một khoảng thời gian, một hạn mức.
  expect(
    screen.getByText(`${formatLocal(BASE.start_at)} - ${formatLocal(BASE.end_at)}`),
  ).toBeTruthy();
  expect(screen.getByText("7 lượt/ngày")).toBeTruthy();
});

test("cuộc thi bật chuẩn hóa: Tổng quan nói rõ xếp hạng theo norm score", async () => {
  const normed: CompetitionDetail = {
    ...BASE,
    normalization: { enabled: true, baseline: 0.4, version: 1 },
  };
  apiMock((url) =>
    url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: normed, status: 200 },
  );
  renderAt("/competitions/ai-challenge-2026");

  await screen.findByRole("heading", { name: "Tổng quan", level: 2 });
  expect(screen.getByText("Xếp hạng.")).toBeTruthy();
  expect(
    screen.getByText(/Điểm xếp hạng là điểm chuẩn hóa \(norm score, thang 0–100\) quy đổi từ điểm gốc F1/),
  ).toBeTruthy();
  // Masthead giữ chỉ số chính là metric gốc; cách xếp hạng nằm ở dòng Xếp hạng phía trên.
  const masthead = document.querySelector(".comp-facts") as HTMLElement;
  expect(within(masthead).getByText("F1")).toBeTruthy();
});

test("dual bật chuẩn hóa: masthead giữ metric gốc và lịch/hạn mức của cả hai nhánh", async () => {
  apiMock((url) =>
    url.includes("/contents")
      ? { body: CONTENTS, status: 200 }
      : { body: DUAL_NORMED, status: 200 },
  );
  renderAt("/competitions/ai-challenge-2026");

  await screen.findByRole("heading", { name: "Tổng quan", level: 2 });
  const facts = document.querySelector(".comp-facts") as HTMLElement;
  expect(within(facts).getByText("F1")).toBeTruthy();
  // Dual: mỗi nhánh một dòng nhỏ thay cho giá trị gộp "Theo từng nhánh".
  expect(screen.queryByText("Theo từng nhánh")).toBeNull();
  const lines = facts.querySelectorAll(".comp-fact-line");
  expect(lines).toHaveLength(4);
  expect(lines[0]).toHaveTextContent(
    `Public ${formatLocal(PUBLIC_VIEW.start_at)} - ${formatLocal(PUBLIC_VIEW.end_at)}`,
  );
  expect(lines[1]).toHaveTextContent(
    `Private ${formatLocal(PRIVATE_VIEW.start_at)} - ${formatLocal(PRIVATE_VIEW.end_at)}`,
  );
  expect(lines[2]).toHaveTextContent("Public 10 lượt/ngày");
  expect(lines[3]).toHaveTextContent("Private 3 lượt/ngày");
  // Câu dẫn cũ ở masthead và ở khối "Hai nhánh thi đấu" đã bị bỏ.
  expect(screen.queryByText("Hai nhánh: Public và Private")).toBeNull();
  expect(screen.queryByText(/Cuộc thi có hai nhánh/)).toBeNull();
});

test("cấu hình chưa thiết lập hiển thị “Chưa cấu hình”, không lộ null/undefined", async () => {
  const unconfigured: CompetitionDetail = {
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
  };
  apiMock((url) =>
    url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: unconfigured, status: 200 },
  );
  renderAt("/competitions/ai-challenge-2026");

  await screen.findByRole("heading", { name: "Tổng quan", level: 2 });
  // Cột ID, cột dự đoán, cách tính điểm, nhãn dương - cả bốn đều chưa được đặt.
  await waitFor(() => expect(screen.getAllByText("Chưa cấu hình")).toHaveLength(4));
  expect(document.body.textContent).not.toContain("null");
  expect(document.body.textContent).not.toContain("undefined");
});

test("nhãn dương không được tiết lộ thì bỏ hẳn dòng khỏi Tổng quan", async () => {
  const hidden = {
    ...BASE,
    submission_config: { ...BASE.submission_config, pos_label: undefined },
  };
  apiMock((url) =>
    url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: hidden, status: 200 },
  );
  renderAt("/competitions/ai-challenge-2026");

  await screen.findByRole("heading", { name: "Tổng quan", level: 2 });
  expect(screen.getByText("Cột ID.")).toBeTruthy();
  expect(screen.queryByText("Nhãn dương.")).toBeNull();
});

test("lỗi mục lục nội dung không xoá thể lệ/quy cách và có nút thử lại tải được danh sách", async () => {
  const user = userEvent.setup();
  let contentsFailed = false;
  apiMock((url) => {
    if (url.includes("/contents")) {
      if (!contentsFailed) {
        contentsFailed = true;
        return { body: { error: { code: "INTERNAL", message: "Lỗi máy chủ." } }, status: 500 };
      }
      return { body: CONTENTS, status: 200 };
    }
    return { body: BASE, status: 200 };
  });
  renderAt("/competitions/ai-challenge-2026");

  await screen.findByRole("heading", { name: "Tổng quan", level: 2 });
  // Khối tài liệu báo lỗi, nhưng phần thể lệ và quy cách vẫn còn nguyên.
  expect(await screen.findByText("Không tải được danh sách tài liệu cuộc thi.")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Thể lệ & cách tham gia", level: 3 })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Quy cách bài nộp", level: 3 })).toBeTruthy();
  expect(screen.getByText("Tối đa 7 lượt mỗi ngày.")).toBeTruthy();

  const retry = screen.getAllByRole("button", { name: "Thử lại" });
  await user.click(retry[retry.length - 1]);
  await waitFor(() => expect(docList().getByRole("link", { name: /^Đề bài/ })).toBeTruthy());
});

test("admin xem trước (chưa có membership): Tổng quan nói rõ vì sao chưa nộp được", async () => {
  // Admin đọc được payload nhưng chưa tham gia cuộc thi; gate vẫn mở nên đây là nhánh
  // duy nhất còn thấy được thông báo chặn nộp bài "chưa tham gia" trong Tổng quan.
  const preview: CompetitionDetail = { ...BASE, membership: { active: false, joined_at: null } };
  apiMock((url) =>
    url.includes("/contents") ? { body: CONTENTS, status: 200 } : { body: preview, status: 200 },
  );
  renderAt("/competitions/ai-challenge-2026");

  const overview = (await screen.findByRole("heading", { name: "Tổng quan", level: 2 })).closest("section")!;
  // Mục lục cuộc thi luôn có link điều hướng "Nộp bài"; ý của test là CTA trong Tổng quan không render.
  expect(within(overview).queryByRole("link", { name: "Nộp bài" })).toBeNull();
  expect(
    screen.getByText("Nhập mã do Ban Tổ chức cấp ở khối tham gia phía trên để bắt đầu nộp bài."),
  ).toBeTruthy();
  // Cuộc thi công khai bảng xếp hạng nên vẫn còn lối vào đó.
  expect(screen.getByRole("link", { name: "Xem bảng xếp hạng" })).toBeTruthy();
});
