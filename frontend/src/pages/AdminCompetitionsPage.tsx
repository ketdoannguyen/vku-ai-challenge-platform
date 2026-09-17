/** Admin competitions: table + tạo/sửa modal + publish/close/clone confirm. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { AdminCompetition, AdminCompetitionsResponse, Competition } from "../api/competitions";
import { JOIN_MODE_LABEL, METRIC_LABEL, STATUS_LABEL, formatLocal, statusClass } from "../api/competitions";
import {
  CompetitionActionConfirmModal,
  CompetitionDeleteModal,
  CompetitionFormModal,
  type CompetitionAction,
} from "../components/AdminCompetitionManagement";
import { Loading } from "../components/ui";

const PAGE_SIZE = 5;
type StatusFilter = "all" | Competition["status"];

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

function IconDots({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
    </Icon>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Đã xảy ra lỗi không xác định.";
}

export function AdminCompetitionsPage() {
  const [data, setData] = useState<AdminCompetitionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Competition | null>(null);
  const [confirming, setConfirming] = useState<{ action: CompetitionAction; competition: Competition } | null>(null);
  const [deleting, setDeleting] = useState<Competition | null>(null);

  const load = useCallback(async (refresh = false) => {
    setError(null);
    if (refresh) setRefreshing(true);
    try {
      setData(await api.get<AdminCompetitionsResponse>("/admin/competitions"));
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
              <col className="ac-col-members" />
              <col className="ac-col-submissions" />
              <col className="ac-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Tên</th>
                <th scope="col">Slug</th>
                <th scope="col">Trạng thái</th>
                <th scope="col">Thời gian</th>
                <th scope="col">Metric</th>
                <th scope="col" className="ac-count-head">Thành viên</th>
                <th scope="col" className="ac-count-head">Bài nộp</th>
                <th scope="col">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="ac-table-state">
                    <Loading />
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={8} className="ac-table-state">
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
                  <td colSpan={8} className="ac-table-state">
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
                  <td colSpan={8} className="ac-table-state">
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
                    onDelete={() => setDeleting(competition)}
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
          onSaved={(saved) => {
            setCreating(false);
            notify(`Đã tạo cuộc thi "${saved.name}".`);
          }}
        />
      )}
      {editing && (
        <CompetitionFormModal
          competition={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            notify(`Đã cập nhật "${saved.name}".`);
          }}
        />
      )}
      {confirming && (
        <CompetitionActionConfirmModal
          action={confirming.action}
          competition={confirming.competition}
          onSuccess={(action, clone) => {
            setConfirming(null);
            notify(
              action === "clone"
                ? `Đã clone thành "${clone!.name}" (draft).`
                : action === "publish"
                  ? "Đã publish cuộc thi."
                  : "Đã kết thúc cuộc thi.",
            );
          }}
          onClose={() => setConfirming(null)}
        />
      )}
      {deleting && (
        <CompetitionDeleteModal
          competition={deleting}
          onDeleted={() => {
            const name = deleting.name;
            setDeleting(null);
            // notify() tải lại danh sách nên row vừa xoá biến mất ngay.
            notify(`Đã xóa cuộc thi "${name}".`);
          }}
          onClose={() => setDeleting(null)}
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
  onDelete,
}: {
  competition: AdminCompetition;
  onEdit: () => void;
  onConfirm: (action: CompetitionAction) => void;
  onDelete: () => void;
}) {
  const c = competition;

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
        </div>
      </td>
      <td className="ac-count-cell">
        <span className={`ac-count${c.member_count === 0 ? " is-empty" : ""}`}>{c.member_count}</span>
      </td>
      <td className="ac-count-cell">
        <span className={`ac-count${c.submission_count === 0 ? " is-empty" : ""}`}>{c.submission_count}</span>
      </td>
      <td className="ac-actions-cell">
        <RowActionMenu competition={c} onEdit={onEdit} onConfirm={onConfirm} onDelete={onDelete} />
      </td>
    </tr>
  );
}

const EDIT_LOCKED_REASON = "Cuộc thi đã kết thúc và không thể chỉnh sửa.";

/** Menu ba chấm: gom thao tác của row để cột Thao tác không chiếm chỗ của các cột khác.
 *  Render qua portal + position:fixed vì `.ac-table-scroll` (overflow-x) sẽ cắt dropdown. */
function RowActionMenu({
  competition,
  onEdit,
  onConfirm,
  onDelete,
}: {
  competition: AdminCompetition;
  onEdit: () => void;
  onConfirm: (action: CompetitionAction) => void;
  onDelete: () => void;
}) {
  const c = competition;
  const editDisabled = c.status === "closed";
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    setPosition(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Đặt menu cạnh nút nhưng lật lên trên nếu chạm đáy viewport (row cuối bảng).
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!open || !trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const openUp = rect.bottom + menu.offsetHeight + 8 > window.innerHeight;
    setPosition({
      top: openUp ? rect.top - menu.offsetHeight - 4 : rect.bottom + 4,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  // Chỉ focus được sau khi `position` có giá trị: lúc chưa có toạ độ menu còn
  // `visibility: hidden` và phần tử hidden không nhận được focus.
  useEffect(() => {
    if (open && position) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    }

    function onKeyDown(event: KeyboardEvent) {
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
      if (event.key === "Escape") {
        close(true);
        return;
      }
      if (event.key === "Tab") {
        close();
        return;
      }
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (step === 0 && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      if (event.key === "Home") items[0].focus();
      else if (event.key === "End") items[items.length - 1].focus();
      else items[(current + step + items.length) % items.length].focus();
    }

    // Menu neo theo toạ độ viewport nên phải đóng khi trang cuộn để không lệch.
    function onViewportChange() {
      close();
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [open, close]);

  function run(action: () => void) {
    close();
    action();
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="ac-menu-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Thao tác cho ${c.name}`}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <IconDots />
      </button>
      {editDisabled && (
        <span className="sr-only" id={`edit-reason-${c.id}`}>
          {EDIT_LOCKED_REASON}
        </span>
      )}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="ac-menu"
            role="menu"
            aria-label={`Thao tác cho ${c.name}`}
            style={{ ...position, visibility: position ? "visible" : "hidden" }}
          >
            <Link className="ac-menu-item" role="menuitem" to={`/admin/competitions/${c.id}`}>
              Quản lý
            </Link>
            <button
              className="ac-menu-item"
              type="button"
              role="menuitem"
              disabled={editDisabled}
              title={editDisabled ? EDIT_LOCKED_REASON : undefined}
              aria-describedby={editDisabled ? `edit-reason-${c.id}` : undefined}
              onClick={() => run(onEdit)}
            >
              {editDisabled && <IconLock className="ac-action-lock" />}
              Sửa
            </button>
            {(c.status === "draft" || c.status === "published") && <div className="ac-menu-separator" />}
            {c.status === "draft" && (
              <button className="ac-menu-item ac-menu-item-strong" type="button" role="menuitem" onClick={() => run(() => onConfirm("publish"))}>
                Publish
              </button>
            )}
            {c.status === "published" && (
              <button className="ac-menu-item ac-menu-item-danger" type="button" role="menuitem" onClick={() => run(() => onConfirm("close"))}>
                Kết thúc
              </button>
            )}
            <button className="ac-menu-item" type="button" role="menuitem" onClick={() => run(() => onConfirm("clone"))}>
              Clone
            </button>
            {/* Chỉ draft xoá được — published/closed giữ lịch sử thi (ADR-009). */}
            {c.status === "draft" && (
              <>
                <div className="ac-menu-separator" />
                <button
                  className="ac-menu-item ac-menu-item-danger"
                  type="button"
                  role="menuitem"
                  onClick={() => run(onDelete)}
                >
                  Xóa
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
