/** Admin quản lý nội dung, assets, scoring và thành viên của một competition. */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { Competition } from "../api/competitions";
import {
  formatLocal,
  JOIN_MODE_LABEL,
  METRIC_LABEL,
  STATUS_LABEL,
  statusClass,
} from "../api/competitions";
import type { ContentSummary } from "../api/contents";
import {
  formatScore,
  type LeaderboardResponse,
  type SubmissionHistoryItem,
} from "../api/results";
import {
  CompetitionActionConfirmModal,
  CompetitionFormModal,
  type CompetitionAction,
} from "../components/AdminCompetitionManagement";
import { ConfirmModal, Modal } from "../components/Modal";
import { ErrorBox, Loading } from "../components/ui";

type Tab = "contents" | "assets" | "scoring" | "members" | "results";

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

interface AdminSubmission extends SubmissionHistoryItem {
  account: { id: string; name: string; email: string };
}

const ADMIN_RESULTS_PAGE_SIZE = 50;

const SUBMISSION_STATUS_LABEL: Record<SubmissionHistoryItem["status"], string> = {
  completed: "Đã chấm điểm",
  rejected: "Không hợp lệ",
  failed: "Lỗi chấm điểm",
};

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
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<Tab>("contents");
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<CompetitionAction | null>(null);
  const messageTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCompetition(await api.get<Competition>(`/admin/competitions/${id}`));
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
        <ErrorBox error={error} />
        <p>
          <Link to="/admin/competitions">← Về danh sách cuộc thi</Link>
        </p>
      </div>
    );
  }

  const editDisabled = competition.status === "closed";
  const editReason = "Cuộc thi đã kết thúc và không thể chỉnh sửa.";

  return (
    <div className="page admin-detail-page">
      <header className="admin-detail-header">
        <div className="admin-detail-breadcrumb-wrap">
          <Link className="admin-detail-breadcrumb back-link" to="/admin/competitions">
            <IconArrowBack className="admin-detail-breadcrumb-icon" />
            <span>Quản lý cuộc thi</span>
          </Link>
        </div>

        <div className="admin-detail-heading-row">
          <div className="admin-detail-heading">
            <div className="admin-detail-title-row">
              <h1 className="admin-detail-title page-title">{competition.name}</h1>
              <div className={`admin-detail-status status-badge ${statusClass(competition.status)}`}>
                <span className="admin-detail-status-dot" aria-hidden="true" />
                <span>{STATUS_LABEL[competition.status]}</span>
              </div>
            </div>
            {competition.short_description && (
              <p className="admin-detail-description admin-summary-desc">{competition.short_description}</p>
            )}
          </div>

          <div className="admin-detail-actions">
            <button
              type="button"
              className="admin-detail-action"
              disabled={editDisabled}
              title={editDisabled ? editReason : undefined}
              aria-describedby={editDisabled ? `edit-reason-${competition.id}` : undefined}
              onClick={() => setEditing(true)}
            >
              <IconEdit className="admin-detail-action-icon" />
              <span>Sửa</span>
            </button>
            <button
              type="button"
              className="admin-detail-action"
              onClick={() => setConfirming("clone")}
            >
              <IconCopy className="admin-detail-action-icon" />
              <span>Clone</span>
            </button>
            {competition.status === "draft" && (
              <button
                type="button"
                className="admin-detail-action primary"
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
          </div>
        </div>

        <section className="admin-detail-summary card admin-competition-summary" aria-label="Thông tin chung cuộc thi">
          <dl className="admin-detail-meta comp-meta">
            <div className="admin-detail-meta-item comp-meta-item"><dt>Slug</dt><dd className="mono">{competition.slug}</dd></div>
            <div className="admin-detail-meta-item comp-meta-item"><dt>Bắt đầu</dt><dd>{formatLocal(competition.start_at)}</dd></div>
            <div className="admin-detail-meta-item comp-meta-item"><dt>Kết thúc</dt><dd>{formatLocal(competition.end_at)}</dd></div>
            <div className="admin-detail-meta-item comp-meta-item"><dt>Tham gia</dt><dd>{JOIN_MODE_LABEL[competition.join_mode] ?? competition.join_mode}</dd></div>
            <div className="admin-detail-meta-item comp-meta-item"><dt>Chỉ số chính</dt><dd>{METRIC_LABEL[competition.primary_metric] ?? competition.primary_metric.toUpperCase()}</dd></div>
            <div className="admin-detail-meta-item comp-meta-item"><dt>Quota</dt><dd>{competition.quota_per_day} lượt/ngày</dd></div>
          </dl>
        </section>

        <nav className="tab-nav admin-detail-tabs" aria-label="Quản lý cuộc thi" role="tablist">
          {(
            [
              ["contents", "Nội dung"],
              ["assets", "Assets"],
              ["scoring", "Chấm điểm"],
              ["results", "Kết quả"],
              ["members", "Thành viên & mã tham gia"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`tab-link admin-detail-tab${tab === key ? " active" : ""}`}
              onClick={() => setTab(key)}
            >
              <span>{label}</span>
              {tab === key && <span className="admin-detail-tab-indicator" aria-hidden="true" />}
            </button>
          ))}
        </nav>
      </header>

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

      {tab === "contents" && <ContentsPanel competitionId={competition.id} />}
      {tab === "assets" && <AssetsPanel competitionId={competition.id} />}
      {tab === "scoring" && <ScoringPanel competition={competition} />}
      {tab === "results" && <ResultsPanel competition={competition} />}
      {tab === "members" && <MembersPanel competition={competition} onCompetitionChanged={load} />}

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
                  : "Đã kết thúc cuộc thi.",
              );
              await load();
            }
          }}
          onClose={() => setConfirming(null)}
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
  const [submissions, setSubmissions] = useState<AdminSubmission[]>([]);
  const [submissionsLoading, setSubmissionsLoading] = useState(true);
  const [submissionsError, setSubmissionsError] = useState<unknown>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [filters, setFilters] = useState({ search: "", status: "" });
  const [offset, setOffset] = useState(0);

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

  const loadSubmissions = useCallback(async () => {
    setSubmissionsLoading(true);
    setSubmissionsError(null);
    const params = new URLSearchParams({ limit: String(ADMIN_RESULTS_PAGE_SIZE), offset: String(offset) });
    if (filters.search) params.set("q", filters.search);
    if (filters.status) params.set("status", filters.status);
    try {
      const history = await api.get<{ submissions: AdminSubmission[]; total: number }>(
        `/admin/competitions/${competition.id}/submissions?${params.toString()}`,
      );
      setSubmissions(history.submissions);
      setTotal(history.total);
    } catch (err) {
      setSubmissionsError(err);
    } finally {
      setSubmissionsLoading(false);
    }
  }, [competition.id, filters, offset]);

  useEffect(() => {
    void loadLeaderboard();
  }, [loadLeaderboard]);

  useEffect(() => {
    void loadSubmissions();
  }, [loadSubmissions]);

  function clearFilters() {
    setSearch("");
    setStatus("");
    setOffset(0);
    setFilters({ search: "", status: "" });
  }

  const hasFilters = Boolean(filters.search || filters.status);

  return (
    <div className="admin-results">
      <section className="card results-section">
        <div className="results-head">
          <div>
            <h2>Bảng xếp hạng</h2>
            <p className="text-muted">Admin luôn xem được kết quả, kể cả khi participant leaderboard đang ẩn.</p>
          </div>
          <a className="btn admin-results-export" href={`/api/admin/competitions/${competition.id}/export.xlsx`} download>
            Xuất Excel
          </a>
        </div>
        {leaderboardError ? (
          <div className="admin-section-error">
            <ErrorBox error={leaderboardError} />
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadLeaderboard()}>Thử lại</button>
          </div>
        ) : leaderboardLoading ? (
          <Loading />
        ) : leaderboard?.entries.length ? (
          <div className="table-wrap admin-results-table-wrap">
            <table className="table results-table">
              <thead><tr><th scope="col">Hạng</th><th scope="col">Đội</th><th scope="col" className="score-cell">Điểm chính</th><th scope="col" className="score-cell">F1</th><th scope="col" className="score-cell">Precision</th><th scope="col" className="score-cell">Recall</th><th scope="col" className="results-count-cell">Số bài</th></tr></thead>
              <tbody>
                {leaderboard.entries.map((entry) => (
                  <tr key={entry.best_submission_id}>
                    <td><span className="rank-cell">{entry.rank}</span></td>
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

      <section className="card results-section">
        <div className="results-head">
          <div>
            <h2>Danh sách submissions</h2>
            <p className="text-muted">{total} submission trong bộ lọc hiện tại.</p>
          </div>
        </div>
        <form
          className="results-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setOffset(0);
            setFilters({ search: search.trim(), status });
          }}
        >
          <input className="input" type="search" aria-label="Lọc theo đội" placeholder="Tên hoặc email đội" value={search} onChange={(event) => setSearch(event.target.value)} />
          <select className="input" aria-label="Lọc theo trạng thái" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Mọi trạng thái</option>
            <option value="completed">Đã chấm điểm</option>
            <option value="rejected">Không hợp lệ</option>
            <option value="failed">Lỗi chấm điểm</option>
          </select>
          <button className="btn" type="submit">Lọc</button>
          {hasFilters && <button className="btn btn-ghost" type="button" onClick={clearFilters}>Xóa bộ lọc</button>}
        </form>
        {submissionsError ? (
          <div className="admin-section-error">
            <ErrorBox error={submissionsError} />
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadSubmissions()}>Thử lại</button>
          </div>
        ) : submissionsLoading ? (
          <Loading />
        ) : submissions.length ? (
          <div className="table-wrap admin-results-table-wrap">
            <table className="table results-table admin-submissions-table">
              <thead><tr><th scope="col">Thời gian</th><th scope="col">Đội</th><th scope="col">File</th><th scope="col">Trạng thái</th><th scope="col" className="score-cell">F1</th><th scope="col" className="score-cell">Precision</th><th scope="col" className="score-cell">Recall</th><th scope="col" className="score-cell">Điểm chính</th></tr></thead>
              <tbody>
                {submissions.map((submission) => (
                  <tr key={submission.id}>
                    <td>{formatLocal(submission.created_at)}</td>
                    <td><strong>{submission.account.name}</strong><span className="cell-secondary">{submission.account.email}</span></td>
                    <td className="filename-cell">{submission.filename}</td>
                    <td>
                      <span className={`status-badge submission-status ${submission.status}`}>{SUBMISSION_STATUS_LABEL[submission.status]}</span>
                      {submission.error && <span className="cell-error">{submission.error.message}</span>}
                    </td>
                    <td className="score-cell">{formatScore(submission.metrics?.f1)}</td>
                    <td className="score-cell">{formatScore(submission.metrics?.precision)}</td>
                    <td className="score-cell">{formatScore(submission.metrics?.recall)}</td>
                    <td className="score-cell primary-score">{formatScore(submission.primary_score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="admin-results-empty">
            <p>Không có submission phù hợp.</p>
            {hasFilters && <button className="btn btn-secondary btn-sm" type="button" onClick={clearFilters}>Xóa bộ lọc</button>}
          </div>
        )}
        {!submissionsError && total > ADMIN_RESULTS_PAGE_SIZE && (
          <div className="pagination pagination-controls admin-results-pagination">
            <button className="btn btn-secondary btn-sm" type="button" disabled={offset === 0 || submissionsLoading} onClick={() => setOffset(Math.max(0, offset - ADMIN_RESULTS_PAGE_SIZE))}>Trang trước</button>
            <span>{offset + 1}–{Math.min(offset + ADMIN_RESULTS_PAGE_SIZE, total)} / {total}</span>
            <button className="btn btn-secondary btn-sm" type="button" disabled={offset + ADMIN_RESULTS_PAGE_SIZE >= total || submissionsLoading} onClick={() => setOffset(offset + ADMIN_RESULTS_PAGE_SIZE)}>Trang sau</button>
          </div>
        )}
      </section>
    </div>
  );
}

/** ---------- Chấm điểm ---------- */

function ScoringPanel({ competition }: { competition: Competition }) {
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
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading />;

  return (
    <div className="scoring-admin-grid">
      <div className="card scoring-panel">
        <div className="scoring-panel-head">
          <div>
            <h2>Cấu hình CSV</h2>
            <p className="text-muted">
              Metric chính: {competition.primary_metric.toUpperCase()} · Quota: {competition.quota_per_day} lượt/ngày
            </p>
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
        <ErrorBox error={error} />

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
          <button className="btn" type="submit" disabled={busy || status?.locked}>
            {busy ? "Đang lưu..." : "Lưu cấu hình"}
          </button>
        </form>
      </div>

      <div className="card scoring-panel">
        <h2>Ground truth private</h2>
        <p className="text-muted">
          CSV UTF-8, tối đa <strong>{status?.max_upload_mb ?? 10} MiB</strong>. File không có public download URL.
        </p>
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
        <label className="btn btn-secondary">
          {status?.ground_truth ? "Thay ground truth CSV" : "Upload ground truth CSV"}
          <input
            aria-label="Upload ground truth CSV"
            type="file"
            accept=".csv,text/csv"
            hidden
            disabled={busy || status?.locked || !status?.config}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                if (status?.ground_truth) setPendingGroundTruth(file);
                else void uploadGroundTruth(file);
              }
              event.target.value = "";
            }}
          />
        </label>
        {!status?.config && <p className="text-muted">Lưu cấu hình CSV trước khi upload.</p>}
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

function ContentsPanel({ competitionId }: { competitionId: string }) {
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
    <div>
      <div className="toolbar">
        <button className="btn" onClick={() => setCreating(true)}>
          Thêm trang nội dung
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
      <ErrorBox error={error} />
      <div className="table-wrap" aria-busy={loading}>
        <table className="table">
          <thead>
            <tr>
              <th>Thứ tự</th>
              <th>Tiêu đề</th>
              <th>Slug</th>
              <th>Hiển thị</th>
              <th>File</th>
              <th>Thao tác</th>
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
                  content={content}
                  first={index === 0}
                  last={index === contents.length - 1}
                  onEdit={() => setEditing(content)}
                  onDelete={() => setDeleting(content)}
                  onMove={(d) => void move(index, d)}
                  onChanged={notify}
                />
              ))
            ) : (
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
  );
}

function ContentRow({
  competitionId,
  content,
  first,
  last,
  onEdit,
  onDelete,
  onMove,
  onChanged,
}: {
  competitionId: string;
  content: AdminContent;
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
            <span className="order-num">{content.order}</span>
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
            <label className="btn btn-secondary btn-sm upload-md-btn">
              {content.size_bytes !== null ? "Thay .md" : "Upload .md"}
              <span className="upload-size-hint">≤ 2 MiB</span>
              <input
                type="file"
                accept=".md,text/markdown"
                hidden
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    void run(
                      () => api.upload(`/admin/competitions/${competitionId}/contents/${content.id}/file`, file),
                      `Đã upload Markdown cho "${content.title}".`,
                    );
                  }
                  e.target.value = "";
                }}
              />
            </label>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onEdit}>
              Sửa
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-danger-ghost"
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
            {rowError}
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
  const [slug, setSlug] = useState(content?.slug ?? "");
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
    <Modal title={isEdit ? `Sửa nội dung — ${content.title}` : "Thêm trang nội dung"} onClose={onClose}>
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
              onChange={(e) => setTitle(e.target.value)}
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
              onChange={(e) => setSlug(e.target.value)}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              title="Chỉ a-z, 0-9 và dấu gạch ngang"
              required
            />
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
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Đang lưu..." : isEdit ? "Lưu" : "Tạo"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** ---------- Assets ---------- */

function AssetsPanel({ competitionId }: { competitionId: string }) {
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
    setBusy(true);
    setError(null);
    try {
      await api.postFile(`/admin/competitions/${competitionId}/assets`, file);
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
        <div className="s14-card s14-upload-card">
          <div className="s14-card-header">
            <div className="s14-card-icon">
              <IconUpload className="s14-icon" />
            </div>
            <div className="s14-card-header-text">
              <div className="s14-card-title-row">
                <h2 className="s14-card-title">Kho lưu trữ hình ảnh (Assets)</h2>
                <span className="s14-badge-count">{assets.length} tệp</span>
              </div>
              <p className="s14-card-desc">
                Tải lên hình ảnh để sử dụng trong các trang tài liệu Markdown của cuộc thi (tổng quan, thể lệ, dữ liệu).
              </p>
            </div>
          </div>

          <div className="s14-upload-body">
            <div className="toolbar s14-upload-toolbar">
              <label className="btn s14-upload-btn">
                <IconUpload className="s14-btn-icon" />
                <span>{busy ? "Đang xử lý..." : "Upload ảnh (PNG/JPEG/GIF/WebP ≤ 2 MiB)"}</span>
                <input
                  type="file"
                  aria-label="Chọn tệp ảnh"
                  accept=".png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp"
                  hidden
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void upload(file);
                    e.target.value = "";
                  }}
                />
              </label>
              <span className="s14-upload-hint">Định dạng hỗ trợ: PNG, JPG, GIF, WebP (Tối đa 2 MiB / tệp)</span>
            </div>
          </div>
        </div>

        <div className="s14-card s14-guide-card">
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
      <div className="s14-table-card">
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
        <ErrorBox error={error} />

        <div className="table-wrap s14-table-wrap" aria-busy={loading}>
          <table className="table s14-table">
            <thead>
              <tr>
                <th className="s14-th-name">Tên file</th>
                <th className="s14-th-type">Loại</th>
                <th className="s14-th-size">Dung lượng</th>
                <th className="s14-th-md">Dùng trong Markdown</th>
                <th className="s14-th-actions">Thao tác</th>
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
                    <td className="asset-name-cell s14-td-name">
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
                    <td className="s14-td-md">
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
              ) : (
                <tr>
                  <td colSpan={5} className="table-state s14-empty-state">
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [codeConfigured, setCodeConfigured] = useState(competition.join_code_configured);
  const [joinCode, setJoinCode] = useState("");
  const [pendingJoinCode, setPendingJoinCode] = useState("");
  const [pendingMember, setPendingMember] = useState<MemberItem | null>(null);
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
      const data = await api.get<{ members: MemberItem[]; total: number }>(
        `/admin/competitions/${competition.id}/members?limit=200`,
      );
      setMembers(data.members);
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
      <aside className="card admin-members-code-card">
        <h2>Mã tham gia</h2>
        {competition.join_mode !== "code" ? (
          <p className="text-muted admin-members-note">
            Cuộc thi này dùng chế độ tham gia{" "}
            {competition.join_mode === "open" ? "tự do" : "chỉ mời"} — không dùng mã.
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
              placeholder={codeConfigured ? "Đã đặt mã — nhập mã mới để đổi" : "Chưa đặt mã"}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              minLength={8}
              maxLength={128}
              required
              autoComplete="off"
            />
            <button className="btn" type="submit" disabled={busy}>
              {codeConfigured ? "Đổi mã" : "Đặt mã"}
            </button>
          </form>
        )}
      </aside>

      <section className="admin-members-list">
        <div className="admin-members-head">
          <div>
            <h2>Thành viên cuộc thi</h2>
            <p>{total} thành viên</p>
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
            <button className="btn" type="submit" disabled={busy}>Thêm thành viên</button>
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
        <div className="table-wrap admin-members-table-wrap" aria-busy={loading}>
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
                    </td>
                  </tr>
                ))
              ) : (
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
    </div>
  );
}
