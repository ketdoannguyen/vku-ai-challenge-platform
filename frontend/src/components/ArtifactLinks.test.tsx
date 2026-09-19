import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { SubmissionArtifacts } from "../api/results";
import { ArtifactLinks } from "./ArtifactLinks";

const FULL: SubmissionArtifacts = {
  prediction: { filename: "prediction.csv", size_bytes: 128, available: true },
  notebook: { filename: "notebook.ipynb", size_bytes: 4096, available: true },
};

const LEGACY: SubmissionArtifacts = {
  prediction: { filename: "first.csv", size_bytes: null, available: true },
  notebook: null,
};

function renderLinks(artifacts = FULL, basePath = "/admin/submissions") {
  return render(
    <ArtifactLinks basePath={basePath} submissionId="s1" artifacts={artifacts} />,
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("chỉ hiện nút cho tệp backend thực sự có", () => {
  const { unmount } = renderLinks(LEGACY);
  expect(screen.getByRole("button", { name: "CSV" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Notebook" })).toBeNull();
  unmount();

  // Không còn tệp nào (ví dụ submission đã bị dọn) thì báo rõ thay vì để cột trống.
  renderLinks({ prediction: null, notebook: null });
  expect(screen.getByText("Không có tệp")).toBeTruthy();
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

  renderLinks(FULL, "/competitions/c1/submissions");
  fireEvent.click(screen.getByRole("button", { name: "Notebook" }));

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

  renderLinks();
  fireEvent.click(screen.getByRole("button", { name: "CSV" }));

  expect(await screen.findByText(/Hệ thống lưu trữ tạm thời không khả dụng/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "CSV" })).toBeEnabled();
});
