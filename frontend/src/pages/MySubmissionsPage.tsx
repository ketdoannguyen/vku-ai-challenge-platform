import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { formatLocal } from "../api/competitions";
import {
  fetchMySubmissions,
  formatScore,
  SUBMISSION_STATUS_LABEL,
  type SubmissionsResponse,
} from "../api/results";
import { ArtifactLinks } from "../components/ArtifactLinks";
import { ErrorBox, Loading } from "../components/ui";
import type { CompetitionContext } from "./CompetitionDetailPage";

const PAGE_SIZE = 50;

export function MySubmissionsPage() {
  const { competition } = useOutletContext<CompetitionContext>();
  const [data, setData] = useState<SubmissionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** Trang đang yêu cầu; `attempt` buộc tải lại cả khi bấm lại đúng trang đó (ví dụ sau lỗi). */
  const [query, setQuery] = useState({ offset: 0, attempt: 0 });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const hasData = useRef(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  /** Giữ bảng cũ trong lúc tải trang mới; chỉ lần đầu chưa có dữ liệu mới hiện full loading. */
  const loadData = useCallback(
    async (nextOffset: number, keepRows: boolean) => {
      const sequence = ++requestSequence.current;
      setError(null);
      if (keepRows) setRefreshing(true);
      else setLoading(true);
      try {
        const result = await fetchMySubmissions(competition.id, PAGE_SIZE, nextOffset);
        // Response cũ không được ghi đè response mới khi người dùng đổi trang liên tục.
        if (sequence !== requestSequence.current) return;
        hasData.current = true;
        setData(result);
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
    [competition.id],
  );

  useEffect(() => {
    void loadData(query.offset, hasData.current);
  }, [loadData, query]);

  /** Đổi trang/làm mới đều đi qua đây để nút đang giữ focus không bị unmount. */
  const requestPage = useCallback((nextOffset: number) => {
    setQuery((current) => ({ offset: Math.max(0, nextOffset), attempt: current.attempt + 1 }));
  }, []);

  /** Lỗi sao chép là chuyện riêng của nút: không được thay bằng lỗi tải dữ liệu hay unmount bảng. */
  function copyId(id: string) {
    if (!navigator.clipboard) {
      setCopiedId(null);
      setCopyError("Trình duyệt không cho phép sao chép tự động - hãy chọn ID và sao chép thủ công.");
      return;
    }
    navigator.clipboard.writeText(id).then(
      () => {
        setCopyError(null);
        setCopiedId(id);
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => {
          setCopiedId(null);
          copyTimer.current = null;
        }, 2000);
      },
      () => {
        setCopiedId(null);
        setCopyError("Không sao chép được ID - hãy chọn ID và sao chép thủ công.");
      },
    );
  }

  const busy = loading || refreshing;

  // Lần đầu chưa có gì thì vẫn là full loading; các lần sau bảng cũ ở lại trong DOM.
  if (loading && !data) return <Loading label="Đang tải lịch sử bài nộp..." />;
  if (error && !data) {
    return (
      <section className="subm-page">
        <ErrorBox error={error} />
        <div className="results-retry">
          <button type="button" className="btn btn-secondary" onClick={() => requestPage(query.offset)}>
            Thử lại
          </button>
        </div>
      </section>
    );
  }
  if (!data?.submissions.length) {
    return (
      <section className="subm-page">
        <div className="subm-head">
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

  // Dải đang hiển thị lấy từ `data` (server echo) nên vẫn khớp với các dòng đang thấy
  // kể cả khi request đổi trang vừa lỗi.
  const shownFrom = data.offset + 1;
  const shownTo = Math.min(data.offset + PAGE_SIZE, data.total);
  const hasNext = data.offset + PAGE_SIZE < data.total;

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
    <section className="subm-page">
      {/* Tiêu đề trang và tóm tắt */}
      <div className="subm-head">
        <div className="subm-head-copy">
          <div className="subm-eyebrow">
            <span>Lịch sử đánh giá</span>
            <span>•</span>
            <span className="results-slug">{competition.slug}</span>
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
            <span className="subm-telemetry-val subm-telemetry-ok">
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
              <span className="subm-summary-best">
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
            className="btn btn-secondary btn-sm"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) requestPage(data.offset);
            }}
            title="Tải lại danh sách bài nộp"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            <span>Làm mới</span>
          </button>
          <Link to="../submit" className="btn btn-sm">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Nộp bài mới</span>
          </Link>
        </div>
      </div>

      {/* Phản hồi sao chép ID sống riêng: không thay lỗi tải dữ liệu và không unmount bảng. */}
      <p className="sr-only" role="status">
        {copiedId ? `Đã sao chép ID ${copiedId}.` : ""}
      </p>
      {copyError && (
        <div className="status-banner warning" role="alert">
          <span>{copyError}</span>
        </div>
      )}

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

      {/* Bảng 7 cột kết quả */}
      <div
        className="subm-table-wrap table-wrap"
        aria-busy={busy}
        tabIndex={0}
        role="region"
        aria-label="Bảng bài đã nộp"
      >
        <table className="subm-table table results-table">
          <thead>
            <tr>
              <th scope="col" className="subm-col-id">Submission / thời gian</th>
              <th scope="col" className="subm-col-file">Tệp đã nộp</th>
              <th scope="col" className="subm-col-status">Trạng thái</th>
              <th scope="col" className="subm-col-num">F1</th>
              <th scope="col" className="subm-col-num">Precision</th>
              <th scope="col" className="subm-col-num">Recall</th>
              <th scope="col" className="subm-col-primary">Điểm chính</th>
            </tr>
          </thead>
          <tbody>
            {data.submissions.map((submission) => {
              const isBest = submission.id === bestSubmissionId;
              return (
                <tr key={submission.id} className={isBest ? "best-submission-row" : undefined}>
                  <td>
                    <div className="subm-id-row">
                      <span className="subm-id-pill submission-id">
                        #{submission.id.slice(-8)}
                        <button
                          type="button"
                          className={`subm-id-copy-btn${copiedId === submission.id ? " copied" : ""}`}
                          title={copiedId === submission.id ? "Đã sao chép" : "Sao chép ID"}
                          aria-label={copiedId === submission.id ? "Đã sao chép ID" : "Sao chép ID"}
                          onClick={() => copyId(submission.id)}
                        >
                          {copiedId === submission.id ? (
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
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
                  <td className="subm-artifact-cell">
                    <ArtifactLinks
                      basePath={`/competitions/${competition.id}/submissions`}
                      submissionId={submission.id}
                      artifacts={submission.artifacts}
                    />
                  </td>
                  <td>
                    <span
                      className={`status-badge ${
                        submission.status === "completed" ? "success" : "danger"
                      }`}
                    >
                      {SUBMISSION_STATUS_LABEL[submission.status]}
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
          <div role="status">
            {busy ? (
              "Đang cập nhật…"
            ) : (
              <>Đã hiển thị <strong>{shownFrom}–{shownTo}</strong> trong số <strong>{data.total}</strong> bài nộp</>
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
            <span>{shownFrom}–{shownTo} / {data.total}</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              aria-disabled={busy || !hasNext}
              onClick={() => {
                if (!busy && hasNext) requestPage(data.offset + PAGE_SIZE);
              }}
            >
              Trang sau
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
