import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
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

  useEffect(() => {
    if (!competition.leaderboard_visible) return;
    let active = true;
    setLoading(true);
    setError(null);
    void fetchLeaderboard(competition.id)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((reason) => {
        if (active) setError(reason);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [competition.id, competition.leaderboard_visible]);

  if (!competition.leaderboard_visible) {
    return <div className="status-banner warning">Bảng xếp hạng hiện chưa được công bố.</div>;
  }
  if (loading) return <Loading label="Đang tải bảng xếp hạng..." />;
  if (error) return <ErrorBox error={error} />;
  if (!data?.entries.length) {
    return <div className="empty-state"><p>Chưa có kết quả xếp hạng.</p></div>;
  }

  return (
    <section className="results-page">
      <div className="results-head">
        <div>
          <h2>Bảng xếp hạng</h2>
          <p className="text-muted">
            Xếp theo {METRIC_LABEL[data.primary_metric]} tốt nhất; nếu bằng điểm, bài đạt điểm sớm hơn đứng trước.
          </p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table results-table">
          <thead>
            <tr>
              <th>Hạng</th>
              <th>Đội / tài khoản</th>
              <th>Điểm chính</th>
              <th>F1</th>
              <th>Precision</th>
              <th>Recall</th>
              <th>Đạt lúc</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((entry) => (
              <tr key={entry.best_submission_id} className={entry.is_current_user ? "current-user-row" : undefined}>
                <td className="rank-cell">{entry.rank}</td>
                <td className="name-cell">
                  {entry.display_name}
                  {entry.is_current_user && <span className="current-user-label">Bạn</span>}
                </td>
                <td className="score-cell primary-score">{formatScore(entry.primary_score)}</td>
                <td className="score-cell">{formatScore(entry.metrics.f1)}</td>
                <td className="score-cell">{formatScore(entry.metrics.precision)}</td>
                <td className="score-cell">{formatScore(entry.metrics.recall)}</td>
                <td>{formatLocal(entry.best_submission_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
