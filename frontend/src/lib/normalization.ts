export type CleanNormalizationResult =
  | { ok: true; normalization: { enabled: boolean; baseline: number | null } }
  | { ok: false; message: string };

/** Nhãn cố định cho con số lịch sử ghi cùng bài nộp - không được gọi là norm hiện tại. */
export const PROVISIONAL_NORM_LABEL = "Norm tạm lúc ghi nhận kết quả";

/**
 * Ghi chú quy tắc xếp hạng, dùng chung trang BXH thí sinh và bảng kết quả admin để hai nơi
 * không mô tả luật khác nhau.
 */
export const NORM_RANKING_NOTE =
  "Điểm norm cập nhật theo kết quả hợp lệ tốt nhất hiện tại. Bằng norm: bài hợp lệ đạt điểm đó được nộp sớm hơn đứng trước.";

/**
 * Chuẩn hóa form cấu hình norm. Bật thì baseline bắt buộc là số hữu hạn (0 và số âm vẫn hợp lệ
 * với metric tương ứng - không áp min 0); tắt thì bỏ hẳn baseline để không còn mẫu số mồ côi.
 */
export function cleanNormalization(
  enabled: boolean,
  baselineInput: string,
): CleanNormalizationResult {
  if (!enabled) return { ok: true, normalization: { enabled: false, baseline: null } };
  const trimmed = baselineInput.trim();
  const value = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(value)) {
    return { ok: false, message: "Bật chuẩn hóa cần baseline là số hữu hạn." };
  }
  return { ok: true, normalization: { enabled: true, baseline: value } };
}
