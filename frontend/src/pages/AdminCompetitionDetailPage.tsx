/** Admin quản lý nội dung, assets, scoring và thành viên của một competition. */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import type {
  AdminCompetition,
  Competition,
  CompetitionResource,
} from "../api/competitions";
import {
  DEFAULT_UPLOAD_LIMITS,
  formatLocal,
  JOIN_MODE_LABEL,
  MAX_COMPETITION_RESOURCES,
  METRIC_LABEL,
  STATUS_LABEL,
  displayStatus,
  statusClass,
} from "../api/competitions";
import type { ContentSummary } from "../api/contents";
import { formatScore, type LeaderboardResponse } from "../api/results";
import {
  CompetitionActionConfirmModal,
  CompetitionDeleteModal,
  CompetitionFormModal,
  type CompetitionAction,
} from "../components/AdminCompetitionManagement";
import { AdminSubmissionsPanel } from "../components/AdminSubmissionsPanel";
import { AiReviewSettingsPanel, IconSparkle } from "../components/AiReviewSettingsPanel";
import { ConfirmModal, Modal } from "../components/Modal";
import { ErrorBox, FileButton, Loading } from "../components/ui";
import { useAutoSlug } from "../hooks/useAutoSlug";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  cleanCompetitionResources,
  sameCompetitionResources,
} from "../lib/competitionResources";
import { downloadArtifact } from "../lib/downloadArtifact";
import { SLUG_MAX } from "../lib/slug";

type Tab = "contents" | "assets" | "resources" | "scoring" | "settings" | "members" | "results";

type IconComponent = (props: { className?: string }) => ReactNode;

/** Định nghĩa tab ở module scope để không tạo mảng mới mỗi lần render. */
const ADMIN_TABS: ReadonlyArray<{ key: Tab; label: string; Icon: IconComponent }> = [
  { key: "contents", label: "Nội dung", Icon: IconFileText },
  { key: "assets", label: "Hình ảnh", Icon: IconImage },
  { key: "resources", label: "Tài nguyên", Icon: IconFolder },
  { key: "scoring", label: "Chấm điểm", Icon: IconGauge },
  // Cấu hình AI là chuyện của từng cuộc thi, không phải thiết lập toàn hệ thống, nên đứng cạnh
  // Chấm điểm thay vì tách sang trang riêng.
  { key: "settings", label: "Cài đặt", Icon: IconSparkle },
  { key: "results", label: "Kết quả", Icon: IconTrophy },
  { key: "members", label: "Thành viên & mã tham gia", Icon: IconUsers },
];

/**
 * Accent xanh–đỏ–vàng lặp theo **vị trí render**, không đọc status/join_mode/metric:
 * màu chỉ để nhận diện thương hiệu, không mang nghĩa nghiệp vụ.
 */
const ROW_ACCENTS = ["blue", "red", "yellow"] as const;

type AccentTone = (typeof ROW_ACCENTS)[number];

function toneAt(index: number): AccentTone {
  return ROW_ACCENTS[index % ROW_ACCENTS.length];
}

/** Sáu field của dải tóm tắt; `read` giữ nguyên formatter hiện có, không hardcode giá trị. */
const SUMMARY_FACTS: ReadonlyArray<{
  label: string;
  Icon: IconComponent;
  mono?: boolean;
  read: (competition: Competition) => ReactNode;
}> = [
  { label: "Slug", Icon: IconTag, mono: true, read: (c) => c.slug },
  { label: "Bắt đầu", Icon: IconCalendar, read: (c) => formatLocal(c.start_at) },
  { label: "Kết thúc", Icon: IconFlag, read: (c) => formatLocal(c.end_at) },
  { label: "Tham gia", Icon: IconKey, read: (c) => JOIN_MODE_LABEL[c.join_mode] ?? c.join_mode },
  {
    label: "Chỉ số chính",
    Icon: IconTarget,
    read: (c) => METRIC_LABEL[c.primary_metric] ?? c.primary_metric.toUpperCase(),
  },
  { label: "Quota", Icon: IconClock, read: (c) => `${c.quota_per_day} lượt/ngày` },
];

interface AdminContent extends ContentSummary {
  markdown?: string;
}

interface AssetItem {
  name: string;
  size_bytes: number;
  content_type: string;
  url: string;
}

interface MemberItem {
  account_id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  joined_at: string;
}

interface ScoringConfig {
  id_column: string;
  prediction_column: string;
  label_column: string;
  average: "binary" | "macro" | "weighted";
  pos_label: string | null;
  higher_is_better: true;
}

interface ScoringStatus {
  ready: boolean;
  not_ready_reason: { code: string; message: string } | null;
  locked: boolean;
  config: ScoringConfig | null;
  ground_truth: {
    row_count: number;
    columns: string[];
    uploaded_at: string;
  } | null;
  primary_metric: "f1" | "precision" | "recall";
  quota_per_day: number;
  max_upload_mb: number;
}

function Icon({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function IconArrowBack({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m14.5 5-7 7 7 7" />
      <path d="M8 12h11" />
    </Icon>
  );
}

function IconEdit({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M13.5 6.5 17.5 10.5" />
      <path d="m4 20 4.25-1 10.5-10.5a2.12 2.12 0 0 0-3-3L5.25 16Z" />
    </Icon>
  );
}

function IconCopy({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </Icon>
  );
}

function IconPublish({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M5 14v5h14v-5" />
    </Icon>
  );
}

function IconStop({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </Icon>
  );
}

function IconReopen({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </Icon>
  );
}

function IconUpload({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M5 14v5h14v-5" />
    </Icon>
  );
}

function IconInfo({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </Icon>
  );
}

function IconImage({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="9" r="1.5" />
      <path d="m4 17 4.5-4.5 3.5 3 2.5-2.5 5.5 5" />
    </Icon>
  );
}

function IconTrash({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="m6 7 1 13h10l1-13" />
      <path d="M10 11v5M14 11v5" />
    </Icon>
  );
}

function IconSearch({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="10.75" cy="10.75" r="6.25" />
      <path d="m15.25 15.25 4.25 4.25" />
    </Icon>
  );
}

function IconCheck({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 2.5 2.5L16 9" />
    </Icon>
  );
}

function IconFileText({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </Icon>
  );
}

function IconGauge({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="m12 18 4.5-5" />
      <path d="M3 18h18" />
    </Icon>
  );
}

function IconTrophy({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M8 4h8v5a4 4 0 0 1-8 0Z" />
      <path d="M8 5H5v2a3 3 0 0 0 3 3M16 5h3v2a3 3 0 0 1-3 3" />
      <path d="M12 13v4M9 20h6" />
    </Icon>
  );
}

function IconUsers({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M3 20v-.5a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v.5" />
      <path d="M16.5 5.4a3.5 3.5 0 0 1 0 6.2M18 14.8a5 5 0 0 1 3 4.6v.6" />
    </Icon>
  );
}

function IconPlus({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

function IconTag({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3 11V5a2 2 0 0 1 2-2h6l10 10-8 8Z" />
      <circle cx="7.5" cy="7.5" r="1.25" />
    </Icon>
  );
}

function IconCalendar({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 11h18" />
    </Icon>
  );
}

function IconFlag({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M6 21V4" />
      <path d="M6 5h12l-2.5 4L18 13H6" />
    </Icon>
  );
}

function IconTarget({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
    </Icon>
  );
}

function IconClock({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Icon>
  );
}

function IconKey({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="8.5" cy="15.5" r="3.5" />
      <path d="m11 13 8.5-8.5" />
      <path d="m15.5 8.5 2.5 2.5M18.5 5.5l2 2" />
    </Icon>
  );
}

function IconFolder({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3.5 7a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.6.8l1 1.2H18.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7Z" />
      <path d="M12 10.5v5M9.5 13h5" />
    </Icon>
  );
}

function formatAssetType(contentType: string): string {
  switch (contentType.toLowerCase()) {
    case "image/png":
      return "PNG";
    case "image/jpeg":
    case "image/jpg":
      return "JPEG";
    case "image/gif":
      return "GIF";
    case "image/webp":
      return "WebP";
    default:
      return contentType;
  }
}

/** Chặn ở client để file quá trần không phát request; câu chữ khớp lỗi 413 của backend. */
function tooLargeMessage(file: File, limitMb: number): string | null {
  return file.size > limitMb * 1024 * 1024 ? `File vượt quá giới hạn ${limitMb} MiB.` : null;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return kb >= 10 ? `${Math.round(kb)} KB` : `${kb.toFixed(1)} KB`;
  }
  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(2)} MiB`;
}

export function AdminCompetitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [competition, setCompetition] = useState<AdminCompetition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<Tab>("contents");
  const [focusedTab, setFocusedTab] = useState<Tab>("contents");
  const [resourceDraft, setResourceDraft] = useState<CompetitionResource[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<CompetitionAction | null>(null);
  const [deleting, setDeleting] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const messageTimer = useRef<number | null>(null);
  // Tên cuộc thi chỉ biết sau khi tải xong nên tiêu đề tab bám theo dữ liệu, không theo id.
  useDocumentTitle(competition?.name ?? (error ? "Không thể tải cuộc thi" : "Quản lý cuộc thi"));

  const load = useCallback(async () => {
    setError(null);
    try {
      setCompetition(await api.get<AdminCompetition>(`/admin/competitions/${id}`));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(
    () => () => {
      if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    },
    [],
  );

  function notify(text: string) {
    if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    setMessage(text);
    messageTimer.current = window.setTimeout(() => {
      setMessage("");
      messageTimer.current = null;
    }, 4500);
  }

  // Manual activation: đổi tab sẽ mount panel và có thể phát API request, nên Arrow chỉ
  // dời focus; Enter/Space/click mới thực sự đổi panel.
  function activateTab(key: Tab) {
    setTab(key);
    setFocusedTab(key);
  }

  // Tablist luôn nằm ngang nên chỉ ArrowLeft/ArrowRight dời focus; ArrowUp/ArrowDown
  // để nguyên cho trình duyệt cuộn trang.
  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const last = ADMIN_TABS.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
        next = index === 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        activateTab(ADMIN_TABS[index].key);
        return;
      default:
        return;
    }
    event.preventDefault();
    setFocusedTab(ADMIN_TABS[next].key);
    tabRefs.current[next]?.focus();
  }

  if (loading) {
    return (
      <div className="page">
        <Loading />
      </div>
    );
  }
  if (error || !competition) {
    return (
      <div className="page">
        {/* Trang lỗi cần H1 mô tả trạng thái; `ErrorBox` cố ý không tự render heading. */}
        <h1 className="page-title">Không thể tải cuộc thi</h1>
        <ErrorBox error={error} />
        <p>
          <Link to="/admin/competitions">← Về danh sách cuộc thi</Link>
        </p>
      </div>
    );
  }

  const editDisabled = competition.status === "closed";
  const editReason = "Cuộc thi đã kết thúc và không thể chỉnh sửa.";
  // Quá `end_at` thì hiển thị như đã kết thúc, khớp với việc thí sinh đã không vào được nữa.
  const shownStatus = displayStatus(competition.status, competition.end_at);
  // Backend cũ chưa trả `upload_limits` - rơi về mặc định thay vì ẩn hint.
  const uploadLimits = competition.upload_limits ?? DEFAULT_UPLOAD_LIMITS;
  // Backend vẫn là authority: nếu payload không kèm readiness (list) thì không tự chặn.
  const publishBlocked = competition.publish_blocked_reason ?? null;
  // CTA phải mở đúng tab chứa thứ đang thiếu: mã tham gia nằm ở tab Thành viên, mọi lý do
  // chặn còn lại (cấu hình chấm điểm, ground truth) đều thuộc tab Chấm điểm.
  const publishBlockCta =
    publishBlocked?.code === "JOIN_CODE_REQUIRED"
      ? { tab: "members" as Tab, label: "Mở tab Thành viên" }
      : { tab: "scoring" as Tab, label: "Mở tab Chấm điểm" };

  return (
    <div className="page admin-detail-page">
      <header className="admin-detail-header">
        <div className="admin-detail-breadcrumb-wrap">
          <Link className="admin-detail-breadcrumb back-link" to="/admin/competitions">
            <IconArrowBack className="admin-detail-breadcrumb-icon" />
            <span>Quản lý cuộc thi</span>
          </Link>
        </div>

        <div className="admin-detail-shell">
        <div className="admin-detail-heading-row">
          <div className="admin-detail-heading">
            <div className="admin-detail-title-row">
              <span className="admin-detail-mark" aria-hidden="true">
                <IconTrophy className="admin-detail-mark-icon" />
              </span>
              <div className="admin-detail-title-group">
                <div className="admin-detail-title-line">
                  <h1 className="admin-detail-title page-title">{competition.name}</h1>
                  <div className={`admin-detail-status status-badge ${statusClass(shownStatus)}`}>
                    <span className="admin-detail-status-dot" aria-hidden="true" />
                    <span>{STATUS_LABEL[shownStatus]}</span>
                  </div>
                </div>
                {competition.short_description && (
                  <p className="admin-detail-description admin-summary-desc">{competition.short_description}</p>
                )}
                <span className="vku-accent" aria-hidden="true">
                  <span className="blue" />
                  <span className="red" />
                  <span className="yellow" />
                </span>
              </div>
            </div>
          </div>

          <div className="admin-detail-actions">
            <button
              type="button"
              className="admin-detail-action admin-detail-action-outline"
              disabled={editDisabled}
              title={editDisabled ? editReason : undefined}
              aria-describedby={editDisabled ? `edit-reason-${competition.id}` : undefined}
              onClick={() => setEditing(true)}
            >
              <IconEdit className="admin-detail-action-icon" />
              <span>Sửa</span>
            </button>
            {editDisabled && (
              <span className="sr-only" id={`edit-reason-${competition.id}`}>
                {editReason}
              </span>
            )}
            <button
              type="button"
              className="admin-detail-action admin-detail-action-outline"
              onClick={() => setConfirming("clone")}
            >
              <IconCopy className="admin-detail-action-icon" />
              <span>Clone</span>
            </button>
            {competition.status === "draft" && (
              <button
                type="button"
                className="admin-detail-action admin-detail-action-publish"
                disabled={publishBlocked !== null}
                title={publishBlocked?.message}
                aria-describedby={
                  publishBlocked ? `publish-blocked-${competition.id}` : undefined
                }
                onClick={() => setConfirming("publish")}
              >
                <IconPublish className="admin-detail-action-icon" />
                <span>Publish</span>
              </button>
            )}
            {competition.status === "published" && (
              <button
                type="button"
                className="admin-detail-action danger"
                onClick={() => setConfirming("close")}
              >
                <IconStop className="admin-detail-action-icon" />
                <span>Kết thúc</span>
              </button>
            )}
            {competition.status === "closed" && (
              <button
                type="button"
                className="admin-detail-action admin-detail-action-outline"
                onClick={() => setConfirming("reopen")}
              >
                <IconReopen className="admin-detail-action-icon" />
                <span>Mở lại</span>
              </button>
            )}
            {/* Xoá được ở draft và closed; cuộc thi đang chạy phải Kết thúc trước. */}
            {competition.status !== "published" && (
              <button
                type="button"
                className="admin-detail-action danger"
                onClick={() => setDeleting(true)}
              >
                <IconTrash className="admin-detail-action-icon" />
                <span>Xóa</span>
              </button>
            )}
          </div>
        </div>

        <section className="admin-competition-summary" aria-label="Thông tin chung cuộc thi">
          <dl className="admin-detail-facts">
            {SUMMARY_FACTS.map(({ label, Icon: FactIcon, mono, read }, index) => (
              <div className="admin-detail-fact" key={label} data-tone={toneAt(index)}>
                <dt>
                  <span className="admin-detail-fact-icon" aria-hidden="true">
                    <FactIcon className="admin-detail-fact-icon-glyph" />
                  </span>
                  <span>{label}</span>
                </dt>
                <dd className={mono ? "mono" : undefined}>{read(competition)}</dd>
              </div>
            ))}
          </dl>
        </section>
        </div>
      </header>

      {competition.status === "draft" && publishBlocked && (
        <div
          className="status-banner warning admin-detail-publish-banner"
          role="status"
          id={`publish-blocked-${competition.id}`}
        >
          <span className="admin-detail-publish-banner-text">
            <strong>Chưa thể publish.</strong> {publishBlocked.message}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => activateTab(publishBlockCta.tab)}
          >
            {publishBlockCta.label}
          </button>
        </div>
      )}

      {message && (
        <div className="status-banner success admin-detail-toast" role="status">
          <span>{message}</span>
          <button
            type="button"
            className="banner-dismiss"
            aria-label="Đóng thông báo"
            onClick={() => setMessage("")}
          >
            ×
          </button>
        </div>
      )}

      <div className="admin-detail-layout">
        {/* Một thanh tab ngang duy nhất cho các khu vực của cuộc thi. */}
        <nav
          className="admin-detail-rail"
          aria-label="Quản lý cuộc thi"
          role="tablist"
        >
          {ADMIN_TABS.map(({ key, label, Icon: TabIcon }, index) => (
            <button
              key={key}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`admin-tab-${key}`}
              aria-selected={tab === key}
              // Chỉ panel của tab đang chọn tồn tại, nên tab khác không được trỏ tới id đó.
              aria-controls={tab === key ? `admin-tabpanel-${key}` : undefined}
              tabIndex={focusedTab === key ? 0 : -1}
              className={`admin-detail-tab${tab === key ? " active" : ""}`}
              onClick={() => activateTab(key)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              <TabIcon className="admin-detail-tab-icon" />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div
          className="admin-detail-panel"
          role="tabpanel"
          id={`admin-tabpanel-${tab}`}
          aria-labelledby={`admin-tab-${tab}`}
          tabIndex={0}
        >
          {tab === "contents" && (
            <ContentsPanel competitionId={competition.id} maxContentMb={uploadLimits.content_mb} />
          )}
          {tab === "assets" && (
            <AssetsPanel competitionId={competition.id} maxAssetMb={uploadLimits.asset_mb} />
          )}
          {tab === "resources" && (
            <ResourcesPanel
              competition={competition}
              draft={resourceDraft}
              onDraftChange={setResourceDraft}
              onSaved={(saved) => {
                setCompetition(saved);
                setResourceDraft(null);
              }}
              onNotify={notify}
            />
          )}
          {tab === "scoring" && (
            <ScoringPanel competition={competition} onCompetitionChanged={load} />
          )}
          {tab === "settings" && <AiReviewSettingsPanel competitionId={competition.id} />}
          {tab === "results" && <ResultsPanel competition={competition} />}
          {tab === "members" && (
            <MembersPanel competition={competition} onCompetitionChanged={load} />
          )}
        </div>
      </div>

      {editing && (
        <CompetitionFormModal
          competition={competition}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            setCompetition(saved);
            notify(`Đã cập nhật "${saved.name}".`);
          }}
        />
      )}
      {confirming && (
        <CompetitionActionConfirmModal
          action={confirming}
          competition={competition}
          onSuccess={async (action, cloned) => {
            setConfirming(null);
            if (action === "clone" && cloned) {
              navigate(`/admin/competitions/${cloned.id}`);
            } else {
              notify(
                action === "publish"
                  ? "Đã publish cuộc thi."
                  : action === "reopen"
                    ? "Đã mở lại cuộc thi."
                    : "Đã kết thúc cuộc thi.",
              );
              await load();
            }
          }}
          onClose={() => setConfirming(null)}
        />
      )}
      {deleting && (
        <CompetitionDeleteModal
          competition={competition}
          onDeleted={() => navigate("/admin/competitions")}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  );
}

/** ---------- Kết quả & submissions ---------- */

function ResultsPanel({ competition }: { competition: Competition }) {
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);
  const [leaderboardError, setLeaderboardError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);

  async function exportResults() {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      await downloadArtifact(
        `/admin/competitions/${competition.id}/export.xlsx`,
        `${competition.slug}-ket-qua.xlsx`,
      );
    } catch (err) {
      setExportError(err);
    } finally {
      setExporting(false);
    }
  }

  const loadLeaderboard = useCallback(async () => {
    setLeaderboardLoading(true);
    setLeaderboardError(null);
    try {
      setLeaderboard(await api.get<LeaderboardResponse>(`/admin/competitions/${competition.id}/leaderboard`));
    } catch (err) {
      setLeaderboardError(err);
    } finally {
      setLeaderboardLoading(false);
    }
  }, [competition.id]);

  useEffect(() => {
    void loadLeaderboard();
  }, [loadLeaderboard]);

  return (
    <div className="admin-results">
      <section className="results-section admin-detail-card" data-tone="yellow">
        <div className="results-head">
          <div className="admin-detail-section-heading">
            <span className="admin-detail-card-icon" aria-hidden="true">
              <IconTrophy className="admin-detail-card-icon-glyph" />
            </span>
            <div>
              <h2 className="admin-detail-card-title">Bảng xếp hạng</h2>
              <p className="text-muted">Admin luôn xem được kết quả, kể cả khi participant leaderboard đang ẩn.</p>
            </div>
          </div>
          <button
            className="btn admin-results-export admin-detail-primary-action"
            type="button"
            aria-busy={exporting}
            disabled={exporting}
            onClick={() => void exportResults()}
          >
            {exporting ? "Đang xuất..." : "Xuất Excel"}
          </button>
        </div>
        {exportError !== null && (
          <div className="admin-section-error">
            <ErrorBox error={exportError} />
          </div>
        )}
        {leaderboardError ? (
          <div className="admin-section-error">
            <ErrorBox error={leaderboardError} />
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadLeaderboard()}>Thử lại</button>
          </div>
        ) : leaderboardLoading ? (
          <Loading />
        ) : leaderboard?.entries.length ? (
          <div
            className="table-wrap admin-results-table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Bảng xếp hạng của cuộc thi"
          >
            <table className="table results-table">
              <thead><tr><th scope="col">Hạng</th><th scope="col">Đội</th><th scope="col" className="score-cell">Điểm chính</th><th scope="col" className="score-cell">F1</th><th scope="col" className="score-cell">Precision</th><th scope="col" className="score-cell">Recall</th><th scope="col" className="results-count-cell">Số bài</th></tr></thead>
              <tbody>
                {leaderboard.entries.map((entry) => (
                  <tr key={entry.best_submission_id}>
                    <td><span className="rank-cell" data-rank={entry.rank}>{entry.rank}</span></td>
                    <td>{entry.display_name}</td>
                    <td className="score-cell primary-score">{formatScore(entry.primary_score)}</td>
                    <td className="score-cell">{formatScore(entry.metrics.f1)}</td>
                    <td className="score-cell">{formatScore(entry.metrics.precision)}</td>
                    <td className="score-cell">{formatScore(entry.metrics.recall)}</td>
                    <td className="results-count-cell">{entry.total_submissions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="admin-results-empty text-muted">Chưa có kết quả xếp hạng.</p>}
      </section>

      <AdminSubmissionsPanel
        competitionId={competition.id}
        title="Danh sách submissions"
        listLabel="Danh sách bài nộp của cuộc thi"
      />
    </div>
  );
}

/** ---------- Chấm điểm ---------- */

function ScoringPanel({
  competition,
  onCompetitionChanged,
}: {
  competition: Competition;
  // Readiness của publish nằm ở state trang cha, nên panel phải báo lại sau mỗi lần đổi
  // config/ground truth - nếu không banner "Chưa thể publish" và nút Publish đứng hình.
  onCompetitionChanged: () => Promise<void>;
}) {
  const [status, setStatus] = useState<ScoringStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [idColumn, setIdColumn] = useState("id");
  const [predictionColumn, setPredictionColumn] = useState("prediction");
  const [labelColumn, setLabelColumn] = useState("label");
  const [average, setAverage] = useState<ScoringConfig["average"]>("binary");
  const [posLabel, setPosLabel] = useState("1");
  const [pendingGroundTruth, setPendingGroundTruth] = useState<File | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<ScoringStatus>(
        `/admin/competitions/${competition.id}/scoring`,
      );
      setStatus(data);
      if (data.config) {
        setIdColumn(data.config.id_column);
        setPredictionColumn(data.config.prediction_column);
        setLabelColumn(data.config.label_column);
        setAverage(data.config.average);
        setPosLabel(data.config.pos_label ?? "");
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [competition.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      const data = await api.put<ScoringStatus>(
        `/admin/competitions/${competition.id}/scoring`,
        {
          id_column: idColumn,
          prediction_column: predictionColumn,
          label_column: labelColumn,
          average,
          pos_label: average === "binary" ? posLabel : null,
          higher_is_better: true,
        },
      );
      setStatus(data);
      setMessage("Đã lưu cấu hình chấm điểm.");
      await onCompetitionChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function uploadGroundTruth(file: File) {
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      const data = await api.upload<ScoringStatus>(
        `/admin/competitions/${competition.id}/ground-truth`,
        file,
      );
      setStatus(data);
      setMessage("Đã upload và kiểm tra ground truth.");
      await onCompetitionChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading />;

  return (
    <div className="admin-detail-grid">
      <section className="admin-detail-card" data-tone="blue">
        <div className="admin-detail-card-head">
          <div className="admin-detail-section-heading">
            <span className="admin-detail-card-icon" aria-hidden="true">
              <IconGauge className="admin-detail-card-icon-glyph" />
            </span>
              <div>
                <h2 className="admin-detail-card-title">Cấu hình CSV</h2>
                <p className="admin-detail-card-desc">
                  Metric chính: {competition.primary_metric.toUpperCase()} · Quota:{" "}
                  {competition.quota_per_day} lượt/ngày
                </p>
              </div>
            </div>
            {status && (
              <span className={`status-badge ${status.ready ? "success" : "warning"}`}>
                {status.ready ? "Sẵn sàng chấm điểm" : "Chưa sẵn sàng"}
              </span>
            )}
        </div>

        {status?.locked && (
          <div className="status-banner warning">
            Cấu hình đã bị khóa vì cuộc thi đã đóng hoặc đã có bài được chấm điểm.
          </div>
        )}
        {status && !status.ready && status.not_ready_reason && (
          <div className="status-banner warning">{status.not_ready_reason.message}</div>
        )}
        {message && (
          <div className="status-banner success" role="status">
            <span>{message}</span>
            <button
              type="button"
              className="banner-dismiss"
              aria-label="Đóng thông báo"
              onClick={() => setMessage("")}
            >
              ×
            </button>
          </div>
        )}
        {error ? (
          <div className="admin-section-error">
            <ErrorBox error={error} />
            {!status && (
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => void load()}>
                Thử lại
              </button>
            )}
          </div>
        ) : null}

        <form onSubmit={saveConfig}>
          <div className="form-grid">
            <div className="form-field">
              <label className="field-label" htmlFor="scoring-id-column">Cột ID</label>
              <input
                id="scoring-id-column"
                className="input"
                value={idColumn}
                disabled={busy || status?.locked}
                onChange={(event) => setIdColumn(event.target.value)}
                required
              />
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor="scoring-prediction-column">Cột prediction</label>
              <input
                id="scoring-prediction-column"
                className="input"
                value={predictionColumn}
                disabled={busy || status?.locked}
                onChange={(event) => setPredictionColumn(event.target.value)}
                required
              />
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor="scoring-label-column">Cột label trong ground truth</label>
              <input
                id="scoring-label-column"
                className="input"
                value={labelColumn}
                disabled={busy || status?.locked}
                onChange={(event) => setLabelColumn(event.target.value)}
                required
              />
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor="scoring-average">Average</label>
              <select
                id="scoring-average"
                className="input"
                value={average}
                disabled={busy || status?.locked}
                onChange={(event) => setAverage(event.target.value as ScoringConfig["average"])}
              >
                <option value="binary">Binary</option>
                <option value="macro">Macro</option>
                <option value="weighted">Weighted</option>
              </select>
            </div>
            {average === "binary" && (
              <div className="form-field">
                <label className="field-label" htmlFor="scoring-pos-label">Positive label</label>
                <input
                  id="scoring-pos-label"
                  className="input"
                  value={posLabel}
                  disabled={busy || status?.locked}
                  onChange={(event) => setPosLabel(event.target.value)}
                  required
                />
              </div>
            )}
          </div>
          <button
            className="btn admin-detail-primary-action"
            type="submit"
            disabled={busy || status?.locked}
          >
            {busy ? "Đang lưu..." : "Lưu cấu hình"}
          </button>
        </form>
      </section>

      <div className="admin-detail-column">
      <section className="admin-detail-card" data-tone="red">
        <div className="admin-detail-section-heading">
          <span className="admin-detail-card-icon" aria-hidden="true">
            <IconInfo className="admin-detail-card-icon-glyph" />
          </span>
          <div>
            <h2 className="admin-detail-card-title">Ground truth private</h2>
            <p className="admin-detail-card-desc">
              CSV UTF-8, tối đa <strong>{status?.max_upload_mb ?? 10} MiB</strong>. File không có public
              download URL.
            </p>
          </div>
        </div>
        {status?.ground_truth ? (
          <dl className="scoring-metadata">
            <div className="scoring-meta-item">
              <dt>Dữ liệu</dt>
              <dd>{status.ground_truth.row_count} dòng</dd>
            </div>
            <div className="scoring-meta-item">
              <dt>Các cột</dt>
              <dd>{status.ground_truth.columns.join(", ")}</dd>
            </div>
            <div className="scoring-meta-item">
              <dt>Upload lúc</dt>
              <dd>{formatLocal(status.ground_truth.uploaded_at)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-muted">Chưa có ground truth.</p>
        )}
        <FileButton
          className="btn btn-secondary admin-detail-outline-action"
          inputLabel="Upload ground truth CSV"
          accept=".csv,text/csv"
          disabled={busy || status?.locked || !status?.config}
          onFile={(file) => {
            if (status?.ground_truth) setPendingGroundTruth(file);
            else void uploadGroundTruth(file);
          }}
        >
          {status?.ground_truth ? "Thay ground truth CSV" : "Upload ground truth CSV"}
        </FileButton>
        {!status?.config && <p className="text-muted">Lưu cấu hình CSV trước khi upload.</p>}
      </section>

      {/* Chỉ hiện khi đã có cấu hình lưu ở backend; nếu chưa, form đang giữ giá
          trị mặc định và không phải cấu hình đang áp dụng. */}
      {status?.config && (
        <section className="admin-detail-card" data-tone="yellow">
          <div className="admin-detail-section-heading">
            <span className="admin-detail-card-icon" aria-hidden="true">
              <IconInfo className="admin-detail-card-icon-glyph" />
            </span>
            <div>
              <h2 className="admin-detail-card-title">Hướng dẫn định dạng</h2>
              <p className="admin-detail-card-desc">
                Cấu hình đang áp dụng khi đọc file CSV lúc chấm điểm.
              </p>
            </div>
          </div>
          <dl className="scoring-metadata">
            <div className="scoring-meta-item">
              <dt>Cột ID</dt>
              <dd><code>{idColumn}</code></dd>
            </div>
            <div className="scoring-meta-item">
              <dt>Cột prediction</dt>
              <dd><code>{predictionColumn}</code></dd>
            </div>
            <div className="scoring-meta-item">
              <dt>Cột label</dt>
              <dd><code>{labelColumn}</code></dd>
            </div>
            <div className="scoring-meta-item">
              <dt>Average</dt>
              <dd><code>{average}</code></dd>
            </div>
            {average === "binary" && (
              <div className="scoring-meta-item">
                <dt>Positive label</dt>
                <dd><code>{posLabel}</code></dd>
              </div>
            )}
          </dl>
        </section>
      )}
      </div>
      {pendingGroundTruth && (
        <ConfirmModal
          title="Thay ground truth"
          body="File ground truth hiện tại sẽ bị thay thế. Hãy chắc chắn file mới đã được kiểm tra đúng schema."
          confirmLabel="Thay ground truth"
          danger
          onConfirm={async () => {
            await uploadGroundTruth(pendingGroundTruth);
            setPendingGroundTruth(null);
          }}
          onClose={() => setPendingGroundTruth(null)}
        />
      )}
    </div>
  );
}

/** ---------- Nội dung ---------- */

/**
 * Gợi ý cách chia trang nội dung. Đây là hướng dẫn tĩnh cho quản trị viên, không
 * phải dữ liệu của cuộc thi - không suy ra từ API và không thay thế nội dung thật.
 */
const CONTENT_TOPICS: ReadonlyArray<{ title: string; hint: string }> = [
  { title: "Thể lệ", hint: "Điều kiện dự thi, cách tính điểm và quy định bài nộp." },
  { title: "Lịch trình", hint: "Mốc mở đề, hạn nộp và thời gian công bố kết quả." },
  { title: "Dataset / Tài nguyên", hint: "Tập dữ liệu, file mẫu và tài liệu kèm theo." },
  { title: "Giải thưởng / Kết quả", hint: "Cơ cấu giải thưởng và cách công bố kết quả." },
  { title: "Ban Tổ chức & Liên hệ", hint: "Đơn vị tổ chức và kênh hỗ trợ thí sinh." },
];

function ContentsPanel({ competitionId, maxContentMb }: { competitionId: string; maxContentMb: number }) {
  const [contents, setContents] = useState<AdminContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminContent | null>(null);
  const [deleting, setDeleting] = useState<AdminContent | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<{ contents: AdminContent[] }>(
        `/admin/competitions/${competitionId}/contents`,
      );
      setContents(data.contents);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [competitionId]);

  useEffect(() => {
    void load();
  }, [load]);

  function notify(text: string) {
    setMessage(text);
    void load();
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= contents.length) return;
    const swapped = [...contents];
    [swapped[index], swapped[target]] = [swapped[target], swapped[index]];
    const items = swapped.map((c, i) => ({ id: c.id, order: (i + 1) * 10 }));
    try {
      await api.post(`/admin/competitions/${competitionId}/contents/reorder`, { items });
      await load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <>
      <div className="admin-detail-card" data-tone="blue">
        <div className="admin-detail-card-head">
          <div className="admin-detail-section-heading">
            <span className="admin-detail-card-icon" aria-hidden="true">
              <IconFileText className="admin-detail-card-icon-glyph" />
            </span>
            <div>
              <h2 className="admin-detail-card-title">Quản lý nội dung</h2>
              <p className="admin-detail-card-desc">
                Thêm, chỉnh sửa và sắp xếp các trang nội dung của cuộc thi.
              </p>
            </div>
          </div>
          <button className="btn admin-detail-primary-action" type="button" onClick={() => setCreating(true)}>
            <IconPlus className="admin-detail-primary-icon" />
            <span>Thêm trang nội dung</span>
          </button>
        </div>
        {message && (
          <div className="status-banner success" role="status">
            <span>{message}</span>
            <button
              type="button"
              className="banner-dismiss"
              aria-label="Đóng thông báo"
              onClick={() => setMessage("")}
            >
              ×
            </button>
          </div>
        )}
        {error ? (
          <div className="admin-section-error">
            <ErrorBox error={error} />
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void load()}>
              Thử lại
            </button>
          </div>
        ) : null}
        <div
          className="table-wrap"
          aria-busy={loading}
          tabIndex={0}
          role="region"
          aria-label="Bảng nội dung cuộc thi"
        >
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Thứ tự</th>
                <th scope="col">Tiêu đề</th>
                <th scope="col">Slug</th>
                <th scope="col">Hiển thị</th>
                <th scope="col">File</th>
                <th scope="col">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="table-state">
                    <Loading />
                  </td>
                </tr>
              ) : contents.length > 0 ? (
                contents.map((content, index) => (
                  <ContentRow
                    key={content.id}
                    competitionId={competitionId}
                    maxContentMb={maxContentMb}
                    content={content}
                    position={index + 1}
                    first={index === 0}
                    last={index === contents.length - 1}
                    onEdit={() => setEditing(content)}
                    onDelete={() => setDeleting(content)}
                    onMove={(d) => void move(index, d)}
                    onChanged={notify}
                  />
                ))
              ) : error ? null : (
                <tr>
                  <td colSpan={6} className="table-state">
                    Chưa có trang nội dung nào.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {creating && (
          <ContentFormModal
            competitionId={competitionId}
            onClose={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              notify("Đã tạo trang nội dung.");
            }}
          />
        )}
        {editing && (
          <ContentFormModal
            competitionId={competitionId}
            content={editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              notify("Đã cập nhật trang nội dung.");
            }}
          />
        )}
        {deleting && (
          <ConfirmModal
            title="Xóa trang nội dung"
            body={`Xóa "${deleting.title}" và file Markdown liên quan? Thao tác này không thể hoàn tác.`}
            confirmLabel="Xóa"
            danger
            onConfirm={async () => {
              await api.del(`/admin/competitions/${competitionId}/contents/${deleting.id}`);
              setDeleting(null);
              notify(`Đã xóa "${deleting.title}".`);
            }}
            onClose={() => setDeleting(null)}
          />
        )}
      </div>
      <section className="admin-detail-card admin-detail-topic-card" data-tone="yellow">
        <div className="admin-detail-section-heading">
          <span className="admin-detail-card-icon" aria-hidden="true">
            <IconInfo className="admin-detail-card-icon-glyph" />
          </span>
          <div>
            <h2 className="admin-detail-card-title">Các phần nội dung thường có</h2>
            <p className="admin-detail-card-desc">
              Gợi ý cách chia trang cho dễ theo dõi. Số lượng và thứ tự tuỳ từng cuộc thi.
            </p>
          </div>
        </div>
        <ul className="admin-detail-topic-list">
          {CONTENT_TOPICS.map((topic) => (
            <li key={topic.title} className="admin-detail-topic">
              <strong className="admin-detail-topic-name">{topic.title}</strong>
              <span className="admin-detail-topic-hint">{topic.hint}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function ContentRow({
  competitionId,
  maxContentMb,
  content,
  position,
  first,
  last,
  onEdit,
  onDelete,
  onMove,
  onChanged,
}: {
  competitionId: string;
  maxContentMb: number;
  content: AdminContent;
  /** Vị trí trong danh sách đã sắp theo order - thứ tự hiển thị, không phải `content.order`. */
  position: number;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  onChanged: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState("");

  async function run(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    setRowError("");
    try {
      await action();
      onChanged(successMessage);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr>
        <td className="order-col">
          <div className="order-cell">
            <span className="order-num">{position}</span>
            <div className="order-arrows">
              <button
                type="button"
                className="btn btn-ghost btn-sm order-arrow-btn"
                aria-label={`Đưa ${content.title} lên`}
                disabled={first || busy}
                onClick={() => onMove(-1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm order-arrow-btn"
                aria-label={`Đưa ${content.title} xuống`}
                disabled={last || busy}
                onClick={() => onMove(1)}
              >
                ↓
              </button>
            </div>
          </div>
        </td>
        <td className="name-cell">{content.title}</td>
        <td className="slug-cell">
          <code>{content.slug}</code>
        </td>
        <td>
          <span className={`status-badge ${content.visibility === "members" ? "warning" : "neutral"}`}>
            <span className="status-dot" />
            {content.visibility === "members" ? "Chỉ thành viên" : "Mọi thí sinh"}
          </span>
        </td>
        <td>
          {content.size_bytes !== null ? (
            <span className="status-badge success file-status-badge">
              <span>Đã upload</span>
              {content.size_bytes > 0 && (
                <span className="file-size-hint"> ({(content.size_bytes / 1024).toFixed(0)} KB)</span>
              )}
            </span>
          ) : (
            <span className="status-badge warning file-status-badge">Chưa có file</span>
          )}
        </td>
        <td className="col-actions">
          <span className="action-group">
            <FileButton
              className="btn btn-sm upload-md-btn admin-detail-primary-action"
              inputLabel={`Upload file Markdown cho "${content.title}"`}
              accept=".md,text/markdown"
              disabled={busy}
              onFile={(file) => {
                const tooLarge = tooLargeMessage(file, maxContentMb);
                if (tooLarge) {
                  setRowError(tooLarge);
                  return;
                }
                void run(
                  () => api.upload(`/admin/competitions/${competitionId}/contents/${content.id}/file`, file),
                  `Đã upload Markdown cho "${content.title}".`,
                );
              }}
            >
              {content.size_bytes !== null ? "Thay .md" : "Upload .md"}{" "}
              <span className="upload-size-hint">≤ {maxContentMb} MiB</span>
            </FileButton>
            <button
              type="button"
              className="btn btn-sm admin-detail-outline-action"
              disabled={busy}
              onClick={onEdit}
            >
              Sửa
            </button>
            <button
              type="button"
              className="btn btn-sm admin-detail-danger-action"
              disabled={busy}
              onClick={onDelete}
            >
              Xóa
            </button>
          </span>
        </td>
      </tr>
      {rowError && (
        <tr>
          <td colSpan={6} className="table-state error-cell">
            <span role="alert">{rowError}</span>
          </td>
        </tr>
      )}
    </>
  );
}

function ContentFormModal({
  competitionId,
  content,
  onClose,
  onSaved,
}: {
  competitionId: string;
  content?: AdminContent;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = content !== undefined;
  const [title, setTitle] = useState(content?.title ?? "");
  // Sửa trang cũng bám theo tiêu đề: đổi tiêu đề là đổi URL trang nội dung.
  const { slug, onTitleChange, onSlugChange } = useAutoSlug(content?.slug ?? "", true);
  const [visibility, setVisibility] = useState<"public" | "members">(content?.visibility ?? "public");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const payload = { title, slug: slug.trim().toLowerCase(), visibility };
    try {
      if (isEdit) {
        await api.patch(`/admin/competitions/${competitionId}/contents/${content.id}`, payload);
      } else {
        await api.post(`/admin/competitions/${competitionId}/contents`, payload);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={isEdit ? `Sửa nội dung - ${content.title}` : "Thêm trang nội dung"} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="form-field">
            <label className="field-label" htmlFor="content-title">
              Tiêu đề
            </label>
            <input
              id="content-title"
              className="input"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                onTitleChange(e.target.value);
              }}
              required
              autoFocus
            />
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="content-slug">
              Slug {isEdit && "(không hiển thị cho participant khi đổi)"}
            </label>
            <input
              id="content-slug"
              className="input"
              value={slug}
              onChange={(e) => onSlugChange(e.target.value)}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              title="Chỉ a-z, 0-9 và dấu gạch ngang"
              maxLength={SLUG_MAX}
              required
            />
            <small className="text-muted">
              {isEdit
                ? "Bám theo tiêu đề: sửa tiêu đề là đổi URL trang. Gõ tay để tự chọn slug khác."
                : "Tự điền theo tiêu đề, gõ tay để đổi."}
            </small>
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="content-visibility">
              Hiển thị cho
            </label>
            <select
              id="content-visibility"
              className="input"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as "public" | "members")}
            >
              <option value="public">Mọi thí sinh</option>
              <option value="members">Chỉ thành viên cuộc thi</option>
            </select>
          </div>
        </div>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Hủy
          </button>
          <button className="btn admin-detail-primary-action" type="submit" disabled={busy}>
            {busy ? "Đang lưu..." : isEdit ? "Lưu" : "Tạo"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** ---------- Tài nguyên ---------- */

function ResourcesPanel({
  competition,
  draft,
  onDraftChange,
  onSaved,
  onNotify,
}: {
  competition: AdminCompetition;
  draft: CompetitionResource[] | null;
  onDraftChange: (resources: CompetitionResource[] | null) => void;
  onSaved: (competition: AdminCompetition) => void;
  onNotify: (message: string) => void;
}) {
  const initialResources = competition.resources ?? [];
  const resources = draft ?? initialResources;
  const [resourceError, setResourceError] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const locked = competition.status === "closed";
  const dirty = !sameCompetitionResources(resources, initialResources);

  function updateResource(index: number, patch: Partial<CompetitionResource>) {
    onDraftChange(
      resources.map((row, position) =>
        position === index ? { ...row, ...patch } : row,
      ),
    );
    setResourceError("");
    setError(null);
  }

  function reset() {
    onDraftChange(null);
    setResourceError("");
    setError(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (locked || !dirty) return;

    setResourceError("");
    setError(null);
    const cleaned = cleanCompetitionResources(resources);
    if (!cleaned.ok) {
      setResourceError(cleaned.message);
      return;
    }

    setBusy(true);
    try {
      const saved = await api.patch<AdminCompetition>(
        `/admin/competitions/${competition.id}`,
        { resources: cleaned.resources },
      );
      onSaved(saved);
      onNotify("Đã cập nhật tài nguyên.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-detail-card" data-tone="yellow">
      <div className="admin-detail-card-head">
        <div className="admin-detail-section-heading">
          <span className="admin-detail-card-icon" aria-hidden="true">
            <IconFolder className="admin-detail-card-icon-glyph" />
          </span>
          <div>
            <h2 className="admin-detail-card-title">Tài nguyên tải về</h2>
            <p className="admin-detail-card-desc">
              Chỉ nhận link Google Drive hoặc Google Docs. Hãy đặt quyền chia sẻ “Bất kỳ ai có
              liên kết” để thí sinh có thể mở tài liệu.
            </p>
          </div>
        </div>
      </div>

      {locked && (
        <div className="status-banner warning">
          Cuộc thi đã kết thúc - không thể sửa tài nguyên.
        </div>
      )}

      <form className="admin-resource-form" onSubmit={save} noValidate>
        <fieldset className="admin-resource-fieldset" disabled={locked || busy}>
          <legend className="sr-only">Danh sách tài nguyên tải về</legend>
          {resources.length === 0 ? (
            <p className="admin-resource-empty">Chưa có tài nguyên nào.</p>
          ) : (
            <div className="admin-resource-list">
              {resources.map((resource, index) => (
                <div className="admin-resource-row" key={index}>
                  <div className="form-field">
                    <label className="field-label" htmlFor={`resource-label-${index}`}>
                      Tên tài nguyên {index + 1}
                    </label>
                    <input
                      id={`resource-label-${index}`}
                      className="input"
                      value={resource.label}
                      onChange={(event) => updateResource(index, { label: event.target.value })}
                      placeholder="Ví dụ: Dataset huấn luyện"
                    />
                  </div>
                  <div className="form-field">
                    <label className="field-label" htmlFor={`resource-url-${index}`}>
                      Link tài nguyên {index + 1}
                    </label>
                    <input
                      id={`resource-url-${index}`}
                      className="input admin-resource-url"
                      type="url"
                      value={resource.url}
                      onChange={(event) => updateResource(index, { url: event.target.value })}
                      placeholder="https://drive.google.com/..."
                    />
                  </div>
                  <button
                    type="button"
                    className="btn admin-detail-danger-action admin-resource-remove"
                    onClick={() => {
                      onDraftChange(
                        resources.filter((_, position) => position !== index),
                      );
                      setResourceError("");
                      setError(null);
                    }}
                    aria-label={`Xóa tài nguyên ${index + 1}`}
                  >
                    <IconTrash className="admin-detail-primary-icon" />
                    <span>Xóa</span>
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            className="btn admin-detail-outline-action admin-resource-add"
            onClick={() => {
              onDraftChange([...resources, { label: "", url: "" }]);
              setResourceError("");
              setError(null);
            }}
            disabled={locked || busy || resources.length >= MAX_COMPETITION_RESOURCES}
          >
            <IconPlus className="admin-detail-primary-icon" />
            <span>Thêm tài nguyên</span>
          </button>
        </fieldset>

        {resourceError && (
          <div className="error-box" role="alert">
            {resourceError}
          </div>
        )}
        {error !== null && <ErrorBox error={error} />}

        <div className="admin-resource-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={locked || busy || !dirty}
            onClick={reset}
          >
            Hủy thay đổi
          </button>
          <button
            type="submit"
            className="btn admin-detail-primary-action"
            disabled={locked || busy || !dirty}
          >
            {busy ? "Đang lưu..." : "Lưu thay đổi"}
          </button>
        </div>
      </form>
    </section>
  );
}

/** ---------- Hình ảnh ---------- */

function AssetsPanel({ competitionId, maxAssetMb }: { competitionId: string; maxAssetMb: number }) {
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [deletingAsset, setDeletingAsset] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<{ assets: AssetItem[] }>(`/admin/competitions/${competitionId}/assets`);
      setAssets(data.assets);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [competitionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(file: File) {
    const tooLarge = tooLargeMessage(file, maxAssetMb);
    if (tooLarge) {
      setError(new Error(tooLarge));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.postFile(`/admin/competitions/${competitionId}/assets`, { file });
      setMessage(`Đã upload "${file.name}".`);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/admin/competitions/${competitionId}/assets/${name}`);
      setMessage("Đã xóa ảnh.");
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function copyRef(ref: string) {
    try {
      await navigator.clipboard.writeText(ref);
      setMessage(`Đã copy: ${ref}`);
    } catch {
      setError(new Error(`Không thể copy "${ref}" vào clipboard. Vui lòng copy thủ công.`));
    }
  }

  const filteredAssets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter(
      (asset) =>
        asset.name.toLowerCase().includes(q) ||
        asset.content_type.toLowerCase().includes(q)
    );
  }, [assets, searchQuery]);

  const totalBytes = useMemo(
    () => assets.reduce((acc, cur) => acc + (cur.size_bytes || 0), 0),
    [assets]
  );

  return (
    <div className="s14-assets-container">
      {/* Bento Grid: 8 col Upload Card + 4 col Markdown Guide Card */}
      <div className="s14-bento-grid">
        <div className="s14-card s14-upload-card" data-tone="blue">
          <div className="s14-card-header">
            <div className="s14-card-icon">
              <IconUpload className="s14-icon" />
            </div>
            <div className="s14-card-header-text">
              <div className="s14-card-title-row">
                <h2 className="s14-card-title">Kho lưu trữ hình ảnh</h2>
                <span className="s14-badge-count">{assets.length} tệp</span>
              </div>
              <p className="s14-card-desc">
                Tải lên hình ảnh để sử dụng trong các trang tài liệu Markdown của cuộc thi (tổng quan, thể lệ, dữ liệu).
              </p>
            </div>
          </div>

          <div className="s14-upload-body">
            <div className="toolbar s14-upload-toolbar">
              <FileButton
                className="btn s14-upload-btn admin-detail-primary-action"
                inputLabel="Chọn tệp ảnh"
                accept=".png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp"
                disabled={busy}
                onFile={(file) => void upload(file)}
              >
                <IconUpload className="s14-btn-icon" />
                <span>
                  {busy
                    ? "Đang xử lý..."
                    : `Upload ảnh (PNG/JPEG/GIF/WebP ≤ ${maxAssetMb} MiB)`}
                </span>
              </FileButton>
              <span className="s14-upload-hint">
                Định dạng hỗ trợ: PNG, JPG, GIF, WebP (Tối đa {maxAssetMb} MiB / tệp)
              </span>
            </div>
          </div>
        </div>

        <div className="s14-card s14-guide-card" data-tone="yellow">
          <div className="s14-card-header">
            <div className="s14-card-icon guide-icon">
              <IconInfo className="s14-icon" />
            </div>
            <h2 className="s14-card-title">Quy chuẩn nhúng Markdown</h2>
          </div>
          <div className="s14-guide-body">
            <p className="s14-guide-text">
              Trong nội dung Markdown (Tab Nội dung), sử dụng đường dẫn tương đối trực tiếp:
            </p>
            <div className="s14-code-pill-wrapper">
              <code className="s14-code-pill">
                <span>![Mô tả](</span>
                <span>assets/ten-file.png</span>
                <span>)</span>
              </code>
              <button
                type="button"
                className="s14-copy-pill-btn"
                title="Copy cú pháp mẫu"
                onClick={() => void copyRef("![Mô tả](assets/ten-file.png)")}
              >
                <IconCopy className="s14-icon-xs" />
                <span>Copy mẫu</span>
              </button>
            </div>
            <p className="s14-guide-subtext">
              Hệ thống tự động phân giải thành link tải an toàn cho thí sinh.
            </p>
          </div>
        </div>
      </div>

      {/* Table Card */}
      <div className="s14-table-card" data-tone="red">
        <div className="s14-table-toolbar">
          <div className="s14-table-title-group">
            <h3 className="s14-table-title">Danh sách tài nguyên đã tải lên</h3>
            <span className="s14-table-subtitle">
              {filteredAssets.length} / {assets.length} tệp • Tổng dung lượng: {formatBytes(totalBytes)}
            </span>
          </div>
          <div className="s14-table-search">
            <label className="s14-search-label">
              <span className="sr-only">Tìm kiếm tài nguyên</span>
              <IconSearch className="s14-search-icon" />
              <input
                type="text"
                placeholder="Tìm kiếm tài nguyên..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="s14-search-input"
              />
            </label>
          </div>
        </div>

        {message && (
          <div className="status-banner success s14-banner" role="status">
            <IconCheck className="s14-banner-icon" />
            <span>{message}</span>
            <button
              type="button"
              className="banner-dismiss"
              aria-label="Đóng thông báo"
              onClick={() => setMessage("")}
            >
              ×
            </button>
          </div>
        )}
        {error ? (
          <div className="admin-section-error">
            <ErrorBox error={error} />
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void load()}>
              Thử lại
            </button>
          </div>
        ) : null}

        <div
          className="table-wrap s14-table-wrap"
          aria-busy={loading}
          tabIndex={0}
          role="region"
          aria-label="Bảng tài nguyên cuộc thi"
        >
          <table className="table s14-table">
            <thead>
              <tr>
                <th scope="col">Tên file</th>
                <th scope="col">Loại</th>
                <th scope="col" className="s14-th-size">Dung lượng</th>
                <th scope="col">Dùng trong Markdown</th>
                <th scope="col" className="s14-th-actions">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="table-state">
                    <Loading />
                  </td>
                </tr>
              ) : filteredAssets.length > 0 ? (
                filteredAssets.map((asset) => (
                  <tr key={asset.name}>
                    <td className="asset-name-cell">
                      <div className="s14-file-row">
                        <IconImage className="s14-file-icon" />
                        <code className="asset-name s14-filename">{asset.name}</code>
                      </div>
                    </td>
                    <td>
                      <span className="asset-type-badge s14-type-badge">
                        {formatAssetType(asset.content_type)}
                      </span>
                    </td>
                    <td className="s14-td-size">
                      <span className="s14-mono-size">{formatBytes(asset.size_bytes)}</span>
                    </td>
                    <td>
                      <div className="s14-md-group">
                        <img
                          className="asset-preview s14-preview-thumb"
                          src={asset.url}
                          alt={asset.name}
                          loading="lazy"
                        />
                        <code className="s14-md-code">assets/{asset.name}</code>
                      </div>
                    </td>
                    <td className="col-actions s14-td-actions">
                      <span className="action-group s14-action-group">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm s14-action-btn"
                          disabled={busy}
                          onClick={() => void copyRef(`assets/${asset.name}`)}
                        >
                          <IconCopy className="s14-icon-xs" />
                          <span>Copy tham chiếu</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm btn-danger-ghost s14-action-btn-danger"
                          disabled={busy}
                          onClick={() => setDeletingAsset(asset.name)}
                        >
                          <IconTrash className="s14-icon-xs" />
                          <span>Xóa</span>
                        </button>
                      </span>
                    </td>
                  </tr>
                ))
              ) : assets.length > 0 ? (
                <tr>
                  <td colSpan={5} className="table-state">
                    Không tìm thấy tài nguyên nào phù hợp với "{searchQuery}".
                  </td>
                </tr>
              ) : error ? null : (
                <tr>
                  <td colSpan={5} className="table-state">
                    Chưa có ảnh nào. Trong Markdown dùng đường dẫn tương đối <code>assets/ten-file.png</code>.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {deletingAsset && (
        <ConfirmModal
          title="Xóa asset"
          body="Xóa ảnh này? Các trang Markdown đang dùng ảnh này sẽ không còn hiển thị ảnh."
          confirmLabel="Xóa"
          danger
          onConfirm={async () => {
            await remove(deletingAsset);
            setDeletingAsset(null);
          }}
          onClose={() => setDeletingAsset(null)}
        />
      )}
    </div>
  );
}

/** ---------- Thành viên & mã tham gia ---------- */

function MembersPanel({
  competition,
  onCompetitionChanged,
}: {
  competition: Competition;
  onCompetitionChanged: () => Promise<void>;
}) {
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [total, setTotal] = useState(0);
  const [activeTotal, setActiveTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [codeConfigured, setCodeConfigured] = useState(competition.join_code_configured);
  const [joinCode, setJoinCode] = useState("");
  const [pendingJoinCode, setPendingJoinCode] = useState("");
  const [pendingMember, setPendingMember] = useState<MemberItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MemberItem | null>(null);
  const [busy, setBusy] = useState(false);
  const messageTimer = useRef<number | null>(null);

  const notify = useCallback((text: string) => {
    if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    setMessage(text);
    messageTimer.current = window.setTimeout(() => {
      setMessage("");
      messageTimer.current = null;
    }, 4500);
  }, []);

  const dismissMessage = useCallback(() => {
    if (messageTimer.current !== null) {
      window.clearTimeout(messageTimer.current);
      messageTimer.current = null;
    }
    setMessage("");
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<{
        members: MemberItem[];
        total: number;
        active_total: number;
      }>(`/admin/competitions/${competition.id}/members?limit=200`);
      setMembers(data.members);
      setActiveTotal(data.active_total);
      setTotal(data.total);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [competition.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => () => {
      if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    },
    [],
  );

  async function run(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      notify(successMessage);
      await load();
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function runConfirmed(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      notify(successMessage);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-members">
      <aside className="admin-members-code-card admin-detail-card" data-tone="red">
        <div className="admin-detail-section-heading">
          <span className="admin-detail-card-icon admin-detail-card-icon-key" aria-hidden="true">
            <IconKey className="admin-detail-card-icon-glyph" />
          </span>
          <h2 className="admin-detail-card-title">Mã tham gia</h2>
        </div>
        {competition.join_mode !== "code" ? (
          <p className="text-muted admin-members-note">
            Cuộc thi này dùng chế độ tham gia{" "}
            {competition.join_mode === "open" ? "tự do" : "chỉ mời"} - không dùng mã.
          </p>
        ) : (
          <form
            className="admin-members-code-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (codeConfigured) setPendingJoinCode(joinCode);
              else {
                const code = joinCode;
                void run(
                  () => api.put(`/admin/competitions/${competition.id}/join-code`, { join_code: code }),
                  "Đã đặt mã tham gia.",
                ).then((saved) => {
                  if (saved) {
                    setCodeConfigured(true);
                    setJoinCode("");
                    void onCompetitionChanged();
                  }
                });
              }
            }}
          >
            <input
              className="input"
              type="password"
              aria-label="Mã tham gia mới"
              placeholder={codeConfigured ? "Đã đặt mã - nhập mã mới để đổi" : "Chưa đặt mã"}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              minLength={8}
              maxLength={128}
              required
              autoComplete="off"
            />
            <button className="btn admin-detail-primary-action" type="submit" disabled={busy}>
              {codeConfigured ? "Đổi mã" : "Đặt mã"}
            </button>
          </form>
        )}
      </aside>

      <section className="admin-members-list admin-detail-card" data-tone="blue">
        <div className="admin-members-head">
          <div className="admin-detail-section-heading">
            <span className="admin-detail-card-icon" aria-hidden="true">
              <IconUsers className="admin-detail-card-icon-glyph" />
            </span>
            <div>
              <h2 className="admin-detail-card-title">Thành viên cuộc thi</h2>
              <p>
                {activeTotal} đang hoạt động
                {total > activeTotal ? ` · ${total} tổng cộng` : ""}
              </p>
            </div>
          </div>
          <form
            className="admin-members-add-form"
            onSubmit={(e) => {
              e.preventDefault();
              const memberEmail = email;
              void run(
                () => api.post(`/admin/competitions/${competition.id}/members`, { email: memberEmail }),
                `Đã thêm thành viên ${memberEmail}.`,
              ).then((added) => {
                if (added) setEmail("");
              });
            }}
          >
            <input
              className="input"
              type="email"
              aria-label="Email thành viên"
              placeholder="email@vku.vn"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <button className="btn admin-detail-primary-action" type="submit" disabled={busy}>Thêm thành viên</button>
          </form>
        </div>
        {message && (
          <div className="status-banner success admin-members-message" role="status">
            <span>{message}</span>
            <button className="banner-dismiss" type="button" aria-label="Đóng thông báo" onClick={dismissMessage}>×</button>
          </div>
        )}
        {Boolean(error) && (
          <div className="admin-section-error">
            <ErrorBox error={error} />
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void load()}>Thử lại</button>
          </div>
        )}
        <div
          className="table-wrap admin-members-table-wrap"
          aria-busy={loading}
          tabIndex={0}
          role="region"
          aria-label="Bảng thành viên cuộc thi"
        >
          <table className="table admin-members-table">
            <thead>
              <tr><th scope="col">Email</th><th scope="col">Tên</th><th scope="col">Vai trò</th><th scope="col">Trạng thái</th><th scope="col">Tham gia lúc</th><th scope="col">Thao tác</th></tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="table-state"><Loading /></td></tr>
              ) : members.length > 0 ? (
                members.map((member) => (
                  <tr key={member.account_id}>
                    <td className="email-cell">{member.email}</td>
                    <td className="name-cell">{member.name}</td>
                    <td><span className={`role-badge${member.role === "admin" ? "" : " badge-muted"}`}>{member.role === "admin" ? "Admin" : "Thí sinh"}</span></td>
                    <td><span className={`status-badge ${member.active ? "success" : "danger"}`}>{member.active ? "Đang hoạt động" : "Đã vô hiệu"}</span></td>
                    <td className="admin-members-date">{formatLocal(member.joined_at)}</td>
                    <td className="col-actions">
                      <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => setPendingMember(member)}>
                        {member.active ? "Vô hiệu hóa" : "Kích hoạt"}
                      </button>
                      <button className="btn btn-ghost btn-sm btn-danger-ghost" type="button" disabled={busy} onClick={() => setPendingDelete(member)}>
                        Xóa
                      </button>
                    </td>
                  </tr>
                ))
              ) : error ? null : (
                <tr><td colSpan={6} className="table-state">Chưa có thành viên nào.</td></tr>
              )}
            </tbody>
          </table>
          {total > 0 && (
            <div className="admin-members-total">
              {members.length < total
                ? <>Đang hiển thị {members.length} / {total}</>
                : <>Tổng số: {total}</>}
            </div>
          )}
        </div>
      </section>
      {pendingJoinCode && (
        <ConfirmModal
          title="Đổi mã tham gia"
          body="Mã cũ sẽ mất hiệu lực ngay. Các thí sinh chưa tham gia cần nhận mã mới."
          confirmLabel="Đổi mã"
          danger
          onConfirm={async () => {
            const code = pendingJoinCode;
            await runConfirmed(
              () => api.put(`/admin/competitions/${competition.id}/join-code`, { join_code: code }),
              "Đã cập nhật mã tham gia.",
            );
            setPendingJoinCode("");
            setJoinCode("");
            await onCompetitionChanged();
          }}
          onClose={() => setPendingJoinCode("")}
        />
      )}
      {pendingMember && (
        <ConfirmModal
          title={pendingMember.active ? "Vô hiệu hóa thành viên" : "Kích hoạt thành viên"}
          body={
            pendingMember.active
              ? `Vô hiệu hóa ${pendingMember.email}? Thành viên sẽ không thể nộp bài cho cuộc thi này.`
              : `Kích hoạt lại ${pendingMember.email}? Thành viên sẽ lấy lại quyền tham gia cuộc thi.`
          }
          confirmLabel={pendingMember.active ? "Vô hiệu hóa" : "Kích hoạt"}
          danger={pendingMember.active}
          onConfirm={async () => {
            const member = pendingMember;
            await runConfirmed(
              () => api.patch(
                `/admin/competitions/${competition.id}/members/${member.account_id}`,
                { active: !member.active },
              ),
              member.active ? "Đã vô hiệu hóa thành viên." : "Đã kích hoạt lại thành viên.",
            );
            setPendingMember(null);
          }}
          onClose={() => setPendingMember(null)}
        />
      )}
      {pendingDelete && (
        <ConfirmModal
          title="Xóa thành viên"
          body={`Xóa ${pendingDelete.email} khỏi cuộc thi? Chỉ xóa được thành viên chưa từng có bài nộp được chấm điểm.`}
          confirmLabel="Xóa"
          danger
          onConfirm={async () => {
            const member = pendingDelete;
            await runConfirmed(
              () => api.del(`/admin/competitions/${competition.id}/members/${member.account_id}`),
              "Đã xóa thành viên.",
            );
            setPendingDelete(null);
          }}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
