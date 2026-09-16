import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { formatLocal } from "../api/competitions";
import {
  fetchMySubmissions,
  formatScore,
  type SubmissionsResponse,
} from "../api/results";
import { ErrorBox, Loading } from "../components/ui";
import type { CompetitionContext } from "./CompetitionDetailPage";

const PAGE_SIZE = 50;
const STATUS_LABEL = {
  completed: "Đã chấm",
  rejected: "Bị từ chối",
  failed: "Lỗi",
};

export function MySubmissionsPage() {
  const { competition } = useOutletContext<CompetitionContext>();
  const [data, setData] = useState<SubmissionsResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetchMySubmissions(competition.id, PAGE_SIZE, offset)
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
  }, [competition.id, offset]);

  if (loading) return <Loading label="Đang tải lịch sử bài nộp..." />;
  if (error) return <ErrorBox error={error} />;
  if (!data?.submissions.length) {
    return <div className="empty-state"><p>Bạn chưa có bài nộp nào.</p></div>;
  }

  return (
    <section className="results-page">
      <div className="results-head">
        <div>
          <h2>Bài đã nộp</h2>
          <p className="text-muted">Lịch sử của riêng bạn, mới nhất hiển thị trước.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table results-table">
          <thead>
            <tr>
              <th>Submission / thời gian</th>
              <th>File</th>
              <th>Trạng thái</th>
              <th>F1</th>
              <th>Precision</th>
              <th>Recall</th>
              <th>Điểm chính</th>
            </tr>
          </thead>
          <tbody>
            {data.submissions.map((submission) => (
              <tr key={submission.id}>
                <td>
                  <span className="submission-id">#{submission.id.slice(-8)}</span>
                  <span className="cell-secondary">{formatLocal(submission.created_at)}</span>
                </td>
                <td className="filename-cell">{submission.filename}</td>
                <td>
                  <span className={`status-badge ${submission.status === "completed" ? "success" : "danger"}`}>
                    {STATUS_LABEL[submission.status]}
                  </span>
                  {submission.error && <span className="cell-error">{submission.error.message}</span>}
                </td>
                <td className="score-cell">{formatScore(submission.metrics?.f1)}</td>
                <td className="score-cell">{formatScore(submission.metrics?.precision)}</td>
                <td className="score-cell">{formatScore(submission.metrics?.recall)}</td>
                <td className="score-cell primary-score">{formatScore(submission.primary_score)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.total > PAGE_SIZE && (
        <div className="pagination pagination-controls">
          <button
            className="btn btn-secondary btn-sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Trang trước
          </button>
          <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} / {data.total}</span>
          <button
            className="btn btn-secondary btn-sm"
            disabled={offset + PAGE_SIZE >= data.total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Trang sau
          </button>
        </div>
      )}
    </section>
  );
}
