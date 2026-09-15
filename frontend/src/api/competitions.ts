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
  pos_label: string | null;
  max_upload_mb: number;
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
  created_by: string;
  join_code_configured: boolean;
  membership: Membership;
  submission_config: SubmissionConfig;
}

export interface JoinResponse {
  competition_id: string;
  membership: Membership;
  joined_now: boolean;
}

export interface CompetitionsResponse {
  competitions: Competition[];
}

export const STATUS_LABEL: Record<Competition["status"], string> = {
  draft: "Nháp",
  published: "Đang mở",
  closed: "Đã kết thúc",
};

export const JOIN_MODE_LABEL: Record<Competition["join_mode"], string> = {
  open: "Tự do tham gia",
  code: "Cần mã tham gia",
  invite_only: "Chỉ được mời",
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

/** published → success, closed → muted, draft (admin-only view) → warning. */
export function statusClass(status: Competition["status"]): string {
  if (status === "published") return "success";
  if (status === "closed") return "closed";
  return "warning";
}
