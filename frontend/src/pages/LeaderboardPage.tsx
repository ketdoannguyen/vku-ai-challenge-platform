import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { ApiClientError } from "../api/client";
import {
  TRACKS,
  TRACK_LABEL,
  accessLostReason,
  formatLocal,
  isDual,
  parseTrack,
  trackLocked,
  unpublishedNote,
  type Track,
} from "../api/competitions";
import {
  fetchLeaderboard,
  formatMetric,
  metricLabel,
  resultContract,
  type NormalizationBoard,
  type ParticipantLeaderboardResponse,
} from "../api/results";
import { ErrorBox, Loading } from "../components/ui";
import { AutoRefreshNotice } from "../components/AutoRefreshNotice";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import {
  currentNormHiddenReason,
  hiddenNormNote,
} from "../lib/normalization";
import type { CompetitionContext } from "./CompetitionDetailPage";

/** Số dòng mỗi trang; backend chặn 1–200 nên đây chỉ là lựa chọn hiển thị. */
const PAGE_SIZE = 25;

/** Nhịp tự làm mới ngầm khi tab đang mở. */
const AUTO_REFRESH_MS = 3_000;

/**
 * Câu mô tả quy tắc xếp hạng. Cuộc thi chưa khai báo metric chính (bản nháp v2) thì không nêu tên
 * metric: `metricLabel` trả null cho key rỗng, không phải chuỗi "null" để lọt ra màn hình.
 */
function rankingNote(label: string | null): string {
  return label
    ? `Xếp theo ${label} tốt nhất; nếu bằng điểm, bài đạt điểm sớm hơn đứng trước.`
    : "Xếp theo điểm chấm của cuộc thi; nếu bằng điểm, bài đạt điểm sớm hơn đứng trước.";
}

/** Mẫu số chỉ hiện khi nhánh đang xem được phép đọc metadata norm. */
function NormSummary({
  board,
  sourceLabel,
  decimals,
}: {
  board: NormalizationBoard;
  sourceLabel: string;
  decimals: number;
}) {
  return (
    <div className="lb-norm-summary">
      <p className="lb-norm-formula">
        Tính theo điểm chuẩn hóa (norm score) · {board.max_score} ×{" "}
        {board.higher_is_better
          ? "(điểm gốc − baseline) / (điểm tốt nhất − baseline)"
          : "(baseline − điểm gốc) / (baseline − điểm tốt nhất)"}
      </p>
      <dl className="lb-norm-facts">
        <div data-tone="blue">
          <dt>Baseline · {sourceLabel}</dt>
          <dd>{formatMetric(board.baseline, decimals)}</dd>
        </div>
        <div data-tone="yellow">
          <dt>Điểm gốc tốt nhất</dt>
          <dd>{formatMetric(board.reference_best, decimals)}</dd>
        </div>
        <div data-tone="red">
          <dt>Giới hạn điểm</dt>
          <dd>0–{board.max_score}</dd>
        </div>
      </dl>
    </div>
  );
}

export function LeaderboardPage() {
  const { competition, reportAccessLost } = useOutletContext<CompetitionContext>();
  // Cột metric và số thập phân đọc từ hợp đồng của cuộc thi, không cố định f1/precision/recall.
  const contract = resultContract(competition.submission_config);
  /** Số thập phân của metric chính; hợp đồng rỗng (bản nháp v2) rơi về mức 4 như bộ chấm v1. */
  const primaryDecimals =
    contract.metrics.find((metric) => metric.key === contract.primary_metric)?.decimals ?? 4;
  // Dual: hai nhánh có hai bảng riêng, không dùng chung.
  const dual = isDual(competition);
  const [searchParams, setSearchParams] = useSearchParams();
  const track: Track = (dual ? parseTrack(searchParams.get("track")) : null) ?? "public";
  const view = dual ? competition.tracks?.[track] ?? null : null;
  /**
   * Bảng của nhánh đang xem đã công bố chưa: Public luôn hiện, Private chờ dấu mốc công bố.
   * Đây là metadata của shell (tự làm mới theo nhịp) nên bảng tự mở khi BTC công bố, không cần
   * người dùng tải lại trang.
   */
  const published = view ? view.results_released : true;
  /**
   * Nhánh đang xem chưa tới giờ mở: bảng của nhánh bị khóa thay vì hiện dòng cũ - kể cả khi BTC
   * vừa dời lịch về sau. Metadata của shell tự làm mới nên bảng tự mở lại khi tới giờ.
   */
  const locked = trackLocked(competition, dual ? track : null);
  /**
   * Metadata chưa kịp thấy lần công bố mà server đã từ chối (lệch nhịp hiếm): hiện bảng "chờ công
   * bố" thay vì báo lỗi, và tự xoá khi có lượt tải thành công.
   */
  const [unpublished, setUnpublished] = useState(false);
  /** Cùng lệch nhịp như `unpublished`, cho tín hiệu 403 `TRACK_NOT_OPEN` từ API bảng. */
  const [notOpen, setNotOpen] = useState(false);
  const boardHidden = !published || unpublished;
  const boardLocked = locked || notOpen;
  const [data, setData] = useState<ParticipantLeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(competition.leaderboard_visible);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  /** Trang đang yêu cầu; `attempt` buộc tải lại cả khi bấm lại đúng trang đó (ví dụ sau lỗi). */
  const [query, setQuery] = useState({ offset: 0, attempt: 0 });
  const requestSequence = useRef(0);
  const hasData = useRef(false);
  /** Số lượt tải do người dùng chủ động đang chạy; lượt ngầm nhường để không tranh chấp. */
  const manualLoads = useRef(0);

  /** Giữ bảng cũ trong lúc tải trang mới; chỉ lần đầu chưa có dữ liệu mới hiện full loading. */
  const loadData = useCallback(
    async (nextOffset: number, keepRows: boolean, silent = false) => {
      if (!competition.leaderboard_visible || !published || locked) return;
      const sequence = ++requestSequence.current;
      if (!silent) {
        manualLoads.current += 1;
        setError(null);
        if (keepRows) setRefreshing(true);
        else setLoading(true);
      }
      try {
        const result = await fetchLeaderboard(
          competition.id,
          PAGE_SIZE,
          nextOffset,
          dual ? track : null,
        );
        // Response cũ không được ghi đè response mới khi người dùng đổi trang liên tục.
        if (sequence !== requestSequence.current) return;
        hasData.current = true;
        setData(result);
        // Lượt ngầm thành công cũng xoá băng lỗi cũ: dữ liệu mới đã về thì lỗi hết đúng.
        setError(null);
        setUnpublished(false);
        setLastUpdated(new Date().toLocaleTimeString("vi-VN"));
        // total co lại có thể làm trang đang xem vượt range: lùi về trang cuối còn dữ liệu.
        const lastOffset = Math.max(0, Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE);
        if (nextOffset > lastOffset) {
          setQuery((current) => ({ offset: lastOffset, attempt: current.attempt + 1 }));
        }
      } catch (reason) {
        if (sequence !== requestSequence.current) return;
        // 401/membership bị thu hồi: quyền đọc cả cuộc thi đã mất - nhường shell đóng gate
        // ngay, không giữ điểm đã tải trên màn hình.
        const lost = accessLostReason(reason);
        if (lost !== null) {
          hasData.current = false;
          setData(null);
          reportAccessLost(lost);
        } else if (reason instanceof ApiClientError && reason.code === "LEADERBOARD_HIDDEN") {
          // Bảng vừa bị ẩn giữa chừng: xoá điểm đã tải; lượt làm mới của shell sẽ cập nhật
          // `leaderboard_visible` và thẻ "chưa công bố" tự hiện, nên không báo mất quyền.
          hasData.current = false;
          setData(null);
          if (!silent) setError(reason);
        } else if (reason instanceof ApiClientError && reason.code === "TRACK_NOT_OPEN") {
          // Nhánh vừa bị dời về chưa mở mà metadata shell chưa kịp thấy: xoá dòng đã tải và chuyển
          // sang thẻ khóa; lượt làm mới của shell sẽ đưa `window_state` về đúng để tự mở lại.
          hasData.current = false;
          setData(null);
          setNotOpen(true);
        } else if (
          reason instanceof ApiClientError &&
          reason.code === "PRIVATE_RESULTS_UNPUBLISHED"
        ) {
          // Kết quả Private chưa công bố: xoá dòng đã tải và chuyển sang thẻ "chờ công bố" thay vì
          // báo lỗi; vòng tự làm mới vẫn chạy để tự mở bảng khi metadata thấy dấu mốc công bố.
          hasData.current = false;
          setData(null);
          setUnpublished(true);
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
    [
      competition.id,
      competition.leaderboard_visible,
      reportAccessLost,
      dual,
      track,
      published,
      locked,
    ],
  );

  // Đổi nhánh là đổi hẳn bảng: bỏ dòng của nhánh cũ thay vì để chúng mang nhãn nhánh mới, và về
  // trang đầu vì phân trang của hai bảng không liên quan nhau.
  useEffect(() => {
    hasData.current = false;
    setData(null);
    setUnpublished(false);
    setNotOpen(false);
    setQuery((current) =>
      current.offset === 0 ? current : { offset: 0, attempt: current.attempt + 1 },
    );
  }, [track]);

  // Master BXH vừa bị tắt giữa chừng: bỏ rows/me/norm đang giữ và vô hiệu request đang bay, để
  // lượt bật lại sau đó phải tải mới thay vì hiện lại dữ liệu của lần công bố trước.
  useEffect(() => {
    if (competition.leaderboard_visible) return;
    requestSequence.current += 1;
    hasData.current = false;
    setData(null);
  }, [competition.leaderboard_visible]);

  // Cửa sổ của nhánh vừa đổi trạng thái khóa: bỏ dòng đang giữ (và mọi tín hiệu "chưa mở" cũ),
  // vô hiệu request đang bay; lượt tải kế tiếp theo `loadData` phản ánh đúng cửa sổ hiện tại.
  useEffect(() => {
    requestSequence.current += 1;
    hasData.current = false;
    setData(null);
    setNotOpen(false);
  }, [locked]);

  useEffect(() => {
    void loadData(query.offset, hasData.current);
  }, [loadData, query]);

  /** Đổi trang/làm mới đều đi qua đây để nút đang giữ focus không bị unmount. */
  const requestPage = useCallback((nextOffset: number) => {
    setQuery((current) => ({ offset: Math.max(0, nextOffset), attempt: current.attempt + 1 }));
  }, []);

  /** Đổi nhánh ghi vào URL để back/forward và bookmark giữ đúng nhánh đang xem. */
  function selectTrack(next: Track) {
    if (next !== track) setSearchParams({ track: next });
  }

  /**
   * Lượt làm mới ngầm: không đụng trạng thái tải để bảng không nháy, và nhường khi
   * người dùng đang bấm nút hoặc đang bôi đen nội dung.
   */
  const silentRefresh = useCallback(async () => {
    if (manualLoads.current > 0) return false;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return false;
    await loadData(query.offset, true, true);
  }, [loadData, query.offset]);

  // Bảng đang công bố thì tự cập nhật ngầm; hook tự tạm dừng khi tab bị ẩn. Nhánh chưa công bố
  // hay đang khóa không có dòng để làm mới - metadata của shell mới là thứ mở bảng khi tới lúc.
  const refreshStatus = useAutoRefresh(
    competition.leaderboard_visible && published && !locked,
    silentRefresh,
    { intervalMs: AUTO_REFRESH_MS },
  );

  const busy = loading || refreshing;

  // Quyền xem norm đọc từ metadata HIỆN TẠI của nhánh: bị thu hồi giữa chừng thì metadata norm
  // còn nằm trong response đã tải cũng bị coi như không có.
  const normHidden = currentNormHiddenReason(competition, dual ? track : null);
  /** Metadata norm của lần dựng bảng đang xem; null khi norm tắt hoặc thí sinh không được xem. */
  const norm = normHidden ? null : data?.normalization ?? null;
  /** Câu giải thích khi norm bị capability che nhưng bảng vẫn xem được (metric nguồn bị ẩn). */
  const hiddenNorm = norm === null ? hiddenNormNote(normHidden) : null;
  /** Nhãn và số thập phân của metric nguồn để đọc baseline/mẫu số đúng đơn vị điểm gốc. */
  const sourceLabel = norm
    ? metricLabel(contract, norm.source_metric) ?? norm.source_metric
    : null;
  const sourceDecimals =
    contract.metrics.find((metric) => metric.key === norm?.source_metric)?.decimals ??
    primaryDecimals;

  const header = (
    <div className="lb-head">
      <div className="lb-head-top">
        <div className="lb-eyebrow">
          <span>{dual ? `Bảng xếp hạng nhánh ${TRACK_LABEL[track]}` : "Bảng xếp hạng công bố"}</span>
          <span>/</span>
          <span className="results-slug">{competition.slug}</span>
        </div>
        {dual && (
          <div className="dash-filters" role="group" aria-label="Chọn nhánh xếp hạng">
            {TRACKS.map((item) => (
              <button
                key={item}
                type="button"
                className="dash-filter"
                aria-pressed={item === track}
                onClick={() => selectTrack(item)}
              >
                {TRACK_LABEL[item]}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="lb-head-main">
        <div className="lb-head-copy">
          <h2 className="lb-title">Bảng xếp hạng{dual ? ` ${TRACK_LABEL[track]}` : ""}</h2>
          {!boardHidden && (
            norm && sourceLabel ? (
              <NormSummary board={norm} sourceLabel={sourceLabel} decimals={sourceDecimals} />
            ) : hiddenNorm ? (
              <p className="lb-lead text-muted" role="status">{hiddenNorm}</p>
            ) : (
              <p className="lb-lead text-muted">
                {rankingNote(metricLabel(contract, data?.primary_metric ?? contract.primary_metric))}
              </p>
            )
          )}
        </div>
        {!boardHidden && data && (
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
        )}
      </div>
    </div>
  );

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
                  <div className="lb-locked-tile-tag">Chấm điểm nội bộ</div>
                  <p className="lb-locked-tile-text">
                    Hệ thống vẫn chấm điểm và lưu kết quả các bài nộp của bạn.
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

  // Dual, nhánh đang xem chưa tới giờ mở (kể cả khi BTC vừa dời lịch về sau): bảng của nhánh bị
  // khóa, không hiện dòng nào. Giữ bộ chọn nhánh để xem nhánh còn lại; dữ liệu cũ giữ nguyên
  // trong hệ thống và tự hiện lại khi tới giờ.
  if (boardLocked) {
    return (
      <section className="lb-page">
        {header}

        <div className="lb-locked-card">
          <div className="lb-locked-content">
            <div className="lb-locked-emblem" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.75">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>

            <h2 className="lb-locked-title">
              Nhánh {TRACK_LABEL[track]} chưa mở — Bảng xếp hạng đang khóa.
            </h2>
            <p className="lb-locked-lead">
              {view && `Bảng của nhánh này mở lúc ${formatLocal(view.start_at)}. `}
              Kết quả và bài nộp cũ của nhánh không bị xóa, sẽ hiện lại đầy đủ khi nhánh mở.
            </p>
          </div>
        </div>
      </section>
    );
  }

  // Dual, nhánh Private chưa công bố: không có dòng nào để tải, nhưng vẫn giữ bộ chọn nhánh để
  // thí sinh xem được bảng Public tham khảo và đọc đúng thông báo theo cấu hình công bố.
  if (boardHidden) {
    return (
      <section className="lb-page">
        {header}

        <div className="lb-locked-card">
          <div className="lb-locked-content">
            <div className="lb-locked-emblem" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.75">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>

            <h2 className="lb-locked-title">Kết quả nhánh Private chưa được công bố.</h2>
            <p className="lb-locked-lead">
              {unpublishedNote(competition)} Bảng nhánh Public vẫn xem được để tham khảo.
            </p>

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
        {header}
        <AutoRefreshNotice {...refreshStatus} />
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
      {header}

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
            <div className="lb-me-score">
              <dt>{norm ? "Điểm chuẩn hóa" : "Điểm chính"}</dt>
              <dd>
                {norm
                  ? formatMetric(data.me.normalized_score, norm.decimals)
                  : formatMetric(data.me.primary_score, primaryDecimals)}
              </dd>
            </div>
            {norm && (
              <div className="lb-me-source-score">
                <dt>Điểm gốc · {metricLabel(contract, contract.primary_metric)}</dt>
                <dd>{formatMetric(data.me.primary_score, primaryDecimals)}</dd>
              </div>
            )}
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
      {/* Cột metric theo đúng thứ tự hợp đồng. Không dựng thêm cột "Điểm chính" vì
          `primary_score` chính là giá trị của metric chính - vẽ cả hai là lặp số. */}
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
              {/* Norm là điểm xếp hạng khi cuộc thi bật chuẩn hóa; metric nguồn ở lại cột phụ. */}
              {norm && (
                <th scope="col" className="lb-col-num">
                  Điểm chuẩn hóa (0–{norm.max_score})
                </th>
              )}
              {contract.metrics.map((metric) => (
                <th scope="col" className="lb-col-num" key={metric.key}>
                  {metric.label}
                </th>
              ))}
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
                {norm && (
                  <td className="score-cell lb-score-cell lb-norm-score primary-score">
                    <span className="score-pill norm">{formatMetric(entry.normalized_score, norm.decimals)}</span>
                  </td>
                )}
                {contract.metrics.map((metric) => (
                  <td
                    key={metric.key}
                    className={`score-cell${metric.key === contract.primary_metric ? " lb-score-cell lb-raw-score primary-score" : ""}`}
                  >
                    {metric.key === contract.primary_metric ? (
                      <span className="score-pill">{formatMetric(entry.metrics[metric.key], metric.decimals)}</span>
                    ) : (
                      formatMetric(entry.metrics[metric.key], metric.decimals)
                    )}
                  </td>
                ))}
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
