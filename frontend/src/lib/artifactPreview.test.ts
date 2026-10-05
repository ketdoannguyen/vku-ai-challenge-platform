/** Xem trước artifact: notebook (số cell 1-based, output an toàn) và CSV (RFC 4180, trần hiển thị). */

import { expect, test } from "vitest";
import {
  CSV_CELL_TRUNCATED_NOTICE,
  CSV_COLUMN_LIMIT_NOTICE,
  CSV_ROW_LIMIT_NOTICE,
  MAX_CSV_CELL_CHARS,
  MAX_CSV_COLUMNS,
  MAX_CSV_ROWS,
  MAX_IMAGE_BYTES,
  MAX_NOTEBOOK_TEXT_CHARS,
  MAX_NOTEBOOK_OUTPUTS_PER_CELL,
  NOTEBOOK_OMISSION_LABEL,
  NOTEBOOK_TRUNCATED_LABEL,
  parseCsvPreview,
  parseNotebook,
  type NotebookCell,
  type NotebookOmissionReason,
  type NotebookOutput,
} from "./artifactPreview";

/** Notebook tối thiểu đúng dạng nbformat để thử từng kiểu cell/output. */
function notebookJson(cells: unknown[]): string {
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells });
}

/** Đọc kết quả thành công; ném lỗi khi notebook hỏng để test không phải tự narrow. */
function readCells(text: string): NotebookCell[] {
  const result = parseNotebook(text);
  if (!result.ok) throw new Error(`không đọc được notebook: ${result.reason}`);
  return result.cells;
}

/** Output của một cell code duy nhất - đủ để thử từng output độc lập. */
function outputsOf(outputs: unknown[]): NotebookOutput[] {
  return readCells(notebookJson([{ cell_type: "code", execution_count: 1, outputs }]))[0].outputs;
}

/** Base64 hợp lệ đúng `bytes` byte sau giải mã, dùng để thử trần kích thước ảnh. */
function imageBase64(bytes: number): string {
  const rest = bytes % 3;
  const tail = rest === 0 ? "" : `${"A".repeat(rest + 1)}${rest === 1 ? "==" : "="}`;
  return "A".repeat(Math.floor(bytes / 3) * 4) + tail;
}

/** "hello" - base64 hợp lệ của 5 byte. */
const PNG = "aGVsbG8=";

test("giữ mọi cell theo đúng thứ tự 1-based, kể cả raw và loại lạ", () => {
  const cells = readCells(
    notebookJson([
      { cell_type: "markdown", source: ["# Tiêu đề\n", "Nội dung"] },
      { cell_type: "code", execution_count: 3, source: "print('a')", outputs: [] },
      { cell_type: "raw", source: "raw text" },
      { cell_type: "heading", source: 42 },
    ]),
  );

  expect(cells.map((cell) => cell.index)).toEqual([1, 2, 3, 4]);
  expect(cells.map((cell) => cell.cellType)).toEqual(["markdown", "code", "raw", "unknown"]);
  expect(cells[0].source).toBe("# Tiêu đề\nNội dung");
  expect(cells[1].source).toBe("print('a')");
  expect(cells[1].executionCount).toBe(3);
  expect(cells[1].outputs).toEqual([]);
  expect(cells[2].source).toBe("raw text");
  // Cell sai kiểu nguồn vẫn giữ chỗ với nguồn rỗng chứ không biến mất.
  expect(cells[3]).toMatchObject({
    source: "",
    sourceTruncated: false,
    executionCount: null,
    outputs: [],
  });
});

test("notebook hỏng JSON, thiếu cells hoặc cells sai kiểu đều trả lỗi chứ không ném", () => {
  expect(parseNotebook("{")).toEqual({ ok: false, reason: "invalid-json" });
  expect(parseNotebook("")).toEqual({ ok: false, reason: "invalid-json" });
  expect(parseNotebook("[]")).toEqual({ ok: false, reason: "invalid-structure" });
  expect(parseNotebook("42")).toEqual({ ok: false, reason: "invalid-structure" });
  expect(parseNotebook(JSON.stringify({ nbformat: 4 }))).toEqual({
    ok: false,
    reason: "invalid-structure",
  });
  expect(parseNotebook(JSON.stringify({ cells: "không phải mảng" }))).toEqual({
    ok: false,
    reason: "invalid-structure",
  });
});

test("notebook UTF-8 BOM hợp lệ, version khác v4 bị từ chối", () => {
  const valid = notebookJson([{ cell_type: "code", source: "print(1)" }]);
  expect(parseNotebook(`﻿${valid}`).ok).toBe(true);
  expect(parseNotebook(valid.replace('"nbformat":4', '"nbformat":3'))).toEqual({
    ok: false,
    reason: "invalid-structure",
  });
});

test("phần tử cells không phải object vẫn chiếm đúng số thứ tự", () => {
  const cells = readCells(notebookJson([null, "x", 7, { cell_type: "code", source: "a" }]));
  expect(cells.map((cell) => cell.index)).toEqual([1, 2, 3, 4]);
  expect(cells[3].source).toBe("a");
  expect(cells.slice(0, 3).every((cell) => cell.source === "" && cell.cellType === "unknown")).toBe(
    true,
  );
});

test("nguồn cell dài bị cắt theo trần nhưng vẫn giữ bản đầy đủ cho nút mở rộng", () => {
  const exact = readCells(
    notebookJson([{ cell_type: "markdown", source: "x".repeat(MAX_NOTEBOOK_TEXT_CHARS) }]),
  )[0];
  expect(exact.source).toHaveLength(MAX_NOTEBOOK_TEXT_CHARS);
  expect(exact.sourceTruncated).toBe(false);
  // Nguồn vừa chạm trần không mang thêm bản sao nào.
  expect("fullSource" in exact).toBe(false);

  const over = readCells(
    notebookJson([{ cell_type: "markdown", source: "x".repeat(MAX_NOTEBOOK_TEXT_CHARS + 1) }]),
  )[0];
  expect(over.source).toHaveLength(MAX_NOTEBOOK_TEXT_CHARS);
  expect(over.sourceTruncated).toBe(true);
  // Bản xem trước vẫn bị cắt, còn đuôi văn bản nằm nguyên trong fullSource.
  expect(over.fullSource).toHaveLength(MAX_NOTEBOOK_TEXT_CHARS + 1);
  expect(over.source).toBe(over.fullSource?.slice(0, MAX_NOTEBOOK_TEXT_CHARS));

  // Chạm trần ở giữa mảng dòng cũng báo đã cắt và giữ đủ các dòng phía sau.
  const lines = readCells(
    notebookJson([
      { cell_type: "markdown", source: ["x".repeat(MAX_NOTEBOOK_TEXT_CHARS), "phần sau"] },
    ]),
  )[0];
  expect(lines.source).toHaveLength(MAX_NOTEBOOK_TEXT_CHARS);
  expect(lines.sourceTruncated).toBe(true);
  expect(lines.fullSource).toBe(`${"x".repeat(MAX_NOTEBOOK_TEXT_CHARS)}phần sau`);

  // Dòng rỗng thêm vào sau khi chạm trần không phải là nội dung bị cắt.
  const blank = readCells(
    notebookJson([{ cell_type: "markdown", source: ["x".repeat(MAX_NOTEBOOK_TEXT_CHARS), ""] }]),
  )[0];
  expect(blank.sourceTruncated).toBe(false);
  expect("fullSource" in blank).toBe(false);
});

test("stream giữ nguyên văn bản, ghép mảng dòng và mặc định là stdout", () => {
  const outputs = outputsOf([
    { output_type: "stream", name: "stdout", text: ["dòng 1\n", "dòng 2\n"] },
    { output_type: "stream", name: "stderr", text: "cảnh báo\n" },
    { output_type: "stream", text: "không ghi tên" },
  ]);
  expect(outputs).toEqual([
    { kind: "text", name: "stdout", text: "dòng 1\ndòng 2\n", truncated: false },
    { kind: "text", name: "stderr", text: "cảnh báo\n", truncated: false },
    { kind: "text", name: "stdout", text: "không ghi tên", truncated: false },
  ]);
});

test("văn bản stream dài bị cắt theo trần và đánh dấu truncated", () => {
  const [output] = outputsOf([
    { output_type: "stream", name: "stdout", text: "x".repeat(MAX_NOTEBOOK_TEXT_CHARS + 10) },
  ]);
  expect(output).toEqual({
    kind: "text",
    name: "stdout",
    text: "x".repeat(MAX_NOTEBOOK_TEXT_CHARS),
    truncated: true,
  });
});

test("stream sai cấu trúc bị đánh dấu không hiển thị", () => {
  expect(outputsOf([{ output_type: "stream", name: "stdout", text: 42 }])).toEqual([
    { kind: "omitted", reason: "malformed-output", mime: null },
  ]);
  expect(outputsOf([{ output_type: "stream", text: ["a", 5] }])).toEqual([
    { kind: "omitted", reason: "malformed-output", mime: null },
  ]);
});

test("ảnh trong cùng bundle được ưu tiên hơn text/plain; HTML không bao giờ lọt vào kết quả", () => {
  const outputs = outputsOf([
    // matplotlib để lại text/plain chỉ để mô tả hình - ảnh mới là nội dung thật.
    {
      output_type: "display_data",
      data: { "text/plain": "<Figure size 640x480 with 1 Axes>", "image/png": PNG },
    },
    {
      output_type: "execute_result",
      execution_count: 2,
      data: { "text/plain": ["kết quả\n"], "image/png": PNG },
    },
    // Không có ảnh thì text/plain vẫn hiện, HTML đi kèm bị bỏ qua.
    { output_type: "display_data", data: { "text/plain": "chữ", "text/html": "<b>chữ</b>" } },
    { output_type: "display_data", data: { "text/plain": "", "image/png": PNG } },
  ]);

  expect(outputs[0]).toEqual({ kind: "image", mime: "image/png", base64: PNG, bytes: 5 });
  expect(outputs[1]).toEqual({ kind: "image", mime: "image/png", base64: PNG, bytes: 5 });
  expect(outputs[2]).toEqual({ kind: "text", name: "result", text: "chữ", truncated: false });
  // text/plain rỗng không phải nội dung: bundle vẫn cho ra ảnh thay vì ô trống.
  expect(outputs[3]).toEqual({ kind: "image", mime: "image/png", base64: PNG, bytes: 5 });

  // Dòng mô tả hình và HTML đều không lọt vào output - mỗi bundle chỉ cho ra một output.
  const serialized = JSON.stringify(outputs);
  expect(serialized).not.toContain("Figure");
  expect(serialized).not.toContain("<b>");
});

test("ảnh PNG/JPEG hợp lệ trả base64 kèm số byte, không dựng data URL", () => {
  const outputs = outputsOf([
    { output_type: "display_data", data: { "image/png": PNG } },
    { output_type: "execute_result", execution_count: 1, data: { "image/jpeg": PNG } },
  ]);
  expect(outputs).toEqual([
    { kind: "image", mime: "image/png", base64: PNG, bytes: 5 },
    { kind: "image", mime: "image/jpeg", base64: PNG, bytes: 5 },
  ]);
  // Nơi hiển thị tự dựng thẻ img từ base64; lib không tạo chuỗi HTML hay data URL nào.
  const serialized = JSON.stringify(outputs);
  expect(serialized).not.toContain("data:image");
  expect(serialized).not.toContain("<img");
});

test("base64 hỏng bị từ chối chứ không cắt bớt", () => {
  expect(
    outputsOf([{ output_type: "display_data", data: { "image/png": "không-phải-base64!" } }]),
  ).toEqual([{ kind: "omitted", reason: "invalid-image", mime: "image/png" }]);
  expect(outputsOf([{ output_type: "display_data", data: { "image/png": "" } }])).toEqual([
    { kind: "omitted", reason: "invalid-image", mime: "image/png" },
  ]);
  // Chuỗi mã hoá dư đúng 1 ký tự không thể suy ra số byte.
  expect(outputsOf([{ output_type: "display_data", data: { "image/png": "AAAAA" } }])).toEqual([
    { kind: "omitted", reason: "invalid-image", mime: "image/png" },
  ]);
  expect(outputsOf([{ output_type: "display_data", data: { "image/png": 42 } }])).toEqual([
    { kind: "omitted", reason: "invalid-image", mime: "image/png" },
  ]);
  // Ảnh hỏng không rơi về text/plain mô tả hình: nhãn nói rõ vì sao ảnh không hiển thị được.
  expect(
    outputsOf([
      {
        output_type: "display_data",
        data: { "text/plain": "<Figure size 640x480 with 1 Axes>", "image/png": "hỏng!" },
      },
    ]),
  ).toEqual([{ kind: "omitted", reason: "invalid-image", mime: "image/png" }]);
});

test("ảnh PNG hỏng không che mất JPEG hợp lệ trong cùng bundle", () => {
  expect(
    outputsOf([
      {
        output_type: "display_data",
        data: { "image/png": "hỏng!", "image/jpeg": PNG, "text/plain": "<Figure>" },
      },
    ]),
  ).toEqual([{ kind: "image", mime: "image/jpeg", base64: PNG, bytes: 5 }]);
});

test("ảnh đúng 1 MiB được nhận, vượt 1 MiB bị bỏ", () => {
  const exact = imageBase64(MAX_IMAGE_BYTES);
  expect(outputsOf([{ output_type: "display_data", data: { "image/png": exact } }])).toEqual([
    { kind: "image", mime: "image/png", base64: exact, bytes: MAX_IMAGE_BYTES },
  ]);
  expect(
    outputsOf([
      { output_type: "display_data", data: { "image/jpeg": imageBase64(MAX_IMAGE_BYTES + 1) } },
    ]),
  ).toEqual([{ kind: "omitted", reason: "image-too-large", mime: "image/jpeg" }]);
});

test("tổng ảnh chạm 4 MiB thì ảnh kế tiếp bị bỏ", () => {
  const oneMiB = imageBase64(MAX_IMAGE_BYTES);
  const image = { output_type: "display_data", data: { "image/png": oneMiB } };
  const outputs = outputsOf([
    ...Array.from({ length: 4 }, () => image),
    { output_type: "display_data", data: { "image/png": imageBase64(1) } },
  ]);
  expect(outputs.slice(0, 4)).toEqual(
    Array.from({ length: 4 }, () => ({
      kind: "image",
      mime: "image/png",
      base64: oneMiB,
      bytes: MAX_IMAGE_BYTES,
    })),
  );
  expect(outputs[4]).toEqual({
    kind: "omitted",
    reason: "image-budget-exhausted",
    mime: "image/png",
  });
});

test("MIME ngoài danh sách an toàn bị đánh dấu, payload không lọt vào kết quả", () => {
  const outputs = outputsOf([
    { output_type: "display_data", data: { "text/html": "<img src=x onerror=alert(1)>" } },
    { output_type: "display_data", data: { "image/svg+xml": "<svg onload=alert(1)></svg>" } },
    { output_type: "display_data", data: { "application/vnd.plotly.v1+json": { data: [] } } },
    { output_type: "execute_result", execution_count: 1, data: { "text/markdown": "# x" } },
  ]);
  expect(outputs).toEqual([
    { kind: "omitted", reason: "unsupported-mime", mime: "text/html" },
    { kind: "omitted", reason: "unsupported-mime", mime: "image/svg+xml" },
    { kind: "omitted", reason: "unsupported-mime", mime: "application/vnd.plotly.v1+json" },
    { kind: "omitted", reason: "unsupported-mime", mime: "text/markdown" },
  ]);
  // Không dấu vết nào của payload được giữ lại, kể cả trong nhãn.
  const serialized = JSON.stringify(outputs);
  expect(serialized).not.toContain("onerror");
  expect(serialized).not.toContain("onload");
  expect(serialized).not.toContain("<");
});

test("output sai cấu trúc hoặc loại lạ bị đánh dấu không hiển thị", () => {
  const outputs = outputsOf([
    "không phải object",
    null,
    { output_type: "update_display_data", data: {} },
    { output_type: "execute_result" },
    { output_type: "execute_result", data: "x" },
    { output_type: "display_data", data: { "text/plain": 5 } },
  ]);
  expect(outputs.slice(0, 5)).toEqual(
    Array.from({ length: 5 }, () => ({
      kind: "omitted",
      reason: "malformed-output",
      mime: null,
    })),
  );
  // text/plain sai kiểu vẫn giữ MIME để nhãn nói đúng phần hỏng.
  expect(outputs[5]).toEqual({ kind: "omitted", reason: "malformed-output", mime: "text/plain" });
});

test("output lỗi gộp ename, evalue và traceback", () => {
  const outputs = outputsOf([
    {
      output_type: "error",
      ename: "ValueError",
      evalue: "boom",
      traceback: ["Dòng 1\n", "Dòng 2"],
    },
    { output_type: "error", ename: "Lỗi" },
    { output_type: "error", traceback: ["Chỉ có traceback"] },
  ]);
  expect(outputs).toEqual([
    { kind: "error", text: "ValueError: boom\nDòng 1\nDòng 2", truncated: false },
    { kind: "error", text: "Lỗi", truncated: false },
    { kind: "error", text: "Chỉ có traceback", truncated: false },
  ]);
});

test("traceback dài bị cắt theo trần ký tự", () => {
  const [output] = outputsOf([
    { output_type: "error", ename: "Lỗi", traceback: ["x".repeat(MAX_NOTEBOOK_TEXT_CHARS + 5)] },
  ]);
  // Cả khối lỗi (tên lỗi + traceback) bị cắt theo cùng một trần ký tự.
  expect(output).toEqual({
    kind: "error",
    text: `Lỗi\n${"x".repeat(MAX_NOTEBOOK_TEXT_CHARS)}`.slice(0, MAX_NOTEBOOK_TEXT_CHARS),
    truncated: true,
  });
});

test("cell nhiều output chỉ dựng 100 output đầu và báo phần bị lược", () => {
  const output = { output_type: "stream", name: "stdout", text: "x" };
  const outputs = outputsOf(Array.from({ length: 10_000 }, () => output));
  expect(outputs).toHaveLength(MAX_NOTEBOOK_OUTPUTS_PER_CELL + 1);
  expect(outputs[0]).toEqual({ kind: "text", name: "stdout", text: "x", truncated: false });
  expect(outputs[MAX_NOTEBOOK_OUTPUTS_PER_CELL]).toEqual({
    kind: "omitted",
    reason: "output-limit",
    mime: null,
  });
});

test("mọi lý do bỏ output đều có nhãn hiển thị", () => {
  const reasons: NotebookOmissionReason[] = [
    "unsupported-mime",
    "invalid-image",
    "image-too-large",
    "image-budget-exhausted",
    "malformed-output",
    "output-limit",
  ];
  for (const reason of reasons) {
    expect(NOTEBOOK_OMISSION_LABEL[reason].length).toBeGreaterThan(0);
  }
  expect(NOTEBOOK_TRUNCATED_LABEL.length).toBeGreaterThan(0);
});

test("đọc bảng CSV đơn giản, dòng đầu là header", () => {
  expect(parseCsvPreview("id,prediction\nsample_0001,1\nsample_0002,0\n")).toEqual({
    rows: [
      ["id", "prediction"],
      ["sample_0001", "1"],
      ["sample_0002", "0"],
    ],
    hasMoreRows: false,
    columnCount: 2,
    columnsOmitted: 0,
    cellTruncated: false,
  });
});

test("BOM đầu tệp không dính vào ô đầu tiên", () => {
  expect(parseCsvPreview("\uFEFFa,b\n1,2\n").rows).toEqual([
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("ô có ngoặc kép giữ dấu phẩy, dấu ngoặc escaped và xuống dòng nhúng", () => {
  expect(parseCsvPreview('a,"b,c","d""e",f\n').rows).toEqual([["a", "b,c", 'd"e', "f"]]);
  expect(parseCsvPreview('"dòng 1\ndòng 2",x\n').rows).toEqual([["dòng 1\ndòng 2", "x"]]);
  // Xuống dòng kiểu CRLF bên trong ô cũng không được cắt dòng.
  expect(parseCsvPreview('"a\r\nb",c\r\n').rows).toEqual([["a\r\nb", "c"]]);
});

test("CRLF và \\r đơn lẻ đều là một lần xuống dòng", () => {
  expect(parseCsvPreview("a,b\r\nc,d\r\n").rows).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
  expect(parseCsvPreview("a,b\rc,d\r").rows).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("dòng trắng bị bỏ, dòng cuối không sinh thêm dòng rỗng", () => {
  expect(parseCsvPreview("a,b\n\nc,d\n").rows).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
  expect(parseCsvPreview("a,b\n\n\n").rows).toEqual([["a", "b"]]);
  expect(parseCsvPreview("").rows).toEqual([]);
  expect(parseCsvPreview("\n\n").rows).toEqual([]);
  // Dòng chỉ có dấu phẩy vẫn là dòng thật với các ô rỗng.
  expect(parseCsvPreview(",,\n").rows).toEqual([["", "", ""]]);
  expect(parseCsvPreview('a,"",c\n').rows).toEqual([["a", "", "c"]]);
});

test("chỉ đọc 1000 dòng đầu, lookahead báo còn dòng phía sau", () => {
  const body = `${Array.from({ length: MAX_CSV_ROWS }, (_, index) => `r${index},v${index}`).join("\n")}\n`;
  const exact = parseCsvPreview(body);
  expect(exact.rows).toHaveLength(MAX_CSV_ROWS);
  expect(exact.rows[MAX_CSV_ROWS - 1]).toEqual(["r999", "v999"]);
  expect(exact.hasMoreRows).toBe(false);

  const extra = parseCsvPreview(`${body}r1000,v1000`);
  expect(extra.rows).toHaveLength(MAX_CSV_ROWS);
  expect(extra.hasMoreRows).toBe(true);

  // Dòng thừa chỉ là dòng trắng thì không tính là còn dữ liệu.
  expect(parseCsvPreview(`${body}\n\n`).hasMoreRows).toBe(false);
});

test("quá 50 cột thì cắt bớt và báo số cột bị bỏ", () => {
  const wide = Array.from({ length: 55 }, (_, index) => `c${index}`).join(",");
  const preview = parseCsvPreview(`${wide}\na,b\n`);
  expect(preview.rows[0]).toHaveLength(MAX_CSV_COLUMNS);
  expect(preview.rows[0][MAX_CSV_COLUMNS - 1]).toBe("c49");
  expect(preview.columnCount).toBe(MAX_CSV_COLUMNS);
  expect(preview.columnsOmitted).toBe(5);
  // Dòng hẹp hơn không làm số cột bị bỏ tăng thêm.
  expect(preview.rows[1]).toEqual(["a", "b"]);
  const droppedLongCell = parseCsvPreview(
    `${Array.from({ length: MAX_CSV_COLUMNS }, () => "a").join(",")},${"x".repeat(MAX_CSV_CELL_CHARS + 1)}\n`,
  );
  expect(droppedLongCell.columnsOmitted).toBe(1);
  expect(droppedLongCell.cellTruncated).toBe(false);
});

test("ô dài bị cắt theo trần ký tự", () => {
  const over = parseCsvPreview(`${"x".repeat(MAX_CSV_CELL_CHARS + 1)},b\n`);
  expect(over.rows[0][0]).toHaveLength(MAX_CSV_CELL_CHARS);
  expect(over.cellTruncated).toBe(true);

  const exact = parseCsvPreview(`${"x".repeat(MAX_CSV_CELL_CHARS)},b\n`);
  expect(exact.rows[0][0]).toHaveLength(MAX_CSV_CELL_CHARS);
  expect(exact.cellTruncated).toBe(false);

  // Ô dài nằm ở dòng không hiển thị thì không tính vào cảnh báo.
  const beyond = parseCsvPreview(
    `${Array.from({ length: MAX_CSV_ROWS }, () => "a").join("\n")}\n${"x".repeat(
      MAX_CSV_CELL_CHARS + 1,
    )}\n`,
  );
  expect(beyond.hasMoreRows).toBe(true);
  expect(beyond.cellTruncated).toBe(false);
});

test("ngoặc kép chưa đóng hoặc đứng giữa ô không làm hỏng dòng", () => {
  expect(parseCsvPreview('a,"b').rows).toEqual([["a", "b"]]);
  expect(parseCsvPreview('a"b,c\n').rows).toEqual([['a"b', "c"]]);
  expect(parseCsvPreview('"a""b",c\n').rows).toEqual([['a"b', "c"]]);
});

test("nhãn giới hạn hiển thị khớp hằng số", () => {
  expect(CSV_ROW_LIMIT_NOTICE).toContain(String(MAX_CSV_ROWS));
  expect(CSV_COLUMN_LIMIT_NOTICE).toContain(String(MAX_CSV_COLUMNS));
  expect(CSV_CELL_TRUNCATED_NOTICE).toContain(String(MAX_CSV_CELL_CHARS));
});
