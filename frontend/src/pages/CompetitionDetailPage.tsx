/** Competition detail shell theo slug: header + tab nav. Tab Sprint 04/05 disabled rõ ràng. */

import { useEffect, useState } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { Competition } from "../api/competitions";
import { JOIN_MODE_LABEL, METRIC_LABEL, STATUS_LABEL, formatLocal, statusClass } from "../api/competitions";
import { ErrorBox, Loading } from "../components/ui";

export function CompetitionDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<Competition>(`/competitions/${slug}`)
      .then((c) => {
        if (!cancelled) setCompetition(c);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (loading) {
    return (
      <div className="page">
        <Loading />
      </div>
    );
  }
  if (error) {
    return (
      <div className="page">
        <ErrorBox error={error} />
        <p>
          <Link to="/">← Về danh sách cuộc thi</Link>
        </p>
      </div>
    );
  }
  const c = competition!;
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
      </div>

      <nav className="tab-nav" aria-label="Mục lục cuộc thi" role="tablist">
        <Tab to="." end>
          Tổng quan
        </Tab>
        <Tab to="problem" disabled title="Có từ Sprint 04">
          Đề bài
        </Tab>
        <Tab to="rules" disabled title="Có từ Sprint 04">
          Rules
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

      <div className="card comp-body">
        <h2>Tổng quan</h2>
        <p className="text-muted">
          Trang nội dung tổng quan của cuộc thi sẽ có từ Sprint 04. Hiện tại bạn có thể xem thông tin
          thời gian, cách thức tham gia và giới hạn nộp bài ở trên.
        </p>
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
