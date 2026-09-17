/** Admin competitions: table + tạo/sửa modal + publish/close/clone confirm. */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Competition, CompetitionsResponse } from "../api/competitions";
import { JOIN_MODE_LABEL, METRIC_LABEL, STATUS_LABEL, formatLocal, isoToLocalInput, localInputToIso, statusClass } from "../api/competitions";
import { ConfirmModal, Modal } from "../components/Modal";
import { Loading } from "../components/ui";

const PAGE_SIZE = 5;
type StatusFilter = "all" | Competition["status"];
type ConfirmAction = "publish" | "close" | "clone";

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "Tất cả" },
  { value: "draft", label: "Bản nháp" },
  { value: "published", label: "Đang diễn ra" },
  { value: "closed", label: "Đã kết thúc" },
];

function Icon({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <svg className={className} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function IconFolder({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3.75 6.75h5l2 2h9.5v8.5a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2Z" />
      <path d="M3.75 9.25h16.5" />
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

function IconRefresh({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M19 8a7.5 7.5 0 0 0-12.75-2.1L4 8" />
      <path d="M4 4v4h4" />
      <path d="M5 16a7.5 7.5 0 0 0 12.75 2.1L20 16" />
      <path d="M20 20v-4h-4" />
    </Icon>
  );
}

function IconLock({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Đã xảy ra lỗi không xác định.";
}

export function AdminCompetitionsPage() {
  const [data, setData] = useState<CompetitionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Competition | null>(null);
  const [confirming, setConfirming] = useState<{ action: ConfirmAction; competition: Competition } | null>(null);

  const load = useCallback(async (refresh = false) => {
    setError(null);
    if (refresh) setRefreshing(true);
    try {
      setData(await api.get<CompetitionsResponse>("/admin/competitions"));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const messageTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    },
    [],
  );

  function dismissMessage() {
    if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    messageTimer.current = null;
    setMessage("");
  }

  function notify(text: string) {
    if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    setMessage(text);
    messageTimer.current = window.setTimeout(dismissMessage, 4500);
    void load();
  }

  const competitions = useMemo(() => data?.competitions ?? [], [data]);
  const counts = useMemo(
    () => ({
      all: competitions.length,
      draft: competitions.filter((competition) => competition.status === "draft").length,
      published: competitions.filter((competition) => competition.status === "published").length,
      closed: competitions.filter((competition) => competition.status === "closed").length,
    }),
    [competitions],
  );

  const filteredCompetitions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("vi");
    return competitions.filter((competition) => {
      const matchesStatus = statusFilter === "all" || competition.status === statusFilter;
      const matchesQuery =
        normalizedQuery.length === 0 ||
        competition.name.toLocaleLowerCase("vi").includes(normalizedQuery) ||
        competition.slug.toLocaleLowerCase("vi").includes(normalizedQuery);
      return matchesStatus && matchesQuery;
    });
  }, [competitions, query, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredCompetitions.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredCompetitions.slice(pageStart, pageStart + PAGE_SIZE);
  const displayStart = filteredCompetitions.length === 0 ? 0 : pageStart + 1;
  const displayEnd = Math.min(pageStart + PAGE_SIZE, filteredCompetitions.length);

  // Đổi bộ lọc/tìm kiếm thì quay về trang 1; `currentPage` tự kẹp theo `pageCount` khi dữ liệu ngắn lại.
  function changeQuery(value: string) {
    setQuery(value);
    setPage(1);
  }

  function changeStatusFilter(value: StatusFilter) {
    setStatusFilter(value);
    setPage(1);
  }

  function clearFilters() {
    setQuery("");
    setStatusFilter("all");
    setPage(1);
  }

  async function confirmAction() {
    if (!confirming) return;
    const { action, competition } = confirming;
    if (action === "clone") {
      const clone = await api.post<Competition>(`/admin/competitions/${competition.id}/clone`);
      setConfirming(null);
      notify(`Đã clone thành "${clone.name}" (draft).`);
      return;
    }
    await api.post(`/admin/competitions/${competition.id}/${action}`);
    setConfirming(null);
    notify(action === "publish" ? "Đã publish cuộc thi." : "Đã kết thúc cuộc thi.");
  }

  const confirmation = confirming
    ? confirming.action === "publish"
      ? {
          title: "Publish cuộc thi",
          body: `Publish "${confirming.competition.name}" — thí sinh sẽ thấy cuộc thi này. Thao tác này không tự hoàn tác.`,
          label: "Publish",
          danger: false,
        }
      : confirming.action === "close"
        ? {
            title: "Kết thúc cuộc thi",
            body: `Kết thúc "${confirming.competition.name}" — không nhận submission mới, cuộc thi không thể mở lại.`,
            label: "Kết thúc",
            danger: true,
          }
        : {
            title: "Clone cuộc thi",
            body: `Clone "${confirming.competition.name}" thành một bản nháp mới?`,
            label: "Clone",
            danger: false,
          }
    : null;

  return (
    <div className="page ac-page">
      <header className="ac-page-head">
        <div>
          <h1 className="ac-title">Quản lý cuộc thi</h1>
          <p className="ac-subtitle">Tạo, chỉnh sửa, publish/close và clone cuộc thi</p>
        </div>
        <button className="ac-create-button" type="button" onClick={() => setCreating(true)}>
          <span aria-hidden="true">+</span>
          Tạo cuộc thi
        </button>
      </header>

      <section className="ac-stats" aria-label="Tổng quan cuộc thi">
        <StatCard label="Tổng cuộc thi" value={counts.all} detail="toàn hệ thống" icon={<IconFolder className="ac-stat-icon" />} />
        <StatCard label="Đang diễn ra" value={counts.published} detail="cuộc thi" badge="Live" tone="live" />
        <StatCard label="Bản nháp" value={counts.draft} detail="Chỉ admin thấy" badge="Draft" tone="draft" />
        <StatCard label="Đã kết thúc" value={counts.closed} detail="cuộc thi" badge="Closed" tone="closed" />
      </section>

      <section className="ac-toolbar" aria-label="Tìm và lọc cuộc thi">
        <div className="ac-filter-list" role="group" aria-label="Lọc theo trạng thái">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={`ac-filter${statusFilter === filter.value ? " active" : ""}`}
              aria-pressed={statusFilter === filter.value}
              onClick={() => changeStatusFilter(filter.value)}
            >
              {filter.label} ({counts[filter.value]})
            </button>
          ))}
        </div>
        <div className="ac-toolbar-actions">
          <label className="ac-search">
            <span className="sr-only">Tìm kiếm cuộc thi</span>
            <IconSearch className="ac-search-icon" />
            <input value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="Tìm kiếm theo tên hoặc slug..." />
          </label>
          <button className="ac-refresh" type="button" title="Làm mới bảng" disabled={refreshing} onClick={() => void load(true)}>
            <IconRefresh className={refreshing ? "ac-refresh-icon spinning" : "ac-refresh-icon"} />
            <span>{refreshing ? "Đang tải..." : "Làm mới"}</span>
          </button>
        </div>
      </section>

      {message && (
        <div className="ac-toast" role="status">
          <IconCheck className="ac-toast-icon" />
          <span>{message}</span>
          <button type="button" aria-label="Đóng thông báo" onClick={dismissMessage}>
            ×
          </button>
        </div>
      )}

      <section className="ac-table-card" aria-busy={loading || refreshing}>
        <div className="ac-table-scroll">
          <table className="ac-table">
            <colgroup>
              <col className="ac-col-name" />
              <col className="ac-col-slug" />
              <col className="ac-col-status" />
              <col className="ac-col-time" />
              <col className="ac-col-metric" />
              <col className="ac-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Tên</th>
                <th scope="col">Slug</th>
                <th scope="col">Trạng thái</th>
                <th scope="col">Thời gian</th>
                <th scope="col">Metric</th>
                <th scope="col">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="ac-table-state">
                    <Loading />
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={6} className="ac-table-state">
                    <div className="ac-error-state" role="alert">
                      <strong>Không thể tải danh sách cuộc thi.</strong>
                      <span>{errorMessage(error)}</span>
                      <button type="button" className="ac-state-button" onClick={() => void load(true)}>
                        Thử lại
                      </button>
                    </div>
                  </td>
                </tr>
              ) : competitions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="ac-table-state">
                    <div className="ac-empty-state">
                      <strong>Chưa có cuộc thi nào. Tạo cuộc thi đầu tiên.</strong>
                      <button type="button" className="ac-state-button" onClick={() => setCreating(true)}>
                        Tạo cuộc thi
                      </button>
                    </div>
                  </td>
                </tr>
              ) : pageItems.length === 0 ? (
                <tr>
                  <td colSpan={6} className="ac-table-state">
                    <div className="ac-empty-state">
                      <strong>Không tìm thấy cuộc thi phù hợp.</strong>
                      <button type="button" className="ac-state-button" onClick={clearFilters}>
                        Xóa bộ lọc
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                pageItems.map((competition) => (
                  <CompetitionRow
                    key={competition.id}
                    competition={competition}
                    onEdit={() => setEditing(competition)}
                    onConfirm={(action) => setConfirming({ action, competition })}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && !error && competitions.length > 0 && (
          <div className="ac-pagination">
            <div>
              Hiển thị <strong>{displayStart}–{displayEnd}</strong> trong số <strong>{filteredCompetitions.length}</strong> cuộc thi
            </div>
            {pageCount > 1 && (
              <nav className="ac-pagination-controls" aria-label="Phân trang cuộc thi">
                <button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>
                  Trang trước
                </button>
                {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
                  <button
                    key={pageNumber}
                    type="button"
                    className={pageNumber === currentPage ? "active" : ""}
                    aria-current={pageNumber === currentPage ? "page" : undefined}
                    aria-label={`Trang ${pageNumber}`}
                    onClick={() => setPage(pageNumber)}
                  >
                    {pageNumber}
                  </button>
                ))}
                <button type="button" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>
                  Trang sau
                </button>
              </nav>
            )}
          </div>
        )}
      </section>

      {creating && (
        <CompetitionFormModal
          onClose={() => setCreating(false)}
          onSaved={(name) => {
            setCreating(false);
            notify(`Đã tạo cuộc thi "${name}".`);
          }}
        />
      )}
      {editing && (
        <CompetitionFormModal
          competition={editing}
          onClose={() => setEditing(null)}
          onSaved={(name) => {
            setEditing(null);
            notify(`Đã cập nhật "${name}".`);
          }}
        />
      )}
      {confirming && confirmation && (
        <ConfirmModal
          title={confirmation.title}
          body={confirmation.body}
          confirmLabel={confirmation.label}
          danger={confirmation.danger}
          onConfirm={confirmAction}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  detail,
  icon,
  badge,
  tone,
}: {
  label: string;
  value: number;
  detail: string;
  icon?: ReactNode;
  badge?: string;
  tone?: "live" | "draft" | "closed";
}) {
  return (
    <article className="ac-stat-card">
      <div className="ac-stat-head">
        <span>{label}</span>
        {icon}
        {badge && (
          <span className={`ac-stat-badge ${tone}`}>
            <span aria-hidden="true" />
            {badge}
          </span>
        )}
      </div>
      <div>
        <strong className="ac-stat-value">{value}</strong>
        <div className={`ac-stat-detail${tone === "draft" ? " draft" : ""}`}>{detail}</div>
      </div>
    </article>
  );
}

function CompetitionRow({
  competition,
  onEdit,
  onConfirm,
}: {
  competition: Competition;
  onEdit: () => void;
  onConfirm: (action: ConfirmAction) => void;
}) {
  const c = competition;
  const editDisabled = c.status === "closed";
  const editReason = "Cuộc thi đã kết thúc và không thể chỉnh sửa.";

  return (
    <tr>
      <td>
        <div className="ac-name-cell">
          <Link to={`/admin/competitions/${c.id}`}>{c.name}</Link>
          <span>{JOIN_MODE_LABEL[c.join_mode]}</span>
        </div>
      </td>
      <td>
        <code className="ac-slug-cell">{c.slug}</code>
      </td>
      <td>
        <div className="ac-status-cell">
          <span className={`ac-status ${statusClass(c.status)}`}>
            <span aria-hidden="true" />
            {STATUS_LABEL[c.status]}
          </span>
          {c.status === "draft" && <small>Chỉ admin thấy</small>}
        </div>
      </td>
      <td>
        <div className="ac-time-cell">
          <div>
            <span>Bắt đầu:</span> <time dateTime={c.start_at}>{formatLocal(c.start_at)}</time>
          </div>
          <div>
            <span>Kết thúc:</span> <time dateTime={c.end_at}>{formatLocal(c.end_at)}</time>
          </div>
        </div>
      </td>
      <td>
        <div className="ac-metric-cell">
          <strong>{METRIC_LABEL[c.primary_metric]}</strong>
          <span>{c.quota_per_day} lượt/ngày</span>
          <small>{c.leaderboard_visible ? "Leaderboard hiển thị" : "Leaderboard đang ẩn"}</small>
        </div>
      </td>
      <td className="ac-actions-cell">
        <div className="ac-actions">
          <Link className="ac-row-action" to={`/admin/competitions/${c.id}`}>
            Quản lý
          </Link>
          <button
            className="ac-row-action"
            type="button"
            disabled={editDisabled}
            title={editDisabled ? editReason : undefined}
            aria-describedby={editDisabled ? `edit-reason-${c.id}` : undefined}
            onClick={onEdit}
          >
            {editDisabled && <IconLock className="ac-action-lock" />}
            Sửa
          </button>
          {c.status === "draft" && (
            <button className="ac-row-action ac-row-action-primary" type="button" onClick={() => onConfirm("publish")}>
              Publish
            </button>
          )}
          {c.status === "published" && (
            <button className="ac-row-action ac-row-action-danger" type="button" onClick={() => onConfirm("close")}>
              Kết thúc
            </button>
          )}
          <button className="ac-row-action ac-row-action-ghost" type="button" onClick={() => onConfirm("clone")}>
            Clone
          </button>
        </div>
        {editDisabled && (
          <span className="ac-disabled-reason" id={`edit-reason-${c.id}`}>
            {editReason}
          </span>
        )}
      </td>
    </tr>
  );
}

/** Dùng chung create/edit. Create: nhập mọi field. Edit: slug/status khóa (backend enforce). */
function CompetitionFormModal({
  competition,
  onClose,
  onSaved,
}: {
  competition?: Competition;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const isEdit = competition !== undefined;
  const [name, setName] = useState(competition?.name ?? "");
  const [slug, setSlug] = useState(competition?.slug ?? "");
  const [description, setDescription] = useState(competition?.short_description ?? "");
  const [startAt, setStartAt] = useState(competition ? isoToLocalInput(competition.start_at) : "");
  const [endAt, setEndAt] = useState(competition ? isoToLocalInput(competition.end_at) : "");
  const [joinMode, setJoinMode] = useState<Competition["join_mode"]>(competition?.join_mode ?? "open");
  const [metric, setMetric] = useState<Competition["primary_metric"]>(competition?.primary_metric ?? "f1");
  const [quota, setQuota] = useState(String(competition?.quota_per_day ?? 5));
  const [leaderboardVisible, setLeaderboardVisible] = useState(competition?.leaderboard_visible ?? true);
  const [dateError, setDateError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const title = isEdit ? `Sửa cuộc thi — ${competition.slug}` : "Tạo cuộc thi";
  const metricLocked = isEdit && competition.status === "published";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setDateError("");
    setError("");
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (end <= start) {
      setDateError("Thời gian kết thúc phải sau thời gian bắt đầu.");
      return;
    }
    setBusy(true);
    const payload = {
      name,
      slug: slug.trim().toLowerCase(),
      short_description: description,
      start_at: localInputToIso(startAt),
      end_at: localInputToIso(endAt),
      join_mode: joinMode,
      primary_metric: metric,
      quota_per_day: Number(quota),
      leaderboard_visible: leaderboardVisible,
    };
    try {
      const saved = isEdit
        ? await api.patch<Competition>(`/admin/competitions/${competition.id}`, payload)
        : await api.post<Competition>("/admin/competitions", payload);
      onSaved(saved.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose} variant="competition-form">
      <form className="ac-form" onSubmit={submit}>
        <div className="ac-form-eyebrow">
          <span aria-hidden="true" />
          CẤU HÌNH CUỘC THI / COMPETITION SETUP
        </div>

        <div className="ac-form-body">
          <div className="ac-form-field">
            <label className="ac-required" htmlFor="comp-name">
              Tên cuộc thi
            </label>
            <input
              id="comp-name"
              className="ac-form-control"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="ac-form-field">
            <div className="ac-form-label-row">
              <label className="ac-required" htmlFor="comp-slug">
                Slug {isEdit && "(không đổi được)"}
              </label>
              {isEdit && <IconLock className="ac-form-lock" />}
            </div>
            <div className={`ac-slug-input${isEdit ? " locked" : ""}`}>
              <span aria-hidden="true">/competitions/</span>
              <input
                id="comp-slug"
                className="ac-form-control"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                title="Chỉ a-z, 0-9 và dấu gạch ngang"
                disabled={isEdit}
                required
              />
              {isEdit && <IconLock className="ac-form-lock" />}
            </div>
            <small>Slug dùng làm URL định danh: /competitions/{slug || "slug-cuoc-thi"}</small>
          </div>

          <div className="ac-form-field">
            <label htmlFor="comp-desc">Mô tả ngắn</label>
            <textarea id="comp-desc" className="ac-form-control ac-form-textarea" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>

          <div className="ac-date-group">
            <div className="ac-form-grid">
              <div className="ac-form-field">
                <label className="ac-required" htmlFor="comp-start">
                  Bắt đầu
                </label>
                <input
                  id="comp-start"
                  className="ac-form-control ac-form-mono"
                  type="datetime-local"
                  value={startAt}
                  onChange={(event) => setStartAt(event.target.value)}
                  required
                />
              </div>
              <div className="ac-form-field">
                <label className="ac-required" htmlFor="comp-end">
                  Kết thúc
                </label>
                <input
                  id="comp-end"
                  className="ac-form-control ac-form-mono"
                  type="datetime-local"
                  value={endAt}
                  onChange={(event) => setEndAt(event.target.value)}
                  required
                />
              </div>
            </div>
            {dateError && (
              <div className="ac-date-error" role="alert">
                {dateError}
              </div>
            )}
          </div>

          <fieldset className="ac-join-fieldset">
            <legend className="ac-required">Cách tham gia</legend>
            <div className="ac-join-options">
              {(Object.keys(JOIN_MODE_LABEL) as Competition["join_mode"][]).map((mode) => (
                <label key={mode} className={joinMode === mode ? "selected" : ""}>
                  <input type="radio" name="comp-join" value={mode} checked={joinMode === mode} onChange={() => setJoinMode(mode)} />
                  <span>
                    <strong>{JOIN_MODE_LABEL[mode]}</strong>
                    <small>{mode}</small>
                  </span>
                  {joinMode === mode && <IconCheck className="ac-join-check" />}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="ac-form-grid">
            <div className="ac-form-field">
              <div className="ac-form-label-row">
                <label className="ac-required" htmlFor="comp-metric">
                  Chỉ số chính
                </label>
                {metricLocked && <IconLock className="ac-form-lock" />}
              </div>
              <select
                id="comp-metric"
                className="ac-form-control ac-form-mono"
                value={metric}
                onChange={(event) => setMetric(event.target.value as Competition["primary_metric"])}
                disabled={metricLocked}
              >
                <option value="f1">{METRIC_LABEL.f1}</option>
                <option value="precision">{METRIC_LABEL.precision}</option>
                <option value="recall">{METRIC_LABEL.recall}</option>
              </select>
              {metricLocked && <small>Cuộc thi đã publish — không thể đổi chỉ số chính.</small>}
            </div>

            <div className="ac-form-field">
              <label className="ac-required" htmlFor="comp-quota">
                Giới hạn nộp bài (lượt/ngày)
              </label>
              <div className="ac-quota-input">
                <input
                  id="comp-quota"
                  className="ac-form-control ac-form-mono"
                  type="number"
                  min={0}
                  max={1000}
                  value={quota}
                  onChange={(event) => setQuota(event.target.value)}
                  required
                />
                <span aria-hidden="true">lượt / ngày</span>
              </div>
            </div>
          </div>

          <div className="ac-leaderboard-field">
            <label htmlFor="comp-leaderboard">
              <input
                id="comp-leaderboard"
                type="checkbox"
                checked={leaderboardVisible}
                onChange={(event) => setLeaderboardVisible(event.target.checked)}
              />
              <span>
                <strong>Leaderboard hiển thị với thí sinh</strong>
                <small>Nếu tắt, thí sinh sẽ thấy thông báo bảng xếp hạng chưa được công bố.</small>
              </span>
            </label>
          </div>

          {error && (
            <div className="error-box ac-form-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <footer className="ac-form-footer">
          <span>Nhấn phím Esc hoặc bấm Hủy để đóng hộp thoại.</span>
          <div>
            <button type="button" className="ac-form-button secondary" onClick={onClose} disabled={busy}>
              Hủy
            </button>
            <button className="ac-form-button primary" type="submit" disabled={busy}>
              {busy ? "Đang lưu..." : isEdit ? "Lưu" : "Tạo"}
              {!busy && <span aria-hidden="true">→</span>}
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
