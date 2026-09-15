/** Competition layout: header + membership + content sidebar + nested routes. */

import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { Competition, Membership } from "../api/competitions";
import { JOIN_MODE_LABEL, METRIC_LABEL, STATUS_LABEL, formatLocal, statusClass } from "../api/competitions";
import { fetchContents, type ContentSummary } from "../api/contents";
import { ErrorBox, Loading } from "../components/ui";
import { JoinControl } from "../components/JoinControl";

export interface CompetitionContext {
  competition: Competition;
  contents: ContentSummary[];
}

export function CompetitionDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [contents, setContents] = useState<ContentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const comp = await api.get<Competition>(`/competitions/${slug}`);
      setCompetition(comp);
      try {
        const contentData = await fetchContents(slug!);
        setContents(contentData.contents);
      } catch {
        setContents([]);
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

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
          <Link to="/">← Về danh sách cuộc thi</Link>
        </p>
      </div>
    );
  }

  const c = competition;
  return (
    <div className="page">
      <p>
        <Link className="back-link" to="/">
          ← Cuộc thi
        </Link>
      </p>
      <div className="card comp-header">
        <div className="comp-header-top">
          <h1 className="page-title">{c.name}</h1>
          <span className={`status-badge ${statusClass(c.status)}`}>{STATUS_LABEL[c.status]}</span>
        </div>
        {c.short_description && <p className="page-subtitle comp-header-desc">{c.short_description}</p>}
        <dl className="comp-meta">
          <div className="comp-meta-item">
            <dt>Thời gian</dt>
            <dd>
              {formatLocal(c.start_at)} — {formatLocal(c.end_at)}
            </dd>
          </div>
          <div className="comp-meta-item">
            <dt>Tham gia</dt>
            <dd>{JOIN_MODE_LABEL[c.join_mode]}</dd>
          </div>
          <div className="comp-meta-item">
            <dt>Chỉ số chính</dt>
            <dd>{METRIC_LABEL[c.primary_metric]}</dd>
          </div>
          <div className="comp-meta-item">
            <dt>Giới hạn nộp bài</dt>
            <dd>{c.quota_per_day} lượt/ngày</dd>
          </div>
        </dl>
        <div className="comp-header-join">
          <JoinControl
            competition={c}
            onJoined={(membership: Membership) => setCompetition({ ...c, membership })}
          />
        </div>
      </div>

      <nav className="tab-nav" aria-label="Mục lục cuộc thi" role="tablist">
        <Tab to="." end>
          Tổng quan
        </Tab>
        <Tab to="submit" disabled title="Có từ Sprint 05">
          Nộp bài
        </Tab>
        <Tab to="submissions" disabled title="Có từ Sprint 05">
          Submissions
        </Tab>
        <Tab to="leaderboard" disabled title="Có từ Sprint 06">
          Leaderboard
        </Tab>
      </nav>

      <div className="content-layout">
        <aside className="content-sidebar">
          <div className="content-sidebar-title">Nội dung</div>
          {contents.length > 0 ? (
            <nav className="content-nav" aria-label="Nội dung cuộc thi">
              {contents.map((item) => (
                <NavLink
                  key={item.id}
                  to={`content/${item.slug}`}
                  className={({ isActive }) => `content-nav-item${isActive ? " active" : ""}`}
                >
                  {item.title}
                  {item.visibility === "members" && <span className="visibility-tag">members</span>}
                </NavLink>
              ))}
            </nav>
          ) : (
            <p className="text-muted" style={{ padding: "4px 10px", margin: 0, fontSize: 13 }}>
              Chưa có nội dung.
            </p>
          )}
        </aside>
        <div className="card comp-body">
          <Outlet context={{ competition: c, contents } satisfies CompetitionContext} />
        </div>
      </div>
    </div>
  );
}

function Tab({
  to,
  end = false,
  disabled = false,
  title,
  children,
}: {
  to: string;
  end?: boolean;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span className="tab-link disabled" role="tab" aria-disabled="true" title={title}>
        {children}
      </span>
    );
  }
  return (
    <NavLink to={to} end={end} role="tab" className={({ isActive }) => `tab-link${isActive ? " active" : ""}`}>
      {children}
    </NavLink>
  );
}
