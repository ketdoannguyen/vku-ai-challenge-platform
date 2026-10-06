import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import {
  AI_PARTICIPANT_DISCLAIMER,
  AI_STATE_LABEL,
  AI_VERDICT_LABEL,
  AI_VERDICT_TONE,
} from "../api/aiReview";
import {
  TRACKS,
  TRACK_LABEL,
  UNPUBLISHED_RESULT_LABEL,
  accessLostReason,
  formatLocal,
  isDual,
  parseTrack,
  unpublishedNote,
  type CompetitionDetail,
  type Track,
} from "../api/competitions";
import {
  fetchMySubmissions,
  formatMetric,
  resultContract,
  SUBMISSION_STATUS_LABEL,
  type SubmissionsResponse,
} from "../api/results";
import {
  ArtifactLinks,
  LazyArtifactViewerModal,
  type ArtifactKind,
  type ArtifactViewerTarget,
} from "../components/ArtifactLinks";
import { ErrorBox, Loading } from "../components/ui";
import { AutoRefreshNotice } from "../components/AutoRefreshNotice";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import {
  currentNormHiddenReason,
  hiddenNormNote,
  PROVISIONAL_NORM_LABEL,
} from "../lib/normalization";
import type { CompetitionContext } from "./CompetitionDetailPage";

const PAGE_SIZE = 50;

/** Nhịp tự làm mới ngầm khi tab đang mở. */
const AUTO_REFRESH_MS = 3_000;

/**
 * Hạn ngạch hiển thị trên thẻ telemetry. Cuộc thi dual không có quota cấp cuộc thi: số phải lấy
 * theo nhánh đang xem, và là quota thật của chính thí sinh nên vẫn hiện dù nhánh đó chưa công bố.
 */
function quotaBadgeValue(competition: CompetitionDetail, track: Track, dual: boolean): string {
  if (!dual) return `${competition.quota_per_day} lượt/ngày`;
  const view = competition.tracks?.[track];
  if (view?.quota) return `Còn ${view.quota.remaining}/${view.quota.per_day} lượt`;
  if (view && view.quota_per_day > 0) return `${view.quota_per_day} lượt/ngày`;
  return "Không nhận bài nộp";
}

export function MySubmissionsPage() {
  const { competition, reportAccessLost } = useOutletContext<CompetitionContext>();
  // Cuộc thi v2 khai báo metric riêng, nên cột chỉ số lấy từ hợp đồng thay vì cố định f1/precision/recall.
  const contract = resultContract(competition.submission_config);
  const primaryMetric = contract.metrics.find((metric) => metric.key === contract.primary_metric);
  const displayMetrics = primaryMetric
    ? [primaryMetric, ...contract.metrics.filter((metric) => metric.key !== contract.primary_metric)]
    : contract.metrics;
  // Dual: endpoint lịch sử cố ý trả cả hai nhánh trong một danh sách nên bộ lọc nhánh là lớp xem
  // trên trang đang tải - đổi nhánh không phát thêm request và không mất dòng đã tải.
  const dual = isDual(competition);
  const [searchParams, setSearchParams] = useSearchParams();
  const track: Track = (dual ? parseTrack(searchParams.get("track")) : null) ?? "public";
  const [data, setData] = useState<SubmissionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** Trang đang yêu cầu; `attempt` buộc tải lại cả khi bấm lại đúng trang đó (ví dụ sau lỗi). */
  const [query, setQuery] = useState({ offset: 0, attempt: 0 });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  /** Tệp đang mở trong trình xem; `null` là đóng. Trang chỉ có một trình xem cho cả bảng. */
  const [viewer, setViewer] = useState<ArtifactViewerTarget | null>(null);
  const requestSequence = useRef(0);
  const hasData = useRef(false);
  /** Số lượt tải do người dùng chủ động đang chạy; lượt ngầm nhường để không tranh chấp. */
  const manualLoads = useRef(0);
  const copyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  /** Giữ bảng cũ trong lúc tải trang mới; chỉ lần đầu chưa có dữ liệu mới hiện full loading. */
  const loadData = useCallback(
    async (nextOffset: number, keepRows: boolean, silent = false) => {
      const sequence = ++requestSequence.current;
      if (!silent) {
        manualLoads.current += 1;
        setError(null);
        if (keepRows) setRefreshing(true);
        else setLoading(true);
      }
      try {
        const result = await fetchMySubmissions(competition.id, PAGE_SIZE, nextOffset);
        // Response cũ không được ghi đè response mới khi người dùng đổi trang liên tục.
        if (sequence !== requestSequence.current) return;
        hasData.current = true;
        setData(result);
        // Lượt ngầm thành công cũng xoá băng lỗi cũ: dữ liệu mới đã về thì lỗi hết đúng.
        setError(null);
        // total co lại có thể làm trang đang xem vượt range: lùi về trang cuối còn dữ liệu.
        const lastOffset = Math.max(0, Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE);
        if (nextOffset > lastOffset) {
          setQuery((current) => ({ offset: lastOffset, attempt: current.attempt + 1 }));
        }
      } catch (reason) {
        if (sequence !== requestSequence.current) return;
        // Quyền đọc vừa mất: nhường shell đóng gate ngay, không giữ lịch sử đã tải trên màn hình.
        const lost = accessLostReason(reason);
        if (lost !== null) {
          hasData.current = false;
          setData(null);
          reportAccessLost(lost);
        } else if (!silent) {
          setError(reason);
        }
        // Chỉ lượt ngầm ném lỗi ra ngoài: hook cần thấy lỗi để thử lại hoặc dừng hẳn.
        if (silent) throw reason;
      } finally {
        if (!silent) {
          manualLoads.current -= 1;
          if (sequence === requestSequence.current) {
            setLoading(false);
            setRefreshing(false);
          }
        }
      }
    },
    [competition.id, reportAccessLost],
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

  /** Mở tệp trong trình xem duy nhất của trang; nút ở dòng nào cũng gọi vào đây. */
  function openViewer(kind: ArtifactKind, submissionId: string, filename: string) {
    setViewer({ kind, submissionId, filename });
  }

  /**
   * Lượt làm mới ngầm: không đụng trạng thái tải để bảng không nháy, và nhường khi
   * người dùng đang bấm nút, đang mở trình xem tệp, hoặc đang bôi đen nội dung.
   */
  const silentRefresh = useCallback(async () => {
    if (manualLoads.current > 0 || viewer) return false;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return false;
    await loadData(query.offset, true, true);
  }, [loadData, query.offset, viewer]);

  // Trang đang mở thì tự cập nhật ngầm; hook tự tạm dừng khi tab bị ẩn.
  const refreshStatus = useAutoRefresh(true, silentRefresh, {
    intervalMs: AUTO_REFRESH_MS,
  });

  /**
   * Đầu trang dùng chung cho nhánh rỗng lẫn bảng dữ liệu: nút đổi nhánh nằm cùng hàng eyebrow
   * như bảng xếp hạng, còn tiêu đề nêu rõ nhánh đang xem.
   */
  const header = (
    <div className="subm-head">
      <div className="subm-head-top">
        <div className="subm-eyebrow">
          <span>Lịch sử đánh giá</span>
          <span>•</span>
          <span className="results-slug">{competition.slug}</span>
        </div>
        {/* Dual: chọn nhánh đang xem. */}
        {dual && (
          <div className="dash-filters" role="group" aria-label="Lọc lịch sử theo nhánh">
            {TRACKS.map((item) => (
              <button
                key={item}
                type="button"
                className="dash-filter"
                aria-pressed={item === track}
                onClick={() => setSearchParams({ track: item })}
              >
                {TRACK_LABEL[item]}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="subm-head-main">
        <div className="subm-head-copy">
          <h2 className="subm-title">Bài đã nộp{dual ? ` ${TRACK_LABEL[track]}` : ""}</h2>
          <p className="subm-lead text-muted">
            Lịch sử của riêng bạn, mới nhất hiển thị trước.
          </p>
        </div>
        <div className="subm-head-side">
          <div className="subm-telemetry-badge">
            <div className="subm-telemetry-item">
              <span className="subm-telemetry-label">
                {dual ? `Hạn ngạch · ${TRACK_LABEL[track]}` : "Hạn ngạch"}
              </span>
              <span className="subm-telemetry-val">{quotaBadgeValue(competition, track, dual)}</span>
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
      </div>
    </div>
  );

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
        {header}
        <AutoRefreshNotice {...refreshStatus} />
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
  // Dual: bộ lọc nhánh chỉ lọc trên trang đang tải; cuộc thi một nhánh giữ nguyên toàn bộ dòng.
  const rows = dual
    ? data.submissions.filter((submission) => submission.track === track)
    : data.submissions;
  /** Nhánh còn lại - lối thoát khi trang đang tải không có dòng nào của nhánh đang xem. */
  const otherTrack: Track = track === "public" ? "private" : "public";
  // Dòng đã chấm nhưng chưa công bố: khác hẳn chưa chấm, lỗi hay điểm 0 nên phải nói riêng.
  const showsHidden = rows.some((submission) => submission.result_visibility === "hidden");
  // Cột AI chỉ có nghĩa khi cuộc thi thật sự công khai kết luận cho thí sinh. Bật AI sau khi đã
  // có bài nộp khiến trang trộn hai loại dòng, nên điều kiện là "có ít nhất một dòng đang xem".
  const showsAi = rows.some((submission) => submission.ai_review);
  // Quyền xem norm đọc từ metadata HIỆN TẠI của nhánh đang xem, không từ payload đã tải: BXH bị
  // tắt giữa chừng thì snapshot còn nằm trong state cũ cũng không được render.
  const normHidden = currentNormHiddenReason(competition, dual ? track : null);
  const hasSnapshotRows = rows.some((submission) => submission.normalization_snapshot);
  // Cùng cách với cột AI: chỉ dựng cột norm khi có dòng mang snapshot VÀ nhánh còn quyền xem.
  const showsNorm = !normHidden && hasSnapshotRows;
  // Có con số vừa bị thu hồi khỏi màn hình thì nói đúng lý do đang chặn thay vì bỏ im lặng.
  const droppedNormNote = normHidden && hasSnapshotRows ? hiddenNormNote(normHidden) : null;

  // Bài tốt nhất trong các dòng đang xem. Chiều so sánh lấy từ hợp đồng kết quả vì có cuộc thi lấy
  // metric nhỏ hơn làm điểm tốt (loss, RMSE), nên "điểm cao là nhất" chỉ đúng một chiều. Bài bị
  // admin từ chối vẫn đã chấm điểm nhưng không còn được tính vào kết quả; bài chưa công bố không
  // mang điểm nên tự rơi khỏi phép chọn - dòng bị ẩn không bao giờ được gắn "Tốt nhất". Cuộc thi
  // xếp hạng theo norm thì bỏ hẳn phép so raw: snapshot của các bài có mẫu số khác nhau, "tốt
  // nhất" ở đây chỉ còn nghĩa với điểm gốc.
  const best = showsNorm ? null : rows.reduce<{ id: string; score: number } | null>(
    (winner, submission) => {
      if (
        submission.status !== "completed" ||
        submission.review?.status === "rejected" ||
        typeof submission.primary_score !== "number"
      ) {
        return winner;
      }
      const score = submission.primary_score;
      if (winner === null) return { id: submission.id, score };
      const better = contract.higher_is_better ? score > winner.score : score < winner.score;
      return better ? { id: submission.id, score } : winner;
    },
    null,
  );
  const bestSubmissionId = best?.id ?? null;
  const bestScoreVal = best?.score ?? null;

  // Số thập phân của điểm tốt nhất phải theo metric chính trong hợp đồng; hợp đồng chưa chọn metric
  // chính thì giữ mức 4 của hợp đồng v1 để con số không đổi định dạng.
  const bestScoreDecimals = primaryMetric?.decimals ?? 4;

  return (
    <section className="subm-page">
      {header}

      {/* Toolbar tóm tắt & thao tác */}
      <div className="subm-toolbar">
        <div className="subm-summary-pills">
          <span>
            Tổng cộng <strong>{data.total}</strong> bài nộp
            {dual && " (cả hai nhánh)"}
          </span>
          {bestScoreVal != null && (
            <>
              <span>•</span>
              <span className="subm-summary-best">
                <span>Điểm tốt nhất trong trang:</span>
                <strong className="subm-summary-score">
                  {formatMetric(bestScoreVal, bestScoreDecimals)}
                </strong>
              </span>
            </>
          )}
          {/* Thay cho pill "tốt nhất" cũ: norm hiện tại nằm ở bảng xếp hạng, không suy từ lịch sử. */}
          {showsNorm && (
            <>
              <span>•</span>
              <Link to={dual ? `../leaderboard?track=${track}` : "../leaderboard"}>
                Điểm norm hiện tại xem ở bảng xếp hạng
              </Link>
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
          {/* Mang nhánh đang xem sang trang nộp bài: người dùng đã chọn nhánh một lần rồi. */}
          <Link to={dual ? `../submit?track=${track}` : "../submit"} className="btn btn-sm">
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

      <AutoRefreshNotice {...refreshStatus} />

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

      {/* Nhánh Private đã chấm nhưng chưa công bố: giải thích một lần cho cả bảng, câu chữ theo
          cấu hình công bố của cuộc thi thay vì hứa một mốc thời gian cụ thể. */}
      {showsHidden && (
        <div className="status-banner busy" role="status">
          <span>
            Có bài nhánh Private đã chấm xong nhưng chưa được công bố. {unpublishedNote(competition)}
          </span>
        </div>
      )}

      {/* Quyền xem norm của nhánh vừa bị thu hồi: cột norm biến mất kèm đúng lý do đang chặn. */}
      {droppedNormNote && (
        <p className="subm-ai-note text-muted" role="status">
          {droppedNormNote}
        </p>
      )}

      {/* Bảng kết quả: metric chính đứng đầu cụm chỉ số, các metric phụ giữ thứ tự hợp đồng. */}
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
              {showsAi && (
                <th scope="col" className="subm-col-ai">AI sơ bộ</th>
              )}
              {showsNorm && <th scope="col" className="subm-col-num">{PROVISIONAL_NORM_LABEL}</th>}
              {displayMetrics.map((metric) => (
                <th
                  key={metric.key}
                  scope="col"
                  className={metric.key === contract.primary_metric ? "subm-col-primary" : "subm-col-num"}
                >
                  {metric.key === contract.primary_metric
                    ? `${showsNorm ? "Điểm gốc" : "Điểm chính"} · ${metric.label}`
                    : metric.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              // Trang đang tải có bài nhưng không thuộc nhánh đang xem: lịch sử trả cả hai nhánh
              // trong một danh sách, nên nói thẳng và cho lối đổi nhánh thay vì bảng trống.
              <tr>
                <td colSpan={3 + (showsAi ? 1 : 0) + (showsNorm ? 1 : 0) + displayMetrics.length}>
                  <div className="empty-state">
                    <p>Không có bài nộp nhánh {TRACK_LABEL[track]} trong phần đang hiển thị.</p>
                    <p className="text-muted">
                      Trang này chỉ có bài nhánh {TRACK_LABEL[otherTrack]}.
                    </p>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setSearchParams({ track: otherTrack })}
                    >
                      Xem nhánh {TRACK_LABEL[otherTrack]}
                    </button>
                  </div>
                </td>
              </tr>
            )}
            {rows.map((submission) => {
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
                      onView={openViewer}
                    />
                  </td>
                  <td>
                    {/* Chưa công bố không phải "Đã chấm điểm" theo nghĩa có điểm xem được, nên có
                        nhãn riêng; quyết định của admin vẫn là badge độc lập như trước. */}
                    {submission.result_visibility === "hidden" ? (
                      <span className="status-badge neutral">{UNPUBLISHED_RESULT_LABEL}</span>
                    ) : (
                      <span
                        className={`status-badge ${
                          submission.status === "completed" ? "success" : "danger"
                        }`}
                      >
                        {SUBMISSION_STATUS_LABEL[submission.status]}
                      </span>
                    )}
                    {submission.review && (
                      <span className="status-badge danger">Không chấp nhận</span>
                    )}
                    {submission.error && (
                      <span className="cell-error">{submission.error.message}</span>
                    )}
                    {submission.review?.note && (
                      <span className="cell-secondary subm-review-reason">
                        Lý do: {submission.review.note}
                      </span>
                    )}
                  </td>
                  {showsAi && (
                    <td className="subm-ai-cell">
                      {/* Thí sinh chỉ nhận trạng thái, kết luận và một câu tóm tắt an toàn. */}
                      {submission.ai_review ? (
                        <>
                          <span
                            className={`status-badge ${
                              submission.ai_review.verdict
                                ? AI_VERDICT_TONE[submission.ai_review.verdict]
                                : "neutral"
                            }`}
                          >
                            {submission.ai_review.verdict
                              ? AI_VERDICT_LABEL[submission.ai_review.verdict]
                              : AI_STATE_LABEL[submission.ai_review.state]}
                          </span>
                          <span className="cell-secondary">{submission.ai_review.summary}</span>
                        </>
                      ) : (
                        <span className="cell-secondary">—</span>
                      )}
                    </td>
                  )}
                  {/* Snapshot là ảnh chụp lúc ghi nhận kết quả, không phải norm hiện tại của BXH;
                      bài bị từ chối vẫn giữ snapshot nhưng nói rõ là không còn tính vào BXH. */}
                  {showsNorm && (
                    <td className="subm-primary-score-cell score-cell primary-score">
                      {submission.normalization_snapshot ? (
                        <>
                          <span className="score-pill norm">
                            {formatMetric(submission.normalization_snapshot.score, 2)}
                          </span>
                          {submission.review?.status === "rejected" && (
                            <span className="cell-secondary">Không tính BXH</span>
                          )}
                        </>
                      ) : (
                        <span className="cell-secondary">—</span>
                      )}
                    </td>
                  )}
                  {/* Điểm chính chỉ hiện trong cột metric chính, không nhân đôi giá trị. Có norm thì
                      metric nguồn xuống cột "Điểm gốc" và giữ nguyên khung như bảng xếp hạng. */}
                  {displayMetrics.map((metric) => (
                    <td
                      key={metric.key}
                      className={
                        metric.key === contract.primary_metric
                          ? "subm-primary-score-cell score-cell primary-score"
                          : "subm-score-cell score-cell"
                      }
                    >
                      {metric.key === contract.primary_metric ? (
                        <span className="score-pill">
                          {formatMetric(submission.metrics?.[metric.key], metric.decimals)}
                        </span>
                      ) : (
                        formatMetric(submission.metrics?.[metric.key], metric.decimals)
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showsAi && <p className="subm-ai-note text-muted">{AI_PARTICIPANT_DISCLAIMER}</p>}
      {/* Cột norm là ảnh chụp lúc nộp, không phải norm hiện tại: nói một câu ngay dưới bảng. */}
      {showsNorm && (
        <p className="subm-norm-note text-muted">
          Điểm norm trong bảng là điểm chấm tạm lúc nộp bài.
        </p>
      )}

      {/* Phân trang */}
      {data.total > PAGE_SIZE && (
        <div className="subm-pagination-footer pagination pagination-controls">
          <div role="status">
            {busy ? (
              "Đang cập nhật…"
            ) : dual ? (
              // Bộ lọc nhánh không đổi phân trang của server: nói rõ dòng đang xem thuộc trang nào.
              <>
                Đang xem <strong>{rows.length}</strong> bài nhánh <strong>{TRACK_LABEL[track]}</strong>{" "}
                · trang {shownFrom}–{shownTo} / {data.total} bài nộp
              </>
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

      {/* Một trình xem duy nhất cho cả bảng: dòng chỉ báo tệp cần mở qua `onView`, không dòng nào
          tự dựng modal nên không thể mở nhiều trình xem cùng lúc. */}
      {viewer && (
        <Suspense fallback={<span role="status">Đang mở trình xem…</span>}>
          <LazyArtifactViewerModal
            path={`/competitions/${competition.id}/submissions/${viewer.submissionId}/${viewer.kind}`}
            kind={viewer.kind}
            filename={viewer.filename}
            onClose={() => setViewer(null)}
          />
        </Suspense>
      )}
    </section>
  );
}
