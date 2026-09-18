import { api } from "./client";

export interface Metrics {
  f1: number;
  precision: number;
  recall: number;
}

export interface SubmissionHistoryItem {
  id: string;
  competition_id: string;
  filename: string;
  status: "completed" | "rejected" | "failed";
  metrics: Metrics | null;
  primary_score: number | null;
  created_at: string;
  error?: { code: string; message: string };
}

export interface SubmissionsResponse {
  submissions: SubmissionHistoryItem[];
  total: number;
  limit: number;
  offset: number;
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
