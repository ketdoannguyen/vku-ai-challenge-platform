/** Thẻ một nhánh Public/Private: cửa sổ, hạn, quota của chính mình, tài nguyên và lối nộp riêng. */

import { Link } from "react-router-dom";
import type { CompetitionDetail, ParticipantTrackView, Track } from "../api/competitions";
import {
  PARTICIPANT_WINDOW_LABEL,
  TRACK_BLOCKED_MESSAGE,
  TRACK_LABEL,
  formatLocal,
  isSafeResourceUrl,
} from "../api/competitions";

/**
 * Dùng chung ở Tổng quan và màn chọn nhánh của trang Nộp bài: đây là nơi duy nhất chọn nhánh
 * để nộp - không có nhánh mặc định. `submitTo` khác nhau theo route đang đứng nên truyền vào.
 */
export function TrackCard({
  competition,
  track,
  submitTo,
}: {
  competition: CompetitionDetail;
  track: Track;
  submitTo: string;
}) {
  const view: ParticipantTrackView | undefined = competition.tracks?.[track];
  if (!view) return null;
  const resources = view.resources.filter((item) => isSafeResourceUrl(item.url));
  return (
    <article className={`track-card ${track} ${view.window_state}`}>
      <header className="track-card-head">
        <h4 className="track-card-name">{TRACK_LABEL[track]}</h4>
        {/* Trạng thái cửa sổ nằm cùng dòng với tên nhánh; màu viền thẻ cũng theo trạng thái này. */}
        <p className={`track-window ${view.window_state}`}>
          <span className="track-window-dot" aria-hidden="true" />
          {PARTICIPANT_WINDOW_LABEL[view.window_state]}
        </p>
      </header>
      <dl className="track-card-facts">
        <div>
          <dt>Mở lúc</dt>
          <dd>{formatLocal(view.start_at)}</dd>
        </div>
        <div>
          <dt>Hạn nộp</dt>
          <dd>{formatLocal(view.end_at)}</dd>
        </div>
        {view.quota && (
          <div>
            <dt>Lượt còn lại hôm nay</dt>
            <dd>
              Còn {view.quota.remaining}/{view.quota.per_day} lượt
            </dd>
          </div>
        )}
        <div>
          <dt>Kết quả</dt>
          <dd>{view.results_released ? "Điểm hiện sau khi chấm" : "Điểm chờ BTC công bố"}</dd>
        </div>
      </dl>
      <div className="track-card-actions">
        {resources.map((item) => (
          <a
            key={item.url}
            className="btn btn-secondary"
            href={item.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
          >
            {item.label || "Dữ liệu"}
          </a>
        ))}
        {view.can_submit ? (
          <Link className="btn" to={submitTo}>
            Nộp {TRACK_LABEL[track]}
          </Link>
        ) : (
          <p className="track-card-blocked">
            {TRACK_BLOCKED_MESSAGE[view.blocked_reason ?? ""] ??
              "Nhánh này hiện không nhận bài nộp."}
          </p>
        )}
      </div>
    </article>
  );
}
