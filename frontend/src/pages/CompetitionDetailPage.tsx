/** Competition shell: masthead (trạng thái, đếm ngược, chỉ số) + tab bar + mục lục nội dung + nested routes. */

import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useParams, useResolvedPath } from "react-router-dom";
import { api } from "../api/client";
import type { Competition, Membership } from "../api/competitions";
import {
  JOIN_MODE_LABEL,
  METRIC_LABEL,
  STATUS_LABEL,
  formatLocal,
  statusClass,
} from "../api/competitions";
import { fetchContents, type ContentSummary } from "../api/contents";
import { ErrorBox } from "../components/ui";
import { CompetitionResources } from "../components/CompetitionResources";
import { JoinControl } from "../components/JoinControl";
import { useCountdown } from "../hooks/useCountdown";

export interface CompetitionContext {
  competition: Competition;
  contents: ContentSummary[];
  contentsLoading?: boolean;
  contentsError?: unknown;
  /** Tải lại mục lục nội dung — dùng ở trạng thái lỗi của khối tài liệu trong Tổng quan. */
  reloadContents: () => Promise<void>;
  /** Tải lại cuộc thi (quota sau khi nộp) mà không bật skeleton, để không unmount trang con. */
  refreshCompetition: () => Promise<void>;
}

export const VISIBILITY_LABEL: Record<ContentSummary["visibility"], string> = {
  public: "Mọi thí sinh",
  members: "Chỉ thành viên cuộc thi",
};

/** Wrapper SVG dùng chung: icon trang trí nên luôn aria-hidden. */
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const TABS: { to: string; end: boolean; label: string; icon: React.ReactNode }[] = [
  {
    to: ".",
    end: true,
    label: "Tổng quan",
    icon: (
      <>
        <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
        <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
      </>
    ),
  },
  {
    to: "submit",
    end: false,
    label: "Nộp bài",
    icon: (
      <>
        <path d="M12 15V4" />
        <path d="M8 8l4-4 4 4" />
        <path d="M5 19h14" />
      </>
    ),
  },
  {
    to: "submissions",
    end: false,
    label: "Bài đã nộp",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
  },
  {
    to: "leaderboard",
    end: false,
    label: "Bảng xếp hạng",
    icon: (
      <>
        <path d="M4 20V10" />
        <path d="M12 20V4" />
        <path d="M20 20v-6" />
      </>
    ),
  },
];

export function CompetitionDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const { pathname } = useLocation();
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [contents, setContents] = useState<ContentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [contentsLoading, setContentsLoading] = useState(true);
  const [contentsError, setContentsError] = useState<unknown>(null);

  const loadCompetition = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCompetition(await api.get<Competition>(`/competitions/${slug}`));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  /** Refetch im lặng: quota là thông tin phụ, lỗi mạng không được xoá nội dung đang xem. */
  const refreshCompetition = useCallback(async () => {
    try {
      setCompetition(await api.get<Competition>(`/competitions/${slug}`));
    } catch {
      // Giữ nguyên dữ liệu cũ; lần nộp kế tiếp vẫn được backend kiểm tra quota thật.
    }
  }, [slug]);

  // Danh sách nội dung tải độc lập với cuộc thi: lỗi ở đây hiện trạng thái lỗi + "Thử lại",
  // tuyệt đối không rơi về "chưa có nội dung" vì hai tình huống này khác nhau.
  const loadContents = useCallback(async () => {
    setContentsLoading(true);
    setContentsError(null);
    try {
      const data = await fetchContents(slug!);
      setContents(data.contents);
    } catch (err) {
      setContentsError(err);
      setContents([]);
    } finally {
      setContentsLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void loadCompetition();
    void loadContents();
  }, [loadCompetition, loadContents]);

  // Gọi vô điều kiện trước mọi nhánh return; chuỗi rỗng khi chưa tải xong cũng trả null.
  const remaining = useCountdown(competition?.end_at ?? "");

  if (loading) {
    return (
      <div className="page comp-page" aria-busy="true">
        <p className="sr-only" role="status">
          Đang tải cuộc thi…
        </p>
        <div className="comp-skel" aria-hidden="true">
          <div className="comp-skel-masthead">
            <span className="comp-skel-line comp-skel-chip" />
            <span className="comp-skel-line comp-skel-title" />
            <span className="comp-skel-line comp-skel-text" />
            <div className="comp-skel-facts">
              <span className="comp-skel-line comp-skel-fact" />
              <span className="comp-skel-line comp-skel-fact" />
              <span className="comp-skel-line comp-skel-fact" />
            </div>
          </div>
          <div className="comp-skel-tabs">
            <span className="comp-skel-line comp-skel-tab" />
            <span className="comp-skel-line comp-skel-tab" />
            <span className="comp-skel-line comp-skel-tab" />
            <span className="comp-skel-line comp-skel-tab" />
          </div>
          <div className="comp-skel-grid">
            <span className="comp-skel-line comp-skel-aside" />
            <span className="comp-skel-line comp-skel-panel" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !competition) {
    return (
      <div className="page comp-page">
        <ErrorBox error={error} />
        <div className="comp-error-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void loadCompetition()}>
            Thử lại
          </button>
          <Link className="btn btn-secondary" to="/">
            ← Về danh sách cuộc thi
          </Link>
        </div>
      </div>
    );
  }

  const c = competition;
  // Chip chỉ có nghĩa với cuộc thi đang mở — cuộc thi đã đóng không đếm ngược nữa.
  const countdownLabel = c.status === "published" ? remaining : null;
  const currentPath = pathname.replace(/\/+$/, "");
  const basePath = `/competitions/${slug}`.replace(/\/+$/, "");
  const isOverview = currentPath === basePath || currentPath.startsWith(`${basePath}/content`);

  return (
    <div className="page comp-page">
      <nav className="comp-crumbs" aria-label="Đường dẫn">
        <Link className="comp-crumb-back" to="/">
          <Icon>
            <path d="M19 12H5" />
            <path d="M11 6l-6 6 6 6" />
          </Icon>
          Cuộc thi
        </Link>
      </nav>

      <header className="comp-masthead">
        <div className="comp-badges">
          <span className={`status-badge ${statusClass(c.status)}`}>
            <span className="chip-dot" aria-hidden="true" />
            {STATUS_LABEL[c.status]}
          </span>
          {countdownLabel && (
            <span className="chip">
              <Icon>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </Icon>
              {countdownLabel}
            </span>
          )}
          <span className="chip">{JOIN_MODE_LABEL[c.join_mode]}</span>
        </div>

        <div className="comp-masthead-main">
          <div className="comp-masthead-copy">
            <p className="comp-eyebrow">{c.slug}</p>
            <h1 className="comp-title">{c.name}</h1>
            {c.short_description && <p className="comp-lead">{c.short_description}</p>}
          </div>
          <div className="comp-masthead-actions">
            <JoinControl
              competition={c}
              onMembershipChange={(membership: Membership) => {
                setCompetition({ ...c, membership });
                // Quota chỉ xuất hiện sau khi join — tải lại để chỗ nộp bài biết còn bao nhiêu lượt.
                void refreshCompetition();
              }}
            />
          </div>
        </div>

        <dl className="comp-facts">
          <div className="comp-fact">
            <dt>
              <Icon>
                <rect x="3" y="5" width="18" height="16" rx="2" />
                <path d="M8 3v4M16 3v4M3 11h18" />
              </Icon>
              Thời gian thi đấu
            </dt>
            <dd className="comp-fact-value">
              {formatLocal(c.start_at)} — {formatLocal(c.end_at)}
            </dd>
          </div>
          <div className="comp-fact">
            <dt>
              <Icon>
                <circle cx="12" cy="12" r="8" />
                <circle cx="12" cy="12" r="3.5" />
              </Icon>
              Chỉ số chính
            </dt>
            <dd className="comp-fact-value">{METRIC_LABEL[c.primary_metric]}</dd>
          </div>
          <div className="comp-fact">
            <dt>
              <Icon>
                <path d="M12 16V4" />
                <path d="M8 8l4-4 4 4" />
                <path d="M5 20h14" />
              </Icon>
              Giới hạn nộp bài
            </dt>
            <dd className="comp-fact-value">
              {c.quota_per_day > 0 ? `${c.quota_per_day} lượt/ngày` : "Không nhận bài nộp"}
            </dd>
          </div>
        </dl>
      </header>

      <nav className="comp-tabs" aria-label="Mục lục cuộc thi" role="tablist">
        {TABS.map((tab) => (
          <CompTab key={tab.to} to={tab.to} end={tab.end} label={tab.label} icon={tab.icon} />
        ))}
      </nav>

      <div className={`content-layout${!isOverview ? " is-workspace" : ""}`}>
        {isOverview && (
          <aside className="content-sidebar">
            <section className="content-card content-card-toc">
              <div className="content-card-head">
                <span className="content-card-title">
                  <Icon>
                    <path d="M9 6h11" />
                    <path d="M9 12h11" />
                    <path d="M9 18h11" />
                    <path d="M4.5 6h.01" />
                    <path d="M4.5 12h.01" />
                    <path d="M4.5 18h.01" />
                  </Icon>
                  Mục lục nội dung
                </span>
                {!contentsLoading && !contentsError && contents.length > 0 && (
                  <span className="content-card-count">{contents.length} mục</span>
                )}
              </div>

              {contentsLoading ? (
                <p className="content-nav-state" role="status">
                  Đang tải nội dung…
                </p>
              ) : contentsError ? (
                <div className="content-nav-state" role="alert">
                  <p>Không tải được danh sách nội dung.</p>
                  <button type="button" className="btn btn-secondary" onClick={() => void loadContents()}>
                    Thử lại
                  </button>
                </div>
              ) : contents.length > 0 ? (
                <nav className="content-nav" aria-label="Nội dung cuộc thi">
                  {contents.map((item) => (
                    <NavLink
                      key={item.id}
                      to={`content/${item.slug}`}
                      className={({ isActive }) => `content-nav-item${isActive ? " active" : ""}`}
                    >
                      <span className="content-nav-title">{item.title}</span>
                      {item.visibility === "public" && (
                        <span className="chip">{VISIBILITY_LABEL[item.visibility]}</span>
                      )}
                    </NavLink>
                  ))}
                </nav>
              ) : (
                <p className="content-nav-state">Ban Tổ chức chưa đăng nội dung cho cuộc thi này.</p>
              )}
            </section>

            <CompetitionResources resources={c.resources} />
          </aside>
        )}

        <div className={`card comp-body${!isOverview ? " comp-body-workspace" : ""}`}>
          <Outlet
            context={
              {
                competition: c,
                contents,
                contentsLoading,
                contentsError,
                reloadContents: loadContents,
                refreshCompetition,
              } satisfies CompetitionContext
            }
          />
        </div>
      </div>
    </div>
  );
}

/** Tab điều hướng dạng pill; tự tính active để đặt được aria-selected (NavLink không cho set). */
function CompTab({
  to,
  end,
  label,
  icon,
}: {
  to: string;
  end: boolean;
  label: string;
  icon: React.ReactNode;
}) {
  const path = useResolvedPath(to);
  const { pathname } = useLocation();
  const currentPath = pathname.replace(/\/+$/, "");
  const targetPath = path.pathname.replace(/\/+$/, "");

  const isOverviewTab = to === "." || to === "";
  const isActive = isOverviewTab
    ? currentPath === targetPath || currentPath.startsWith(`${targetPath}/content`)
    : currentPath === targetPath || (!end && currentPath.startsWith(`${targetPath}/`));

  return (
    <Link
      to={to}
      role="tab"
      aria-selected={isActive}
      className={`comp-tab${isActive ? " active" : ""}`}
    >
      <Icon>{icon}</Icon>
      {label}
    </Link>
  );
}
