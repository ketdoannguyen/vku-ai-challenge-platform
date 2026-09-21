/** Dashboard participant: danh sách competition đang mở/đã kết thúc (draft luôn ẩn ở backend). */

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Competition, CompetitionsResponse, Membership } from "../api/competitions";
import {
  JOIN_MODE_LABEL,
  METRIC_LABEL,
  STATUS_LABEL,
  displayStatus,
  formatLocal,
  statusClass,
} from "../api/competitions";
import { Loading } from "../components/ui";
import { JoinControl } from "../components/JoinControl";
import { useOptionalAuth } from "../auth/AuthContext";
import { useDeadlineClock } from "../hooks/useCountdown";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { formatCountdown } from "../lib/countdown";

type StatusFilter = "all" | "published" | "closed";
type CompetitionSort = "name" | "ending_soon" | "hottest";
type ParticipationFilter = "all" | "joined" | "not_joined";

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "published", label: "Đang diễn ra" },
  { id: "closed", label: "Đã kết thúc" },
];

const SORTS: { id: CompetitionSort; label: string }[] = [
  { id: "name", label: "Tên A–Z" },
  { id: "ending_soon", label: "Sắp kết thúc" },
  { id: "hottest", label: "Nhiều lượt nộp nhất" },
];

const PARTICIPATION: { id: ParticipationFilter; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "joined", label: "Đã tham gia" },
  { id: "not_joined", label: "Chưa tham gia" },
];

// Collator đặt ở module scope: dựng một lần, không tạo mới mỗi lần render.
const nameCollator = new Intl.Collator("vi", { sensitivity: "base", numeric: true });

/** So tên tiếng Việt rồi tới slug/id để mọi kiểu sort đều có tie-break tất định. */
function compareByName(a: Competition, b: Competition): number {
  return nameCollator.compare(a.name, b.name) || a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id);
}

/** Mốc hạn hợp lệ; ngày lỗi/thiếu trả null để bị đẩy xuống cuối nhóm thay vì phá thứ tự. */
function endAtMillis(competition: Competition): number | null {
  const millis = Date.parse(competition.end_at);
  return Number.isNaN(millis) ? null : millis;
}

const COMPARATORS: Record<CompetitionSort, (a: Competition, b: Competition) => number> = {
  name: compareByName,
  /**
   * Cuộc thi đang mở lên trước và gần hạn nhất đứng đầu; đã kết thúc xếp sau, mới đóng gần đây
   * trước. Nhóm theo `status` chứ không so với đồng hồ trang để thứ tự không đổi theo thời gian.
   */
  ending_soon: (a, b) => {
    if (a.status !== b.status) return a.status === "published" ? -1 : 1;
    const first = endAtMillis(a);
    const second = endAtMillis(b);
    if (first === null || second === null) {
      if (first !== second) return first === null ? 1 : -1;
      return compareByName(a, b);
    }
    if (first !== second) return a.status === "published" ? first - second : second - first;
    return compareByName(a, b);
  },
  hottest: (a, b) =>
    (b.submission_count ?? 0) - (a.submission_count ?? 0) || compareByName(a, b),
};

/**
 * Màu thẻ theo VỊ TRÍ trong lưới đang render, không theo trạng thái cuộc thi:
 * cột 1 xanh, cột 2 đỏ, cột 3 vàng rồi lặp lại. Cuộc thi đã kết thúc nằm ở cột 2
 * vẫn giữ thẻ đỏ, chỉ status badge chuyển xám.
 */
const CARD_THEMES = ["blue", "red", "yellow"] as const;
type CardTheme = (typeof CARD_THEMES)[number];

function getCardTheme(index: number): CardTheme {
  return CARD_THEMES[index % CARD_THEMES.length];
}

function IconSearch() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

function IconFilter() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={13}
      height={13}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function IconKey() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={12}
      height={12}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14 6a6 6 0 1 0-5.66 8H10v3h3v-3h3v-3h-2.34A6 6 0 0 0 14 6zm-6 7a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" />
    </svg>
  );
}

function IconMail() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={12}
      height={12}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm9 8L4.3 7h15.4L12 13z" />
    </svg>
  );
}

function IconCalendar() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 11h18" />
    </svg>
  );
}

function IconFlag() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 21V4M6 4h12l-2.5 4L18 12H6" />
    </svg>
  );
}

function IconError() {
  return (
    <svg
      className="form-error-icon"
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
    </svg>
  );
}

function IconPulse() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 12h4l3-7 4 14 3-7h4" />
    </svg>
  );
}

function IconTrophy({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4z" />
      <path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3M12 14v4M9 20h6" />
    </svg>
  );
}

function IconUsers() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1" />
      <circle cx="9" cy="8" r="3.2" />
      <path d="M22 20v-1a4 4 0 0 0-3-3.87M16.5 5.2a3.2 3.2 0 0 1 0 5.6" />
    </svg>
  );
}

/** Icon lớn cho hai trạng thái rỗng - thay emoji để đồng bộ bộ icon SVG của app. */
function IconEmptyState({ kind }: { kind: "search" | "trophy" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={28}
      height={28}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {kind === "search" ? (
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </>
      ) : (
        <>
          <path d="M7 4h10v5a5 5 0 0 1-10 0V4z" />
          <path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3M12 14v4M9 20h6" />
        </>
      )}
    </svg>
  );
}

/**
 * Nút Lọc gom sắp xếp và lọc tham gia vào một panel. Hai nhóm dùng radio native trong
 * `fieldset` nên hợp đồng bàn phím/đọc màn hình là của trình duyệt, không phải tự dựng.
 * Panel neo theo viewport qua portal vì `.page-hero` có `overflow: hidden` sẽ cắt dropdown.
 */
function CompetitionFilterDropdown({
  sort,
  onSortChange,
  participation,
  onParticipationChange,
  participationLocked,
  activeCount,
}: {
  sort: CompetitionSort;
  onSortChange: (value: CompetitionSort) => void;
  participation: ParticipationFilter;
  onParticipationChange: (value: ParticipationFilter) => void;
  /** Khách chưa đăng nhập: nhóm tham gia hiện nhưng khóa, vì mọi membership đều rỗng. */
  participationLocked: boolean;
  /** Số nhóm đang khác mặc định - hiện badge để trạng thái không chỉ truyền đạt bằng màu. */
  activeCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const ids = useId();

  const close = useCallback((refocus = false) => {
    setOpen(false);
    setPosition(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Đặt panel dưới nút nhưng lật lên trên nếu chạm đáy viewport; kẹp ngang để không tràn.
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!open || !trigger || !panel) return;
    const rect = trigger.getBoundingClientRect();
    const openUp = rect.bottom + panel.offsetHeight + 8 > window.innerHeight;
    const right = Math.max(
      Math.min(window.innerWidth - rect.right, window.innerWidth - panel.offsetWidth - 8),
      8,
    );
    setPosition({
      top: openUp ? Math.max(rect.top - panel.offsetHeight - 4, 8) : rect.bottom + 4,
      right,
    });
  }, [open]);

  // Chỉ focus được sau khi có toạ độ: lúc chưa đo panel còn `visibility: hidden`.
  useEffect(() => {
    if (open && position) {
      panelRef.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
    }
  }, [open, position]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      close(true);
    }

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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="dash-filter dash-filter-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Lọc và sắp xếp cuộc thi"
        data-active={activeCount > 0}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <IconFilter />
        Lọc
        {activeCount > 0 && (
          <span className="dash-filter-badge" aria-hidden="true">
            {activeCount}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="dash-filter-panel"
            role="dialog"
            aria-label="Lọc và sắp xếp cuộc thi"
            style={position ?? { top: 0, right: 0, visibility: "hidden" }}
          >
            <fieldset className="dash-filter-group">
              <legend className="dash-filter-legend">Sắp xếp</legend>
              {SORTS.map((option) => (
                <label key={option.id} className="dash-filter-option" htmlFor={`${ids}-sort-${option.id}`}>
                  <input
                    type="radio"
                    id={`${ids}-sort-${option.id}`}
                    name={`${ids}-sort`}
                    value={option.id}
                    checked={sort === option.id}
                    onChange={() => onSortChange(option.id)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </fieldset>

            <fieldset className="dash-filter-group" disabled={participationLocked}>
              <legend className="dash-filter-legend">Tham gia</legend>
              {PARTICIPATION.map((option) => (
                <label key={option.id} className="dash-filter-option" htmlFor={`${ids}-participation-${option.id}`}>
                  <input
                    type="radio"
                    id={`${ids}-participation-${option.id}`}
                    name={`${ids}-participation`}
                    value={option.id}
                    checked={participation === option.id}
                    onChange={() => onParticipationChange(option.id)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
              {participationLocked && (
                <p className="dash-filter-hint">Đăng nhập để lọc theo tham gia.</p>
              )}
            </fieldset>
          </div>,
          document.body,
        )}
    </>
  );
}

export function DashboardPage() {
  const auth = useOptionalAuth();
  const [data, setData] = useState<CompetitionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<CompetitionSort>("name");
  const [participation, setParticipation] = useState<ParticipationFilter>("all");
  useDocumentTitle("Cuộc thi");

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      setData(await api.get<CompetitionsResponse>("/competitions"));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const competitions = data?.competitions;

  // Một clock duy nhất cho cả trang, nhịp theo deadline gần nhất trong các cuộc thi đang mở.
  const publishedDeadlines = useMemo(
    () =>
      (competitions ?? [])
        .filter((item) => item.status === "published")
        .map((item) => item.end_at),
    [competitions],
  );
  const now = useDeadlineClock(publishedDeadlines);

  // Ngoài AuthProvider (test dựng component lẻ) coi như không phải khách để giữ hành vi cũ.
  const isGuest = auth !== null && !auth.loading && auth.account === null;

  const filtered = useMemo(() => {
    // Khách không có membership nào nên ép về "tất cả": state cũ không thể làm rỗng danh sách
    // khi phiên đăng nhập kết thúc giữa chừng.
    const participationFilter = isGuest ? "all" : participation;
    const needle = query.trim().toLocaleLowerCase("vi");
    const rows = (competitions ?? []).filter((item) => {
      if (filter !== "all" && item.status !== filter) return false;
      if (participationFilter === "joined" && !item.membership.active) return false;
      if (participationFilter === "not_joined" && item.membership.active) return false;
      return needle === "" || item.name.toLocaleLowerCase("vi").includes(needle);
    });
    // `sort` trả về mảng mới nên không đụng tới mảng của state.
    return rows.sort(COMPARATORS[sort]);
  }, [competitions, filter, isGuest, participation, query, sort]);

  const activeCount = (competitions ?? []).filter((item) => item.status === "published").length;
  const closedCount = (competitions ?? []).filter((item) => item.status === "closed").length;
  const joinedCount = (competitions ?? []).filter((item) => item.membership.active).length;

  const hasCompetitions = competitions !== undefined && competitions.length > 0;
  const errorMessage = error instanceof Error ? error.message : "Đã xảy ra lỗi không xác định.";

  return (
    <div className="page dash-page">
      <header className="page-hero">
        <div className="page-hero-row">
          <span className="page-hero-icon" aria-hidden="true">
            <IconTrophy className="page-hero-glyph" />
          </span>
          <div className="page-hero-copy">
            <h1 className="page-hero-title">Cuộc thi</h1>
            <p className="page-hero-subtitle">Các cuộc thi bạn có thể tham gia</p>
            <span className="vku-accent" aria-hidden="true">
              <span className="blue" />
              <span className="red" />
              <span className="yellow" />
            </span>
          </div>
          <section className="dash-stats page-hero-aside" aria-label="Thống kê cuộc thi">
            <dl className="dash-stat">
              <dt className="dash-stat-label">
                <IconPulse />
                Đang diễn ra
              </dt>
              <dd className="dash-stat-value">{String(activeCount).padStart(2, "0")}</dd>
            </dl>
            <dl className="dash-stat dash-stat-closed">
              <dt className="dash-stat-label">
                <IconTrophy />
                Đã kết thúc
              </dt>
              <dd className="dash-stat-value">{String(closedCount).padStart(2, "0")}</dd>
            </dl>
            {/* Khách chưa có membership nào nên ô này luôn 00 - chỉ tổ rối. */}
            {!isGuest && (
              <dl className="dash-stat dash-stat-joined">
                <dt className="dash-stat-label">
                  <IconUsers />
                  Đã tham gia
                </dt>
                <dd className="dash-stat-value">{String(joinedCount).padStart(2, "0")}</dd>
              </dl>
            )}
          </section>
        </div>

        <div className="dash-toolbar">
          <div className="dash-toolbar-left">
            <div className="dash-search">
              <span className="dash-search-icon" aria-hidden="true">
                <IconSearch />
              </span>
              <input
                className="input"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Tìm kiếm cuộc thi..."
                aria-label="Tìm kiếm cuộc thi"
              />
            </div>
            <div className="dash-filters" role="group" aria-label="Lọc theo trạng thái">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="dash-filter"
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <CompetitionFilterDropdown
              sort={sort}
              onSortChange={setSort}
              // Truyền giá trị đang thực sự áp dụng, để nhóm bị khóa của khách không hiển thị
              // một lựa chọn khác với danh sách đang render.
              participation={isGuest ? "all" : participation}
              onParticipationChange={setParticipation}
              participationLocked={isGuest}
              activeCount={(sort === "name" ? 0 : 1) + (participation === "all" || isGuest ? 0 : 1)}
            />
          </div>
        </div>
      </header>

      {loading ? (
        <Loading />
      ) : error ? (
        <div className="form-error dash-error" role="alert">
          <IconError />
          {/* Mã lỗi thô của API là chi tiết kỹ thuật - người dùng cuối chỉ cần câu mô tả. */}
          <div>
            <p>{errorMessage}</p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => void load()}>
            Thử lại
          </button>
        </div>
      ) : filtered.length > 0 ? (
        <>
          <div className="dash-list-head">
            <h2 className="dash-list-title">Danh sách cuộc thi</h2>
            <p className="dash-count">Hiển thị {filtered.length} cuộc thi</p>
          </div>
          <div className="comp-list">
            {filtered.map((competition, index) => (
              <CompetitionCard
                key={competition.id}
                competition={competition}
                theme={getCardTheme(index)}
                now={now}
                onMembershipChange={(slug, membership) =>
                  setData((prev) =>
                    prev
                      ? {
                          ...prev,
                          competitions: prev.competitions.map((item) =>
                            item.slug === slug ? { ...item, membership } : item,
                          ),
                        }
                      : prev,
                  )
                }
              />
            ))}
          </div>
        </>
      ) : hasCompetitions ? (
        // Có cuộc thi nhưng bộ lọc không khớp - khác hẳn "hệ thống chưa có gì".
        <div className="card empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            <IconEmptyState kind="search" />
          </div>
          <h2>Không tìm thấy cuộc thi phù hợp</h2>
          <p>Thử từ khóa khác hoặc bỏ bớt bộ lọc.</p>
        </div>
      ) : (
        <div className="card empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            <IconEmptyState kind="trophy" />
          </div>
          <h2>Chưa có cuộc thi nào</h2>
          <p>Các cuộc thi sẽ xuất hiện tại đây khi được Ban Tổ chức mở.</p>
        </div>
      )}
    </div>
  );
}

function CompetitionCard({
  competition,
  theme,
  now,
  onMembershipChange,
}: {
  competition: Competition;
  /** Theme lấy theo vị trí trong lưới đang render - không lấy từ trạng thái cuộc thi. */
  theme: CardTheme;
  /** Mốc giờ dùng chung của cả trang - mỗi thẻ không tự mở timer riêng. */
  now: number | null;
  onMembershipChange: (slug: string, membership: Membership) => void;
}) {
  const c = competition;
  const remaining =
    c.status === "published" && now !== null ? formatCountdown(c.end_at, now) : null;
  // Thẻ đã quá hạn không còn "Đang diễn ra" nữa, dù backend vẫn giữ status `published`.
  const shown = displayStatus(c.status, c.end_at);

  return (
    // `data-theme` quyết định màu thẻ, `data-status` chỉ để tra cứu; `statusClass` chỉ
    // còn dùng cho badge nên cuộc thi đã kết thúc ở cột 2 vẫn giữ nguyên thẻ đỏ.
    <article className="card comp-card" data-theme={theme} data-status={c.status}>
      <div className="comp-card-head">
        {/* h3 vì cả danh sách đã nằm dưới h2 "Danh sách cuộc thi". */}
        <h3 className="comp-card-title">
          <Link to={`/competitions/${c.slug}`}>{c.name}</Link>
        </h3>
        <span className={`status-badge status-badge-lg ${statusClass(shown)}`}>
          <span className="chip-dot" aria-hidden="true" />
          {STATUS_LABEL[shown]}
        </span>
      </div>

      <div className="comp-card-body">
        <div className="comp-card-chips">
          {remaining && (
            <span className="status-badge warning">
              <IconClock />
              {remaining}
            </span>
          )}
          <span className="chip">
            {c.join_mode === "code" && <IconKey />}
            {c.join_mode === "invite_only" && <IconMail />}
            {JOIN_MODE_LABEL[c.join_mode]}
          </span>
        </div>

        {c.short_description && <p className="comp-card-desc">{c.short_description}</p>}

        <dl className="comp-meta">
          <div className="comp-meta-item">
            <dt>
              <IconCalendar />
              <span className="sr-only">Bắt đầu</span>
            </dt>
            <dd>{formatLocal(c.start_at)}</dd>
          </div>
          <div className="comp-meta-item">
            <dt>
              <IconFlag />
              <span className="sr-only">Kết thúc</span>
            </dt>
            <dd>{formatLocal(c.end_at)}</dd>
          </div>
        </dl>

        <div className="comp-telemetry">
          <div className="comp-telemetry-item">
            <span className="comp-telemetry-label">Chỉ số đánh giá</span>
            <span className="comp-telemetry-value">{METRIC_LABEL[c.primary_metric]}</span>
          </div>
          <div className="comp-telemetry-item">
            <span className="comp-telemetry-label">Hạn mức nộp</span>
            <span className="comp-telemetry-value">
              {c.quota_per_day > 0 ? `${c.quota_per_day} lượt / ngày` : "Không nhận bài nộp"}
            </span>
          </div>
        </div>
      </div>

      <div className="comp-card-footer">
        {/* Thẻ trong danh sách chỉ dẫn vào cuộc thi; rời cuộc thi nằm ở trang chi tiết. */}
        <JoinControl
          competition={c}
          showLeave={false}
          onMembershipChange={(membership) => onMembershipChange(c.slug, membership)}
        />
      </div>
    </article>
  );
}
