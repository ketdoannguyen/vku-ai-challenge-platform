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

export interface SubmissionHistoryItem {
  id: string;
  competition_id: string;
  status: "completed" | "rejected" | "failed";
  metrics: Metrics | null;
  primary_score: number | null;
  created_at: string;
  artifacts: SubmissionArtifacts;
  error?: { code: string; message: string };
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
export interface AdminSubmissionItem extends SubmissionHistoryItem {
  account: { id: string; name: string; email: string };
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
