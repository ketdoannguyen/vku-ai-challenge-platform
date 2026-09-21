"""Hằng số hợp đồng của AI Notebook Review.

Giá trị ở đây không đọc từ environment: chúng là một phần hợp đồng dữ liệu (được ghi vào Mongo và
được băm vào cache key), nên đổi chúng là đổi schema chứ không phải đổi cấu hình vận hành.

Ba trục trạng thái độc lập (ADR-035 vẫn nguyên vẹn):
    Scoring: `submissions.status`
    Human:   `submissions.review.status`
    AI:      `submissions.ai_review.state` + `.verdict`
"""

# --- Provider -------------------------------------------------------------------------------
# Chỉ giao thức OpenAI-compatible phía server; không có adapter Anthropic (quyết định sản phẩm).
PROVIDER_OPENAI_COMPATIBLE = "openai_compatible"

# --- Trạng thái AI trên submission ----------------------------------------------------------
AI_STATE_QUEUED = "QUEUED"
AI_STATE_RUNNING = "RUNNING"
AI_STATE_COMPLETED = "COMPLETED"
AI_STATE_ERROR = "ERROR"
AI_PENDING_STATES = (AI_STATE_QUEUED, AI_STATE_RUNNING)

# --- Verdict --------------------------------------------------------------------------------
VERDICT_CLEAR = "CLEAR"
VERDICT_FLAGGED = "FLAGGED"
VERDICT_INCONCLUSIVE = "INCONCLUSIVE"
VERDICT_ERROR = "ERROR"
# Terminal verdict dùng được cho cache. ERROR không có mặt: nó do pipeline sinh ra chứ không phải
# kết luận của model, và một lượt hỏng thì không bao giờ được phục vụ lại từ cache.
CACHEABLE_VERDICTS = (VERDICT_CLEAR, VERDICT_FLAGGED, VERDICT_INCONCLUSIVE)

# --- Trạng thái job -------------------------------------------------------------------------
JOB_QUEUED = "QUEUED"
JOB_RUNNING = "RUNNING"
JOB_COMPLETED = "COMPLETED"
JOB_FAILED = "FAILED"

JOB_SOURCE_AUTO = "AUTO"
JOB_SOURCE_MANUAL = "MANUAL"

# --- Trạng thái snapshot nội dung -----------------------------------------------------------
SNAPSHOT_CAPTURED = "CAPTURED"
SNAPSHOT_ERROR = "ERROR"

# --- Finding --------------------------------------------------------------------------------
CHECKABLE = "CHECKABLE_FROM_NOTEBOOK"
NOT_CHECKABLE = "NOT_CHECKABLE_FROM_NOTEBOOK"

FINDING_VIOLATION = "VIOLATION"
FINDING_COMPLIANT = "COMPLIANT"

REVIEW_STATUS_COMPLETED = "COMPLETED"
REVIEW_STATUS_FAILED = "FAILED"

# `source` của một review row: gọi provider thật, dùng lại cache, hay do pipeline sinh (không gọi).
SOURCE_PROVIDER = "PROVIDER"
SOURCE_CACHE = "CACHE"
SOURCE_PIPELINE = "PIPELINE"

# --- Phiên bản ------------------------------------------------------------------------------
# Mọi thứ ảnh hưởng tới nội dung gửi model đều phải nằm trong cache key; đổi hành vi là bump version.
PROMPT_VERSION = "ai-review-v2"
NORMALIZATION_VERSION = "notebook-v2"
CONTEXT_POLICY_VERSION = "context-v2"

# --- Giới hạn cấu trúc output ---------------------------------------------------------------
# Trần cứng để output model không bao giờ phình to trong Mongo; vượt trần là output không hợp lệ.
MAX_FINDINGS = 20
MAX_EVIDENCE_PER_FINDING = 5
MAX_SUMMARY_CHARS = 1_000
MAX_REASON_CHARS = 1_000
MAX_RULE_TEXT_CHARS = 2_000
MAX_SNIPPET_LINES = 12
MAX_SNIPPET_CHARS = 600
# Snippet do backend dựng lại từ đúng dòng trong notebook đã normalize, không tin model.
SNIPPET_LINE_WINDOW = 4

# --- Trục lọc AI của bảng admin -------------------------------------------------------------
# Giá trị query param độc lập hoàn toàn với `status` (chấm điểm) và `review` (BTC duyệt).
FILTER_AI_ALL = "all"
FILTER_AI_CLEAR = "clear"
FILTER_AI_FLAGGED = "flagged"
FILTER_AI_INCONCLUSIVE = "inconclusive"
FILTER_AI_ERROR = "error"
FILTER_AI_PENDING = "pending"
FILTER_AI_NONE = "none"
AI_FILTERS = (
    FILTER_AI_ALL,
    FILTER_AI_CLEAR,
    FILTER_AI_FLAGGED,
    FILTER_AI_INCONCLUSIVE,
    FILTER_AI_ERROR,
    FILTER_AI_PENDING,
    FILTER_AI_NONE,
)

# --- Mã lỗi API (docs/API_CONTRACT.md) --------------------------------------------------------
AI_CONFIG_INCOMPLETE = "AI_CONFIG_INCOMPLETE"
AI_ENCRYPTION_KEY_MISSING = "AI_ENCRYPTION_KEY_MISSING"
AI_API_KEY_MISSING = "AI_API_KEY_MISSING"
AI_ENDPOINT_INVALID = "AI_ENDPOINT_INVALID"
AI_HOST_NOT_ALLOWED = "AI_HOST_NOT_ALLOWED"
AI_PRIVATE_HOST_NOT_ALLOWED = "AI_PRIVATE_HOST_NOT_ALLOWED"
AI_INSECURE_ENDPOINT_NOT_ALLOWED = "AI_INSECURE_ENDPOINT_NOT_ALLOWED"
AI_TRANSFER_NOT_ACKNOWLEDGED = "AI_TRANSFER_NOT_ACKNOWLEDGED"
AI_REVIEW_DISABLED = "AI_REVIEW_DISABLED"
AI_REVIEW_IN_PROGRESS = "AI_REVIEW_IN_PROGRESS"
AI_REVIEW_NOT_AVAILABLE = "AI_REVIEW_NOT_AVAILABLE"
AI_NOTEBOOK_MISSING = "AI_NOTEBOOK_MISSING"
AI_CONNECTION_FAILED = "AI_CONNECTION_FAILED"
AI_PROVIDER_UNAUTHORIZED = "AI_PROVIDER_UNAUTHORIZED"
AI_PROVIDER_MODEL_INVALID = "AI_PROVIDER_MODEL_INVALID"
AI_PROVIDER_RATE_LIMITED = "AI_PROVIDER_RATE_LIMITED"
AI_PROVIDER_UNAVAILABLE = "AI_PROVIDER_UNAVAILABLE"
AI_PROVIDER_REDIRECT_REJECTED = "AI_PROVIDER_REDIRECT_REJECTED"
AI_PROVIDER_RESPONSE_TOO_LARGE = "AI_PROVIDER_RESPONSE_TOO_LARGE"
AI_RESPONSE_INVALID = "AI_RESPONSE_INVALID"
AI_CONTENT_SNAPSHOT_UNAVAILABLE = "AI_CONTENT_SNAPSHOT_UNAVAILABLE"
AI_CONTENT_TOO_LARGE = "AI_CONTENT_TOO_LARGE"

# Mã lỗi riêng của quá trình chụp snapshot - lưu vào `submissions.content_snapshot.error_code`.
SNAPSHOT_CONTENT_EMPTY = "CONTENT_EMPTY"
SNAPSHOT_CONTENT_TOO_LARGE = "CONTENT_SNAPSHOT_TOO_LARGE"
SNAPSHOT_CONTENT_CHANGED = "CONTENT_CHANGED_DURING_CAPTURE"
SNAPSHOT_CONTENT_UNREADABLE = "CONTENT_UNREADABLE"

# Thông điệp an toàn cho participant: không bao giờ lộ mã lỗi kỹ thuật hay chi tiết provider.
PARTICIPANT_ERROR_SUMMARY = "AI chưa thể hoàn tất kiểm tra."
PARTICIPANT_QUEUED_SUMMARY = "AI đang kiểm tra notebook."
