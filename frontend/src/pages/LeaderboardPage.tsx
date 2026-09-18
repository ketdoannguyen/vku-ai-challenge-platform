import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { formatLocal, METRIC_LABEL } from "../api/competitions";
import {
  fetchLeaderboard,
  formatScore,
  type ParticipantLeaderboardResponse,
} from "../api/results";
import { ErrorBox, Loading } from "../components/ui";
import type { CompetitionContext } from "./CompetitionDetailPage";

/** Số dòng mỗi trang; backend chặn 1–200 nên đây chỉ là lựa chọn hiển thị. */
const PAGE_SIZE = 25;

export function LeaderboardPage() {
  const { competition } = useOutletContext<CompetitionContext>();
  const [data, setData] = useState<ParticipantLeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(competition.leaderboard_visible);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  /** Trang đang yêu cầu; `attempt` buộc tải lại cả khi bấm lại đúng trang đó (ví dụ sau lỗi). */
  const [query, setQuery] = useState({ offset: 0, attempt: 0 });
  const requestSequence = useRef(0);
  const hasData = useRef(false);

  /** Giữ bảng cũ trong lúc tải trang mới; chỉ lần đầu chưa có dữ liệu mới hiện full loading. */
  const loadData = useCallback(
    async (nextOffset: number, keepRows: boolean) => {
      if (!competition.leaderboard_visible) return;
      const sequence = ++requestSequence.current;
      setError(null);
      if (keepRows) setRefreshing(true);
      else setLoading(true);
      try {
        const result = await fetchLeaderboard(competition.id, PAGE_SIZE, nextOffset);
        // Response cũ không được ghi đè response mới khi người dùng đổi trang liên tục.
        if (sequence !== requestSequence.current) return;
        hasData.current = true;
        setData(result);
        setLastUpdated(new Date().toLocaleTimeString("vi-VN"));
        // total co lại có thể làm trang đang xem vượt range: lùi về trang cuối còn dữ liệu.
        const lastOffset = Math.max(0, Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE);
        if (nextOffset > lastOffset) {
          setQuery((current) => ({ offset: lastOffset, attempt: current.attempt + 1 }));
        }
      } catch (reason) {
        if (sequence === requestSequence.current) setError(reason);
      } finally {
        if (sequence === requestSequence.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [competition.id, competition.leaderboard_visible],
  );

  useEffect(() => {
    void loadData(query.offset, hasData.current);
  }, [loadData, query]);

  /** Đổi trang/làm mới đều đi qua đây để nút đang giữ focus không bị unmount. */
  const requestPage = useCallback((nextOffset: number) => {
    setQuery((current) => ({ offset: Math.max(0, nextOffset), attempt: current.attempt + 1 }));
  }, []);

  const busy = loading || refreshing;

  // S08b: Chưa công bố bảng xếp hạng (không gọi API)
  if (!competition.leaderboard_visible) {
    return (
      <section className="lb-page">
        <div className="lb-locked-card">
          <div className="lb-locked-content">
            <span className="vku-accent" aria-hidden="true">
              <span className="blue" />
              <span className="red" />
              <span className="yellow" />
            </span>

            <div className="lb-locked-emblem" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.75">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>

            <h2 className="lb-locked-title">Bảng xếp hạng hiện chưa được công bố.</h2>
            <p className="lb-locked-lead">
              Ban Tổ chức sẽ công bố sau khi cuộc thi kết thúc.
            </p>

            <div className="lb-locked-divider" />

            <div className="lb-locked-bento">
              <div className="lb-locked-tile">
                <div>
                  <div className="lb-locked-tile-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                  </div>
                  <div className="lb-locked-tile-tag">Sandbox Chấm điểm</div>
                  <p className="lb-locked-tile-text">
                    Điểm số các bài nộp của bạn vẫn được tính toán và lưu vết an toàn trong hệ thống.
                  </p>
                </div>
              </div>

              <div className="lb-locked-tile">
                <div>
                  <div className="lb-locked-tile-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </div>
                  <div className="lb-locked-tile-tag">Theo dõi cá nhân</div>
                  <p className="lb-locked-tile-text">
                    Bạn có thể theo dõi toàn bộ kết quả bài nộp của mình tại trang Bài đã nộp.
                  </p>
                </div>
              </div>

              <div className="lb-locked-tile">
                <div>
                  <div className="lb-locked-tile-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                      <line x1="16" y1="2" x2="16" y2="6" />
                      <line x1="8" y1="2" x2="8" y2="6" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                  </div>
                  <div className="lb-locked-tile-tag">Công bố kết quả</div>
                  <p className="lb-locked-tile-text">
                    Bảng xếp hạng sẽ được mở công khai sau khi hết thời hạn nhận bài thi.
                  </p>
                </div>
              </div>
            </div>

            <div className="lb-locked-actions">
              <Link to="../submissions" className="btn btn-secondary">
                Xem bài đã nộp
              </Link>
              <Link to="../submit" className="btn">
                Nộp bài mới
              </Link>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // Lần đầu chưa có gì thì vẫn là full loading; các lần sau bảng cũ ở lại trong DOM.
  if (loading && !data) return <Loading label="Đang tải bảng xếp hạng..." />;
  if (error && !data) {
    return (
      <section className="lb-page">
        <ErrorBox error={error} />
        <div className="results-retry">
          <button type="button" className="btn btn-secondary" onClick={() => requestPage(query.offset)}>
            Thử lại
          </button>
        </div>
      </section>
    );
  }
  // Chỉ total = 0 mới thật sự là "chưa có kết quả"; trang rỗng vì offset quá xa là chuyện khác.
  if (!data || data.total === 0) {
    return (
      <section className="lb-page">
        <div className="lb-head">
          <div className="lb-head-copy">
            <h2 className="lb-title">Bảng xếp hạng</h2>
            <p className="lb-lead text-muted">
              Xếp theo {METRIC_LABEL[competition.primary_metric]} tốt nhất; nếu bằng điểm, bài đạt điểm sớm hơn đứng trước.
            </p>
          </div>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 20V10M12 20V4M20 20v-6" />
            </svg>
          </div>
          <p>Chưa có kết quả xếp hạng.</p>
          <p className="text-muted">Hãy là người đầu tiên ghi điểm.</p>
          <Link to="../submit" className="btn">
            Nộp bài
          </Link>
        </div>
      </section>
    );
  }

  // Dải đang hiển thị lấy từ `data` (server echo) nên vẫn khớp với các dòng đang thấy
  // kể cả khi request đổi trang vừa lỗi.
  const shownFrom = data.offset + 1;
  const shownTo = Math.min(data.offset + PAGE_SIZE, data.total);

  return (
    <section className="lb-page">
      {/* Tiêu đề & giải thích quy tắc tie-break */}
      <div className="lb-head">
        <div className="lb-head-copy">
          <div className="lb-eyebrow">
            <span>Bảng xếp hạng công bố</span>
            <span>/</span>
            <span className="results-slug">{competition.slug}</span>
          </div>
          <h2 className="lb-title">Bảng xếp hạng</h2>
          <p className="lb-lead text-muted">
            Xếp theo {METRIC_LABEL[data.primary_metric]} tốt nhất; nếu bằng điểm, bài đạt điểm sớm hơn đứng trước.
          </p>
        </div>

        <div className="lb-head-tools">
          {lastUpdated && (
            <div className="lb-sync-bar">
              <div className="lb-sync-dot" />
              <span>Cập nhật lúc: <strong>{lastUpdated}</strong></span>
            </div>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) requestPage(data.offset);
            }}
            title="Tải lại bảng điểm"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            <span>Làm mới</span>
          </button>
        </div>
      </div>

      {/* Lỗi khi đổi trang: giữ nguyên các dòng cũ, chỉ báo lỗi ngay trên bảng. */}
      {Boolean(error) && (
        <>
          <ErrorBox error={error} />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => requestPage(query.offset)}
          >
            Thử lại
          </button>
        </>
      )}

      {/* Hạng toàn cục của người xem: backend tìm trên toàn bộ danh sách nên vẫn đúng khi ngoài trang. */}
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
            <div>
              <dt>Điểm chính</dt>
              <dd>{formatScore(data.me.primary_score)}</dd>
            </div>
            <div>
              <dt>Số bài đã nộp</dt>
              <dd>{data.me.total_submissions}</dd>
            </div>
            <div>
              <dt>Đạt lúc</dt>
              <dd>{formatLocal(data.me.best_submission_at)}</dd>
            </div>
          </dl>
          {!data.entries.some((entry) => entry.is_current_user) && (
            <p className="lb-me-offpage">Hạng của bạn nằm ngoài trang này.</p>
          )}
        </div>
      )}

      {data.entries.length === 0 ? (
        <div className="empty-state">
          <p>Trang này không có dữ liệu.</p>
          <p className="text-muted">Kết quả vẫn còn ở các trang trước.</p>
          <button
            type="button"
            className="btn"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) requestPage(Math.max(0, data.offset - PAGE_SIZE));
            }}
          >
            Về trang trước
          </button>
        </div>
      ) : (
      <>
      {/* Bảng xếp hạng 7 cột */}
      <div
        className="lb-table-wrap table-wrap"
        aria-busy={busy}
        tabIndex={0}
        role="region"
        aria-label="Bảng xếp hạng"
      >
        <table className="lb-table table results-table">
          <thead>
            <tr>
              <th scope="col" className="lb-col-rank">Hạng</th>
              <th scope="col">Đội / tài khoản</th>
              <th scope="col" className="lb-col-num">Điểm chính</th>
              <th scope="col" className="lb-col-num">F1</th>
              <th scope="col" className="lb-col-num">Precision</th>
              <th scope="col" className="lb-col-num">Recall</th>
              <th scope="col" className="lb-col-time">Đạt lúc</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((entry) => (
              <tr
                key={entry.best_submission_id}
                className={entry.is_current_user ? "current-user-row" : undefined}
              >
                <td className="lb-cell-rank">
                  <div
                    className={`lb-rank-badge ${
                      entry.rank === 1
                        ? "top-1"
                        : entry.rank === 2
                        ? "top-2"
                        : entry.rank === 3
                        ? "top-3"
                        : "standard"
                    }`}
                  >
                    {entry.rank}
                  </div>
                </td>
                <td className="name-cell">
                  <span className="lb-participant-name">
                    {entry.display_name}
                  </span>
                  {entry.is_current_user && (
                    <span className="lb-user-badge">Bạn</span>
                  )}
                </td>
                <td className="score-cell primary-score">
                  {formatScore(entry.primary_score)}
                </td>
                <td className="score-cell">
                  {formatScore(entry.metrics.f1)}
                </td>
                <td className="score-cell">
                  {formatScore(entry.metrics.precision)}
                </td>
                <td className="score-cell">
                  {formatScore(entry.metrics.recall)}
                </td>
                <td className="lb-time-cell">
                  {formatLocal(entry.best_submission_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pagination pagination-controls lb-pagination">
        <div role="status">
          {busy ? (
            "Đang cập nhật…"
          ) : (
            <>Đã hiển thị <strong>{shownFrom}–{shownTo}</strong> trong số <strong>{data.total}</strong> thí sinh có điểm</>
          )}
        </div>
        <div className="pagination-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-disabled={busy || data.offset === 0}
            onClick={() => {
              if (!busy && data.offset > 0) requestPage(data.offset - PAGE_SIZE);
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
            aria-disabled={busy || !data.has_more}
            onClick={() => {
              if (!busy && data.has_more) requestPage(data.offset + PAGE_SIZE);
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
