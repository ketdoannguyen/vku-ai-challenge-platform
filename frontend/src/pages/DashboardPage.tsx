/** Dashboard participant: danh sách competition đang mở/đã kết thúc (draft luôn ẩn ở backend). */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { Competition, CompetitionsResponse, Membership } from "../api/competitions";
import { STATUS_LABEL, formatLocal, statusClass } from "../api/competitions";
import { ErrorBox, Loading } from "../components/ui";
import { JoinControl } from "../components/JoinControl";

export function DashboardPage() {
  const [data, setData] = useState<CompetitionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
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

  if (loading) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <h1 className="page-title">Cuộc thi</h1>
            <p className="page-subtitle">Các cuộc thi bạn có thể tham gia</p>
          </div>
        </div>
        <Loading />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Cuộc thi</h1>
          <p className="page-subtitle">Các cuộc thi bạn có thể tham gia</p>
        </div>
      </div>

      <ErrorBox error={error} />
      {data && data.competitions.length > 0 ? (
        <div className="comp-list">
          {data.competitions.map((c) => (
            <CompetitionCard
              key={c.id}
              competition={c}
              onJoined={(slug, membership) =>
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
      ) : !error ? (
        <div className="card empty-state">
          <div className="empty-state-icon" aria-hidden>
            🏆
          </div>
          <h2>Chưa có cuộc thi nào</h2>
          <p>Các cuộc thi sẽ xuất hiện tại đây khi được BTC mở.</p>
        </div>
      ) : null}
    </div>
  );
}

function CompetitionCard({
  competition,
  onJoined,
}: {
  competition: Competition;
  onJoined: (slug: string, membership: Membership) => void;
}) {
  const c = competition;
  return (
    <div className="card comp-card">
      <div className="comp-card-head">
        <h2 className="comp-card-title">{c.name}</h2>
        <span className={`status-badge ${statusClass(c.status)}`}>{STATUS_LABEL[c.status]}</span>
      </div>
      {c.short_description && <p className="comp-card-desc">{c.short_description}</p>}
      <dl className="comp-meta">
        <div className="comp-meta-item">
          <dt>Bắt đầu</dt>
          <dd>{formatLocal(c.start_at)}</dd>
        </div>
        <div className="comp-meta-item">
          <dt>Kết thúc</dt>
          <dd>{formatLocal(c.end_at)}</dd>
        </div>
      </dl>
      <div className="comp-card-footer">
        <JoinControl
          competition={c}
          onJoined={(membership) => onJoined(c.slug, membership)}
        />
      </div>
    </div>
  );
}
