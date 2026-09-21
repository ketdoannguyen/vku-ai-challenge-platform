import type { AdminAiReview, ParticipantAiReview } from "./aiReview";
import { api } from "./client";

export interface Metrics {
  f1: number;
  precision: number;
  recall: number;
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

export interface SubmissionHistoryItem {
  id: string;
  competition_id: string;
  status: "completed" | "rejected" | "failed";
  metrics: Metrics | null;
  primary_score: number | null;
  created_at: string;
  artifacts: SubmissionArtifacts;
  error?: { code: string; message: string };
  /** Chỉ có mặt khi bài đang bị từ chối; endpoint admin ghi đè bằng shape đầy đủ. */
  review?: ParticipantReview;
  /** Vắng mặt khi cuộc thi chưa bật AI, tắt AI, hoặc không công khai kết luận cho thí sinh. */
  ai_review?: ParticipantAiReview;
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

/** Nhãn badge cho dòng đã từng bị xét duyệt; `null` (chưa xét) hiển thị là "Hợp lệ". */
export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  accepted: "Đã khôi phục",
  rejected: "Không chấp nhận",
};

/** Cột sắp xếp bảng submission của admin - khớp `SORT_FIELDS` phía backend. */
export type AdminSortField =
  | "created_at"
  | "competition"
  | "team"
  | "primary_score"
  | "f1"
  | "precision"
  | "recall";
export type AdminSortOrder = "asc" | "desc";

/** Tổng quan bảng bài nộp toàn cục, tính trên cả bộ lọc đang xem chứ không phải trang hiện tại. */
export interface AdminSubmissionStats {
  total: number;
  competitions: number;
  teams: number;
  completed: number;
}

/** Dòng submission phía admin: thêm định danh tài khoản mà endpoint participant cố ý bỏ. */
export interface AdminSubmissionItem
  extends Omit<SubmissionHistoryItem, "review" | "ai_review"> {
  account: { id: string; name: string; email: string };
  /** Khác participant: luôn có khoá, `null` khi bài chưa từng bị xét duyệt. */
  review: AdminReview | null;
  /** Khác participant: luôn có khoá, `null` khi cuộc thi chưa từng bật AI lúc nộp bài. */
  ai_review: AdminAiReview | null;
}

/** Bảng toàn cục gắn thêm cuộc thi của từng dòng. */
export interface GlobalSubmissionItem extends AdminSubmissionItem {
  /** Chỉ endpoint toàn cục trả về; bảng theo cuộc thi đã biết sẵn cuộc thi của nó. */
  competition?: { id: string; slug: string; name: string };
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
}

export interface LeaderboardEntry {
  /** Thứ hạng toàn cục, không đánh lại số theo trang. */
  rank: number;
  display_name: string;
  primary_score: number;
  metrics: Metrics;
  best_submission_id: string;
  best_submission_at: string;
  total_submissions: number;
  is_current_user?: boolean;
  /** Chỉ endpoint admin trả về; endpoint participant đã bỏ định danh. */
  account_id?: string;
}

/** Admin và export luôn nhận toàn bộ danh sách, không phân trang. */
export interface LeaderboardResponse {
  competition_id: string;
  primary_metric: "f1" | "precision" | "recall";
  entries: LeaderboardEntry[];
  total: number;
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

export function fetchLeaderboard(
  competitionId: string,
  limit: number,
  offset: number,
): Promise<ParticipantLeaderboardResponse> {
  return api.get(`/competitions/${competitionId}/leaderboard?limit=${limit}&offset=${offset}`);
}

export function formatScore(value: number | null | undefined): string {
  return value == null ? "-" : value.toFixed(6);
}
