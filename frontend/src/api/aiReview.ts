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
  | "source_external"
  | "source_unclear"
  | "source_not_evaluated"
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
  /**
   * Câu gợi ý ngắn do model soạn nháp cho thí sinh; `null` khi model không đưa ra câu nào.
   * Chỉ admin thấy: đây là bản nháp để admin sửa trước khi gửi, không phải thứ thí sinh đọc.
   */
  participant_summary: string | null;
  /**
   * Trạng thái nguồn sau hậu kiểm của lượt hiện tại; `null` khi lượt chưa xong, gặp lỗi, hoặc là
   * row cũ trước phiên bản assessment. Thiếu dữ kiện KHÔNG được đọc thành `ALIGNED`.
   */
  source_status?: AiSourceStatus | null;
  /** Version sinh ra `source_status`; lệch version hiện hành nghĩa là dữ liệu chưa hậu kiểm lại. */
  source_signal_version?: string | null;
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
  /**
   * Lần cuối gọi provider thành công bằng đúng cấu hình đang lưu; `null` khi chưa từng thử hoặc
   * cấu hình đã đổi kể từ đó. Server tự hết hiệu lực hoá bằng vân tay, client chỉ đọc.
   */
  verified_at: string | null;
  updated_at: string | null;
}

export interface AiReviewRuntime {
  encryption_available: boolean;
}

export type ContentSourceReason = "OK" | "NO_MARKDOWN" | "UNREADABLE";

export interface ContentSourcePage {
  content_id: string;
  title: string;
  slug: string;
  order: number;
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

/**
 * Trạng thái nguồn dataset sau hậu kiểm. `NOT_EVALUATED` do backend sinh khi thiếu đánh giá hoặc
 * thiếu tài nguyên BTC để đối chiếu - đọc thành "nguồn đã sạch" là sai.
 */
export type AiSourceStatus = "ALIGNED" | "EXTERNAL" | "UNCLEAR" | "NOT_EVALUATED";

/** Vị trí trích dẫn bị loại khỏi đánh giá nguồn, kèm mã lý do; UI dịch mã, không hiện mã thô. */
export interface AiRejectedSourceEvidence {
  cell: number;
  start_line: number;
  end_line: number;
  code: string;
}

/** Một đánh giá nguồn cho CẢ notebook: đề xuất của AI, kết quả hậu kiểm và bằng chứng hai phía. */
export interface AiSourceAssessment {
  /** Đề xuất ban đầu của AI; `null` khi model không trả đánh giá. */
  model_status: AiSourceStatus | null;
  /** Kết quả sau hậu kiểm cấu trúc; có thể khác đề xuất khi bị hạ. */
  status: AiSourceStatus;
  reason: string;
  /** Chỉ chứa vị trí CODE cell hợp lệ với snippet server dựng lại, không tin bản model chép. */
  evidence: AiEvidence[];
  /** Vị trí AI nêu nhưng không dùng được; giữ lại làm dấu vết cho BTC đọc. */
  rejected_evidence: AiRejectedSourceEvidence[];
  /** Mã chẩn đoán vì sao đánh giá thiếu căn cứ hoặc bị hạ; UI dịch sang tiếng Việt. */
  validation_codes: string[];
}

export type FindingStatus = "VIOLATION" | "COMPLIANT" | "UNCLEAR";
export type Checkability = "CHECKABLE_FROM_NOTEBOOK" | "NOT_CHECKABLE_FROM_NOTEBOOK";

/** Cách hệ thống tìm ra quy định mà finding dựa vào. `UNRESOLVED` nghĩa là không có gì chống lưng. */
export type RuleResolution = "REFERENCE" | "CANONICAL_QUOTE" | "UNRESOLVED";

export interface AiFinding {
  source_content_title: string;
  source_content_slug: string;
  /**
   * Nguyên văn quy định, do server điền từ bản thể lệ đã chốt lúc nộp. Rỗng khi không đối chiếu
   * được quy định nào - UI không bao giờ được thay chỗ trống đó bằng lời của model.
   */
  rule_text: string;
  checkability: Checkability;
  status: FindingStatus;
  reason: string;
  evidence: AiEvidence[];

  /**
   * Các field hậu kiểm bên dưới chỉ có ở audit row từ bản Hybrid B+D trở đi. Chúng đều optional
   * đúng vì lý do đó: row lịch sử không có chúng, và UI phải chịu được điều đó thay vì suy diễn.
   */
  /** Ref do backend sinh mà model đã nhắc lại. `null` khi không đối chiếu được quy định nào. */
  rule_ref?: string | null;
  /** Ref nguyên văn model gửi - giữ lại để đối chiếu khi model chép sai. */
  model_rule_ref?: string;
  rule_resolution?: RuleResolution;
  /** Quy định có thật trong bản thể lệ đã chốt hay không. */
  rule_verified?: boolean;
  evidence_count?: number;
  valid_evidence_count?: number;
  /** Có ít nhất một khoảng cell/dòng hợp lệ và snippet đã được server dựng lại. */
  evidence_verified?: boolean;
  /** Quy định đối chiếu được VÀ bằng chứng hợp lệ. */
  verified?: boolean;
  /** `verified` cộng thêm: là cáo buộc, và kiểm chứng được từ notebook. Đây là thứ giữ FLAGGED. */
  traceable?: boolean;
  /** Mã chẩn đoán vì sao finding chưa được xác minh; UI dịch sang tiếng Việt, không hiện mã. */
  verification_codes?: string[];
}

/** Trạng thái đối chiếu nguồn do backend tính; dùng chung cho cả đoạn code lẫn từng URL/ID. */
export type AiSourceMatch =
  | "MATCHED_RESOURCE"
  | "FOLDER_MEMBERSHIP_UNVERIFIED"
  | "EXTERNAL_SOURCE"
  | "UNVERIFIED_SOURCE";

export interface AiSourceSignal {
  cell: number;
  start_line: number;
  end_line: number;
  snippet: string;
  reason: string;
  match: AiSourceMatch;
  urls: { url: string; match: AiSourceMatch; resource_label: string | null }[];
  warning: boolean;
}

/** Một tài nguyên BTC quét thấy trong CODE cell; `cells` là số cell 1-based, tăng dần. */
export interface AiResourceMention {
  label: string;
  cells: number[];
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
  participant_summary: string | null;
  findings: AiFinding[];
  /** Đánh giá nguồn toàn notebook; thiếu field nghĩa là row cũ trước phiên bản assessment. */
  source_assessment?: AiSourceAssessment | null;
  /** Tín hiệu nguồn của row cũ - chỉ còn để đọc lịch sử, không bao giờ có ở lượt mới. */
  source_signals?: AiSourceSignal[];
  resources_configured?: number;
  /**
   * Kết quả quét toàn notebook (ADR-059): tài nguyên BTC xuất hiện ở CODE cell nào. `[]` nghĩa là
   * đã quét và không thấy; row cũ thiếu field (`null`/`undefined`) nghĩa là không biết.
   */
  resources_in_notebook?: AiResourceMention[] | null;
  notebook_stats: AiNotebookStats;
  provider: string | null;
  provider_host: string | null;
  model: string | null;
  /** Ba version cuối chỉ có ở row từ Hybrid B+D trở đi; row cũ trả `null`. */
  versions: {
    prompt: string | null;
    normalization: string | null;
    context_policy: string | null;
    canonicalization: string | null;
    rule_ref: string | null;
    verifier: string | null;
    source_signal?: string | null;
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

/**
 * Mức độ đối chiếu của một finding, đã dịch từ các field hậu kiểm. `UNKNOWN` dành cho audit row
 * ghi trước Hybrid B+D: chúng không có field mới, và thiếu dữ liệu KHÔNG được đọc thành "đã xác
 * minh" - đó chính là kiểu suy diễn khiến một cáo buộc chưa kiểm chứng trông như đã kiểm chứng.
 */
export type FindingVerification = "VERIFIED" | "RULE_ONLY" | "UNRESOLVED" | "UNKNOWN";

export function findingVerification(finding: AiFinding): FindingVerification {
  if (typeof finding.rule_verified !== "boolean") return "UNKNOWN";
  if (!finding.rule_verified) return "UNRESOLVED";
  return finding.evidence_verified ? "VERIFIED" : "RULE_ONLY";
}

export const FINDING_VERIFICATION_LABEL: Record<FindingVerification, string> = {
  VERIFIED: "Đã đối chiếu",
  RULE_ONLY: "Đã tìm thấy quy định, chưa xác minh bằng chứng",
  UNRESOLVED: "Không đối chiếu được quy định",
  UNKNOWN: "",
};

/** Nhãn trạng thái đối chiếu của cả đoạn code; tone màu thuộc về chỗ hiển thị. */
export const SOURCE_MATCH_LABEL: Record<AiSourceMatch, string> = {
  MATCHED_RESOURCE: "Trùng nguồn BTC cấp",
  FOLDER_MEMBERSHIP_UNVERIFIED: "Chưa xác minh thư mục",
  EXTERNAL_SOURCE: "Không khớp nguồn BTC",
  UNVERIFIED_SOURCE: "Chưa xác định nguồn",
};

/** Nhãn ngắn cho từng URL/ID ghi nhận bên trong đoạn code. */
export const SOURCE_URL_MATCH_LABEL: Record<AiSourceMatch, string> = {
  MATCHED_RESOURCE: "Khớp BTC cấp",
  FOLDER_MEMBERSHIP_UNVERIFIED: "Chưa rõ thư mục",
  EXTERNAL_SOURCE: "Không khớp",
  UNVERIFIED_SOURCE: "Chưa xác định",
};

/** Nhãn trạng thái nguồn cho cả danh sách lẫn modal; một chỗ định nghĩa, hai chỗ đọc. */
export const AI_SOURCE_STATUS_LABEL: Record<AiSourceStatus, string> = {
  ALIGNED: "Nguồn: Phù hợp BTC",
  EXTERNAL: "Nguồn: Nghi nguồn ngoài",
  UNCLEAR: "Nguồn: Chưa xác minh",
  NOT_EVALUATED: "Nguồn: Chưa đánh giá được",
};

/** Row COMPLETED trước phiên bản assessment: thiếu dữ kiện nguồn, không phải đã sạch. */
export const AI_SOURCE_LEGACY_LABEL = "Nguồn: Chưa đánh giá theo phiên bản mới";

/**
 * Mã hậu kiểm nguồn → câu tiếng Việt. UI chỉ hiện câu dịch, không bao giờ hiện mã thô; mã lạ bị
 * ẩn thay vì đổ chuỗi kỹ thuật ra màn hình tác nghiệp.
 */
export const SOURCE_CODE_LABEL: Record<string, string> = {
  CELL_NOT_FOUND: "vị trí trích dẫn không có trong notebook",
  CELL_NOT_CODE: "trích dẫn nằm ngoài CODE cell",
  RANGE_INVALID: "khoảng dòng vượt quá nội dung cell",
  SOURCE_ASSESSMENT_MISSING: "AI không trả đánh giá nguồn cho lượt này",
  SOURCE_RESOURCES_MISSING: "cuộc thi không có tài nguyên BTC để đối chiếu",
  SOURCE_EVIDENCE_MISSING: "AI không kèm trích dẫn nào",
  SOURCE_EVIDENCE_INVALID: "toàn bộ trích dẫn không dùng được",
  SOURCE_EVIDENCE_PARTIALLY_INVALID: "một phần trích dẫn không dùng được",
  SOURCE_NOTEBOOK_TRUNCATED: "notebook bị cắt bớt khi gửi AI",
};

/**
 * Bộ lọc cột AI, tách hai nhóm theo trục: kết luận/trạng thái AI và đánh giá nguồn - không trộn
 * hai loại kết quả khác nhau vào một danh sách phẳng. Nhãn nhóm AI khớp badge trong bảng.
 */
export const AI_FILTER_GROUPS: ReadonlyArray<{
  label: string;
  options: ReadonlyArray<{ value: AiReviewFilter; label: string }>;
}> = [
  {
    label: "Kết luận AI",
    options: [
      { value: "all", label: "Mọi trạng thái AI" },
      { value: "flagged", label: "AI: Có dấu hiệu" },
      { value: "clear", label: "AI: Không phát hiện" },
      { value: "inconclusive", label: "AI: Chưa đủ căn cứ" },
      { value: "error", label: "AI: Chưa hoàn tất" },
      { value: "pending", label: "AI: Đang xử lý" },
      { value: "none", label: "AI: Chưa đánh giá" },
    ],
  },
  {
    label: "Đánh giá nguồn",
    options: [
      { value: "source_external", label: AI_SOURCE_STATUS_LABEL.EXTERNAL },
      { value: "source_unclear", label: AI_SOURCE_STATUS_LABEL.UNCLEAR },
      { value: "source_not_evaluated", label: AI_SOURCE_STATUS_LABEL.NOT_EVALUATED },
    ],
  },
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

/**
 * Nhập cấu hình AI từ cuộc thi khác: server thay thế toàn bộ cấu hình đích, kể cả API key.
 *
 * Ciphertext được sao chép thẳng giữa hai document trên server; request chỉ mang ID nguồn nên key
 * không bao giờ đi qua trình duyệt, và response cũng chỉ có `api_key_configured` như mọi lần đọc.
 */
export function importAiReviewSettings(
  competitionId: string,
  sourceCompetitionId: string,
): Promise<{ config: AiReviewConfig }> {
  return api.post(`/admin/competitions/${competitionId}/ai-review/import`, {
    source_competition_id: sourceCompetitionId,
  });
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
