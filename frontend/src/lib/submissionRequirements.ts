/**
 * Nội dung dùng chung của tab Nộp bài và trang Hướng dẫn: cột CSV và mẫu dữ liệu xem trước.
 * Danh sách lỗi thường gặp chỉ tab Nộp bài dùng - nơi thí sinh đối chiếu ngay với thông báo lỗi.
 */

import type { SubmissionColumn, SubmissionConfig } from "../api/competitions";

/** Cấu trúc tệp CSV để hiển thị: cột định danh, danh sách cột và bốn dòng mẫu. */
export interface SubmissionSchema {
  /** Cột đối soát với ground truth; cột này cũng được sinh mẫu dạng `sample_0001`. */
  idColumn: string;
  columns: readonly SubmissionColumn[];
  /** Ô mẫu đã ở dạng chuỗi, đúng thứ tự cột - bảng xem trước chỉ cần chuỗi như tệp CSV thật. */
  rows: readonly (readonly string[])[];
}

const DEFAULT_ID_COLUMN = "id";
const DEFAULT_PREDICTION_COLUMN = "prediction";
/** Bốn dòng mẫu: đủ để thấy kiểu giá trị của từng cột mà không chiếm chỗ trên màn hình. */
const SAMPLE_COUNT = 4;

/**
 * Bốn dòng mẫu của bộ chấm v1, giữ nguyên giá trị như trước. Cuộc thi v1 không khai báo schema nên
 * không có kiểu dữ liệu để sinh mẫu, và đổi giá trị mẫu sẽ làm hướng dẫn đang công bố lệch đi.
 */
const LEGACY_ROWS: readonly (readonly string[])[] = [
  ["sample_0001", "1"],
  ["sample_0002", "0"],
  ["sample_0003", "0"],
  ["sample_0004", "1"],
];

/** Hai cột cố định của bộ chấm sklearn, dựng lại thành schema để hai đời cấu hình hiển thị như nhau. */
function legacyColumns(idColumn: string, predictionColumn: string): SubmissionColumn[] {
  return [
    { name: idColumn, type: "string", nullable: false, allowed_values: null },
    { name: predictionColumn, type: "integer", nullable: false, allowed_values: null },
  ];
}

/** Giá trị mẫu của một ô: enum thắng, sau đó tới kiểu dữ liệu admin khai báo. */
function sampleValue(column: SubmissionColumn, index: number): string {
  const allowed = column.allowed_values;
  if (allowed?.length) return String(allowed[index % allowed.length]);
  if (column.type === "integer") return String(index + 1);
  if (column.type === "number") return (index + 0.5).toFixed(1);
  return `text_${index + 1}`;
}

/** Cột ID sinh theo dạng `sample_0001` để nhìn ra ngay đây là định danh bản ghi. */
function idValue(column: SubmissionColumn, index: number): string {
  const allowed = column.allowed_values;
  if (allowed?.length) return String(allowed[index % allowed.length]);
  return column.type === "integer" ? String(index + 1) : `sample_000${index + 1}`;
}

/**
 * Cấu trúc CSV của cuộc thi. Cuộc thi v2 dùng đúng schema submission admin khai báo; cuộc thi v1
 * và bản nháp chưa khai báo schema rơi về hai cột cố định để hướng dẫn vẫn đọc được.
 */
export function submissionSchema(
  config: Pick<SubmissionConfig, "id_column" | "prediction_column" | "columns"> | null | undefined,
): SubmissionSchema {
  const columns = config?.columns ?? [];
  if (columns.length === 0) {
    const idColumn = config?.id_column?.trim() || DEFAULT_ID_COLUMN;
    const prediction = config?.prediction_column?.trim() || DEFAULT_PREDICTION_COLUMN;
    return { idColumn, columns: legacyColumns(idColumn, prediction), rows: LEGACY_ROWS };
  }
  const idColumn = config?.id_column?.trim() || columns[0].name;
  return {
    idColumn,
    columns,
    rows: Array.from({ length: SAMPLE_COUNT }, (_, index) =>
      columns.map((column) =>
        column.name === idColumn ? idValue(column, index) : sampleValue(column, index),
      ),
    ),
  };
}

export interface SubmissionPitfall {
  /** Mã lỗi backend trả về, hiển thị nguyên văn để đối chiếu với thông báo khi nộp. */
  code: string;
  /** Lỗi do giá trị trong ô; các lỗi còn lại là lỗi cấu trúc tệp. */
  tone?: "warning";
  label: string;
  description: (schema: SubmissionSchema) => string;
}

export const SUBMISSION_PITFALLS: readonly SubmissionPitfall[] = [
  {
    code: "SUBMISSION_SCHEMA_INVALID",
    label: "Sai cấu trúc cột",
    description: (schema) =>
      `Header CSV không khớp khai báo của cuộc thi: sai tên cột (ví dụ ID thay vì ${schema.idColumn}), thiếu cột bắt buộc hoặc thừa cột không được khai báo.`,
  },
  {
    code: "SUBMISSION_VALUE_INVALID",
    tone: "warning",
    label: "Giá trị ô không hợp lệ",
    description: () =>
      "Có ô để trống, thừa khoảng trắng ở đầu hoặc cuối, sai kiểu (số nguyên/số) hoặc nằm ngoài danh sách giá trị cho phép.",
  },
  {
    code: "SUBMISSION_DUPLICATE_IDS",
    label: "ID trùng lặp",
    description: (schema) =>
      `Cột ${schema.idColumn} chứa ID trùng lặp; mỗi bản ghi chỉ được xuất hiện một lần.`,
  },
  {
    code: "SUBMISSION_ID_MISMATCH",
    label: "Thiếu hoặc thừa bản ghi",
    description: () =>
      "Tập ID không khớp ground truth: số dòng hoặc danh sách ID không đúng bằng tập ID của tập Test.",
  },
  {
    code: "INVALID_NOTEBOOK_TYPE",
    label: "Sai loại tệp notebook",
    description: () =>
      "Tệp thứ hai không có đuôi .ipynb. Bản xuất dạng ZIP, HTML hay PDF đều bị từ chối.",
  },
  {
    code: "NOTEBOOK_INVALID",
    label: "Notebook hỏng cấu trúc",
    description: () =>
      "Notebook không phải JSON hợp lệ hoặc thiếu khoá bắt buộc (nbformat, metadata, cells).",
  },
];
