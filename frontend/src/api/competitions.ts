/** Types + helpers dùng chung cho competition API (Sprint 03). */

export interface Membership {
  active: boolean;
  joined_at: string | null;
}

export interface SubmissionConfig {
  ready: boolean;
  id_column: string | null;
  prediction_column: string | null;
  average: "binary" | "macro" | "weighted" | null;
  /** Chỉ có với admin và thành viên đang hoạt động - nhãn dương là thông tin của ground truth. */
  pos_label?: string | null;
  max_upload_mb: number;
  /** Trần notebook Jupyter - mỗi lượt nộp bắt buộc kèm một tệp .ipynb. */
  max_notebook_mb: number;
}

/** Link tài nguyên BTC khai báo - nền tảng chỉ lưu URL, không host dataset. */
export interface CompetitionResource {
  label: string;
  url: string;
}

/** Khớp RESOURCES_MAX ở backend - chặn thêm dòng ngay trên UI. */
export const MAX_COMPETITION_RESOURCES = 10;

/** Hạn mức nộp trong ngày UTC - chỉ detail trả về, và chỉ cho thành viên đang hoạt động. */
export interface QuotaStatus {
  per_day: number;
  used_today: number;
  remaining: number;
  resets_at: string;
}

export interface Competition {
  id: string;
  slug: string;
  name: string;
  short_description: string;
  status: "draft" | "published" | "closed";
  start_at: string;
  end_at: string;
  join_mode: "open" | "code" | "invite_only";
  primary_metric: "f1" | "precision" | "recall";
  quota_per_day: number;
  leaderboard_visible: boolean;
  join_code_configured: boolean;
  resources: CompetitionResource[];
  membership: Membership;
  submission_config: SubmissionConfig;
  /** Vắng mặt với guest, người chưa join, member bị vô hiệu hóa và cuộc thi đã đóng. */
  quota?: QuotaStatus;
}

export interface JoinResponse {
  competition_id: string;
  membership: Membership;
  joined_now: boolean;
}

export interface LeaveResponse {
  competition_id: string;
  membership: Membership;
  /** false khi gọi lại trên membership đã rời - thao tác vẫn thành công. */
  left_now: boolean;
}

export interface CompetitionsResponse {
  competitions: Competition[];
}

/** Bảng admin kèm số liệu tổng hợp và created_by - endpoint public không trả về các field này. */
export interface AdminCompetition extends Competition {
  created_by: string;
  /** Chỉ đếm thành viên đang hoạt động; người đã rời/bị vô hiệu hóa nằm ở inactive_member_count. */
  member_count: number;
  inactive_member_count: number;
  submission_count: number;
  /** Chỉ endpoint admin detail trả về - list cố ý không đọc ground truth cho từng dòng. */
  publish_ready?: boolean;
  publish_blocked_reason?: PublishBlockedReason | null;
  /** Trần upload theo môi trường; optional để frontend mới vẫn chạy với backend cũ. */
  upload_limits?: UploadLimits;
}

/** Trần dung lượng upload (MiB) do backend cấu hình qua env, dùng để render hint. */
export interface UploadLimits {
  submission_mb: number;
  content_mb: number;
  asset_mb: number;
}

/** Dùng khi backend cũ chưa trả `upload_limits`. */
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  submission_mb: 10,
  content_mb: 2,
  asset_mb: 2,
};

/** Lý do publish bị chặn, khớp mã lỗi backend trả về khi gọi publish. */
export interface PublishBlockedReason {
  code: string;
  message: string;
}

export interface AdminCompetitionsResponse {
  competitions: AdminCompetition[];
}

export const STATUS_LABEL: Record<Competition["status"], string> = {
  draft: "Nháp",
  published: "Đang diễn ra",
  closed: "Đã kết thúc",
};

export const JOIN_MODE_LABEL: Record<Competition["join_mode"], string> = {
  open: "Tự do tham gia",
  code: "Cần mã tham gia",
  invite_only: "Chỉ theo lời mời",
};

export const METRIC_LABEL: Record<Competition["primary_metric"], string> = {
  f1: "F1",
  precision: "Precision",
  recall: "Recall",
};

/** "2026-10-01T00:00:00Z" → "01/10/2026 07:00" theo local timezone (DATA_MODEL quy ước). */
export function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value từ ISO UTC: "2026-10-01T00:00:00Z" → "2026-10-01T07:00" (giờ local). */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local input (giờ local) → ISO UTC string cho API. */
export function localInputToIso(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

const RESOURCE_URL_MAX = 2048;
const RESOURCE_HOSTS = ["drive.google.com", "docs.google.com"];

/**
 * Lọc lại URL tài nguyên ngay trước khi render: backend đã validate, nhưng dữ liệu
 * legacy hoặc ghi trực tiếp vào DB vẫn không được phép tạo thành link sống.
 */
export function isSafeResourceUrl(value: string): boolean {
  if (!value || value.length > RESOURCE_URL_MAX) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return RESOURCE_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

/** published → success, closed → muted, draft (admin-only view) → warning. */
export function statusClass(status: Competition["status"]): string {
  if (status === "published") return "success";
  if (status === "closed") return "closed";
  return "warning";
}
