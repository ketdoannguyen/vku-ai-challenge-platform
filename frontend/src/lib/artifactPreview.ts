/**
 * Xem trước tệp bài nộp ngay trên trình duyệt: notebook (.ipynb) và bảng CSV.
 *
 * Tệp ở đây do thí sinh tải lên nên là dữ liệu không tin cậy: chỉ đọc, không thực thi, không dựng
 * HTML. Ảnh nhúng chỉ được trả về dạng base64 kèm MIME để nơi hiển thị tự dựng thẻ img; output
 * ngoài danh sách an toàn bị đánh dấu "không hiển thị" thay vì cố diễn giải. Ô CSV cũng chỉ là
 * chuỗi, nơi hiển thị phải render như text node.
 *
 * Số cell giữ đúng vị trí 1-based trong mảng `cells` gốc, kể cả cell `raw` - cùng quy ước với
 * `backend/app/ai_review/notebook.py`, để "Cell 14" trong finding của AI trỏ đúng cell 14 trên màn
 * hình.
 */

/** Trần ký tự một khối văn bản notebook: nguồn cell, stdout/stderr, traceback, text/plain. */
export const MAX_NOTEBOOK_TEXT_CHARS = 20_000;

/** Trần kích thước một ảnh nhúng, tính theo số byte sau khi giải mã base64. */
export const MAX_IMAGE_BYTES = 1_048_576;

/** Trần tổng ảnh nhúng của cả notebook - ảnh vượt hạn mức bị bỏ, không cắt bớt ảnh trước. */
export const MAX_TOTAL_IMAGE_BYTES = 4_194_304;

/** Trần output hiển thị cho mỗi cell để tệp không tin cậy không dựng quá nhiều nút DOM. */
export const MAX_NOTEBOOK_OUTPUTS_PER_CELL = 100;

/** Số dòng đầu tiên của tệp CSV được đưa vào bảng xem trước. */
export const MAX_CSV_ROWS = 1_000;

/** Số cột tối đa hiển thị trên một dòng CSV. */
export const MAX_CSV_COLUMNS = 50;

/** Trần ký tự một ô CSV - ô dài hơn chỉ hiển thị phần đầu. */
export const MAX_CSV_CELL_CHARS = 2_000;

/** Loại cell nbformat; loại lạ rơi về `unknown` để không cell nào bị bỏ khỏi danh sách. */
export type NotebookCellType = "code" | "markdown" | "raw" | "unknown";

/** Lý do một output không được hiển thị nội dung. */
export type NotebookOmissionReason =
  | "unsupported-mime"
  | "invalid-image"
  | "image-too-large"
  | "image-budget-exhausted"
  | "malformed-output"
  | "output-limit";

export interface NotebookTextOutput {
  kind: "text";
  /** Nguồn phát: stdout/stderr của stream, hay text/plain của execute_result/display_data. */
  name: "stdout" | "stderr" | "result";
  text: string;
  truncated: boolean;
}

export interface NotebookErrorOutput {
  kind: "error";
  /** "TênLỗi: thông điệp" rồi tới traceback, ghép lại và cắt theo trần ký tự. */
  text: string;
  truncated: boolean;
}

export interface NotebookImageOutput {
  kind: "image";
  mime: "image/png" | "image/jpeg";
  /** Base64 hợp lệ, đã bỏ khoảng trắng; nơi hiển thị dựng thẻ img từ chuỗi này, không nhúng HTML. */
  base64: string;
  /** Số byte sau giải mã, tính từ độ dài chuỗi nên không phải giải mã ảnh. */
  bytes: number;
}

export interface NotebookOmittedOutput {
  kind: "omitted";
  reason: NotebookOmissionReason;
  /** MIME đọc được từ output; null khi output sai cấu trúc. */
  mime: string | null;
}

export type NotebookOutput =
  | NotebookTextOutput
  | NotebookErrorOutput
  | NotebookImageOutput
  | NotebookOmittedOutput;

export interface NotebookCell {
  /** Vị trí 1-based trong mảng `cells` gốc của tệp, không phải vị trí sau khi lọc. */
  index: number;
  cellType: NotebookCellType;
  /** Nguồn cell, ghép từ string hoặc mảng dòng (nbformat v4) và cắt theo trần ký tự. */
  source: string;
  sourceTruncated: boolean;
  /**
   * Nguồn cell trọn vẹn khi `source` đã bị cắt, để nút "xem toàn bộ" hiển thị được phần đuôi thay
   * vì mất hẳn. Chỉ có mặt khi `sourceTruncated` - cell bình thường không mang thêm bản sao nguồn.
   */
  fullSource?: string;
  executionCount: number | null;
  outputs: NotebookOutput[];
}

export type NotebookParseResult =
  | { ok: true; cells: NotebookCell[] }
  | { ok: false; reason: "invalid-json" | "invalid-structure" };

/** Nhãn hiển thị cho output bị bỏ; `reason` giữ chi tiết kỹ thuật, chữ ở đây là câu cho người đọc. */
export const NOTEBOOK_OMISSION_LABEL: Record<NotebookOmissionReason, string> = {
  "unsupported-mime": "Định dạng của output chưa được hỗ trợ hiển thị.",
  "invalid-image": "Ảnh nhúng có dữ liệu base64 không hợp lệ.",
  "image-too-large": "Ảnh nhúng vượt quá 1 MiB.",
  "image-budget-exhausted": "Notebook đã đạt hạn mức 4 MiB ảnh hiển thị.",
  "malformed-output": "Output sai cấu trúc hoặc không phải loại được hỗ trợ.",
  "output-limit": `Chỉ hiển thị ${MAX_NOTEBOOK_OUTPUTS_PER_CELL} output đầu của cell này.`,
};

/** Nhãn chung cho phần văn bản đã bị cắt bớt. */
export const NOTEBOOK_TRUNCATED_LABEL = "Nội dung dài đã được rút gọn.";

/** Cắt văn bản theo trần ký tự, nói rõ có cắt hay không thay vì im lặng. */
function boundText(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

/**
 * Ghép văn bản nbformat dạng chuỗi hoặc mảng dòng (mỗi phần tử đã kèm newline) rồi cắt theo trần.
 * Trả null khi không phải hai dạng đó - nơi gọi tự quyết định đây là rỗng hay là output hỏng.
 */
function joinText(value: unknown, max: number): { text: string; truncated: boolean } | null {
  if (typeof value === "string") return boundText(value, max);
  if (!Array.isArray(value)) return null;
  let text = "";
  for (const line of value) {
    if (typeof line !== "string") return null;
    // Đã chạm trần: chỉ cần biết còn dòng nào thêm nội dung hay không.
    if (text.length >= max) {
      if (line !== "") return { text: text.slice(0, max), truncated: true };
      continue;
    }
    text += line;
  }
  return boundText(text, max);
}

/**
 * Ghép trọn văn bản nbformat dạng chuỗi hoặc mảng dòng, không cắt - nguồn cell cần giữ cả phần đuôi
 * cho nút "xem toàn bộ". Output vẫn dùng `joinText` để dừng ngay khi chạm trần, tránh giữ văn bản
 * khổng lồ của stdout trong bộ nhớ.
 */
function joinWholeText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  let text = "";
  for (const line of value) {
    if (typeof line !== "string") return null;
    text += line;
  }
  return text;
}

function plainText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notebookCellType(value: unknown): NotebookCellType {
  return value === "code" || value === "markdown" || value === "raw" ? value : "unknown";
}

/**
 * Đọc ảnh nhúng: base64 hợp lệ thì trả chuỗi đã bỏ khoảng trắng kèm số byte sau giải mã, ngược lại
 * trả null. Kích thước suy từ độ dài chuỗi nên không giải mã ảnh - không cấp phát dữ liệu nhị phân
 * và không có gì để nhúng thẳng vào HTML.
 */
function readBase64Image(value: unknown): { base64: string; bytes: number } | null {
  if (typeof value !== "string") return null;
  const base64 = value.replace(/\s+/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    return null;
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const body = padding > 0 ? base64.slice(0, -padding) : base64;
  if (!body) return null;
  return { base64, bytes: Math.floor((body.length * 3) / 4) };
}

function omittedOutput(reason: NotebookOmissionReason, mime: string | null): NotebookOmittedOutput {
  return { kind: "omitted", reason, mime };
}

/** Bộ đếm ảnh đã nhận của một notebook. */
interface ImageBudget {
  usedBytes: number;
}

const SAFE_IMAGE_MIMES = ["image/png", "image/jpeg"] as const;

/** Chuyển một output nbformat thành dạng hiển thị được; mọi thứ ngoài danh sách an toàn đều bị bỏ. */
function convertOutput(raw: unknown, budget: ImageBudget): NotebookOutput {
  if (!isRecord(raw)) return omittedOutput("malformed-output", null);

  if (raw.output_type === "stream") {
    const text = joinText(raw.text, MAX_NOTEBOOK_TEXT_CHARS);
    if (!text) return omittedOutput("malformed-output", null);
    return {
      kind: "text",
      name: raw.name === "stderr" ? "stderr" : "stdout",
      text: text.text,
      truncated: text.truncated,
    };
  }

  if (raw.output_type === "error") {
    const head = boundText(
      [plainText(raw.ename), plainText(raw.evalue)].filter(Boolean).join(": "),
      MAX_NOTEBOOK_TEXT_CHARS,
    );
    const traceback = joinText(raw.traceback, MAX_NOTEBOOK_TEXT_CHARS) ?? {
      text: "",
      truncated: false,
    };
    const text = boundText(
      [head.text, traceback.text].filter(Boolean).join("\n"),
      MAX_NOTEBOOK_TEXT_CHARS,
    );
    return {
      kind: "error",
      text: text.text,
      truncated: head.truncated || traceback.truncated || text.truncated,
    };
  }

  if (raw.output_type === "execute_result" || raw.output_type === "display_data") {
    if (!isRecord(raw.data)) return omittedOutput("malformed-output", null);
    const data = raw.data;
    // Ưu tiên ảnh thay vì text/plain mô tả hình của cùng bundle; thử JPEG nếu PNG bị lỗi hoặc
    // vượt trần. Nếu cả hai đều không dùng được thì giữ lý do của ảnh được ưu tiên đầu tiên.
    let rejectedImage: NotebookOmittedOutput | null = null;
    for (const mime of SAFE_IMAGE_MIMES) {
      if (!(mime in data)) continue;
      const image = readBase64Image(data[mime]);
      const rejection = !image
        ? "invalid-image"
        : image.bytes > MAX_IMAGE_BYTES
          ? "image-too-large"
          : budget.usedBytes + image.bytes > MAX_TOTAL_IMAGE_BYTES
            ? "image-budget-exhausted"
            : null;
      if (rejection) {
        rejectedImage ??= omittedOutput(rejection, mime);
        continue;
      }
      budget.usedBytes += image!.bytes;
      return { kind: "image", mime, base64: image!.base64, bytes: image!.bytes };
    }
    if (rejectedImage) return rejectedImage;
    if ("text/plain" in data) {
      const text = joinText(data["text/plain"], MAX_NOTEBOOK_TEXT_CHARS);
      // text/plain rỗng không phải nội dung hiển thị được.
      if (text && text.text) {
        return { kind: "text", name: "result", text: text.text, truncated: text.truncated };
      }
      if (text === null) return omittedOutput("malformed-output", "text/plain");
    }
    return omittedOutput("unsupported-mime", Object.keys(data)[0] ?? null);
  }

  return omittedOutput("malformed-output", null);
}

/**
 * Đọc notebook từ nội dung tệp. Chỉ `JSON.parse` trong try/catch, không thực thi gì từ tệp.
 * Cell hỏng cấu trúc vẫn giữ chỗ với nguồn rỗng để số thứ tự không lệch khỏi notebook gốc.
 */
export function parseNotebook(text: string): NotebookParseResult {
  let root: unknown;
  try {
    root = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (!isRecord(root) || root.nbformat !== 4 || !Array.isArray(root.cells)) {
    return { ok: false, reason: "invalid-structure" };
  }

  const budget: ImageBudget = { usedBytes: 0 };
  const cells = root.cells.map((rawCell, position): NotebookCell => {
    const cell = isRecord(rawCell) ? rawCell : {};
    const sourceText = joinWholeText(cell.source) ?? "";
    const source = boundText(sourceText, MAX_NOTEBOOK_TEXT_CHARS);
    return {
      index: position + 1,
      cellType: notebookCellType(cell.cell_type),
      source: source.text,
      sourceTruncated: source.truncated,
      // Chỉ nguồn đã cắt mới mang thêm bản đầy đủ, thay vì giữ bản sao cho mọi cell.
      ...(source.truncated ? { fullSource: sourceText } : {}),
      executionCount: typeof cell.execution_count === "number" ? cell.execution_count : null,
      outputs: Array.isArray(cell.outputs)
        ? [
            ...cell.outputs
              .slice(0, MAX_NOTEBOOK_OUTPUTS_PER_CELL)
              .map((output) => convertOutput(output, budget)),
            ...(cell.outputs.length > MAX_NOTEBOOK_OUTPUTS_PER_CELL
              ? [omittedOutput("output-limit", null)]
              : []),
          ]
        : [],
    };
  });
  return { ok: true, cells };
}

/** Bảng xem trước một tệp CSV: dòng đầu của tệp nằm ở `rows[0]` (thường là header). */
export interface CsvPreview {
  /** Các dòng đã đọc theo thứ tự trong tệp; mỗi ô đã cắt theo trần ký tự. */
  rows: string[][];
  /** Tệp còn dòng phía sau `rows` - đọc thêm một dòng để biết chắc thay vì đoán. */
  hasMoreRows: boolean;
  /** Số cột tối đa của một dòng đã hiển thị, sau khi cắt theo trần. */
  columnCount: number;
  /** Số cột bị bỏ nhiều nhất ở một dòng; 0 khi mọi dòng trong trần. */
  columnsOmitted: number;
  /** Có ô dài hơn trần ký tự và đã bị rút gọn. */
  cellTruncated: boolean;
}

/** Nhãn cho phần dữ liệu bị bỏ khi tệp chạm trần xem trước. */
export const CSV_ROW_LIMIT_NOTICE = `Chỉ xem trước ${MAX_CSV_ROWS} dòng đầu tiên của tệp.`;
export const CSV_COLUMN_LIMIT_NOTICE = `Chỉ xem trước ${MAX_CSV_COLUMNS} cột đầu tiên của tệp.`;
export const CSV_CELL_TRUNCATED_NOTICE = `Ô dài hơn ${MAX_CSV_CELL_CHARS} ký tự đã được rút gọn.`;

/**
 * Đọc bảng CSV theo RFC 4180: ô có ngoặc kép được giữ nguyên dấu phẩy và xuống dòng bên trong,
 * `""` là một dấu ngoặc kép, CRLF là một lần xuống dòng. Dòng trắng bị bỏ. Chỉ đọc tới trần dòng
 * rồi nhìn thêm một dòng để biết tệp còn nữa hay không; không phụ thuộc thư viện ngoài.
 */
export function parseCsvPreview(text: string): CsvPreview {
  // BOM đầu tệp vô hình với người đọc nhưng sẽ dính vào ô đầu tiên nếu giữ nguyên.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let hasMoreRows = false;
  let columnCount = 0;
  let columnsOmitted = 0;
  let cellTruncated = false;

  let fields: string[] = [];
  let field = "";
  let droppedInRow = 0;
  let rowStarted = false;
  let inQuotes = false;

  const append = (char: string) => {
    rowStarted = true;
    if (field.length < MAX_CSV_CELL_CHARS) field += char;
    // Ô của dòng không hiển thị thì không tính vào cảnh báo rút gọn.
    else if (rows.length < MAX_CSV_ROWS && fields.length < MAX_CSV_COLUMNS) cellTruncated = true;
  };

  const endField = () => {
    if (fields.length < MAX_CSV_COLUMNS) fields.push(field);
    else droppedInRow += 1;
    field = "";
  };

  /** Đóng dòng hiện tại; trả true khi đã chạm trần dòng, phần còn lại của tệp chỉ để đếm. */
  const endRow = (): boolean => {
    endField();
    const complete = rowStarted;
    const row = fields;
    const dropped = droppedInRow;
    fields = [];
    droppedInRow = 0;
    rowStarted = false;
    if (!complete) return false; // dòng trắng
    if (rows.length >= MAX_CSV_ROWS) {
      hasMoreRows = true;
      return true;
    }
    if (row.length > columnCount) columnCount = row.length;
    if (dropped > columnsOmitted) columnsOmitted = dropped;
    rows.push(row);
    return false;
  };

  let full = false;
  for (let i = 0; i < input.length && !full; i += 1) {
    const char = input[i];
    if (inQuotes) {
      if (char !== '"') append(char);
      else if (input[i + 1] === '"') {
        append('"');
        i += 1;
      } else inQuotes = false;
      continue;
    }
    // Ngoặc kép chỉ mở ô khi đứng đầu ô; đứng giữa ô là ký tự thường.
    if (char === '"' && field === "") {
      inQuotes = true;
      rowStarted = true;
      continue;
    }
    if (char === ",") {
      rowStarted = true;
      endField();
      continue;
    }
    if (char === "\n" || char === "\r") {
      // CRLF là một lần xuống dòng; \r đơn lẻ cũng chấp nhận để tệp kiểu cũ vẫn đọc được.
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      full = endRow();
      continue;
    }
    append(char);
  }
  if (!full) endRow();

  return { rows, hasMoreRows, columnCount, columnsOmitted, cellTruncated };
}
