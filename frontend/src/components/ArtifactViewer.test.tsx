/**
 * Trình xem artifact: nạp tệp qua API rồi render bằng parser. Những thứ test ở đây bảo vệ:
 * - Trạng thái: đang tải, lỗi tải/parse, nút thử lại gọi lại đúng route (404 lẫn 503).
 * - An toàn: tệp là dữ liệu không tin cậy - không script, không link/ảnh từ markdown kể cả HTML
 *   đã escape; output chỉ là text/ảnh base64 trong allowlist.
 * - Notebook: cell theo số 1-based, 50 cell mỗi lô kèm bộ đếm, nguồn dài mở lại toàn bộ tại chỗ,
 *   phần bị cắt nói rõ.
 * - CSV: bảng tách header, chia lô "Xem thêm", cảnh báo chạm trần hiện rõ.
 * - Dialog: tiêu đề kèm tên tệp, nội dung chỉ để đọc nên không có nút tải riêng.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  CSV_CELL_TRUNCATED_NOTICE,
  CSV_COLUMN_LIMIT_NOTICE,
  CSV_ROW_LIMIT_NOTICE,
  MAX_CSV_CELL_CHARS,
  MAX_CSV_COLUMNS,
  MAX_CSV_ROWS,
  MAX_NOTEBOOK_TEXT_CHARS,
  NOTEBOOK_OMISSION_LABEL,
  NOTEBOOK_TRUNCATED_LABEL,
} from "../lib/artifactPreview";
import { ArtifactViewerContent, ArtifactViewerModal } from "./ArtifactViewer";

const NOTEBOOK_PATH = "/competitions/c1/submissions/s1/notebook";
const CSV_PATH = "/competitions/c1/submissions/s1/prediction";

function fileResponse(body: string, contentType: string) {
  return new Response(body, { status: 200, headers: { "Content-Type": contentType } });
}

function errorResponse(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub fetch trả lần lượt từng response đã dựng và ghi lại URL đã gọi. */
function stubFetch(...responses: Response[]) {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      const response = responses[requests.length - 1];
      if (!response) throw new Error("fetch bị gọi nhiều hơn số response đã dựng");
      return response;
    }),
  );
  return requests;
}

function notebookJson(cells: unknown[]): string {
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells });
}

function renderViewer(
  path = NOTEBOOK_PATH,
  kind: "notebook" | "prediction" = "notebook",
  filename = "solution.ipynb",
) {
  return render(<ArtifactViewerContent path={path} kind={kind} filename={filename} />);
}

/** Nội dung các khối `<pre>` theo thứ tự tài liệu. */
function preTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("pre")).map((pre) => pre.textContent ?? "");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("hiện trạng thái đang tải rồi dựng notebook theo đúng số cell", async () => {
  let release: (response: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return pending;
    }),
  );

  renderViewer();
  expect(screen.getByRole("status")).toHaveTextContent("Đang tải tệp");
  expect(screen.getByText("solution.ipynb")).toBeTruthy();

  release(
    fileResponse(
      notebookJson([
        { cell_type: "markdown", source: ["# Giới thiệu\n"] },
        { cell_type: "code", execution_count: 2, source: ["print('xin chào')"], outputs: [] },
      ]),
      "application/x-ipynb+json",
    ),
  );

  expect(await screen.findByText("Cell 1 · Markdown")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Giới thiệu" })).toBeTruthy();
  expect(screen.getByText("Cell 2 · Code · In [2]")).toBeTruthy();
  expect(screen.getByText("print('xin chào')")).toBeTruthy();
  // Notebook ngắn hiện hết vẫn có bộ đếm để biết không cell nào bị giấu.
  expect(screen.getByText("Đang hiện 2/2 cell.")).toBeTruthy();
  expect(requests).toEqual([`/api${NOTEBOOK_PATH}`]);
});

test("notebook không có cell nào thì nói rõ thay vì để trống", async () => {
  stubFetch(fileResponse(notebookJson([]), "application/x-ipynb+json"));
  renderViewer();

  expect(await screen.findByText("Notebook không có cell nào.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Hiện thêm/ })).toBeNull();
});

test("notebook dài chỉ dựng 50 cell đầu, bấm Hiện thêm mở dần tới cell cuối", async () => {
  const cells = Array.from({ length: 120 }, (_, index) => ({
    cell_type: "code",
    execution_count: null,
    source: [`c${index + 1}`],
    outputs: [],
  }));
  stubFetch(fileResponse(notebookJson(cells), "application/x-ipynb+json"));
  renderViewer();

  expect(await screen.findByText("Cell 1 · Code · Chưa chạy")).toBeTruthy();
  expect(screen.getByText("Cell 50 · Code · Chưa chạy")).toBeTruthy();
  expect(screen.queryByText("Cell 51 · Code · Chưa chạy")).toBeNull();
  expect(screen.getByText("Đang hiện 50/120 cell.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Hiện thêm 50 cell" }));
  expect(screen.getByText("Cell 100 · Code · Chưa chạy")).toBeTruthy();
  expect(screen.queryByText("Cell 101 · Code · Chưa chạy")).toBeNull();
  expect(screen.getByText("Đang hiện 100/120 cell.")).toBeTruthy();

  // Lô cuối chỉ còn 20 cell: nút ghi đúng số còn lại rồi biến mất khi đã tới cell cuối.
  fireEvent.click(screen.getByRole("button", { name: "Hiện thêm 20 cell" }));
  expect(screen.getByText("Cell 120 · Code · Chưa chạy")).toBeTruthy();
  expect(screen.getByText("Đang hiện 120/120 cell.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Hiện thêm/ })).toBeNull();
});

test("đóng trình xem huỷ yêu cầu tải tệp còn đang chờ", async () => {
  let requestSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }),
  );

  const { unmount } = renderViewer();
  expect(await screen.findByRole("status")).toHaveTextContent("Đang tải tệp");
  expect(requestSignal?.aborted).toBe(false);
  unmount();
  expect(requestSignal?.aborted).toBe(true);
});

test("số dòng code tách khỏi nội dung copy, không tạo dòng dư sau newline cuối", async () => {
  stubFetch(fileResponse(notebookJson([
    { cell_type: "code", source: "a\nb\n", outputs: [{ output_type: "stream", name: "stdout", text: "ok\n" }] },
    { cell_type: "markdown", source: "# Mục" },
    { cell_type: "raw", source: "raw" },
  ]), "application/x-ipynb+json"));
  const { container } = renderViewer();

  expect(await screen.findByText("Cell 1 · Code · Chưa chạy")).toBeTruthy();
  const gutter = container.querySelector(".artifact-viewer-code-gutter");
  expect(gutter?.textContent).toBe("1\n2");
  expect(gutter?.getAttribute("aria-hidden")).toBe("true");
  expect(container.querySelectorAll(".artifact-viewer-code-gutter")).toHaveLength(1);
  expect(container.querySelector(".artifact-viewer-code pre")?.textContent).toBe("a\nb\n");
  expect(container.querySelector('[data-output-tone="stdout"] pre')?.textContent).toBe("ok\n");
  expect(container.querySelector('[data-output-tone="stdout"] .artifact-viewer-output-label')?.textContent).toBe("stdout");
  expect(preTexts(container)).toEqual(["a\nb\n", "ok\n", "raw"]);
});

test("lỗi 503 hiện thông báo và nút thử lại chạy lại đúng route", async () => {
  const requests = stubFetch(
    errorResponse(
      503,
      "ARTIFACT_STORAGE_UNAVAILABLE",
      "Hệ thống lưu trữ tạm thời không khả dụng. Vui lòng thử lại sau.",
    ),
    fileResponse("id,label\n1,cat\n", "text/csv"),
  );

  renderViewer(CSV_PATH, "prediction", "prediction.csv");
  expect(await screen.findByText(/Hệ thống lưu trữ tạm thời không khả dụng/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
  const table = await screen.findByRole("table");
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent),
  ).toEqual(["id", "label"]);
  expect(requests).toEqual([`/api${CSV_PATH}`, `/api${CSV_PATH}`]);
});

test("lỗi 404 tệp không còn hiện thông báo và vẫn thử lại được", async () => {
  const requests = stubFetch(
    errorResponse(404, "ARTIFACT_NOT_FOUND", "Không tìm thấy tệp của bài nộp."),
    fileResponse(notebookJson([{ cell_type: "code", execution_count: null, source: ["1 + 1"], outputs: [] }]), "application/x-ipynb+json"),
  );

  renderViewer();
  expect(await screen.findByText("Không tìm thấy tệp của bài nộp.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
  expect(await screen.findByText("Cell 1 · Code · Chưa chạy")).toBeTruthy();
  expect(requests).toEqual([`/api${NOTEBOOK_PATH}`, `/api${NOTEBOOK_PATH}`]);
});

test("notebook sai định dạng báo lỗi thay vì render nội dung", async () => {
  stubFetch(fileResponse(JSON.stringify({ cells: [] }), "application/x-ipynb+json"));
  const { unmount } = renderViewer();
  expect(await screen.findByText("Cấu trúc notebook không hợp lệ.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Thử lại" })).toBeTruthy();
  unmount();

  stubFetch(fileResponse("không phải JSON", "application/x-ipynb+json"));
  renderViewer();
  expect(await screen.findByText("Tệp notebook không phải JSON hợp lệ.")).toBeTruthy();
});

test("output text và ảnh base64 theo allowlist hiện đúng, output bị bỏ nói rõ lý do", async () => {
  const notebook = notebookJson([
    {
      cell_type: "code",
      execution_count: 1,
      source: ["plot()"],
      outputs: [
        { output_type: "stream", name: "stdout", text: ["dòng một\n", "dòng hai\n"] },
        // Văn bản output chứa HTML vẫn chỉ là text node trong pre, không phải thẻ.
        { output_type: "stream", name: "stdout", text: ["<img src=x onerror=alert(1)>"] },
        { output_type: "stream", name: "stderr", text: ["cảnh báo\n"] },
        { output_type: "execute_result", data: { "text/plain": ["42"] } },
        { output_type: "display_data", data: { "image/png": "aGVsbG8=" } },
        { output_type: "display_data", data: { "image/svg+xml": "<svg/>" } },
        {
          output_type: "error",
          ename: "ValueError",
          evalue: "sai",
          traceback: ["Traceback\n", "ValueError: sai"],
        },
      ],
    },
  ]);
  stubFetch(fileResponse(notebook, "application/x-ipynb+json"));
  const { container } = renderViewer();

  expect(await screen.findByText("Cell 1 · Code · In [1]")).toBeTruthy();
  expect(preTexts(container)).toEqual([
    "plot()",
    "dòng một\ndòng hai\n",
    "<img src=x onerror=alert(1)>",
    "cảnh báo\n",
    "42",
    "ValueError: sai\nTraceback\nValueError: sai",
  ]);
  // stderr và traceback được gọi tên; ảnh chỉ dựng từ base64 mà parser đã duyệt.
  expect(screen.getByText("stderr")).toBeTruthy();
  expect(screen.getByText("Lỗi")).toBeTruthy();
  expect(container.querySelectorAll("img").length).toBe(1);
  expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
  expect(container.querySelector("[onerror]")).toBeNull();
  expect(screen.getByText(`${NOTEBOOK_OMISSION_LABEL["unsupported-mime"]} (image/svg+xml)`)).toBeTruthy();
});

test("cell raw và loại lạ hiện nguyên văn trong pre", async () => {
  stubFetch(
    fileResponse(
      notebookJson([
        { cell_type: "raw", source: ["raw text"] },
        { cell_type: "heading", source: ["lạ"] },
      ]),
      "application/x-ipynb+json",
    ),
  );
  const { container } = renderViewer();

  expect(await screen.findByText("Cell 1 · Raw")).toBeTruthy();
  expect(screen.getByText("Cell 2 · Không rõ loại")).toBeTruthy();
  expect(preTexts(container)).toEqual(["raw text", "lạ"]);
});

test("phần nội dung bị cắt được nói rõ thay vì im lặng", async () => {
  stubFetch(
    fileResponse(
      notebookJson([
        {
          cell_type: "code",
          execution_count: null,
          source: ["x".repeat(MAX_NOTEBOOK_TEXT_CHARS + 10)],
          outputs: [
            { output_type: "stream", name: "stdout", text: ["y".repeat(MAX_NOTEBOOK_TEXT_CHARS + 1)] },
          ],
        },
      ]),
      "application/x-ipynb+json",
    ),
  );
  renderViewer();

  expect(await screen.findByText("Cell 1 · Code · Chưa chạy")).toBeTruthy();
  // Nguồn cell và output mỗi thứ chạm trần một lần.
  expect(screen.getAllByText(NOTEBOOK_TRUNCATED_LABEL).length).toBe(2);
  // Chỉ nguồn cell có bản đầy đủ để mở lại; output bị cắt chỉ được nhắc, không có nút mở.
  expect(screen.getAllByRole("button", { name: "Xem toàn bộ" })).toHaveLength(1);
});

test("nguồn cell dài hơn trần mở toàn bộ tại chỗ rồi thu gọn", async () => {
  const longSource = "x".repeat(MAX_NOTEBOOK_TEXT_CHARS + 500);
  stubFetch(
    fileResponse(
      notebookJson([{ cell_type: "code", execution_count: 1, source: [longSource], outputs: [] }]),
      "application/x-ipynb+json",
    ),
  );
  const { container } = renderViewer();

  expect(await screen.findByText("Cell 1 · Code · In [1]")).toBeTruthy();
  expect(container.querySelector(".artifact-viewer-code-gutter")?.textContent).toBe("1");
  expect(preTexts(container)).toEqual([longSource.slice(0, MAX_NOTEBOOK_TEXT_CHARS)]);
  expect(screen.getByText(NOTEBOOK_TRUNCATED_LABEL)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Xem toàn bộ" }));
  expect(preTexts(container)).toEqual([longSource]);
  // Đang xem trọn nguồn thì nhắc rút gọn không còn đúng nữa.
  expect(screen.queryByText(NOTEBOOK_TRUNCATED_LABEL)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Thu gọn" }));
  expect(preTexts(container)).toEqual([longSource.slice(0, MAX_NOTEBOOK_TEXT_CHARS)]);
});

test("gutter đánh số lại khi mở rộng và thu gọn source nhiều dòng", async () => {
  const source = `${"x\n".repeat(MAX_NOTEBOOK_TEXT_CHARS / 2)}kết thúc`;
  stubFetch(fileResponse(notebookJson([
    { cell_type: "code", source, outputs: [] },
  ]), "application/x-ipynb+json"));
  const { container } = renderViewer();

  expect(await screen.findByText("Cell 1 · Code · Chưa chạy")).toBeTruthy();
  const gutter = container.querySelector(".artifact-viewer-code-gutter");
  expect(gutter?.textContent?.split("\n")).toHaveLength(MAX_NOTEBOOK_TEXT_CHARS / 2);
  fireEvent.click(screen.getByRole("button", { name: "Xem toàn bộ" }));
  expect(gutter?.textContent?.split("\n")).toHaveLength(MAX_NOTEBOOK_TEXT_CHARS / 2 + 1);
  expect(container.querySelector(".artifact-viewer-code pre")?.textContent).toBe(source);
  fireEvent.click(screen.getByRole("button", { name: "Thu gọn" }));
  expect(gutter?.textContent?.split("\n")).toHaveLength(MAX_NOTEBOOK_TEXT_CHARS / 2);
});

test("nguồn quá dài không dựng hàng trăm nghìn dòng khi bấm mở rộng", async () => {
  const source = "x\n".repeat(120_000);
  stubFetch(fileResponse(notebookJson([{ cell_type: "code", source, outputs: [] }]), "application/x-ipynb+json"));
  const { container } = renderViewer();

  expect(await screen.findByText("Cell 1 · Code · Chưa chạy")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Xem toàn bộ" })).toBeNull();
  expect(screen.getByText(/Nguồn quá dài để mở toàn bộ/)).toBeTruthy();
  expect(container.querySelector(".artifact-viewer-code pre")?.textContent).toHaveLength(MAX_NOTEBOOK_TEXT_CHARS);
});

test("markdown cell không dựng HTML thô, không link và không ảnh từ xa", async () => {
  const notebook = notebookJson([
    {
      cell_type: "markdown",
      source: [
        "# Tiêu đề an toàn\n",
        "\n",
        "[bấm vào đây](https://evil.example/x)\n",
        "\n",
        "![ảnh](https://evil.example/x.png)\n",
        "\n",
        "![ảnh nhúng](data:image/png;base64,aGVsbG8=)\n",
        "\n",
        "[mở](javascript:alert(1))\n",
        "\n",
        "<script>alert(1)</script>\n",
        "\n",
        "<img src=x onerror=alert(1)>\n",
      ],
    },
    { cell_type: "code", execution_count: null, source: ["<script>alert(2)</script>"], outputs: [] },
  ]);
  stubFetch(fileResponse(notebook, "application/x-ipynb+json"));
  const { container } = renderViewer();

  expect(await screen.findByRole("heading", { name: "Tiêu đề an toàn" })).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("a")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("[onerror]")).toBeNull();
  expect(container.querySelectorAll("[href]").length).toBe(0);
  // Chữ của link vẫn còn để người đọc biết notebook đã viết gì.
  expect(screen.getByText("bấm vào đây")).toBeTruthy();
  expect(screen.getByText("mở")).toBeTruthy();
  // Nguồn cell code là text node, không phải HTML.
  expect(preTexts(container)).toEqual(["<script>alert(2)</script>"]);
});

test("HTML đã escape trong markdown chỉ hiện thành chữ, không thành thẻ", async () => {
  stubFetch(
    fileResponse(
      notebookJson([
        { cell_type: "markdown", source: ["&lt;script&gt;alert(1)&lt;/script&gt;\n"] },
      ]),
      "application/x-ipynb+json",
    ),
  );
  const { container } = renderViewer();

  const escaped = await screen.findByText("<script>alert(1)</script>");
  expect(escaped.tagName).toBe("P");
  expect(container.querySelector("script")).toBeNull();
});

test("bảng CSV tách header và chia lô dòng bằng nút xem thêm", async () => {
  const dataRows = Array.from({ length: 250 }, (_, index) => `h${index + 1},x${index + 1}`);
  stubFetch(fileResponse(["id,value", ...dataRows].join("\n"), "text/csv"));
  renderViewer(CSV_PATH, "prediction", "prediction.csv");

  const table = await screen.findByRole("table");
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent),
  ).toEqual(["id", "value"]);
  // 100 dòng đầu theo lô, cộng dòng header.
  expect(within(table).getAllByRole("row").length).toBe(101);

  fireEvent.click(screen.getByRole("button", { name: "Xem thêm 100 dòng" }));
  expect(within(table).getAllByRole("row").length).toBe(201);

  fireEvent.click(screen.getByRole("button", { name: "Xem thêm 50 dòng" }));
  expect(within(table).getAllByRole("row").length).toBe(251);
  expect(screen.queryByRole("button", { name: /Xem thêm/ })).toBeNull();
});

test("ô CSV có dấu phẩy và xuống dòng giữ nguyên trong đúng ô", async () => {
  stubFetch(fileResponse('name,note\n"Một, hai","dòng1\ndòng2"\n', "text/csv"));
  renderViewer(CSV_PATH, "prediction", "prediction.csv");

  const table = await screen.findByRole("table");
  expect(
    within(table)
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  ).toEqual(["Một, hai", "dòng1\ndòng2"]);
});

test("tệp CSV chạm trần hiện cảnh báo và không cắt âm thầm", async () => {
  const fiftyOneColumns = Array.from(
    { length: MAX_CSV_COLUMNS + 1 },
    (_, index) => `c${index}`,
  ).join(",");
  const longCell = `"${"z".repeat(MAX_CSV_CELL_CHARS + 1)}"`;
  const filler = Array.from({ length: MAX_CSV_ROWS - 2 }, (_, index) => `h${index + 1},x`);
  const csv = ["id,value", fiftyOneColumns, `1,${longCell}`, ...filler, "đuôi,1"].join("\n");
  stubFetch(fileResponse(csv, "text/csv"));
  renderViewer(CSV_PATH, "prediction", "prediction.csv");

  const table = await screen.findByRole("table");
  expect(within(table).getAllByRole("columnheader").length).toBe(MAX_CSV_COLUMNS);
  expect(await screen.findByText(CSV_ROW_LIMIT_NOTICE)).toBeTruthy();
  expect(screen.getByText(CSV_COLUMN_LIMIT_NOTICE)).toBeTruthy();
  expect(screen.getByText(CSV_CELL_TRUNCATED_NOTICE)).toBeTruthy();
});

test("ArtifactViewerModal mở trong dialog với tiêu đề kèm tên tệp", async () => {
  stubFetch(
    fileResponse(
      notebookJson([{ cell_type: "code", execution_count: null, source: ["1 + 1"], outputs: [] }]),
      "application/x-ipynb+json",
    ),
  );
  const { unmount } = render(
    <ArtifactViewerModal
      path={NOTEBOOK_PATH}
      kind="notebook"
      filename="solution.ipynb"
      onClose={() => {}}
    />,
  );

  const dialog = screen.getByRole("dialog", { name: "Xem notebook · solution.ipynb" });
  expect(within(dialog).getByText("solution.ipynb")).toBeTruthy();
  expect(await within(dialog).findByText("Cell 1 · Code · Chưa chạy")).toBeTruthy();
  // Nội dung chỉ để đọc: nút duy nhất là nút đóng của Modal, không có nút tải riêng.
  expect(within(dialog).getAllByRole("button")).toHaveLength(1);
  unmount();

  stubFetch(fileResponse("id,label\n1,cat\n", "text/csv"));
  render(
    <ArtifactViewerModal
      path={CSV_PATH}
      kind="prediction"
      filename="prediction.csv"
      onClose={() => {}}
    />,
  );
  expect(screen.getByRole("dialog", { name: "Xem CSV · prediction.csv" })).toBeTruthy();
});
