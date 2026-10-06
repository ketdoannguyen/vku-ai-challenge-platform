/**
 * Dialog Tạo/Sửa cuộc thi: cấu trúc 5 section, shell header/body/footer và các
 * invariant nghiệp vụ (payload, khoá slug khi published, lỗi API).
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Competition } from "../api/competitions";
import { CompetitionActionConfirmModal, CompetitionFormModal } from "./AdminCompetitionManagement";

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
    max_notebook_mb: 20,
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

/** Section chứa control - dùng để chốt control nào thuộc nhóm nào. */
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
  // Metric không còn do form này quyết định: bộ chấm Python + result_contract ở tab
  // "Chấm điểm" mới là nơi khai báo cách chấm, nên form không được hỏi lại.
  expect(screen.queryByLabelText("Chỉ số chính")).toBeNull();
  expect(titleOf(screen.getByLabelText(/Giới hạn nộp bài/))).toBe(
    "Chấm điểm & giới hạn",
  );
  expect(titleOf(screen.getByLabelText(/Leaderboard hiển thị với thí sinh/))).toBe(
    "Chấm điểm & giới hạn",
  );
  expect(titleOf(screen.getByLabelText(/Tính điểm chuẩn hóa/))).toBe(
    "Chấm điểm & giới hạn",
  );
  expect(titleOf(screen.getByRole("group", { name: "Tài nguyên tải về" }))).toBe(
    "Tài nguyên tải về",
  );

  // Thứ tự DOM phải khớp thứ tự field cũ để tab order không đổi; baseline chỉ xuất hiện khi bật.
  const order = Array.from(
    dialog().querySelectorAll<HTMLElement>("[id^='comp-']"),
  ).map((node) => node.id);
  expect(order).toEqual([
    "comp-name",
    "comp-slug",
    "comp-desc",
    "comp-start",
    "comp-end",
    "comp-quota",
    "comp-leaderboard",
    "comp-normalization",
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
    quota_per_day: 12,
    leaderboard_visible: false,
    resources: [{ label: "Dataset", url: "https://drive.google.com/drive/folders/abc" }],
    // Không bật thì vẫn gửi cấu hình tắt tường minh để không còn baseline mồ côi.
    normalization: { enabled: false, baseline: null },
  });
  // Không gửi primary_metric: field này chỉ là dấu vết dữ liệu v1, gửi lên là vô tình
  // ghi đè cấu hình chấm mà bộ chấm Python ở tab "Chấm điểm" đang sở hữu.
  expect(postedBodies("POST")[0]).not.toHaveProperty("primary_metric");
});

test("slug tự điền theo tên cuộc thi; gõ tay thì giá trị tay thắng", () => {
  renderForm();

  const name = screen.getByLabelText("Tên cuộc thi");
  const slug = screen.getByLabelText("Slug") as HTMLInputElement;

  fireEvent.change(name, { target: { value: "Cuộc thi AI 2026" } });
  expect(slug).toHaveValue("cuoc-thi-ai-2026");

  // Gõ tay vào slug: đổi tên tiếp cũng không ghi đè lựa chọn của admin.
  fireEvent.change(slug, { target: { value: "vku-2026" } });
  fireEvent.change(name, { target: { value: "Tên khác" } });
  expect(slug).toHaveValue("vku-2026");

  // Xoá trắng ô slug là bật lại tự điền.
  fireEvent.change(slug, { target: { value: "" } });
  fireEvent.change(name, { target: { value: "VKU Challenge" } });
  expect(slug).toHaveValue("vku-challenge");
});

test("dialog tạo mới dùng validation tài nguyên chung và không phát POST khi link sai", async () => {
  mockApi(() => ({ body: BASE, status: 200 }));
  renderForm();

  fireEvent.change(screen.getByLabelText("Tên cuộc thi"), { target: { value: "Test Cup" } });
  fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "test-cup" } });
  fireEvent.change(screen.getByLabelText("Bắt đầu"), { target: { value: "2026-11-01T08:00" } });
  fireEvent.change(screen.getByLabelText("Kết thúc"), { target: { value: "2026-11-02T08:00" } });
  fireEvent.click(screen.getByRole("button", { name: "+ Thêm tài nguyên" }));
  fireEvent.change(screen.getByLabelText("Tên tài nguyên 1"), { target: { value: "Dataset" } });
  fireEvent.change(screen.getByLabelText("Link tài nguyên 1"), {
    target: { value: "https://example.com/data.csv" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Tạo" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Link tài nguyên phải là https://drive.google.com hoặc https://docs.google.com.",
  );
  expect(postedBodies("POST")).toHaveLength(0);
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

test("sửa cuộc thi published: slug bị khoá, tài nguyên chuyển sang tab riêng", async () => {
  mockApi((init) =>
    init.method === "PATCH"
      ? { body: { ...BASE, status: "published" }, status: 200 }
      : { body: BASE, status: 200 },
  );
  const published: Competition = {
    ...BASE,
    status: "published",
    resources: [{ label: "Dataset", url: "https://drive.google.com/file/d/abc" }],
  };
  const { onSaved } = renderForm(published);

  expect(screen.getByRole("dialog", { name: /Sửa cuộc thi/ })).toBeTruthy();
  expect(screen.getByLabelText(/Slug/)).toBeDisabled();
  expect(screen.queryByLabelText("Chỉ số chính")).toBeNull();
  expect(screen.queryByRole("group", { name: "Tài nguyên tải về" })).toBeNull();
  expect(sections()).toHaveLength(4);

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
  expect(postedBodies("PATCH")[0]).not.toHaveProperty("resources");
  expect(postedBodies("PATCH")[0]).not.toHaveProperty("primary_metric");
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

test("xác nhận clone nói rõ phạm vi sao chép đầy đủ và các phần không chép", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ...BASE, id: "2" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const onSuccess = vi.fn();
  render(
    <CompetitionActionConfirmModal
      action="clone"
      competition={BASE}
      onSuccess={onSuccess}
      onClose={vi.fn()}
    />,
  );

  const dialog = screen.getByRole("dialog", { name: "Clone cuộc thi" });
  // Copy phải nói rõ có copy API key/đề/đáp án, không copy người dự thi/mã tham gia, và phải
  // kiểm tra lại trước khi publish.
  expect(dialog).toHaveTextContent(/API key/);
  expect(dialog).toHaveTextContent(/không chép người dự thi, mã tham gia/);
  expect(dialog).toHaveTextContent(/kiểm tra lại bộ chấm và kết nối AI trước khi publish/);

  fireEvent.click(within(dialog).getByRole("button", { name: "Clone" }));

  await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(`/api/admin/competitions/${BASE.id}/clone`);
  expect(calls[0].init?.method).toBe("POST");
  // POST clone vẫn không có body: server tự quyết định phạm vi sao chép.
  expect(calls[0].init?.body).toBeUndefined();
  expect(onSuccess.mock.calls[0][0]).toBe("clone");
});

test("bật chuẩn hóa: hiện baseline bắt buộc và gửi đúng payload", async () => {
  mockApi((init) =>
    init.method === "POST" ? { body: { ...BASE, id: "2" }, status: 201 } : { body: BASE, status: 200 },
  );
  renderForm();

  // Chưa bật thì chưa có baseline; lời mô tả không mặc định F1 khi chưa có hợp đồng.
  const toggle = screen.getByLabelText(/Tính điểm chuẩn hóa/);
  expect(screen.queryByLabelText("Baseline chuẩn hóa")).toBeNull();
  expect(screen.getByLabelText(/Tính điểm chuẩn hóa/).closest("label")).toHaveTextContent(
    "lấy từ metric chính ở tab Chấm điểm",
  );

  fireEvent.click(toggle);
  const baseline = screen.getByLabelText("Baseline chuẩn hóa") as HTMLInputElement;
  expect(baseline).toHaveAttribute("type", "number");
  expect(baseline).toHaveAttribute("step", "any");
  // Không ép min 0: baseline 0/âm hợp lệ với metric tương ứng.
  expect(baseline).not.toHaveAttribute("min");

  fireEvent.change(screen.getByLabelText("Tên cuộc thi"), { target: { value: "Test Cup" } });
  fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "test-cup" } });
  fireEvent.change(screen.getByLabelText("Bắt đầu"), { target: { value: "2026-11-01T08:00" } });
  fireEvent.change(screen.getByLabelText("Kết thúc"), { target: { value: "2026-11-02T08:00" } });
  fireEvent.change(baseline, { target: { value: "0.6" } });
  fireEvent.click(screen.getByRole("button", { name: "Tạo" }));

  await waitFor(() => expect(postedBodies("POST")).toHaveLength(1));
  expect(postedBodies("POST")[0]).toMatchObject({
    normalization: { enabled: true, baseline: 0.6 },
  });
});

test("bật chuẩn hóa mà baseline trống thì chặn submit bằng alert tiếng Việt", async () => {
  mockApi(() => ({ body: BASE, status: 200 }));
  renderForm();

  fireEvent.click(screen.getByLabelText(/Tính điểm chuẩn hóa/));
  fireEvent.change(screen.getByLabelText("Tên cuộc thi"), { target: { value: "Test Cup" } });
  fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "test-cup" } });
  fireEvent.change(screen.getByLabelText("Bắt đầu"), { target: { value: "2026-11-01T08:00" } });
  fireEvent.change(screen.getByLabelText("Kết thúc"), { target: { value: "2026-11-02T08:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Tạo" }));

  // Kiểm ngay trên form, không phó mặc cho `required` của trình duyệt: thông báo khớp backend.
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Bật chuẩn hóa cần baseline là số hữu hạn.",
  );
  expect(postedBodies("POST")).toHaveLength(0);

  // Điền lại baseline hợp lệ thì alert biến mất và POST đi bình thường.
  fireEvent.change(screen.getByLabelText("Baseline chuẩn hóa"), { target: { value: "0.6" } });
  fireEvent.click(screen.getByRole("button", { name: "Tạo" }));
  await waitFor(() => expect(postedBodies("POST")).toHaveLength(1));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("sửa nháp đang bật norm: giữ giá trị đã lưu và mô tả đúng metric nguồn", async () => {
  mockApi((init) =>
    init.method === "PATCH" ? { body: BASE, status: 200 } : { body: BASE, status: 200 },
  );
  const draft: Competition = {
    ...BASE,
    normalization: { enabled: true, baseline: 0.4, version: 1 },
  };
  renderForm(draft);

  expect(screen.getByLabelText(/Tính điểm chuẩn hóa/)).toBeChecked();
  expect(screen.getByLabelText("Baseline chuẩn hóa")).toHaveValue(0.4);
  // Metric nguồn lấy từ hợp đồng kết quả v1 (f1) kèm chiều xếp hạng, không phải chuỗi cứng.
  expect(screen.getByLabelText(/Tính điểm chuẩn hóa/).closest("label")).toHaveTextContent(
    "metric F1 (cao hơn là tốt hơn)",
  );

  // Tắt chuẩn hóa rồi lưu: gửi cấu hình tắt tường minh để không còn baseline mồ côi.
  fireEvent.click(screen.getByLabelText(/Tính điểm chuẩn hóa/));
  fireEvent.change(screen.getByLabelText("Tên cuộc thi"), { target: { value: "Đổi tên" } });
  fireEvent.click(screen.getByRole("button", { name: "Lưu" }));

  await waitFor(() => expect(postedBodies("PATCH")).toHaveLength(1));
  expect(postedBodies("PATCH")[0]).toMatchObject({
    name: "Đổi tên",
    normalization: { enabled: false, baseline: null },
  });
});

test("cuộc thi đã publish: cấu hình norm readonly kèm lý do và không gửi trong PATCH", async () => {
  mockApi((init) =>
    init.method === "PATCH" ? { body: BASE, status: 200 } : { body: BASE, status: 200 },
  );
  const published: Competition = {
    ...BASE,
    status: "published",
    normalization: { enabled: true, baseline: 0.4, version: 1 },
  };
  renderForm(published);

  expect(screen.getByLabelText(/Tính điểm chuẩn hóa/)).toBeDisabled();
  expect(screen.getByLabelText("Baseline chuẩn hóa")).toBeDisabled();
  expect(dialog()).toHaveTextContent(
    "Cấu hình chuẩn hóa chỉ sửa được khi cuộc thi còn nháp",
  );

  fireEvent.change(screen.getByLabelText("Tên cuộc thi"), { target: { value: "Đổi tên" } });
  fireEvent.click(screen.getByRole("button", { name: "Lưu" }));

  await waitFor(() => expect(postedBodies("PATCH")).toHaveLength(1));
  // Gửi lại field readonly sẽ làm hỏng các chỉnh sửa khác (backend khóa cấu hình đã publish).
  expect(postedBodies("PATCH")[0]).not.toHaveProperty("normalization");
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
