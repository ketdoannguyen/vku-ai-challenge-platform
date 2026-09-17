import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { formatLocal, METRIC_LABEL } from "../api/competitions";
import {
  fetchLeaderboard,
  formatScore,
  type LeaderboardResponse,
} from "../api/results";
import { ErrorBox, Loading } from "../components/ui";
import type { CompetitionContext } from "./CompetitionDetailPage";

export function LeaderboardPage() {
  const { competition } = useOutletContext<CompetitionContext>();
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(competition.leaderboard_visible);
  const [error, setError] = useState<unknown>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!competition.leaderboard_visible) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchLeaderboard(competition.id);
      setData(result);
      setLastUpdated(new Date().toLocaleTimeString("vi-VN"));
    } catch (reason) {
      setError(reason);
    } finally {
      setLoading(false);
    }
  }, [competition.id, competition.leaderboard_visible]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // S08b: Chưa công bố bảng xếp hạng (không gọi API)
  if (!competition.leaderboard_visible) {
    return (
      <section className="results-page lb-page">
        <div className="lb-locked-card status-banner warning">
          <div className="lb-locked-cross top-left" aria-hidden="true">+</div>
          <div className="lb-locked-cross top-right" aria-hidden="true">+</div>
          <div className="lb-locked-cross bottom-left" aria-hidden="true">+</div>
          <div className="lb-locked-cross bottom-right" aria-hidden="true">+</div>

          <div className="lb-locked-content">
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

  if (loading) return <Loading label="Đang tải bảng xếp hạng..." />;
  if (error) {
    return (
      <section className="results-page lb-page">
        <ErrorBox error={error} />
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-secondary" onClick={() => void loadData()}>
            Thử lại
          </button>
        </div>
      </section>
    );
  }
  if (!data?.entries.length) {
    return (
      <section className="results-page lb-page">
        <div className="lb-head results-head">
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

  return (
    <section className="results-page lb-page">
      {/* Tiêu đề & giải thích quy tắc tie-break */}
      <div className="lb-head results-head">
        <div className="lb-head-copy">
          <div className="lb-eyebrow">
            <span>Bảng xếp hạng công bố</span>
            <span>/</span>
            <span style={{ color: "var(--palette-data-blue)" }}>
              {competition.slug}
            </span>
          </div>
          <h2 className="lb-title">Bảng xếp hạng</h2>
          <p className="lb-lead text-muted">
            Xếp theo {METRIC_LABEL[data.primary_metric]} tốt nhất; nếu bằng điểm, bài đạt điểm sớm hơn đứng trước.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {lastUpdated && (
            <div className="lb-sync-bar">
              <div className="lb-sync-dot" />
              <span>Cập nhật lúc: <strong>{lastUpdated}</strong></span>
            </div>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm flex items-center gap-1.5"
            onClick={() => void loadData()}
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

      {/* Bảng xếp hạng 7 cột */}
      <div className="lb-table-wrap table-wrap">
        <table className="lb-table table results-table">
          <thead>
            <tr>
              <th scope="col" style={{ width: "80px", textAlign: "center" }}>Hạng</th>
              <th scope="col">Đội / tài khoản</th>
              <th scope="col" style={{ textAlign: "right" }}>Điểm chính</th>
              <th scope="col" style={{ textAlign: "right" }}>F1</th>
              <th scope="col" style={{ textAlign: "right" }}>Precision</th>
              <th scope="col" style={{ textAlign: "right" }}>Recall</th>
              <th scope="col" style={{ textAlign: "right", width: "180px" }}>Đạt lúc</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((entry) => (
              <tr
                key={entry.best_submission_id}
                className={entry.is_current_user ? "current-user-row" : undefined}
              >
                <td style={{ textAlign: "center" }}>
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
                    <span className="lb-user-badge current-user-label">Bạn</span>
                  )}
                </td>
                <td className="score-cell primary-score" style={{ textAlign: "right" }}>
                  {formatScore(entry.primary_score)}
                </td>
                <td className="score-cell" style={{ textAlign: "right" }}>
                  {formatScore(entry.metrics.f1)}
                </td>
                <td className="score-cell" style={{ textAlign: "right" }}>
                  {formatScore(entry.metrics.precision)}
                </td>
                <td className="score-cell" style={{ textAlign: "right" }}>
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
    </section>
  );
}
