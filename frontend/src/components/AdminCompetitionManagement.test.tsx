/**
 * Dialog Tạo/Sửa cuộc thi: cấu trúc 5 section, shell header/body/footer và các
 * invariant nghiệp vụ (payload, khoá slug/metric khi published, lỗi API).
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Competition } from "../api/competitions";
import { CompetitionFormModal } from "./AdminCompetitionManagement";

const BASE: Competition = {
  id: "1",
  slug: "ai-challenge-2026",
  name: "AI Challenge 2026",
  short_description: "",
  status: "draft",
  start_at: "2026-10-01T00:00:00Z",
  end_at: "2026-11-01T00:00:00Z",
  join_mode: "open",
  primary_metric: "f1",
  quota_per_day: 5,
  leaderboard_visible: true,
  join_code_configured: false,
  resources: [],
  membership: { active: false, joined_at: null },
  submission_config: {
    ready: false,
    id_column: null,
    prediction_column: null,
    average: null,
    max_upload_mb: 10,
  },
};

const SECTION_TITLES = [
  "Thông tin cơ bản",
  "Thời gian",
  "Cách tham gia",
  "Chấm điểm & giới hạn",
  "Tài nguyên tải về",
];

/** Ghi lại body của các request POST/PATCH để assert payload. */
function mockApi(respond: (init: RequestInit) => { body: unknown; status: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { body, status } = respond(init ?? {});
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function renderForm(competition?: Competition, onClose = vi.fn()) {
  const onSaved = vi.fn();
  render(
    <CompetitionFormModal
      competition={competition}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onClose, onSaved };
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function sections(): HTMLElement[] {
  return Array.from(dialog().querySelectorAll<HTMLElement>("section.ac-form-section"));
}

/** Section chứa control — dùng để chốt control nào thuộc nhóm nào. */
function sectionOf(control: HTMLElement): HTMLElement {
  const section = control.closest<HTMLElement>("section.ac-form-section");
  if (!section) throw new Error("Control không nằm trong section nào.");
  return section;
}

function postedBodies(filter: "POST" | "PATCH"): unknown[] {
  return (fetch as ReturnType<typeof vi.fn>).mock.calls
    .filter((call) => call[1]?.method === filter)
    .map((call) => JSON.parse(String(call[1]?.body)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("dialog có tên 'Tạo cuộc thi', focus ban đầu ở ô Tên và Escape đóng dialog", () => {
  mockApi(() => ({ body: BASE, status: 200 }));
  const { onClose } = renderForm();

  expect(screen.getByRole("dialog", { name: "Tạo cuộc thi" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText("Tên cuộc thi"));

  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("body chia đúng 5 section theo thứ tự, mỗi section có số thứ tự decorative", () => {
  mockApi(() => ({ body: BASE, status: 200 }));
  renderForm();

  const headings = sections().map(
    (section) => within(section).getByRole("heading", { level: 3 }).textContent,
  );
  expect(headings).toEqual(SECTION_TITLES);

  const numbers = Array.from(
    dialog().querySelectorAll<HTMLElement>(".ac-form-section-num"),
  );
  expect(numbers.map((node) => node.textContent)).toEqual(["01", "02", "03", "04", "05"]);
  // Số thứ tự và icon là trang trí: không được lọt vào tên section.
  for (const node of numbers) expect(node).toHaveAttribute("aria-hidden", "true");
});

test("nhịp màu section là blue/red/yellow/blue/yellow", () => {
  mockApi(() => ({ body: BASE, status: 200 }));
  renderForm();

  expect(sections().map((section) => section.dataset.tone)).toEqual([
    "blue",
    "red",
    "yellow",
    "blue",
    "yellow",
  ]);
});

test("mỗi control nằm đúng section và giữ nguyên thứ tự field hiện tại", () => {
  mockApi(() => ({ body: BASE, status: 200 }));
  renderForm();

  const titleOf = (control: HTMLElement) =>
    within(sectionOf(control)).getByRole("heading", { level: 3 }).textContent;

  expect(titleOf(screen.getByLabelText("Tên cuộc thi"))).toBe("Thông tin cơ bản");
  expect(titleOf(screen.getByLabelText("Slug"))).toBe("Thông tin cơ bản");
  expect(titleOf(screen.getByLabelText("Mô tả ngắn"))).toBe("Thông tin cơ bản");
  expect(titleOf(screen.getByLabelText("Bắt đầu"))).toBe("Thời gian");
  expect(titleOf(screen.getByLabelText("Kết thúc"))).toBe("Thời gian");
  expect(titleOf(screen.getByRole("group", { name: "Cách tham gia" }))).toBe(
    "Cách tham gia",
  );
  expect(titleOf(screen.getByLabelText("Chỉ số chính"))).toBe("Chấm điểm & giới hạn");
  expect(titleOf(screen.getByLabelText(/Giới hạn nộp bài/))).toBe(
    "Chấm điểm & giới hạn",
  );
  expect(titleOf(screen.getByLabelText(/Leaderboard hiển thị với thí sinh/))).toBe(
    "Chấm điểm & giới hạn",
  );
  expect(titleOf(screen.getByRole("group", { name: "Tài nguyên tải về" }))).toBe(
    "Tài nguyên tải về",
  );

  // Thứ tự DOM phải khớp thứ tự field cũ để tab order không đổi.
  const order = Array.from(
    dialog().querySelectorAll<HTMLElement>("[id^='comp-']"),
  ).map((node) => node.id);
  expect(order).toEqual([
    "comp-name",
    "comp-slug",
    "comp-desc",
    "comp-start",
    "comp-end",
    "comp-metric",
    "comp-quota",
    "comp-leaderboard",
  ]);
});

test("Cách tham gia vẫn là nhóm radio ngữ nghĩa với 3 lựa chọn, mặc định open", () => {
  mockApi(() => ({ body: BASE, status: 200 }));
  renderForm();

  const group = screen.getByRole("group", { name: "Cách tham gia" });
  const radios = within(group).getAllByRole("radio");
  expect(radios).toHaveLength(3);
  expect(radios.map((radio) => (radio as HTMLInputElement).value)).toEqual([
    "open",
    "code",
    "invite_only",
  ]);

  const [openRadio, codeRadio, inviteRadio] = radios as HTMLInputElement[];
  expect(openRadio.checked).toBe(true);

  for (const radio of [codeRadio, inviteRadio, openRadio]) {
    fireEvent.click(radio);
    expect(radio.checked).toBe(true);
  }
});

test("payload tạo mới giữ nguyên key, kiểu và giá trị của mọi field", async () => {
  mockApi((init) =>
    init.method === "POST" ? { body: { ...BASE, id: "2" }, status: 201 } : { body: BASE, status: 200 },
  );
  renderForm();

  fireEvent.change(screen.getByLabelText("Tên cuộc thi"), { target: { value: "Test Cup" } });
  fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "test-cup" } });
  fireEvent.change(screen.getByLabelText("Mô tả ngắn"), { target: { value: "Mô tả ngắn" } });
  fireEvent.change(screen.getByLabelText("Bắt đầu"), { target: { value: "2026-11-01T08:00" } });
  fireEvent.change(screen.getByLabelText("Kết thúc"), { target: { value: "2026-11-02T08:00" } });
  fireEvent.click(screen.getByRole("radio", { name: /Cần mã tham gia/ }));
  fireEvent.change(screen.getByLabelText("Chỉ số chính"), { target: { value: "recall" } });
  fireEvent.change(screen.getByLabelText(/Giới hạn nộp bài/), { target: { value: "12" } });
  fireEvent.click(screen.getByLabelText(/Leaderboard hiển thị với thí sinh/));

  fireEvent.click(screen.getByRole("button", { name: "+ Thêm tài nguyên" }));
  fireEvent.change(screen.getByLabelText("Tên tài nguyên 1"), { target: { value: "Dataset" } });
  fireEvent.change(screen.getByLabelText("Link tài nguyên 1"), {
    target: { value: "https://drive.google.com/drive/folders/abc" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Tạo" }));

  await waitFor(() => expect(postedBodies("POST")).toHaveLength(1));
  expect(postedBodies("POST")[0]).toEqual({
    name: "Test Cup",
    slug: "test-cup",
    short_description: "Mô tả ngắn",
    start_at: new Date("2026-11-01T08:00").toISOString(),
    end_at: new Date("2026-11-02T08:00").toISOString(),
    join_mode: "code",
    primary_metric: "recall",
    quota_per_day: 12,
    leaderboard_visible: false,
    resources: [{ label: "Dataset", url: "https://drive.google.com/drive/folders/abc" }],
  });
});

test("lỗi API giữ dialog mở, hiện đúng một alert và cho phép submit lại", async () => {
  let attempts = 0;
  mockApi((init) => {
    if (init.method !== "POST") return { body: BASE, status: 200 };
    attempts += 1;
    return attempts === 1
      ? {
          body: { error: { code: "SLUG_TAKEN", message: "Slug đã được dùng." } },
          status: 409,
        }
      : { body: { ...BASE, id: "3" }, status: 201 };
  });
  const { onSaved } = renderForm();

  fireEvent.change(screen.getByLabelText("Tên cuộc thi"), { target: { value: "Test Cup" } });
  fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "test-cup" } });
  fireEvent.change(screen.getByLabelText("Bắt đầu"), { target: { value: "2026-11-01T08:00" } });
  fireEvent.change(screen.getByLabelText("Kết thúc"), { target: { value: "2026-11-02T08:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Tạo" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Slug đã được dùng.");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(dialog()).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Tạo" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("sửa cuộc thi published: slug và metric bị khoá, field khác vẫn sửa được", async () => {
  mockApi((init) =>
    init.method === "PATCH"
      ? { body: { ...BASE, status: "published" }, status: 200 }
      : { body: BASE, status: 200 },
  );
  const published: Competition = { ...BASE, status: "published" };
  const { onSaved } = renderForm(published);

  expect(screen.getByRole("dialog", { name: /Sửa cuộc thi/ })).toBeTruthy();
  expect(screen.getByLabelText(/Slug/)).toBeDisabled();
  expect(screen.getByLabelText("Chỉ số chính")).toBeDisabled();

  fireEvent.change(screen.getByLabelText("Tên cuộc thi"), {
    target: { value: "Đổi tên" },
  });
  fireEvent.change(screen.getByLabelText(/Giới hạn nộp bài/), { target: { value: "9" } });
  fireEvent.click(screen.getByRole("button", { name: "Lưu" }));

  await waitFor(() => expect(postedBodies("PATCH")).toHaveLength(1));
  expect(postedBodies("PATCH")[0]).toMatchObject({
    name: "Đổi tên",
    slug: "ai-challenge-2026",
    quota_per_day: 9,
  });
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

test("shell: header/footer là anh em trực tiếp của body, không bị bọc thêm", () => {
  mockApi(() => ({ body: BASE, status: 200 }));
  renderForm();

  const root = dialog();
  const form = root.querySelector("form.ac-form") as HTMLElement;
  const head = root.querySelector(".modal-head") as HTMLElement;
  const body = root.querySelector(".ac-form-body") as HTMLElement;
  const footer = root.querySelector(".ac-form-footer") as HTMLElement;

  // `.ac-form` là `display: contents`; chỉ được đúng một tầng bọc này, thêm wrapper
  // nào nữa là header/footer mất tư cách flex item và sticky vỡ.
  expect(head.parentElement).toBe(root);
  expect(body.parentElement).toBe(form);
  expect(footer.parentElement).toBe(form);
  expect(root.querySelector(".ac-form-eyebrow")?.parentElement).toBe(form);

  // Chỉ body cuộn: header và footer không được nằm trong vùng cuộn.
  expect(body.contains(head)).toBe(false);
  expect(body.contains(footer)).toBe(false);

  // Mọi section nằm trong body, không section nào lọt ra ngoài.
  expect(body.querySelectorAll(".ac-form-section")).toHaveLength(5);
  expect(root.querySelectorAll(".ac-form-section")).toHaveLength(5);
});

test("section 05 giữ nguyên hành vi thêm/xóa và trần 10 tài nguyên", () => {
  mockApi(() => ({ body: BASE, status: 200 }));
  renderForm();

  const group = screen.getByRole("group", { name: "Tài nguyên tải về" });
  expect(within(group).getByText("Chưa có tài nguyên nào.")).toBeTruthy();

  const add = within(group).getByRole("button", { name: "+ Thêm tài nguyên" });
  for (let index = 0; index < 10; index += 1) fireEvent.click(add);
  expect(within(group).getByLabelText("Tên tài nguyên 10")).toBeTruthy();
  expect(add).toBeDisabled();

  fireEvent.click(within(group).getByRole("button", { name: "Xóa tài nguyên 1" }));
  expect(within(group).queryByLabelText("Tên tài nguyên 10")).toBeNull();
  expect(add).toBeEnabled();
});
