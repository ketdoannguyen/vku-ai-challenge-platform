/** Bảng điểm tổng hợp dùng chung cho trang thí sinh và khối xem trước của admin. */

import { Link } from "react-router-dom";
import {
  reasonLabel,
  shortName,
  type AggregateEntry,
  type AggregateLeaderboard,
  type AggregateSourceView,
} from "../api/aggregates";
import { formatMetric } from "../api/results";

/** Mọi cột điểm của bảng tổng hợp hiển thị 2 chữ số; xếp hạng vẫn theo điểm đầy đủ. */
const DECIMALS = 2;

export function AggregateIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 21h16" />
      <path d="M8 21V11M12 21V5M16 21v-7" />
    </svg>
  );
}

function componentScore(entry: AggregateEntry, competitionId: string): number | null {
  return (
    entry.components.find((component) => component.competition_id === competitionId)?.score ?? null
  );
}

/** Tên nguồn để hiển thị; document nguồn đã bị xoá không có gì ngoài ObjectId. */
export function sourceName(source: { name: string | null }): string {
  return source.name ?? "Nguồn đã bị xoá";
}

/** Cột của một nguồn: tên ngắn (tên đầy đủ ở tooltip), link về cuộc thi, chip cách tính điểm. */
function SourceColumn({ source }: { source: AggregateSourceView }) {
  const full = sourceName(source);
  return (
    <th scope="col" className="lb-col-num agg-source-col" title={full}>
      {source.slug ? (
        <Link className="agg-source-link" to={`/competitions/${source.slug}`}>
          {shortName(full)}
        </Link>
      ) : (
        <span className="agg-source-link">{shortName(full)}</span>
      )}
      {source.metric_label && <span className="agg-kind-chip">{source.metric_label}</span>}
    </th>
  );
}

/**
 * Một nguồn chưa sẵn sàng làm cả view chờ: không dòng nào, không `me`, không điểm của các nguồn
 * đã sẵn sàng. Chỉ liệt kê tên nguồn và lý do để người xem hiểu vì sao bảng chưa mở.
 */
export function AggregateWaiting({ board }: { board: AggregateLeaderboard }) {
  return (
    <div className="lb-locked-card">
      <div className="lb-locked-content">
        <h2 className="lb-locked-title">Bảng tổng hợp đang chờ đủ nguồn.</h2>
        <p className="lb-locked-lead">
          Bảng mở khi tất cả cuộc thi nguồn sẵn sàng dữ liệu.
        </p>
        <ul>
          {board.sources
            .filter((source) => !source.ready)
            .map((source) => (
              <li key={source.competition_id}>
                <strong>{sourceName(source)}</strong>
                {": "}
                {reasonLabel(source.reason)}
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Bảng điểm đã sẵn sàng: Hạng, Thí sinh, Điểm tổng và một cột cho mỗi nguồn. Cột điểm nguồn
 * luôn hiển thị đủ; `–` là nguồn chưa có kết quả cho người đó, không phải điểm 0.
 */
export function AggregateTable({ board }: { board: AggregateLeaderboard }) {
  // Chỉ gắn nhãn 0–100 khi mọi nguồn đều dùng norm; có nguồn điểm gốc thì tổng không cùng thang.
  const allNormalized = board.sources.every((source) => source.score_kind === "normalized");

  return (
    <>
      <div
        className="lb-table-wrap table-wrap agg-table-wrap"
        tabIndex={0}
        role="region"
        aria-label="Bảng xếp hạng tổng hợp"
      >
        <table className="lb-table table results-table agg-table">
          <thead>
            <tr>
              <th scope="col" className="lb-col-rank">Hạng</th>
              <th scope="col" className="lb-col-name">Thí sinh</th>
              <th scope="col" className="lb-col-num agg-total-col">
                Điểm tổng{allNormalized ? " (0–100)" : ""}
              </th>
              {board.sources.map((source) => (
                <SourceColumn key={source.competition_id} source={source} />
              ))}
            </tr>
          </thead>
          <tbody>
            {board.entries.map((entry, index) => (
              <tr key={index} className={entry.is_current_user ? "current-user-row" : undefined}>
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
                  <span className="lb-participant-name">{entry.display_name}</span>
                  {entry.is_current_user && <span className="lb-user-badge">Bạn</span>}
                </td>
                <td className="score-cell lb-score-cell primary-score">
                  <span className="score-pill norm">
                    {formatMetric(entry.total_score, DECIMALS)}
                  </span>
                </td>
                {board.sources.map((source) => (
                  <td key={source.competition_id} className="score-cell">
                    {formatMetric(componentScore(entry, source.competition_id), DECIMALS)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="agg-note">
        "-" là nguồn chưa có kết quả (tính 0 điểm). Điểm hiển thị làm tròn; hạng theo điểm đầy đủ.
      </p>
    </>
  );
}
