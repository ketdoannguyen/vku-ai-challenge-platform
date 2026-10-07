/**
 * Types + call API cho bảng xếp hạng tổng hợp: một cấu hình ghép điểm chính của nhiều cuộc thi
 * nguồn theo trọng số. Chỉ admin sửa cấu hình; điểm luôn được tính lại phía server khi đọc.
 *
 * View của bảng dùng đúng hai nhánh `public`/`private` như BXH nguồn (`Track`); nguồn một nhánh
 * dùng chung cả hai view.
 */

import { type Track } from "./competitions";
import { api } from "./client";

export type AggregateVisibility = "members_any" | "members_all" | "authenticated";

export const AGGREGATE_VISIBILITY_LABEL: Record<AggregateVisibility, string> = {
  members_any: "Thành viên một trong các cuộc thi nguồn",
  members_all: "Thành viên tất cả cuộc thi nguồn",
  authenticated: "Mọi tài khoản đã đăng nhập",
};

/**
 * Lý do nguồn chưa sẵn sàng, mã ổn định từ backend. Nguồn mất/hỏng không tự mở theo thời gian
 * nên câu chữ hướng về việc admin cần kiểm tra, không hứa hẹn chờ đợi.
 */
const REASON_LABEL: Record<string, string> = {
  source_missing: "Cuộc thi nguồn đã bị xoá — cần admin kiểm tra cấu hình bảng.",
  source_draft: "Cuộc thi nguồn còn là bản nháp.",
  source_invalid: "Cách tính điểm của nguồn không còn dùng được — cần admin kiểm tra.",
  track_not_open: "Nhánh đang xem của nguồn chưa mở.",
  private_unpublished: "Kết quả nhánh Private của nguồn chưa được công bố.",
  leaderboard_hidden: "Bảng xếp hạng của nguồn đang tắt.",
  source_metric_hidden: "Metric chính của nguồn đang bị ẩn khỏi thí sinh.",
};

/** Câu giải thích cho một mã lý do; mã lạ hiện nguyên văn để không giấu sự thật. */
export function reasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return REASON_LABEL[reason] ?? reason;
}

export interface AggregateSourceView {
  competition_id: string;
  /** null khi document nguồn đã bị xoá. */
  slug: string | null;
  name: string | null;
  weight: number;
  /** Chỉ có khi nguồn sẵn sàng; nguồn đang chờ không lộ cách tính. */
  score_kind: "normalized" | "primary" | null;
  metric_label: string | null;
  ready: boolean;
  reason: string | null;
}

export interface AggregateEntry {
  rank: number;
  display_name: string;
  is_current_user: boolean;
  total_score: number;
  /** Luôn đủ nguồn và đúng thứ tự cấu hình; `null` là nguồn chưa có kết quả (khác 0 thật). */
  components: { competition_id: string; score: number | null }[];
}

export interface AggregateLeaderboard {
  slug: string;
  name: string;
  view: Track;
  has_private: boolean;
  /** Mốc sửa cấu hình gần nhất; không phải thời điểm điểm thay đổi. */
  updated_at: string;
  status: "ready" | "waiting";
  sources: AggregateSourceView[];
  entries: AggregateEntry[];
  /** null khi bảng đang chờ nguồn. */
  total: number | null;
  limit: number;
  offset: number;
  has_more: boolean;
  me: AggregateEntry | null;
}

export interface AggregateSourceSummary {
  competition_id: string;
  /** null khi document nguồn đã bị xoá. */
  slug: string | null;
  name: string | null;
  weight: number;
}

export interface AggregateListItem {
  slug: string;
  name: string;
  visibility: AggregateVisibility;
  sources: AggregateSourceSummary[];
  updated_at: string;
}

export interface AdminAggregateDetail extends AggregateListItem {
  published: boolean;
  created_at: string;
  created_by: string | null;
}

export interface AggregateSourceInput {
  competition_id: string;
  /** Trọng số 0–1; UI nhập phần trăm rồi chia 100 trước khi gửi. */
  weight: number;
}

export interface AggregateConfigInput {
  name: string;
  sources: AggregateSourceInput[];
  visibility: AggregateVisibility;
}

/** Trọng số → phần trăm để hiển thị khớp cách admin nhập. */
export function weightPercent(weight: number): string {
  return `${Number((weight * 100).toFixed(2))}%`;
}

/** Tên cuộc thi nguồn cho chỗ hẹp (cột bảng, chip); cắt ở ranh giới từ, tên đầy đủ ở title. */
export function shortName(name: string, max = 36): string {
  if (name.length <= max) return name;
  const cut = name.slice(0, max - 1).trimEnd();
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}

export function fetchAggregates(): Promise<{ aggregates: AggregateListItem[] }> {
  return api.get("/aggregates");
}

export function fetchAggregateLeaderboard(
  slug: string,
  view: Track,
  limit: number,
  offset: number,
): Promise<AggregateLeaderboard> {
  return api.get(`/aggregates/${slug}/leaderboard?view=${view}&limit=${limit}&offset=${offset}`);
}

export function fetchAdminAggregates(): Promise<{ aggregates: AdminAggregateDetail[] }> {
  return api.get("/admin/aggregates");
}

export function fetchAdminAggregate(slug: string): Promise<AdminAggregateDetail> {
  return api.get(`/admin/aggregates/${slug}`);
}

export function createAggregate(input: AggregateConfigInput): Promise<AdminAggregateDetail> {
  return api.post("/admin/aggregates", input);
}

/** PATCH ghép field gửi lên với cấu hình đang lưu rồi validate toàn bộ phía server. */
export function updateAggregate(
  slug: string,
  input: Partial<AggregateConfigInput>,
): Promise<AdminAggregateDetail> {
  return api.patch(`/admin/aggregates/${slug}`, input);
}

export function publishAggregate(slug: string): Promise<AdminAggregateDetail> {
  return api.post(`/admin/aggregates/${slug}/publish`);
}

export function unpublishAggregate(slug: string): Promise<AdminAggregateDetail> {
  return api.post(`/admin/aggregates/${slug}/unpublish`);
}

export function fetchAdminAggregateLeaderboard(
  slug: string,
  view: Track,
  limit: number,
  offset: number,
): Promise<AggregateLeaderboard> {
  return api.get(
    `/admin/aggregates/${slug}/leaderboard?view=${view}&limit=${limit}&offset=${offset}`,
  );
}

export function deleteAggregate(slug: string): Promise<{ deleted: boolean; slug: string }> {
  return api.del(`/admin/aggregates/${encodeURIComponent(slug)}?confirm_slug=${encodeURIComponent(slug)}`);
}
