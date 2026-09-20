/**
 * Nội dung dùng chung của tab Nộp bài và trang Hướng dẫn: tên cột và mẫu CSV.
 * Danh sách lỗi thường gặp chỉ tab Nộp bài dùng - nơi thí sinh đối chiếu ngay với thông báo lỗi.
 */

import type { SubmissionConfig } from "../api/competitions";

export interface SubmissionColumns {
  id: string;
  prediction: string;
}

/**
 * Tên cột để hiển thị. Cuộc thi chưa cấu hình chấm điểm vẫn phải thấy ví dụ đọc được,
 * nên rơi về mặc định của nền tảng thay vì hở `null` ra giao diện.
 */
export function submissionColumns(
  config: Pick<SubmissionConfig, "id_column" | "prediction_column"> | null | undefined,
): SubmissionColumns {
  return {
    id: config?.id_column?.trim() || "id",
    prediction: config?.prediction_column?.trim() || "prediction",
  };
}

/** Bốn dòng mẫu của bảng xem trước CSV; ID cố định để hai trang hiển thị giống nhau. */
export const SAMPLE_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["sample_0001", "1"],
  ["sample_0002", "0"],
  ["sample_0003", "0"],
  ["sample_0004", "1"],
];

export interface SubmissionPitfall {
  /** Mã lỗi backend trả về, hiển thị nguyên văn để đối chiếu với thông báo khi nộp. */
  code: string;
  /** Lỗi do giá trị dự đoán; các lỗi còn lại là lỗi cấu trúc tệp. */
  tone?: "warning";
  label: string;
  description: (columns: SubmissionColumns) => string;
}

export const SUBMISSION_PITFALLS: readonly SubmissionPitfall[] = [
  {
    code: "SCHEMA_MISMATCH",
    label: "Lỗi định dạng",
    description: (columns) =>
      `Tên cột không đúng chữ thường (ví dụ ID thay vì ${columns.id}) hoặc thừa/thiếu cột phụ.`,
  },
  {
    code: "VALUE_OUT_OF_RANGE",
    tone: "warning",
    label: "Sai nhãn dự đoán",
    description: (columns) =>
      `Cột ${columns.prediction} chứa giá trị không tương thích với cấu hình phân loại của cuộc thi.`,
  },
  {
    code: "MISSING_ROWS",
    label: "Thiếu ID bản ghi",
    description: () =>
      "Số lượng dòng hoặc tập ID dự đoán không khớp chính xác với danh sách công bố của tập Test.",
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
