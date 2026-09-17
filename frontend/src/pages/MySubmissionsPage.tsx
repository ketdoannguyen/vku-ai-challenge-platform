import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { formatLocal } from "../api/competitions";
import {
  fetchMySubmissions,
  formatScore,
  type SubmissionsResponse,
} from "../api/results";
import { ErrorBox, Loading } from "../components/ui";
import type { CompetitionContext } from "./CompetitionDetailPage";

const PAGE_SIZE = 50;
const STATUS_LABEL: Record<string, string> = {
  completed: "Đã chấm điểm",
  rejected: "Không hợp lệ",
  failed: "Lỗi chấm điểm",
};

export function MySubmissionsPage() {
  const { competition } = useOutletContext<CompetitionContext>();
  const [data, setData] = useState<SubmissionsResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [, setCopiedId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchMySubmissions(competition.id, PAGE_SIZE, offset);
      setData(result);
    } catch (reason) {
      setError(reason);
    } finally {
      setLoading(false);
    }
  }, [competition.id, offset]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  function copyId(id: string) {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  }

  if (loading) return <Loading label="Đang tải lịch sử bài nộp..." />;
  if (error) {
    return (
      <section className="results-page subm-page">
        <ErrorBox error={error} />
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-secondary" onClick={() => void loadData()}>
            Thử lại
          </button>
        </div>
      </section>
    );
  }
  if (!data?.submissions.length) {
    return (
      <section className="results-page subm-page">
        <div className="subm-head results-head">
          <div className="subm-head-copy">
            <h2 className="subm-title">Bài đã nộp</h2>
            <p className="subm-lead text-muted">Lịch sử của riêng bạn, mới nhất hiển thị trước.</p>
          </div>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <p>Bạn chưa có bài nộp nào.</p>
          <p className="text-muted">Nộp bài đầu tiên để thấy kết quả tại đây.</p>
          <Link to="../submit" className="btn">
            Nộp bài
          </Link>
        </div>
      </section>
    );
  }

  // Xác định submission có primary_score cao nhất trong trang hiện tại
  const bestSubmissionId = data.submissions.reduce<string | null>((bestId, current) => {
    if (current.status !== "completed" || typeof current.primary_score !== "number") {
      return bestId;
    }
    if (!bestId) return current.id;
    const bestScore =
      data.submissions.find((s) => s.id === bestId)?.primary_score ?? -Infinity;
    return current.primary_score > bestScore ? current.id : bestId;
  }, null);

  const bestScoreVal = bestSubmissionId
    ? data.submissions.find((s) => s.id === bestSubmissionId)?.primary_score
    : null;

  return (
    <section className="results-page subm-page">
      {/* Tiêu đề trang và tóm tắt */}
      <div className="subm-head results-head">
        <div className="subm-head-copy">
          <div className="subm-eyebrow">
            <span>Lịch sử đánh giá</span>
            <span>•</span>
            <span style={{ color: "var(--palette-data-blue)" }}>
              {competition.slug}
            </span>
          </div>
          <h2 className="subm-title">Bài đã nộp</h2>
          <p className="subm-lead text-muted">
            Lịch sử của riêng bạn, mới nhất hiển thị trước.
          </p>
        </div>

        <div className="subm-telemetry-badge">
          <div className="subm-telemetry-item">
            <span className="subm-telemetry-label">Hạn ngạch</span>
            <span className="subm-telemetry-val">{competition.quota_per_day} lượt/ngày</span>
          </div>
          <div className="subm-telemetry-divider" />
          <div className="subm-telemetry-item">
            <span className="subm-telemetry-label">Trạng thái</span>
            <span className="subm-telemetry-val" style={{ color: "#15803d" }}>
              Tự động chấm điểm
            </span>
          </div>
        </div>
      </div>

      {/* Toolbar tóm tắt & thao tác */}
      <div className="subm-toolbar">
        <div className="subm-summary-pills">
          <span>
            Tổng cộng <strong>{data.total}</strong> bài nộp
          </span>
          {bestScoreVal != null && (
            <>
              <span>•</span>
              <span className="flex items-center gap-1">
                <span>Điểm cao nhất trong trang:</span>
                <strong className="subm-summary-score">
                  {formatScore(bestScoreVal)}
                </strong>
              </span>
            </>
          )}
        </div>

        <div className="subm-toolbar-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm flex items-center gap-1.5"
            onClick={() => void loadData()}
            title="Tải lại danh sách bài nộp"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            <span>Làm mới</span>
          </button>
          <Link to="../submit" className="btn btn-sm flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Nộp bài mới</span>
          </Link>
        </div>
      </div>

      {/* Bảng 7 cột kết quả */}
      <div className="subm-table-wrap table-wrap">
        <table className="subm-table table results-table">
          <thead>
            <tr>
              <th scope="col" style={{ width: "24%" }}>Submission / thời gian</th>
              <th scope="col" style={{ width: "22%" }}>File</th>
              <th scope="col" style={{ width: "16%" }}>Trạng thái</th>
              <th scope="col" style={{ width: "10%", textAlign: "right" }}>F1</th>
              <th scope="col" style={{ width: "10%", textAlign: "right" }}>Precision</th>
              <th scope="col" style={{ width: "10%", textAlign: "right" }}>Recall</th>
              <th scope="col" style={{ width: "14%", textAlign: "right" }}>Điểm chính</th>
            </tr>
          </thead>
          <tbody>
            {data.submissions.map((submission) => {
              const isBest = submission.id === bestSubmissionId;
              return (
                <tr key={submission.id} className={isBest ? "best-submission-row" : undefined}>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="subm-id-pill submission-id">
                        #{submission.id.slice(-8)}
                        <button
                          type="button"
                          className="subm-id-copy-btn"
                          title="Sao chép ID"
                          aria-label="Sao chép ID"
                          onClick={() => copyId(submission.id)}
                        >
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </button>
                      </span>
                      {isBest && (
                        <span className="subm-badge-best">
                          <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                          </svg>
                          Tốt nhất
                        </span>
                      )}
                    </div>
                    <span className="cell-secondary">{formatLocal(submission.created_at)}</span>
                  </td>
                  <td className="filename-cell">
                    <div className="flex items-center gap-1.5">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, color: "var(--palette-secondary)" }}>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <span title={submission.filename}>{submission.filename}</span>
                    </div>
                  </td>
                  <td>
                    <span
                      className={`status-badge ${
                        submission.status === "completed" ? "success" : "danger"
                      }`}
                    >
                      {STATUS_LABEL[submission.status] ?? submission.status}
                    </span>
                    {submission.error && (
                      <span className="cell-error">{submission.error.message}</span>
                    )}
                  </td>
                  <td className="subm-score-cell score-cell">
                    {formatScore(submission.metrics?.f1)}
                  </td>
                  <td className="subm-score-cell score-cell">
                    {formatScore(submission.metrics?.precision)}
                  </td>
                  <td className="subm-score-cell score-cell">
                    {formatScore(submission.metrics?.recall)}
                  </td>
                  <td className="subm-primary-score-cell score-cell primary-score">
                    {formatScore(submission.primary_score)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Phân trang */}
      {data.total > PAGE_SIZE && (
        <div className="subm-pagination-footer pagination pagination-controls">
          <div>
            Hiển thị <strong>{offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)}</strong> trong số <strong>{data.total}</strong> bài nộp
          </div>
          <div className="flex items-center gap-2">
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
        </div>
      )}

      {/* Notice cards quy chế và tính điểm (§6) */}
      <div className="subm-notice-grid">
        <div className="subm-notice-card">
          <div className="subm-notice-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <div>
            <h3 className="subm-notice-title">Quy chế lưu trữ &amp; Toàn vẹn dữ liệu (§6)</h3>
            <p className="subm-notice-text">
              Bài nộp được lưu trữ vĩnh viễn trên Sandbox của Ban Tổ chức và không thể tải lại hoặc xóa theo quy chế thi.
            </p>
          </div>
        </div>

        <div className="subm-notice-card">
          <div className="subm-notice-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          </div>
          <div>
            <h3 className="subm-notice-title">Cơ chế tính điểm tự động</h3>
            <p className="subm-notice-text">
              Điểm số hiển thị được tính toán ngay khi nộp đối chiếu với tập Public Test. Bài nộp có điểm chính cao nhất được dùng để xếp hạng.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
