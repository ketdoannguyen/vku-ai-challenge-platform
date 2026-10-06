import type { AdminAiReview, ParticipantAiReview } from "./aiReview";
import { api } from "./client";
import type { NormalizationConfig, Track } from "./competitions";

/** Một metric trong hợp đồng kết quả: khóa tra kết quả, nhãn hiển thị và số thập phân. */
export interface MetricDefinition {
  key: string;
  label: string;
  decimals: number;
}

/** Hợp đồng kết quả của cuộc thi: thứ tự cột, metric chính và chiều xếp hạng. */
export interface ResultContract {
  metrics: MetricDefinition[];
  /** Bản nháp chưa chọn metric chính - UI phải nói "chưa cấu hình", không mặc định về F1. */
  primary_metric: string | null;
  higher_is_better: boolean;
}

/**
 * Khóa metric → giá trị. Cuộc thi v2 trả bộ khóa do admin khai báo trong code chấm; cuộc thi v1
 * giữ đúng ba khóa f1/precision/recall.
 */
export type Metrics = Record<string, number>;

/** Ba metric cố định của bộ chấm sklearn, cũng là hợp đồng mô tả lại cho cuộc thi v1. */
const LEGACY_CONTRACT: ResultContract = {
  metrics: [
    { key: "f1", label: "F1", decimals: 4 },
    { key: "precision", label: "Precision", decimals: 4 },
    { key: "recall", label: "Recall", decimals: 4 },
  ],
  primary_metric: "f1",
  higher_is_better: true,
};

const EMPTY_CONTRACT: ResultContract = {
  metrics: [],
  primary_metric: null,
  higher_is_better: true,
};

/**
 * Hợp đồng để render. Response hiện tại đã có `result_contract`; response cũ chưa có field này
 * được mô tả lại thành ba metric v1 để màn hình không phải biết mình đang đọc bản ghi đời nào.
 * Bản nháp v2 chưa khai báo metric trả hợp đồng rỗng thay vì dựng lại ba cột cũ.
 */
export function resultContract(
  config: { result_contract?: ResultContract; version?: number } | null | undefined,
): ResultContract {
  if (config?.result_contract) return config.result_contract;
  return config?.version === 2 ? EMPTY_CONTRACT : LEGACY_CONTRACT;
}

/** Nhãn của một metric trong hợp đồng; `null` khi chưa chọn metric chính. */
export function metricLabel(contract: ResultContract, key: string | null | undefined): string | null {
  if (!key) return null;
  return contract.metrics.find((metric) => metric.key === key)?.label ?? key;
}

/** Metadata một artifact đã lưu; backend không trả object key hay nơi lưu trữ. */
export interface ArtifactMeta {
  filename: string;
  /** null với bài nộp cũ chỉ còn CSV trên đĩa - kích thước không được lưu lúc đó. */
  size_bytes: number | null;
  available: boolean;
}

export interface SubmissionArtifacts {
  prediction: ArtifactMeta | null;
  notebook: ArtifactMeta | null;
}

/** Quyết định xét duyệt của admin - trục riêng, không thay `status` (trạng thái chấm điểm). */
export type ReviewStatus = "accepted" | "rejected";

/** Participant chỉ nhận được lý do, và chỉ khi bài đang bị từ chối. */
export interface ParticipantReview {
  status: "rejected";
  note: string | null;
}

/** Admin nhận thêm người duyệt và thời điểm; `null` nghĩa là bài chưa từng bị xét duyệt. */
export interface AdminReview {
  status: ReviewStatus;
  note: string | null;
  reviewed_at: string;
  reviewed_by: { id: string; name: string; email: string };
}

/**
 * Snapshot norm tạm ghi MỘT LẦN cùng bài nộp: con số lịch sử lúc ghi nhận kết quả, không phải
 * norm hiện tại của bảng xếp hạng (mẫu số đã có thể đổi vì bài khác). Vắng mặt khi cuộc thi
 * không bật norm hoặc người xem không có quyền xem dữ liệu dẫn xuất.
 */
export interface SubmissionNormSnapshot {
  score: number;
  /** Thời điểm chấm xong - không phải mốc tie-break của bảng xếp hạng. */
  calculated_at: string;
}

/** Bản đầy đủ admin xem được: đủ baseline/mẫu số lúc ghi để hậu kiểm. */
export interface AdminSubmissionNormSnapshot extends SubmissionNormSnapshot {
  version: number;
  source_metric: string;
  higher_is_better: boolean;
  baseline: number;
  reference_best: number;
}

export interface SubmissionHistoryItem {
  id: string;
  competition_id: string;
  status: "completed" | "rejected" | "failed";
  metrics: Metrics | null;
  primary_score: number | null;
  created_at: string;
  artifacts: SubmissionArtifacts;
  /** Dual: nhánh bài nộp thuộc về; cuộc thi một nhánh không trả khóa này. */
  track?: Track | null;
  /**
   * Dual: `hidden` khi kết quả đã chấm nhưng chưa được công bố - metrics rỗng và điểm `null`,
   * khác hẳn bài chưa chấm hay điểm 0. Cuộc thi một nhánh không trả khóa này.
   */
  result_visibility?: "hidden" | "visible";
  /** Lý do bị che khi `hidden`; đủ ổn định để UI đối chiếu. */
  visibility_reason?: "private_unpublished";
  error?: { code: string; message: string };
  /** Chỉ có mặt khi bài đang bị từ chối; endpoint admin ghi đè bằng shape đầy đủ. */
  review?: ParticipantReview;
  /** Vắng mặt khi cuộc thi chưa bật AI, tắt AI, hoặc không công khai kết luận cho thí sinh. */
  ai_review?: ParticipantAiReview;
  /** Endpoint admin ghi đè bằng shape đầy đủ; participant chỉ nhận `{score, calculated_at}`. */
  normalization_snapshot?: SubmissionNormSnapshot;
}

export interface SubmissionsResponse {
  submissions: SubmissionHistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

export const SUBMISSION_STATUS_LABEL: Record<SubmissionHistoryItem["status"], string> = {
  completed: "Đã chấm điểm",
  rejected: "Không hợp lệ",
  failed: "Lỗi chấm điểm",
};

/** Nhãn kết quả duyệt; bài chưa có quyết định được duyệt mặc định ở danh sách. */
export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  accepted: "Duyệt",
  rejected: "Không duyệt",
};

/**
 * Cột sắp xếp bảng submission của admin. Bốn trường cố định luôn dùng được; ngoài ra backend còn
 * nhận khóa metric khi bảng đã khóa vào một cuộc thi, nên đây là chuỗi chứ không phải union kín.
 */
export type AdminSortField = string;
export type AdminSortOrder = "asc" | "desc";

/** Bốn trường sắp xếp dùng được ở mọi bảng, kể cả bảng toàn cục trộn nhiều cuộc thi. */
export const ADMIN_SORT_FIELDS: ReadonlyArray<{ value: AdminSortField; label: string; globalOnly?: boolean }> = [
  { value: "created_at", label: "Thời gian" },
  { value: "competition", label: "Cuộc thi", globalOnly: true },
  { value: "team", label: "Đội" },
  { value: "primary_score", label: "Điểm chính" },
];

/** Tổng quan bảng bài nộp toàn cục, tính trên cả bộ lọc đang xem chứ không phải trang hiện tại. */
export interface AdminSubmissionStats {
  total: number;
  competitions: number;
  teams: number;
  completed: number;
}

/** Dòng submission phía admin: thêm định danh tài khoản mà endpoint participant cố ý bỏ. */
export interface AdminSubmissionItem
  extends Omit<SubmissionHistoryItem, "review" | "ai_review" | "normalization_snapshot"> {
  account: { id: string; name: string; email: string };
  /** Dual: nhánh bài nộp thuộc về; cuộc thi một nhánh không trả khóa này. */
  track?: Track | null;
  /** Khác participant: luôn có khoá, `null` khi bài chưa từng bị xét duyệt. */
  review: AdminReview | null;
  /** Khác participant: luôn có khoá, `null` khi cuộc thi chưa từng bật AI lúc nộp bài. */
  ai_review: AdminAiReview | null;
  /** Khác participant: đầy đủ baseline/mẫu số lúc ghi để hậu kiểm. */
  normalization_snapshot?: AdminSubmissionNormSnapshot;
}

/** Bảng toàn cục gắn thêm cuộc thi của từng dòng. */
export interface GlobalSubmissionItem extends AdminSubmissionItem {
  /** Chỉ endpoint toàn cục trả về; bảng theo cuộc thi đã biết sẵn cuộc thi của nó. */
  competition?: { id: string; slug: string; name: string };
}

/** Cuộc thi kèm hợp đồng kết quả của nó, để bảng toàn cục gắn nhãn metric đúng cho từng hàng. */
export interface CompetitionContract {
  id: string;
  slug: string;
  name: string;
  result_contract: ResultContract;
  /** Ở khóa riêng, không trộn vào hợp đồng evaluator; vắng mặt ở response cũ hiểu là đang tắt. */
  normalization?: NormalizationConfig;
}

export interface AdminSubmissionsResponse {
  submissions: GlobalSubmissionItem[];
  total: number;
  limit: number;
  offset: number;
  sort: AdminSortField;
  order: AdminSortOrder;
  /** Chỉ endpoint toàn cục trả về - bảng theo một cuộc thi không có thẻ thống kê. */
  stats?: AdminSubmissionStats;
  /** Chỉ endpoint toàn cục: hợp đồng metric của từng cuộc thi có mặt trong trang. */
  competitions?: CompetitionContract[];
}

/**
 * Metadata chuẩn hóa đi kèm một lần dựng bảng. Mọi entry và metadata trong cùng response phải
 * thuộc cùng lần dựng đó - không tự suy mẫu số từ các entry đã chọn (nhóm toàn 0 có thể chọn
 * bài sớm với raw thấp, `max(entry)` lúc đó không phải best thực).
 */
export interface NormalizationBoard {
  version: number;
  /** Metric lấy điểm gốc để chuẩn hóa, theo hợp đồng kết quả của cuộc thi. */
  source_metric: string;
  /** Chiều xếp hạng của metric nguồn; điểm norm luôn cao hơn là tốt hơn. */
  higher_is_better: boolean;
  baseline: number;
  max_score: number;
  decimals: number;
  /** Điểm gốc tốt nhất toàn cuộc thi dùng làm mẫu số; `null` khi chưa có bài hợp lệ. */
  reference_best: number | null;
  /** Thời điểm build bảng; khác mốc tie-break (mốc đó là giờ nhận bài đại diện). */
  calculated_at: string;
}

export interface LeaderboardEntry {
  /** Thứ hạng toàn cục, không đánh lại số theo trang. */
  rank: number;
  display_name: string;
  /** `null` khi chỉ số chính bị admin ẩn khỏi thí sinh; bảng xếp hạng vẫn xếp theo nó. */
  primary_score: number | null;
  metrics: Metrics;
  best_submission_id: string;
  best_submission_at: string;
  total_submissions: number;
  is_current_user?: boolean;
  /** Chỉ endpoint admin trả về; endpoint participant đã bỏ định danh. */
  account_id?: string;
  /** Norm hiện tại - điểm xếp hạng chính khi cuộc thi bật chuẩn hóa. Vắng mặt khi norm tắt;
   *  `null` khi người xem không được xem (bảng hoặc metric nguồn bị ẩn). */
  normalized_score?: number | null;
}

/** Admin và export luôn nhận toàn bộ danh sách, không phân trang. */
export interface LeaderboardResponse {
  competition_id: string;
  /** Dual: nhánh của bảng đang xem; cuộc thi một nhánh không trả khóa này. */
  track?: Track | null;
  /** Khóa metric chính theo hợp đồng kết quả; `null` khi cuộc thi chưa khai báo metric nào. */
  primary_metric: string | null;
  entries: LeaderboardEntry[];
  total: number;
  /** Vắng mặt khi cuộc thi không bật chuẩn hóa; `null` khi thí sinh không được xem. */
  normalization?: NormalizationBoard | null;
}

export interface ParticipantLeaderboardResponse extends LeaderboardResponse {
  limit: number;
  offset: number;
  has_more: boolean;
  /** Hạng toàn cục của người xem, kể cả khi ngoài trang; null nếu chưa có bài hoàn thành. */
  me: LeaderboardEntry | null;
}

/** Lý do bắt buộc khi từ chối, không được gửi kèm khi khôi phục (backend trả 422). */
export type ReviewPayload =
  | { status: "rejected"; note: string }
  | { status: "accepted" };

/**
 * Số lượt chấm theo trạng thái của một nhánh (hoặc cả cuộc thi single), không theo bộ lọc của
 * bảng đang xem. `failed` gộp cả lượt quá hạn; `in_flight` là các lượt chưa kết thúc.
 */
export interface SubmissionScopeStats {
  total: number;
  completed: number;
  failed: number;
  in_flight: number;
}

/**
 * Số liệu phạm vi nhánh cho trang công bố Private. Nhánh bắt buộc với cuộc thi dual; cuộc thi
 * single không có nhánh nên gọi không kèm `track`.
 */
export function fetchSubmissionScopeStats(
  competitionId: string,
  track: Track | null,
): Promise<SubmissionScopeStats> {
  const scope = track ? `?track=${track}` : "";
  return api.get(`/admin/competitions/${competitionId}/submissions/stats${scope}`);
}

/**
 * Xét duyệt hậu kiểm một bài đã chấm điểm. Không chấm lại, không hoàn lượt nộp.
 * Luôn gọi endpoint toàn cục, kể cả khi bảng đang khóa vào một cuộc thi.
 */
export function setSubmissionReview(
  submissionId: string,
  payload: ReviewPayload,
): Promise<{ submission: AdminSubmissionItem }> {
  return api.patch(`/admin/submissions/${submissionId}/review`, payload);
}

export function fetchMySubmissions(
  competitionId: string,
  limit: number,
  offset: number,
): Promise<SubmissionsResponse> {
  return api.get(`/competitions/${competitionId}/submissions/me?limit=${limit}&offset=${offset}`);
}

/** `track` bắt buộc với cuộc thi dual - backend từ chối khi thiếu, và hai bảng không dùng chung. */
export function fetchLeaderboard(
  competitionId: string,
  limit: number,
  offset: number,
  track?: Track | null,
): Promise<ParticipantLeaderboardResponse> {
  const scope = track ? `&track=${track}` : "";
  return api.get(`/competitions/${competitionId}/leaderboard?limit=${limit}&offset=${offset}${scope}`);
}

/**
 * Số ghi theo đúng số thập phân admin khai báo cho metric đó. Record cũ có thể thiếu metric
 * (bài chấm bằng bộ chấm khác): hiện dấu gạch, không tự coi là 0.
 */
export function formatMetric(value: number | null | undefined, decimals: number): string {
  return value == null ? "-" : value.toFixed(decimals);
}
