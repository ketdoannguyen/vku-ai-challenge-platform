import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { SubmissionArtifacts } from "../api/results";
import {
  ArtifactLinks,
  LazyArtifactViewerModal,
  type ArtifactKind,
  type ArtifactViewerTarget,
} from "./ArtifactLinks";

const FULL: SubmissionArtifacts = {
  prediction: { filename: "prediction.csv", size_bytes: 128, available: true },
  notebook: { filename: "notebook.ipynb", size_bytes: 4096, available: true },
};

const LEGACY: SubmissionArtifacts = {
  prediction: { filename: "first.csv", size_bytes: null, available: true },
  notebook: null,
};

/**
 * Bản sao tối giản của hai nơi gọi thật: trạng thái trình xem nằm ở cấp cha, cả danh sách chỉ có
 * MỘT trình xem, còn `ArtifactLinks` chỉ báo tệp cần mở qua `onView`.
 */
function Harness({
  artifacts = FULL,
  basePath = "/admin/submissions",
  onView,
}: {
  artifacts?: SubmissionArtifacts;
  basePath?: string;
  onView?: (kind: ArtifactKind, submissionId: string, filename: string) => void;
}) {
  const [viewer, setViewer] = useState<ArtifactViewerTarget | null>(null);
  return (
    <>
      <ArtifactLinks
        basePath={basePath}
        submissionId="s1"
        artifacts={artifacts}
        onView={(kind, submissionId, filename) => {
          onView?.(kind, submissionId, filename);
          setViewer({ kind, submissionId, filename });
        }}
      />
      {viewer && (
        <Suspense fallback={<span role="status">Đang mở trình xem…</span>}>
          <LazyArtifactViewerModal
            path={`${basePath}/${viewer.submissionId}/${viewer.kind}`}
            kind={viewer.kind}
            filename={viewer.filename}
            onClose={() => setViewer(null)}
          />
        </Suspense>
      )}
    </>
  );
}

/** Notebook tối thiểu để trình xem đọc được; nội dung cell không phải thứ các test này kiểm. */
function notebookResponse() {
  return new Response(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("chỉ hiện nút cho tệp backend thực sự có", () => {
  const { unmount } = render(<Harness artifacts={LEGACY} />);
  expect(screen.getByRole("button", { name: "Tải CSV" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Xem CSV" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Tải Notebook" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Xem Notebook" })).toBeNull();
  unmount();

  // Không còn tệp nào (ví dụ submission đã bị dọn) thì báo rõ thay vì để cột trống.
  render(<Harness artifacts={{ prediction: null, notebook: null }} />);
  expect(screen.getByText("Không có tệp")).toBeTruthy();
});

test("mỗi loại tệp có nhãn riêng và hai nút icon có tên truy cập, tooltip tên tệp", () => {
  const { container } = render(<Harness />);
  expect(screen.getByText("CSV")).toHaveClass("artifact-link-kind");
  expect(screen.getByText("Notebook")).toHaveClass("artifact-link-kind");
  expect(screen.getAllByRole("button")).toHaveLength(4);
  const csvButtons = ["Xem CSV", "Tải CSV"].map((name) => screen.getByRole("button", { name }));
  for (const button of csvButtons) {
    expect(button).toHaveAttribute("title", "prediction.csv");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  }
  expect(container.querySelectorAll('.artifact-link-group')).toHaveLength(2);
});

test("không truyền callback thì chỉ còn nút tải, không dựng trình xem", () => {
  render(<ArtifactLinks basePath="/admin/submissions" submissionId="s1" artifacts={FULL} />);
  expect(screen.getByRole("button", { name: "Tải CSV" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Tải Notebook" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Xem CSV" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Xem Notebook" })).toBeNull();
});

test("xem CSV dùng route đã đăng nhập, đóng dialog trả focus về nút", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response("id,label\n1,cat\n", { status: 200 });
  }));

  render(<Harness basePath="/competitions/c1/submissions" />);
  const trigger = screen.getByRole("button", { name: "Xem CSV" });
  // Trình xem nạp lười nên modal mount sau cú bấm; chính cú bấm phải đặt focus vào nút
  // để lượt đóng sau đó trả focus về đúng chỗ.
  fireEvent.click(trigger);

  expect(await screen.findByRole("dialog", { name: /prediction\.csv/ })).toBeTruthy();
  expect(await screen.findByRole("table")).toBeTruthy();
  expect(requests).toEqual(["/api/competitions/c1/submissions/s1/prediction"]);
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("xem notebook đi đúng route admin, đóng dialog trả focus về nút", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return notebookResponse();
  }));

  render(<Harness basePath="/admin/submissions" />);
  const trigger = screen.getByRole("button", { name: "Xem Notebook" });
  trigger.focus();
  fireEvent.click(trigger);

  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(requests).toEqual(["/api/admin/submissions/s1/notebook"]);
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("báo cho nơi gọi biết tệp cần mở, kèm id bài nộp và tên tệp", async () => {
  const onView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("id,label\n1,cat\n", { status: 200 })));

  render(<Harness onView={onView} />);
  fireEvent.click(screen.getByRole("button", { name: "Xem CSV" }));

  await screen.findByRole("dialog");
  expect(onView).toHaveBeenCalledTimes(1);
  expect(onView).toHaveBeenCalledWith("prediction", "s1", "prediction.csv");
});

test("tải đúng route của nơi gọi và dùng tên file từ Content-Disposition", async () => {
  const { anchorClick, revokeObjectURL } = stubBlobDownload();
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response("csv-bytes", {
        status: 200,
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": "attachment; filename*=UTF-8''ket%20qua.csv",
        },
      });
    }),
  );

  render(<ArtifactLinks basePath="/competitions/c1/submissions" submissionId="s1" artifacts={FULL} />);
  fireEvent.click(screen.getByRole("button", { name: "Tải Notebook" }));

  await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
  expect(requests).toEqual(["/api/competitions/c1/submissions/s1/notebook"]);
  const anchor = anchorClick.mock.instances[0] as unknown as HTMLAnchorElement;
  expect(anchor.download).toBe("ket qua.csv");
  expect(anchor.isConnected).toBe(false);
  // revoke nằm trong macrotask kế tiếp để trình duyệt kịp đọc blob.
  await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-download"));
});

test("lỗi 503 hiện ngay trong dòng thay vì làm hỏng cả bảng", async () => {
  stubBlobDownload();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "ARTIFACT_STORAGE_UNAVAILABLE",
            message: "Hệ thống lưu trữ tạm thời không khả dụng. Vui lòng thử lại sau.",
          },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );

  render(<ArtifactLinks basePath="/admin/submissions" submissionId="s1" artifacts={FULL} />);
  fireEvent.click(screen.getByRole("button", { name: "Tải CSV" }));

  expect(await screen.findByText(/Hệ thống lưu trữ tạm thời không khả dụng/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Tải CSV" })).toBeEnabled();
});
