/** Admin competition detail: content table, member actions, join code không hiện trong DOM. */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  expect(screen.getByText("Chưa có file")).toBeTruthy();
  expect(screen.getByText("Đã upload")).toBeTruthy();
  expect(screen.getByText("Chỉ thành viên")).toBeTruthy();
});

test("thêm thành viên gửi email đúng endpoint", async () => {
  mockApi((url) => {
    if (url.includes("/members")) return { body: MEMBERS, status: 200 };
    if (url.includes("/contents")) return { body: CONTENTS, status: 200 };
    return { body: COMPETITION, status: 200 };
  });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Thành viên & mã tham gia" }));
  const input = await screen.findByLabelText("Email thành viên");
  fireEvent.change(input, { target: { value: "thi.sinh@vku.vn" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => {
    const addCall = calls.find((c) => c.url.endsWith("/members") && c.init?.method !== "GET" && !c.init?.method);
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
  await waitFor(() => screen.getByText("Đã cập nhật mã tham gia."));
  expect(screen.queryByText("new-secret-2026")).toBeNull();
});

test("đổi trạng thái member gọi PATCH đúng", async () => {
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
  await waitFor(() => {
    const patch = calls.find((c) => c.init?.method === "PATCH" && c.url.includes("/members/u1"));
    expect(patch).toBeTruthy();
    expect(JSON.parse(patch!.init!.body as string)).toEqual({ active: false });
  });
});
