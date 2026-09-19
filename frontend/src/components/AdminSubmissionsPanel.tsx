/**
 * Bảng bài nộp dành cho admin, dùng chung cho hai chỗ:
 * - Trang toàn cục `/admin/submissions`: bộ lọc và cột cuộc thi đều bật.
 * - Tab Kết quả của một cuộc thi: đã khóa vào cuộc thi hiện tại nên ẩn cả hai.
 *
 * Lọc, sắp xếp và phân trang đều chạy phía server để tổng số luôn khớp bộ lọc.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { formatLocal } from "../api/competitions";
import {
  formatScore,
  SUBMISSION_STATUS_LABEL,
  type AdminSortField,
  type AdminSortOrder,
  type AdminSubmissionsResponse,
} from "../api/results";
import { ArtifactLinks } from "./ArtifactLinks";
import { ErrorBox, Loading } from "./ui";

const PAGE_SIZE = 50;

const STATUS_OPTIONS = [
  { value: "", label: "Mọi trạng thái" },
  { value: "completed", label: "Đã chấm điểm" },
  { value: "rejected", label: "Không hợp lệ" },
  { value: "failed", label: "Lỗi chấm điểm" },
];

/** Thứ tự mặc định khi chuyển sang một cột: điểm/thời gian mới nhất trước, tên đội A→Z. */
const DEFAULT_ORDER: Record<AdminSortField, AdminSortOrder> = {
  created_at: "desc",
  team: "asc",
  primary_score: "desc",
};

interface Filters {
  competition_id: string;
  q: string;
  status: string;
}

const NO_FILTERS: Filters = { competition_id: "", q: "", status: "" };

/** Bộ lọc + sắp xếp + trang đang xem; chỉ đổi khi người dùng bấm "Lọc" hoặc đổi trang. */
interface Query extends Filters {
  sort: AdminSortField;
  order: AdminSortOrder;
  offset: number;
  /** Đổi mỗi lần phải gọi lại đúng trang đang xem (thử lại sau lỗi). */
  attempt: number;
}

const INITIAL_QUERY: Query = {
  ...NO_FILTERS,
  sort: "created_at",
  order: "desc",
  offset: 0,
  attempt: 0,
};

interface CompetitionOption {
  id: string;
  name: string;
}

export function AdminSubmissionsPanel({
  competitionId,
  title,
  tableLabel,
}: {
  /** Có cuộc thi thì bảng khóa vào cuộc thi đó: ẩn bộ lọc và cột cuộc thi. */
  competitionId?: string;
  title: string;
  tableLabel: string;
}) {
  const [data, setData] = useState<AdminSubmissionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [competitions, setCompetitions] = useState<CompetitionOption[]>([]);
  const [competitionsError, setCompetitionsError] = useState(false);
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [query, setQuery] = useState<Query>(INITIAL_QUERY);
  const requestSequence = useRef(0);
  const hasData = useRef(false);
  const endpoint = competitionId
    ? `/admin/competitions/${competitionId}/submissions`
    : "/admin/submissions";

  /** Ô lọc cuộc thi chỉ tồn tại ở bảng toàn cục; lỗi tải danh sách chỉ làm hẹp bộ lọc. */
  useEffect(() => {
    if (competitionId) return;
    let active = true;
    api.get<{ competitions: CompetitionOption[] }>("/admin/competitions").then(
      (response) => {
        if (active) setCompetitions(response.competitions);
      },
      () => {
        if (active) setCompetitionsError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [competitionId]);

  /** Giữ bảng cũ trong lúc tải trang mới; chỉ lần đầu chưa có dữ liệu mới hiện full loading. */
  const load = useCallback(
    async (next: Query, keepRows: boolean) => {
      const sequence = ++requestSequence.current;
      setError(null);
      if (keepRows) setRefreshing(true);
      else setLoading(true);
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(next.offset),
        sort: next.sort,
        order: next.order,
      });
      if (!competitionId && next.competition_id) params.set("competition_id", next.competition_id);
      if (next.q) params.set("q", next.q);
      if (next.status) params.set("status", next.status);
      try {
        const response = await api.get<AdminSubmissionsResponse>(
          `${endpoint}?${params.toString()}`,
        );
        // Response cũ không được ghi đè response mới khi bộ lọc đổi liên tiếp.
        if (sequence !== requestSequence.current) return;
        hasData.current = true;
        setData(response);
        // Tổng co lại có thể làm trang đang xem vượt range: lùi về trang cuối còn dữ liệu.
        const lastOffset = Math.max(0, Math.floor((response.total - 1) / PAGE_SIZE) * PAGE_SIZE);
        if (next.offset > lastOffset) {
          setQuery((current) => ({ ...current, offset: lastOffset, attempt: current.attempt + 1 }));
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
    [competitionId, endpoint],
  );

  useEffect(() => {
    void load(query, hasData.current);
  }, [load, query]);

  /** Đổi trang/làm mới đi qua đây để nút đang giữ focus không bị unmount. */
  const requestPage = useCallback((nextOffset: number) => {
    setQuery((current) => ({
      ...current,
      offset: Math.max(0, nextOffset),
      attempt: current.attempt + 1,
    }));
  }, []);

  function changeSort(field: AdminSortField) {
    setQuery((current) => ({
      ...current,
      sort: field,
      order:
        current.sort === field
          ? current.order === "desc"
            ? "asc"
            : "desc"
          : DEFAULT_ORDER[field],
      offset: 0,
    }));
  }

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    setQuery((current) => ({ ...current, ...draft, q: draft.q.trim(), offset: 0 }));
  }

  function clearFilters() {
    setDraft(NO_FILTERS);
    setQuery((current) => ({ ...current, ...NO_FILTERS, offset: 0 }));
  }

  const busy = loading || refreshing;
  const hasFilters = Boolean(query.competition_id || query.q || query.status);
  const shownFrom = data ? data.offset + 1 : 0;
  const shownTo = data ? Math.min(data.offset + PAGE_SIZE, data.total) : 0;
  const hasNext = data ? shownTo < data.total : false;

  /** Ô tiêu đề sắp xếp được: bấm đổi cột, bấm lại cột đang chọn thì đảo chiều. */
  function sortableHeader(field: AdminSortField, label: string, className?: string) {
    const active = query.sort === field;
    return (
      <th
        scope="col"
        className={className}
        aria-sort={active ? (query.order === "asc" ? "ascending" : "descending") : "none"}
      >
        <button type="button" className="admin-sort-button" onClick={() => changeSort(field)}>
          <span>{label}</span>
          <SortArrow active={active} descending={query.order === "desc"} />
        </button>
      </th>
    );
  }

  return (
    <section className="results-section admin-detail-card" data-tone="blue">
      <div className="results-head">
        <div className="admin-detail-section-heading">
          <span className="admin-detail-card-icon" aria-hidden="true">
            <IconSubmission className="admin-detail-card-icon-glyph" />
          </span>
          <div>
            <h2 className="admin-detail-card-title">{title}</h2>
            <p className="text-muted">
              {data
                ? `${data.total} bài nộp trong bộ lọc hiện tại.`
                : "Đang tải danh sách bài nộp."}
            </p>
          </div>
        </div>
      </div>

      {/* Bảng khóa cuộc thi không có ô lọc cuộc thi nên giữ nguyên lưới hai bộ lọc gốc. */}
      <form
        className={`results-filters${competitionId ? "" : " admin-submissions-filters"}`}
        onSubmit={applyFilters}
      >
        {!competitionId && (
          <select
            className="input"
            aria-label="Lọc theo cuộc thi"
            value={draft.competition_id}
            onChange={(event) =>
              setDraft((current) => ({ ...current, competition_id: event.target.value }))
            }
          >
            <option value="">Mọi cuộc thi</option>
            {competitions.map((competition) => (
              <option key={competition.id} value={competition.id}>
                {competition.name}
              </option>
            ))}
          </select>
        )}
        <input
          className="input"
          type="search"
          aria-label="Lọc theo đội"
          placeholder="Tên hoặc email đội"
          value={draft.q}
          onChange={(event) => setDraft((current) => ({ ...current, q: event.target.value }))}
        />
        <select
          className="input"
          aria-label="Lọc theo trạng thái"
          value={draft.status}
          onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button className="btn" type="submit">
          Lọc
        </button>
        {hasFilters && (
          <button className="btn btn-ghost" type="button" onClick={clearFilters}>
            Xóa bộ lọc
          </button>
        )}
        {competitionsError && (
          <span className="cell-error" role="status">
            Không tải được danh sách cuộc thi - chỉ lọc được theo đội và trạng thái.
          </span>
        )}
      </form>

      {Boolean(error) && data && (
        <div className="admin-section-error admin-submissions-error">
          <ErrorBox error={error} />
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => requestPage(query.offset)}
          >
            Thử lại
          </button>
        </div>
      )}

      {loading && !data ? (
        <Loading label="Đang tải danh sách bài nộp..." />
      ) : error && !data ? (
        <div className="admin-section-error admin-submissions-error">
          <ErrorBox error={error} />
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => requestPage(query.offset)}
          >
            Thử lại
          </button>
        </div>
      ) : data && data.submissions.length > 0 ? (
        <div
          className="table-wrap admin-results-table-wrap"
          aria-busy={busy}
          tabIndex={0}
          role="region"
          aria-label={tableLabel}
        >
          <table className="table results-table admin-submissions-table">
            <thead>
              <tr>
                {sortableHeader("created_at", "Thời gian")}
                {!competitionId && <th scope="col">Cuộc thi</th>}
                {sortableHeader("team", "Đội")}
                <th scope="col">Tệp đã nộp</th>
                <th scope="col">Trạng thái</th>
                <th scope="col" className="score-cell">F1</th>
                <th scope="col" className="score-cell">Precision</th>
                <th scope="col" className="score-cell">Recall</th>
                {sortableHeader("primary_score", "Điểm chính", "score-cell")}
              </tr>
            </thead>
            <tbody>
              {data.submissions.map((submission) => (
                <tr key={submission.id}>
                  <td>{formatLocal(submission.created_at)}</td>
                  {!competitionId && (
                    <td>
                      {/* Cuộc thi đã xóa trả slug rỗng và không còn trang để mở. */}
                      {submission.competition?.slug ? (
                        <>
                          <Link to={`/admin/competitions/${submission.competition.id}`}>
                            {submission.competition.name}
                          </Link>
                          <span className="cell-secondary">{submission.competition.slug}</span>
                        </>
                      ) : (
                        <span>{submission.competition?.name}</span>
                      )}
                    </td>
                  )}
                  <td>
                    <strong>{submission.account.name}</strong>
                    <span className="cell-secondary">{submission.account.email}</span>
                  </td>
                  <td className="subm-artifact-cell">
                    <ArtifactLinks
                      basePath="/admin/submissions"
                      submissionId={submission.id}
                      artifacts={submission.artifacts}
                    />
                  </td>
                  <td>
                    <span className={`status-badge submission-status ${submission.status}`}>
                      {SUBMISSION_STATUS_LABEL[submission.status]}
                    </span>
                    {submission.error && (
                      <span className="cell-error">{submission.error.message}</span>
                    )}
                  </td>
                  <td className="score-cell">{formatScore(submission.metrics?.f1)}</td>
                  <td className="score-cell">{formatScore(submission.metrics?.precision)}</td>
                  <td className="score-cell">{formatScore(submission.metrics?.recall)}</td>
                  <td className="score-cell primary-score">
                    {formatScore(submission.primary_score)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="admin-results-empty">
          <p>Không có bài nộp phù hợp.</p>
          {hasFilters && (
            <button className="btn btn-secondary btn-sm" type="button" onClick={clearFilters}>
              Xóa bộ lọc
            </button>
          )}
        </div>
      )}

      {data && data.total > PAGE_SIZE && (
        <div className="pagination pagination-controls admin-results-pagination">
          <div role="status">
            {busy ? (
              "Đang cập nhật…"
            ) : (
              <>
                Đã hiển thị <strong>{shownFrom}–{shownTo}</strong> trong số{" "}
                <strong>{data.total}</strong> bài nộp
              </>
            )}
          </div>
          <div className="pagination-actions">
            <button
              className="btn btn-secondary btn-sm"
              type="button"
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
              className="btn btn-secondary btn-sm"
              type="button"
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

/** Mũi tên trạng thái sắp xếp; cột chưa chọn hiện hai chiều mờ. */
function SortArrow({ active, descending }: { active: boolean; descending: boolean }) {
  const path = !active
    ? "M8 9l4-4 4 4M8 15l4 4 4-4"
    : descending
      ? "M6 9l6 6 6-6"
      : "M6 15l6-6 6 6";
  return (
    <svg
      className="admin-sort-arrow"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  );
}

/** Dùng chung cho panel và panel tiêu đề của trang toàn cục. */
export function IconSubmission({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5" />
      <path d="m9 14.5 2 2 4-4.5" />
    </svg>
  );
}
