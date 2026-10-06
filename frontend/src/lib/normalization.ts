import {
  isDual,
  normalizationOf,
  type CompetitionMode,
  type NormalizationConfig,
  type NormalizationHiddenReason,
  type ParticipantTrackView,
  type Track,
} from "../api/competitions";

export type CleanNormalizationResult =
  | { ok: true; normalization: { enabled: boolean; baseline: number | null } }
  | { ok: false; message: string };

/** Nhãn cố định cho con số lịch sử ghi cùng bài nộp - không được gọi là norm hiện tại. */
export const PROVISIONAL_NORM_LABEL = "Norm score tạm";

/** Câu giải thích khi norm bị ẩn vì master BXH tắt, kể cả khi nhánh Private đã công bố. */
export const NORM_HIDDEN_BY_LEADERBOARD_NOTE =
  "BXH đang được BTC ẩn; điểm chuẩn hóa chưa được hiển thị";

/** Câu giải thích khi norm bị ẩn vì metric nguồn bị ẩn theo cấu hình hiển thị điểm. */
export const NORM_HIDDEN_BY_METRIC_NOTE = "Điểm chuẩn hóa bị ẩn theo cấu hình hiển thị điểm";

/**
 * Câu giải thích dữ liệu chuẩn hóa đang bị che theo lý do capability; `null` cho các lý do đã có
 * câu riêng ở nơi hiển thị (nhánh chưa công bố, cuộc thi không bật chuẩn hóa) để không nói trùng.
 */
export function hiddenNormNote(
  reason: NormalizationHiddenReason | null | undefined,
): string | null {
  if (reason === "leaderboard_hidden") return NORM_HIDDEN_BY_LEADERBOARD_NOTE;
  if (reason === "source_metric_hidden") return NORM_HIDDEN_BY_METRIC_NOTE;
  return null;
}

/** Phần DTO đủ để phán quyết hiển thị norm; khớp cả landing lẫn chi tiết thí sinh. */
export interface NormVisibilitySource {
  mode?: CompetitionMode;
  normalization?: NormalizationConfig;
  leaderboard_visible: boolean;
  /** `null` khi metric chính chưa cấu hình hoặc đã bị ẩn - điều kiện M của quyền xem norm. */
  primary_metric_label: string | null;
  /** Dual: nhánh dưới mắt thí sinh; capability chỉ có ở payload đã qua kiểm quyền đọc. */
  tracks?:
    | Record<Track, Pick<ParticipantTrackView, "normalization_visible" | "normalization_hidden_reason">>
    | null;
}

/**
 * Lý do dữ liệu chuẩn hóa của một nhánh đang bị che theo state HIỆN TẠI của DTO - không đọc từ
 * payload đã tải trước đó. Dual dùng capability backend trả theo nhánh (đủ bốn điều kiện, kể cả
 * nhánh chưa công bố); cuộc thi một nhánh suy từ đúng bốn điều kiện đã công bố, với kết quả luôn
 * hiện. `null` = đang xem được; `undefined` = response cũ không đủ dữ liệu để kết luận nên nơi gọi
 * giữ nguyên hành vi theo payload đã được backend lọc.
 */
export function currentNormHiddenReason(
  competition: NormVisibilitySource,
  track: Track | null,
): NormalizationHiddenReason | null | undefined {
  if (isDual(competition)) {
    const view = track === null ? undefined : competition.tracks?.[track];
    if (view?.normalization_visible === undefined) return undefined;
    return view.normalization_visible ? null : view.normalization_hidden_reason ?? null;
  }
  if (!normalizationOf(competition).enabled) return "normalization_disabled";
  if (!competition.leaderboard_visible) return "leaderboard_hidden";
  if (competition.primary_metric_label === null) return "source_metric_hidden";
  return null;
}

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
