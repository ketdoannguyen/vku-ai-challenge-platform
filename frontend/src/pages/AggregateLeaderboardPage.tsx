/**
 * Trang bảng xếp hạng tổng hợp cho thí sinh: header cấu hình nguồn, tab Public/Private khi có
 * nguồn dual, bảng phân trang và dải hạng của người xem.
 *
 * Bảng làm mới ngầm cả khi đang chờ để tự mở lúc nguồn sẵn sàng; mất quyền (401/403/404) thì bỏ
 * dữ liệu đang giữ và dừng vòng làm mới thay vì hiện điểm cũ.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  fetchAggregateLeaderboard,
  shortName,
  weightPercent,
  type AggregateLeaderboard,
} from "../api/aggregates";
import { ApiClientError } from "../api/client";
import { TRACKS, TRACK_LABEL, type Track } from "../api/competitions";
import { formatMetric } from "../api/results";
import { AggregateIcon, AggregateTable, AggregateWaiting, sourceName } from "../components/AggregateBoard";
import { AutoRefreshNotice } from "../components/AutoRefreshNotice";
import { ErrorBox, Loading } from "../components/ui";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

const PAGE_SIZE = 25;
const AUTO_REFRESH_MS = 3_000;

/** Mất một trong các trạng thái này là mất quyền xem bảng - dữ liệu đã tải không còn hợp lệ. */
function isRefusal(reason: unknown): boolean {
  return (
    reason instanceof ApiClientError &&
    (reason.status === 401 || reason.status === 403 || reason.status === 404)
  );
}

export function AggregateLeaderboardPage() {
  const { slug = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const view: Track = searchParams.get("view") === "private" ? "private" : "public";
  useDocumentTitle("Bảng xếp hạng tổng hợp");

  const [data, setData] = useState<AggregateLeaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** Bị từ chối truy cập: hiện thẻ riêng thay vì bảng lỗi chung. */
  const [refused, setRefused] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [query, setQuery] = useState({ offset: 0, attempt: 0 });
  const requestSequence = useRef(0);
  const hasData = useRef(false);

  const loadData = useCallback(
    async (nextOffset: number, keepRows: boolean, silent = false) => {
      const sequence = ++requestSequence.current;
      if (!silent) {
        setError(null);
        if (keepRows) setRefreshing(true);
        else setLoading(true);
      }
      try {
        const result = await fetchAggregateLeaderboard(slug, view, PAGE_SIZE, nextOffset);
        // Response cũ không được ghi đè response mới khi người dùng đổi trang hoặc đổi tab.
        if (sequence !== requestSequence.current) return;
        hasData.current = true;
        setData(result);
        setError(null);
        setRefused(null);
        setLastUpdated(new Date().toLocaleTimeString("vi-VN"));
        // `total` co lại có thể làm trang đang xem vượt range: lùi về trang cuối còn dữ liệu.
        const lastOffset = Math.max(0, Math.floor(((result.total ?? 0) - 1) / PAGE_SIZE) * PAGE_SIZE);
        if (result.total !== null && nextOffset > lastOffset) {
          setQuery((current) => ({ offset: lastOffset, attempt: current.attempt + 1 }));
        }
      } catch (reason) {
        if (sequence !== requestSequence.current) return;
        if (isRefusal(reason)) {
          // Quyền xem đã mất giữa chừng: xoá dữ liệu đã tải; lượt làm mới kế tiếp (nếu có) dừng hẳn.
          hasData.current = false;
          setData(null);
          setRefused(reason instanceof Error ? reason.message : "Bạn không còn quyền xem bảng này.");
        } else if (!silent) {
          setError(reason);
        }
        // Lượt ngầm ném lỗi ra ngoài để hook thử lại hoặc dừng hẳn theo mã lỗi.
        if (silent) throw reason;
      } finally {
        if (!silent && sequence === requestSequence.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [slug, view],
  );

  // Đổi tab là đổi hẳn nguồn dữ liệu: bỏ dòng của view cũ và về trang đầu, tránh hiện điểm
  // Public mang nhãn Private.
  useEffect(() => {
    requestSequence.current += 1;
    hasData.current = false;
    setData(null);
    setQuery((current) =>
      current.offset === 0 ? current : { offset: 0, attempt: current.attempt + 1 },
    );
  }, [view]);

  useEffect(() => {
    void loadData(query.offset, hasData.current);
  }, [loadData, query]);

  const requestPage = useCallback((nextOffset: number) => {
    setQuery((current) => ({ offset: Math.max(0, nextOffset), attempt: current.attempt + 1 }));
  }, []);

  /** Làm mới ngầm: không đụng trạng thái tải để bảng không nháy. */
  const silentRefresh = useCallback(async () => {
    await loadData(query.offset, true, true);
  }, [loadData, query.offset]);

  // Chờ nguồn cũng làm mới: đây là cách bảng tự mở khi BTC mở nhánh hoặc công bố kết quả.
  const refreshStatus = useAutoRefresh(refused === null, silentRefresh, {
    intervalMs: AUTO_REFRESH_MS,
  });

  function selectView(next: Track) {
    if (next !== view) setSearchParams({ view: next });
  }

  const header = (
    <header className="page-hero agg-leaderboard-hero">
      <div className="lb-head-top">
        <div className="lb-eyebrow">
          <span>Bảng xếp hạng tổng hợp</span>
          <span>/</span>
          <span className="results-slug">{slug}</span>
        </div>
        {data?.has_private && (
          <div className="dash-filters" role="group" aria-label="Chọn nhánh xếp hạng">
            {TRACKS.map((item) => (
              <button
                key={item}
                type="button"
                className="dash-filter"
                aria-pressed={item === view}
                onClick={() => selectView(item)}
              >
                {TRACK_LABEL[item]}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="page-hero-row">
        <span className="page-hero-icon" aria-hidden="true">
          <AggregateIcon className="page-hero-glyph" />
        </span>
        <div className="page-hero-copy agg-leaderboard-copy">
          <h1 className="page-hero-title">{data?.name ?? "Bảng xếp hạng tổng hợp"}</h1>
          <p className="page-hero-subtitle">
            Thứ hạng được ghép từ điểm các cuộc thi nguồn theo trọng số.
          </p>
          <span className="vku-accent" aria-hidden="true">
            <span className="blue" />
            <span className="red" />
            <span className="yellow" />
          </span>
          {data && (
            <div className="agg-chips">
              {data.sources.map((source) => {
                const full = sourceName(source);
                return (
                  <span key={source.competition_id} className="agg-chip" title={full}>
                    {source.slug ? (
                      <Link className="agg-chip-name" to={`/competitions/${source.slug}`}>
                        {shortName(full)}
                      </Link>
                    ) : (
                      <span className="agg-chip-name">{shortName(full)}</span>
                    )}
                    <span className="agg-chip-meta">
                      {weightPercent(source.weight)}
                      {source.metric_label ? ` · ${source.metric_label}` : ""}
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
        {data && (
          <div className="page-hero-aside lb-head-tools">
            {lastUpdated && (
              <div className="lb-sync-bar">
                <div className="lb-sync-dot" />
                <span>
                  Cập nhật lúc: <strong>{lastUpdated}</strong>
                </span>
              </div>
            )}
            <button
              type="button"
              className="btn btn-sm"
              aria-disabled={loading || refreshing}
              onClick={() => {
                if (!loading && !refreshing) requestPage(data.offset);
              }}
              title="Tải lại bảng điểm"
            >
              Làm mới
            </button>
          </div>
        )}
      </div>
    </header>
  );

  if (refused) {
    return (
      <section className="lb-page">
        {header}
        <div className="lb-locked-card">
          <div className="lb-locked-content">
            <h2 className="lb-locked-title">Bạn không xem được bảng tổng hợp này.</h2>
            <p className="lb-locked-lead">{refused}</p>
            <div className="lb-locked-actions">
              <Link to="/tong-hop" className="btn btn-secondary">
                Về danh sách bảng tổng hợp
              </Link>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // Lần đầu chưa có gì thì vẫn là full loading; các lượt sau bảng cũ ở lại trong DOM.
  if (loading && !data) return <Loading label="Đang tải bảng tổng hợp..." />;
  if (error && !data) {
    return (
      <section className="lb-page">
        <ErrorBox error={error} />
        <div className="results-retry">
          <button type="button" className="btn" onClick={() => requestPage(query.offset)}>
            Thử lại
          </button>
        </div>
      </section>
    );
  }
  if (!data) return null;

  if (data.status === "waiting") {
    return (
      <section className="lb-page">
        {header}
        <AutoRefreshNotice {...refreshStatus} />
        <AggregateWaiting board={data} />
      </section>
    );
  }

  const shownFrom = data.offset + 1;
  const shownTo = Math.min(data.offset + PAGE_SIZE, data.total ?? 0);

  return (
    <section className="lb-page">
      {header}
      <AutoRefreshNotice {...refreshStatus} />

      {/* Lỗi khi đổi trang: giữ nguyên các dòng cũ, chỉ báo lỗi ngay trên bảng. */}
      {Boolean(error) && (
        <>
          <ErrorBox error={error} />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => requestPage(query.offset)}
          >
            Thử lại
          </button>
        </>
      )}

      {data.me && (
        <div className="lb-me-strip" role="status">
          <div className="lb-me-rank-block">
            <span className="lb-me-label">Hạng của bạn</span>
            <span className="lb-me-rank">
              #{data.me.rank}
              <span className="lb-me-total">/{data.total}</span>
            </span>
          </div>
          <dl className="lb-me-facts">
            <div className="lb-me-score">
              <dt>Điểm tổng</dt>
              <dd>{formatMetric(data.me.total_score, 2)}</dd>
            </div>
          </dl>
          {!data.entries.some((entry) => entry.is_current_user) && (
            <p className="lb-me-offpage">Hạng của bạn nằm ngoài trang này.</p>
          )}
        </div>
      )}

      {data.entries.length === 0 ? (
        <div className="empty-state">
          <p>Chưa có kết quả xếp hạng.</p>
          <p className="text-muted">Các cuộc thi nguồn chưa có bài hợp lệ để ghép điểm.</p>
        </div>
      ) : (
        <>
          <AggregateTable board={data} />

          <div className="pagination pagination-controls lb-pagination agg-pagination">
            <div role="status">
              {loading || refreshing ? (
                "Đang cập nhật…"
              ) : (
                <>
                  Đã hiển thị <strong>{shownFrom}–{shownTo}</strong> trong số{" "}
                  <strong>{data.total}</strong> thí sinh
                </>
              )}
            </div>
            <div className="pagination-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                aria-disabled={loading || refreshing || data.offset === 0}
                onClick={() => {
                  if (!loading && !refreshing && data.offset > 0) requestPage(data.offset - PAGE_SIZE);
                }}
              >
                Trang trước
              </button>
              <span>
                {shownFrom}–{shownTo} / {data.total}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                aria-disabled={loading || refreshing || !data.has_more}
                onClick={() => {
                  if (!loading && !refreshing && data.has_more) requestPage(data.offset + PAGE_SIZE);
                }}
              >
                Trang sau
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
