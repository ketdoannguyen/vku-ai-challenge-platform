/** JoinControl: các trạng thái membership + join mode. */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import type { Competition } from "../api/competitions";
import { JoinControl } from "./JoinControl";

function makeCompetition(overrides: Partial<Competition> = {}): Competition {
  return {
    id: "1",
    slug: "ai-cup",
    name: "AI Cup",
    short_description: "",
    status: "published",
    start_at: "2026-10-01T00:00:00Z",
    end_at: "2026-11-01T00:00:00Z",
    join_mode: "open",
    primary_metric: "f1",
    quota_per_day: 5,
    leaderboard_visible: true,
    created_by: "admin@vku.vn",
    join_code_configured: false,
    membership: { active: false, joined_at: null },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("open mode: nút Tham gia gọi API và báo joined", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          competition_id: "1",
          membership: { active: true, joined_at: "2026-09-15T00:00:00Z" },
          joined_now: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
  const onJoined = vi.fn();
  render(
    <MemoryRouter>
      <JoinControl competition={makeCompetition()} onJoined={onJoined} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Tham gia" }));
  await waitFor(() => expect(onJoined).toHaveBeenCalledWith({ active: true, joined_at: "2026-09-15T00:00:00Z" }));
});

test("code mode: mở dialog, sai mã hiện lỗi inline", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "JOIN_CODE_INVALID", message: "Mã tham gia không hợp lệ." } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  render(
    <MemoryRouter>
      <JoinControl competition={makeCompetition({ join_mode: "code", join_code_configured: true })} onJoined={vi.fn()} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Nhập mã tham gia" }));
  const input = await screen.findByLabelText("Mã tham gia");
  fireEvent.change(input, { target: { value: "sai-ma" } });
  fireEvent.click(screen.getByRole("button", { name: "Tham gia" }));
  await waitFor(() => screen.getByRole("alert"));
  expect(screen.getByText("Mã tham gia không hợp lệ.")).toBeTruthy();
});

test("invite_only: chỉ hiện hướng dẫn, không có nút join", () => {
  render(
    <MemoryRouter>
      <JoinControl competition={makeCompetition({ join_mode: "invite_only" })} onJoined={vi.fn()} />
    </MemoryRouter>,
  );
  expect(screen.getByText(/Chỉ dành cho tài khoản được mời/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Tham gia/ })).toBeNull();
});

test("đã join: badge + link Vào cuộc thi", () => {
  render(
    <MemoryRouter>
      <JoinControl
        competition={makeCompetition({ membership: { active: true, joined_at: "2026-09-15T00:00:00Z" } })}
        onJoined={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText("Đã tham gia")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Vào cuộc thi" }).getAttribute("href")).toBe("/competitions/ai-cup");
});

test("membership inactive: thông báo liên hệ BTC, không có nút join", () => {
  render(
    <MemoryRouter>
      <JoinControl
        competition={makeCompetition({ membership: { active: false, joined_at: "2026-09-15T00:00:00Z" } })}
        onJoined={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText(/Membership đã bị vô hiệu hóa/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Tham gia/ })).toBeNull();
});

test("closed: không cho join", () => {
  render(
    <MemoryRouter>
      <JoinControl competition={makeCompetition({ status: "closed" })} onJoined={vi.fn()} />
    </MemoryRouter>,
  );
  expect(screen.getByText(/Cuộc thi đã kết thúc/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Tham gia/ })).toBeNull();
});
