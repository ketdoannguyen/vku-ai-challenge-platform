/**
 * API của tính năng kiểm tra notebook bằng AI.
 *
 * Từ vựng ở đây cố ý nói "AI sơ bộ" chứ không phải "duyệt": kết luận AI là thông tin tham khảo,
 * chỉ quyết định của Ban Tổ chức mới loại một bài nộp khỏi kết quả. Trộn hai từ đó sẽ khiến admin
 * đọc nhầm một verdict thành một phán quyết.
 */

import { api } from "./client";

/** Trạng thái vòng chạy; `ERROR` là lượt hỏng, không phải kết luận. */
export type AiReviewState = "QUEUED" | "RUNNING" | "COMPLETED" | "ERROR";

/** Kết luận của model đã qua kiểm tra bằng chứng phía server. */
export type AiVerdict = "CLEAR" | "FLAGGED" | "INCONCLUSIVE" | "ERROR";

/** Bộ lọc cột AI của bảng admin - độc lập hoàn toàn với trục chấm điểm và trục duyệt. */
export type AiReviewFilter =
  | "all"
  | "flagged"
  | "clear"
  | "inconclusive"
  | "error"
  | "pending"
  | "none";

/** Projection thí sinh nhận được: trạng thái, kết luận, một câu tóm tắt an toàn. */
export interface ParticipantAiReview {
  state: AiReviewState;
  /** Chỉ khác null khi `state` là COMPLETED - lượt hỏng không bao giờ trả verdict cho thí sinh. */
  verdict: AiVerdict | null;
  summary: string;
  updated_at: string | null;
}

/** Projection admin: thêm định danh lượt chạy để đối chiếu với lịch sử. */
export interface AdminAiReview extends ParticipantAiReview {
  generation: number | null;
  run_id: string | null;
  latest_review_id: string | null;
  requested_at: string | null;
}

export interface AiReviewConfig {
  enabled: boolean;
  auto_review: boolean;
  participant_visible: boolean;
  provider: string;
  base_url: string;
  model: string;
  /** Backend không bao giờ trả key; chỉ trả việc đã có key hay chưa. */
  api_key_configured: boolean;
  /** Host admin đã xác nhận sẽ nhận nội dung notebook; null nghĩa là chưa xác nhận. */
  acknowledged_host: string | null;
  updated_at: string | null;
}

export interface AiReviewRuntime {
  encryption_available: boolean;
  allowed_hosts_configured: boolean;
}

export type ContentSourceReason = "OK" | "NO_MARKDOWN" | "UNREADABLE";

export interface ContentSourcePage {
  content_id: string;
  title: string;
  slug: string;
  order: number;
  visibility: string;
  included: boolean;
  reason: ContentSourceReason;
}

/** Page nào sẽ nằm trong revision kế tiếp - để admin biết trước khi bật AI. */
export interface ContentSourceView {
  included_count: number;
  excluded_count: number;
  total_bytes: number;
  pages: ContentSourcePage[];
}

export interface AiReviewSettings {
  config: AiReviewConfig;
  runtime: AiReviewRuntime;
  content_source: ContentSourceView;
}

/** Field vắng mặt nghĩa là giữ nguyên; `api_key` rỗng cũng giữ nguyên key đã lưu. */
export interface AiReviewSettingsUpdate {
  enabled?: boolean;
  auto_review?: boolean;
  participant_visible?: boolean;
  base_url?: string;
  model?: string;
  api_key?: string;
  acknowledge_transfer?: boolean;
}

export interface AiConnectionTestRequest {
  base_url?: string;
  model?: string;
  api_key?: string;
}

/** Kết quả thử kết nối: không chứa nội dung cuộc thi vì test không gửi notebook hay thể lệ. */
export interface AiConnectionTestResult {
  ok: boolean;
  host: string;
  model: string;
  latency_ms: number;
}

export interface AiEvidence {
  cell: number;
  start_line: number;
  end_line: number;
  /** Server tự trích lại từ notebook đã lưu, không lấy từ output của model. */
  snippet: string;
}

export type FindingStatus = "VIOLATION" | "COMPLIANT" | "UNCLEAR";
export type Checkability = "CHECKABLE_FROM_NOTEBOOK" | "NOT_CHECKABLE_FROM_NOTEBOOK";

export interface AiFinding {
  source_content_title: string;
  source_content_slug: string;
  rule_text: string;
  checkability: Checkability;
  status: FindingStatus;
  reason: string;
  evidence: AiEvidence[];
}

export interface AiNotebookStats {
  cells: number;
  code_cells: number;
  markdown_cells: number;
  lines: number;
  truncated: boolean;
  omitted_cells: number;
}

export interface AiReviewError {
  code: string;
  message: string;
  occurred_at: string;
}

/** Một dòng lịch sử. Không có raw prompt, raw response, object key hay API key. */
export interface AiReviewRecord {
  id: string;
  run_id: string;
  generation: number;
  status: "COMPLETED" | "FAILED";
  verdict: AiVerdict;
  /** Kết luận thô của model trước khi server hạ cấp; khác `verdict` khi có downgrade. */
  model_verdict: AiVerdict | null;
  summary: string | null;
  findings: AiFinding[];
  notebook_stats: AiNotebookStats;
  provider: string | null;
  provider_host: string | null;
  model: string | null;
  versions: {
    prompt: string | null;
    normalization: string | null;
    context_policy: string | null;
  };
  source: "PROVIDER" | "CACHE" | "PIPELINE";
  reused_from_review_id: string | null;
  bypass_cache: boolean;
  manual: boolean;
  attempts: number | null;
  downgrade_codes: string[];
  error: AiReviewError | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface AiContentSnapshot {
  state: "CAPTURED" | "ERROR" | null;
  revision_id: string | null;
  content_hash: string | null;
  error_code: string | null;
  captured_at: string | null;
}

export interface AiReviewSubmissionRef {
  id: string;
  submission_no: number | null;
  status: string;
  created_at: string;
  account: { id: string; name: string; email: string };
  competition: { id: string; slug: string; name: string };
}

export interface AiReviewDetail {
  submission: AiReviewSubmissionRef;
  ai_review: AdminAiReview | null;
  content_snapshot: AiContentSnapshot | null;
  history: AiReviewRecord[];
}

export const AI_STATE_LABEL: Record<AiReviewState, string> = {
  QUEUED: "Đang chờ",
  RUNNING: "Đang kiểm tra",
  COMPLETED: "Đã có kết luận",
  ERROR: "Chưa hoàn tất",
};

export const AI_VERDICT_LABEL: Record<AiVerdict, string> = {
  CLEAR: "Không phát hiện",
  FLAGGED: "Có dấu hiệu",
  INCONCLUSIVE: "Chưa đủ căn cứ",
  ERROR: "Chưa hoàn tất",
};

/**
 * Tông màu badge. `ERROR` là warning chứ không phải danger: một lượt hỏng không phải bằng chứng
 * vi phạm, và cũng không phải một phán quyết.
 */
export const AI_VERDICT_TONE: Record<AiVerdict, "success" | "danger" | "warning"> = {
  CLEAR: "success",
  FLAGGED: "danger",
  INCONCLUSIVE: "warning",
  ERROR: "warning",
};

export const FINDING_STATUS_LABEL: Record<FindingStatus, string> = {
  VIOLATION: "Có dấu hiệu vi phạm",
  COMPLIANT: "Không vi phạm",
  UNCLEAR: "Chưa rõ",
};

export const CHECKABILITY_LABEL: Record<Checkability, string> = {
  CHECKABLE_FROM_NOTEBOOK: "Kiểm tra được từ notebook",
  NOT_CHECKABLE_FROM_NOTEBOOK: "Không kiểm tra được từ notebook",
};

export const AI_FILTER_OPTIONS: ReadonlyArray<{ value: AiReviewFilter; label: string }> = [
  { value: "all", label: "Mọi trạng thái AI" },
  { value: "flagged", label: "AI: Có dấu hiệu" },
  { value: "clear", label: "AI: Không phát hiện" },
  { value: "inconclusive", label: "AI: Chưa đủ căn cứ" },
  { value: "error", label: "AI lỗi" },
  { value: "pending", label: "AI đang xử lý" },
  { value: "none", label: "Chưa đánh giá" },
];

/** Câu thí sinh đọc được. Không có mã lỗi, tên provider, model hay chi tiết kỹ thuật. */
export const AI_PARTICIPANT_DISCLAIMER =
  "Đây là kết quả kiểm tra tự động. Ban Tổ chức đưa ra quyết định cuối cùng.";

export function fetchAiReviewSettings(competitionId: string): Promise<AiReviewSettings> {
  return api.get(`/admin/competitions/${competitionId}/ai-review`);
}

export function updateAiReviewSettings(
  competitionId: string,
  payload: AiReviewSettingsUpdate,
): Promise<{ config: AiReviewConfig }> {
  return api.put(`/admin/competitions/${competitionId}/ai-review`, payload);
}

export function deleteAiReviewApiKey(competitionId: string): Promise<{ config: AiReviewConfig }> {
  return api.del(`/admin/competitions/${competitionId}/ai-review/api-key`);
}

/** Thử cấu hình chưa lưu: field vắng mặt lấy từ config đang có trên server. */
export function testAiReviewConnection(
  competitionId: string,
  payload: AiConnectionTestRequest,
): Promise<AiConnectionTestResult> {
  return api.post(`/admin/competitions/${competitionId}/ai-review/test`, payload);
}

export function fetchAiReviewDetail(submissionId: string): Promise<AiReviewDetail> {
  return api.get(`/admin/submissions/${submissionId}/ai-review`);
}

export function rerunAiReview(
  submissionId: string,
): Promise<{ submission: unknown }> {
  return api.post(`/admin/submissions/${submissionId}/ai-review/rerun`);
}

/** Có lượt nào đang chạy trong danh sách này không - quyết định bật/tắt polling. */
export function hasPendingAiReview(
  items: ReadonlyArray<{ ai_review?: ParticipantAiReview | null }>,
): boolean {
  return items.some(
    (item) => item.ai_review?.state === "QUEUED" || item.ai_review?.state === "RUNNING",
  );
}
