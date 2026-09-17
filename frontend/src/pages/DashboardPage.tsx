/** Dashboard participant: danh sách competition đang mở/đã kết thúc (draft luôn ẩn ở backend). */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import type { Competition, CompetitionsResponse, Membership } from "../api/competitions";
import {
  JOIN_MODE_LABEL,
  METRIC_LABEL,
  STATUS_LABEL,
  formatLocal,
  statusClass,
} from "../api/competitions";
import { Loading } from "../components/ui";
import { JoinControl } from "../components/JoinControl";
import { useOptionalAuth } from "../auth/AuthContext";

type StatusFilter = "all" | "published" | "closed";

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "published", label: "Đang diễn ra" },
  { id: "closed", label: "Đã kết thúc" },
];

const DAY_MS = 86_400_000;

/** Đếm ngược từ end_at; quá hạn trả null để không hiện chip. */
function countdown(endAt: string): string | null {
  const remaining = new Date(endAt).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const days = Math.floor(remaining / DAY_MS);
  if (days >= 1) return `còn ${days} ngày`;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `còn ${pad(Math.floor(remaining / 3_600_000))}:${pad(
    Math.floor((remaining % 3_600_000) / 60_000),
  )}:${pad(Math.floor((remaining % 60_000) / 1000))}`;
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

export function DashboardPage() {
  const auth = useOptionalAuth();
  const [data, setData] = useState<CompetitionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");

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

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (competitions ?? []).filter((item) => {
      if (filter !== "all" && item.status !== filter) return false;
      return needle === "" || item.name.toLowerCase().includes(needle);
    });
  }, [competitions, filter, query]);

  // Ngoài AuthProvider (test dựng component lẻ) coi như không phải khách để giữ hành vi cũ.
  const isGuest = auth !== null && !auth.loading && auth.account === null;
  const activeCount = (competitions ?? []).filter((item) => item.status === "published").length;
  const closedCount = (competitions ?? []).filter((item) => item.status === "closed").length;
  const joinedCount = (competitions ?? []).filter((item) => item.membership.active).length;

  const errorMessage = error instanceof Error ? error.message : "Đã xảy ra lỗi không xác định.";
  const errorCode = error instanceof ApiClientError ? error.code : null;

  return (
    <div className="page dash-page">
      <section className="dash-hero">
        <div className="dash-hero-top">
          <div className="dash-hero-copy">
            <h1 className="dash-title">Cuộc thi</h1>
            <p className="dash-subtitle">Các cuộc thi bạn có thể tham gia</p>
          </div>
          <div className="dash-stats">
            <div className="dash-stat">
              <span className="dash-stat-label">Đang diễn ra</span>
              <span className="dash-stat-value">{String(activeCount).padStart(2, "0")}</span>
            </div>
            <span className="dash-stat-divider" aria-hidden="true" />
            <div className="dash-stat">
              <span className="dash-stat-label">Đã kết thúc</span>
              <span className="dash-stat-value">{String(closedCount).padStart(2, "0")}</span>
            </div>
            {/* Khách chưa có membership nào nên ô này luôn 00 — chỉ tổ rối. */}
            {!isGuest && (
              <>
                <span className="dash-stat-divider" aria-hidden="true" />
                <div className="dash-stat">
                  <span className="dash-stat-label">Đã tham gia</span>
                  <span className="dash-stat-value">{String(joinedCount).padStart(2, "0")}</span>
                </div>
              </>
            )}
          </div>
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
          </div>
          <p className="dash-count">Hiển thị {filtered.length} cuộc thi</p>
        </div>
      </section>

      {loading ? (
        <Loading />
      ) : error ? (
        <div className="form-error dash-error" role="alert">
          <IconError />
          <div>
            <p>{errorMessage}</p>
            {errorCode && <p className="form-error-code">{errorCode}</p>}
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => void load()}>
            Thử lại
          </button>
        </div>
      ) : competitions && competitions.length > 0 ? (
        <div className="comp-list">
          {filtered.map((competition) => (
            <CompetitionCard
              key={competition.id}
              competition={competition}
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
      ) : (
        <div className="card empty-state">
          <div className="empty-state-icon" aria-hidden>
            🏆
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
  onJoined,
}: {
  competition: Competition;
  onJoined: (slug: string, membership: Membership) => void;
}) {
  const c = competition;
  const remaining = c.status === "published" ? countdown(c.end_at) : null;

  return (
    <article className={`card comp-card ${statusClass(c.status)}`}>
      <div className="comp-card-main">
        {/* Trạng thái là điểm nổi bật của thẻ nên đứng cạnh tiêu đề, không lẫn vào
            hàng chip phụ. `statusClass` dùng chung cho cả thanh màu mép trái. */}
        <div className="comp-card-head">
          <h2 className="comp-card-title">
            <Link to={`/competitions/${c.slug}`}>{c.name}</Link>
          </h2>
          <span className={`status-badge status-badge-lg ${statusClass(c.status)}`}>
            <span className="chip-dot" aria-hidden="true" />
            {STATUS_LABEL[c.status]}
          </span>
        </div>

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
        <JoinControl competition={c} onJoined={(membership) => onJoined(c.slug, membership)} />
      </div>
    </article>
  );
}
