/** Danh sách bảng xếp hạng tổng hợp mà người đang đăng nhập được phép xem. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AGGREGATE_VISIBILITY_LABEL,
  fetchAggregates,
  shortName,
  weightPercent,
  type AggregateListItem,
} from "../api/aggregates";
import { formatLocal } from "../api/competitions";
import { AggregateIcon } from "../components/AggregateBoard";
import { ErrorBox, Loading } from "../components/ui";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

const SOURCE_FALLBACK = "Nguồn đã bị xoá";

export function AggregateIndexPage() {
  const [data, setData] = useState<AggregateListItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const requestSequence = useRef(0);
  useDocumentTitle("Bảng xếp hạng tổng hợp");

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setError(null);
    try {
      const response = await fetchAggregates();
      if (sequence === requestSequence.current) setData(response.aggregates);
    } catch (err) {
      if (sequence === requestSequence.current) setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (data === null) {
    return error ? (
      <section className="lb-page">
        <ErrorBox error={error} />
        <div className="results-retry">
          <button type="button" className="btn btn-secondary" onClick={() => void load()}>
            Thử lại
          </button>
        </div>
      </section>
    ) : (
      <Loading label="Đang tải danh sách bảng tổng hợp..." />
    );
  }

  return (
    <div className="page">
      <header className="page-hero">
        <div className="page-hero-row">
          <span className="page-hero-icon" aria-hidden="true">
            <AggregateIcon className="page-hero-glyph" />
          </span>
          <div className="page-hero-copy">
            <h1 className="page-hero-title">Bảng xếp hạng tổng hợp</h1>
            <p className="page-hero-subtitle">
              Khám phá thứ hạng từ nhiều cuộc thi. Điểm mỗi nguồn được ghép theo trọng số; chỉ những bảng bạn có quyền xem mới xuất hiện.
            </p>
            <span className="vku-accent" aria-hidden="true">
              <span className="blue" />
              <span className="red" />
              <span className="yellow" />
            </span>
          </div>
        </div>
      </header>

      {data.length === 0 ? (
        <div className="empty-state">
          <p>Chưa có bảng tổng hợp nào bạn được xem.</p>
          <p className="text-muted">
            Bảng hiện khi Ban Tổ chức công bố và bạn đủ điều kiện xem theo cấu hình của bảng.
          </p>
        </div>
      ) : (
        <section aria-labelledby="agg-index-heading">
          <div className="agg-index-heading">
            <h2 id="agg-index-heading">Các bảng dành cho bạn</h2>
            <span>{data.length} bảng tổng hợp</span>
          </div>
          <div
            className="lb-table-wrap table-wrap agg-table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Danh sách bảng tổng hợp"
          >
            <table className="lb-table table agg-index-table">
              <thead>
                <tr>
                  <th scope="col">Bảng</th>
                  <th scope="col">Cuộc thi nguồn</th>
                  <th scope="col">Quyền xem</th>
                  <th scope="col" className="lb-col-time">
                    Cập nhật
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((aggregate) => (
                  <tr key={aggregate.slug}>
                    <td className="name-cell">
                      <Link to={`/tong-hop/${aggregate.slug}`}>
                        <strong>{aggregate.name}</strong>
                      </Link>
                    </td>
                    <td>
                      <div className="agg-chips agg-chips--stack">
                        {aggregate.sources.map((source) => {
                          const full = source.name ?? SOURCE_FALLBACK;
                          return (
                            <span key={source.competition_id} className="agg-chip" title={full}>
                              {source.slug ? (
                                <Link className="agg-chip-name" to={`/competitions/${source.slug}`}>
                                  {shortName(full, 32)}
                                </Link>
                              ) : (
                                <span className="agg-chip-name">{shortName(full, 32)}</span>
                              )}
                              <span className="agg-chip-meta">{weightPercent(source.weight)}</span>
                            </span>
                          );
                        })}
                      </div>
                    </td>
                    <td className="agg-visibility-cell">
                      <span className={`agg-visibility${aggregate.visibility === "members_any" ? " agg-visibility--member-any" : ""}`}>
                        {AGGREGATE_VISIBILITY_LABEL[aggregate.visibility] ?? aggregate.visibility}
                      </span>
                    </td>
                    <td className="lb-time-cell">{formatLocal(aggregate.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
