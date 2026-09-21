/**
 * Bảng bài nộp dành cho admin, dùng chung cho hai chỗ:
 * - Trang toàn cục `/admin/submissions`: thẻ thống kê, bộ lọc và cột cuộc thi đều bật.
 * - Tab Kết quả của một cuộc thi: đã khóa vào cuộc thi hiện tại nên ẩn cả ba.
 *
 * Lọc, sắp xếp và phân trang đều chạy phía server để tổng số luôn khớp bộ lọc.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AI_FILTER_OPTIONS,
  AI_STATE_LABEL,
  AI_VERDICT_LABEL,
  AI_VERDICT_TONE,
  hasPendingAiReview,
  type AiReviewFilter,
} from "../api/aiReview";
import { api } from "../api/client";
import { formatLocal } from "../api/competitions";
import {
  formatScore,
  REVIEW_STATUS_LABEL,
  setSubmissionReview,
  SUBMISSION_STATUS_LABEL,
  type AdminSortField,
  type AdminSortOrder,
  type AdminSubmissionItem,
  type AdminSubmissionsResponse,
  type ReviewPayload,
} from "../api/results";
import { usePendingPolling } from "../hooks/usePendingPolling";
import { AiReviewDetailModal } from "./AiReviewDetailModal";
import { ArtifactLinks } from "./ArtifactLinks";
import { ConfirmModal } from "./Modal";
import { SubmissionRejectModal } from "./SubmissionReviewModal";
import { ErrorBox, Loading } from "./ui";

const PAGE_SIZE = 50;
/** Gõ xong mới gọi server; Enter trong ô tìm kiếm thì áp dụng ngay. */
const SEARCH_DEBOUNCE_MS = 300;
/** Băng báo thành công tự tắt; đủ lâu để đọc hết một câu. */
const MESSAGE_TIMEOUT_MS = 4500;

const STATUS_OPTIONS = [
  { value: "", label: "Mọi trạng thái chấm" },
  { value: "completed", label: "Đã chấm điểm" },
  { value: "rejected", label: "Không hợp lệ" },
  { value: "failed", label: "Lỗi chấm điểm" },
];

/** Trục duyệt tách khỏi trục chấm điểm: "Hợp lệ" gồm cả bài chưa từng bị xét duyệt. */
const REVIEW_OPTIONS = [
  { value: "", label: "Mọi trạng thái duyệt" },
  { value: "accepted", label: "Hợp lệ" },
  { value: "rejected", label: "Không chấp nhận" },
];

/** Thứ tự mặc định khi chuyển sang một cột: điểm/thời gian mới nhất trước, tên A→Z. */
const DEFAULT_ORDER: Record<AdminSortField, AdminSortOrder> = {
  created_at: "desc",
  competition: "asc",
  team: "asc",
  primary_score: "desc",
  f1: "desc",
  precision: "desc",
  recall: "desc",
};

interface Filters {
  competition_id: string;
  q: string;
  status: string;
  review: string;
  /** Trục thứ ba, độc lập: bộ lọc AI không bao giờ gộp vào `status` hay `review`. */
  ai_review: AiReviewFilter;
}

const NO_FILTERS: Filters = {
  competition_id: "",
  q: "",
  status: "",
  review: "",
  ai_review: "all",
};

/** Bộ lọc + sắp xếp + trang đang xem; đổi bất kỳ phần nào cũng gọi lại server. */
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
  /** Có cuộc thi thì bảng khóa vào cuộc thi đó: ẩn bộ lọc, cột cuộc thi và thẻ thống kê. */
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
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState<Query>(INITIAL_QUERY);
  /** Bài đang được xử lý; `null` nghĩa là modal tương ứng đang đóng. */
  const [rejecting, setRejecting] = useState<AdminSubmissionItem | null>(null);
  const [restoring, setRestoring] = useState<AdminSubmissionItem | null>(null);
  const [aiDetail, setAiDetail] = useState<AdminSubmissionItem | null>(null);
  const [message, setMessage] = useState("");
  const requestSequence = useRef(0);
  const hasData = useRef(false);
  const messageTimer = useRef<number | null>(null);
  /** Nút vừa mở modal; dùng để trả focus về đúng chỗ sau khi đóng. */
  const triggerRef = useRef<HTMLElement | null>(null);
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
      if (next.review) params.set("review", next.review);
      params.set("ai_review", next.ai_review);
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

  /** Từ khóa chỉ vào query sau khi ngừng gõ, để mỗi ký tự không thành một request. */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery((current) =>
        current.q === search.trim() ? current : { ...current, q: search.trim(), offset: 0 },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  /** Đổi trang/làm mới đi qua đây để nút đang giữ focus không bị unmount. */
  const requestPage = useCallback((nextOffset: number) => {
    setQuery((current) => ({
      ...current,
      offset: Math.max(0, nextOffset),
      attempt: current.attempt + 1,
    }));
  }, []);

  const notify = useCallback((text: string) => {
    if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    setMessage(text);
    messageTimer.current = window.setTimeout(() => {
      setMessage("");
      messageTimer.current = null;
    }, MESSAGE_TIMEOUT_MS);
  }, []);

  useEffect(
    () => () => {
      if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    },
    [],
  );

  /**
   * Lỗi để modal tự hiển thị nên ở đây không bắt: chỉ đóng modal khi backend đã nhận.
   * Refetch giữ nguyên cuộc thi/tìm kiếm/ba bộ lọc/sắp xếp/trang và làm mới cả thẻ thống kê.
   */
  async function rejectSubmission(payload: ReviewPayload) {
    await setSubmissionReview(rejecting!.id, payload);
    setRejecting(null);
    notify("Đã đánh dấu bài nộp là không chấp nhận.");
    requestPage(query.offset);
  }

  async function restoreSubmission() {
    await setSubmissionReview(restoring!.id, { status: "accepted" });
    setRestoring(null);
    notify("Đã khôi phục bài nộp về trạng thái hợp lệ.");
    requestPage(query.offset);
  }

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

  /** Bộ lọc áp dụng ngay khi đổi; trả về chính object cũ khi không có gì đổi để khỏi gọi trùng. */
  function changeFilters(next: Partial<Filters>) {
    setQuery((current) => {
      const changed = (Object.keys(next) as (keyof Filters)[]).some(
        (key) => current[key] !== next[key],
      );
      if (!changed && current.offset === 0) return current;
      return { ...current, ...next, offset: 0 };
    });
  }

  /** Enter trong ô tìm kiếm: bỏ qua debounce, trừ khi từ khóa đã đúng như đang áp dụng. */
  function applySearch(event: FormEvent) {
    event.preventDefault();
    changeFilters({ q: search.trim() });
  }

  function clearFilters() {
    setSearch("");
    changeFilters(NO_FILTERS);
  }

  const busy = loading || refreshing;
  // Còn lượt AI đang chạy thì tự làm mới, nhưng có ngân sách: bảng không quay mãi một mình.
  const pollExhausted = usePendingPolling(hasPendingAiReview(data?.submissions ?? []), () =>
    requestPage(query.offset),
  );
  const hasFilters = Boolean(
    query.competition_id ||
      query.status ||
      query.review ||
      query.ai_review !== "all" ||
      search.trim(),
  );
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

  /**
   * Trạng thái duyệt của một dòng. Record chưa chấm được điểm (`failed`/`rejected` legacy) không
   * bao giờ xét duyệt được nên hiển thị gạch, tránh bị đọc thành "hợp lệ".
   */
  function reviewCell(submission: AdminSubmissionItem) {
    if (submission.status !== "completed") return <span className="cell-secondary">—</span>;
    if (!submission.review) {
      return <span className="status-badge success">Hợp lệ</span>;
    }
    return (
      <>
        <span
          className={`status-badge ${
            submission.review.status === "rejected" ? "danger" : "success"
          }`}
        >
          {REVIEW_STATUS_LABEL[submission.review.status]}
        </span>
        {submission.review.note && (
          <span className="cell-secondary subm-review-note">{submission.review.note}</span>
        )}
        <span className="cell-secondary">
          {submission.review.reviewed_by.name} · {formatLocal(submission.review.reviewed_at)}
        </span>
      </>
    );
  }

  /**
   * Cột AI chỉ để đọc. Bài nộp từ lúc cuộc thi chưa bật AI không có projection - hiển thị là
   * "Chưa đánh giá" chứ không phải "Không phát hiện": thiếu dữ liệu không phải bằng chứng sạch.
   * Nút vẫn phải có: đó là đường duy nhất để BTC khởi tạo lượt kiểm tra cho bài cũ, vì reconciler
   * cố ý không tự chạy cho bài thiếu desired state.
   */
  function aiCell(submission: AdminSubmissionItem) {
    const projection = submission.ai_review;
    return (
      <>
        {projection ? (
          <span
            className={`status-badge ${
              projection.verdict ? AI_VERDICT_TONE[projection.verdict] : "neutral"
            }`}
          >
            {projection.verdict
              ? AI_VERDICT_LABEL[projection.verdict]
              : AI_STATE_LABEL[projection.state]}
          </span>
        ) : (
          <span className="cell-secondary">Chưa đánh giá</span>
        )}
        {projection?.updated_at && (
          <span className="cell-secondary">{formatLocal(projection.updated_at)}</span>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={(event) => {
            triggerRef.current = event.currentTarget;
            setAiDetail(submission);
          }}
        >
          Chi tiết AI
        </button>
      </>
    );
  }

  function actionCell(submission: AdminSubmissionItem) {
    if (submission.status !== "completed") return <span className="cell-secondary">—</span>;
    if (submission.review?.status === "rejected") {
      return (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={(event) => {
            triggerRef.current = event.currentTarget;
            setRestoring(submission);
          }}
        >
          Khôi phục
        </button>
      );
    }
    return (
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={(event) => {
          triggerRef.current = event.currentTarget;
          setRejecting(submission);
        }}
      >
        Không chấp nhận
      </button>
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

      {!competitionId && <SubmissionStats stats={data?.stats ?? null} pending={!data && !error} />}

      {/* Bảng khóa cuộc thi không có ô lọc cuộc thi nên giữ nguyên lưới bộ lọc gốc. */}
      <form
        className={`results-filters${competitionId ? "" : " admin-submissions-filters"}`}
        onSubmit={applySearch}
      >
        {!competitionId && (
          <select
            className="input"
            aria-label="Lọc theo cuộc thi"
            value={query.competition_id}
            onChange={(event) => changeFilters({ competition_id: event.target.value })}
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
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          className="input"
          aria-label="Lọc theo trạng thái chấm"
          value={query.status}
          onChange={(event) => changeFilters({ status: event.target.value })}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className="input"
          aria-label="Lọc theo trạng thái duyệt"
          value={query.review}
          onChange={(event) => changeFilters({ review: event.target.value })}
        >
          {REVIEW_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className="input"
          aria-label="Lọc theo kết luận AI"
          value={query.ai_review}
          onChange={(event) =>
            changeFilters({ ai_review: event.target.value as AiReviewFilter })
          }
        >
          {AI_FILTER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
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

      {message && (
        <div className="status-banner success admin-submissions-banner" role="status">
          <span>{message}</span>
        </div>
      )}

      {/* Polling tự dừng sau ngân sách lượt: nói rõ để không bị đọc thành "AI đã chạy xong". */}
      {pollExhausted && (
        <div className="status-banner warning admin-submissions-banner" role="status">
          <span>Đã tạm dừng tự động làm mới sau nhiều lượt chờ. Bảng có thể chưa hiện kết quả mới nhất.</span>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => requestPage(query.offset)}
          >
            Làm mới
          </button>
        </div>
      )}

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
                {!competitionId && sortableHeader("competition", "Cuộc thi")}
                {sortableHeader("team", "Đội")}
                <th scope="col">Tệp đã nộp</th>
                <th scope="col">Trạng thái</th>
                <th scope="col">AI sơ bộ</th>
                <th scope="col">Xét duyệt</th>
                <th scope="col">Thao tác</th>
                {sortableHeader("f1", "F1", "score-cell")}
                {sortableHeader("precision", "Precision", "score-cell")}
                {sortableHeader("recall", "Recall", "score-cell")}
                {sortableHeader("primary_score", "Điểm chính", "score-cell primary-col")}
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
                  <td className="subm-ai-cell">{aiCell(submission)}</td>
                  <td className="subm-review-cell">{reviewCell(submission)}</td>
                  <td className="subm-action-cell">{actionCell(submission)}</td>
                  <td className="score-cell">{formatScore(submission.metrics?.f1)}</td>
                  <td className="score-cell">{formatScore(submission.metrics?.precision)}</td>
                  <td className="score-cell">{formatScore(submission.metrics?.recall)}</td>
                  <td className="score-cell primary-score primary-col">
                    {formatScore(submission.primary_score)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="admin-results-empty">
          {/* Chưa có dữ liệu khác hẳn bị lọc hết: câu chữ "không phù hợp" ở đây gây hiểu nhầm. */}
          {hasFilters ? (
            <>
              <p>Không có bài nộp phù hợp.</p>
              <button className="btn btn-secondary btn-sm" type="button" onClick={clearFilters}>
                Xóa bộ lọc
              </button>
            </>
          ) : (
            <p>Chưa có bài nộp nào.</p>
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

      {rejecting && (
        <SubmissionRejectModal
          submission={rejecting}
          onConfirm={rejectSubmission}
          onClose={() => setRejecting(null)}
          returnFocusRef={triggerRef}
        />
      )}

      {aiDetail && (
        <AiReviewDetailModal
          submission={aiDetail}
          // Chạy lại đổi projection của dòng đang mở: làm mới bảng để cột AI khớp lại.
          onChanged={() => requestPage(query.offset)}
          onClose={() => setAiDetail(null)}
          returnFocusRef={triggerRef}
        />
      )}

      {restoring && (
        <ConfirmModal
          title="Khôi phục bài nộp"
          body={`Khôi phục bài nộp của ${restoring.account.name} về trạng thái hợp lệ? Bài không được chấm lại và lượt nộp đã dùng không thay đổi.`}
          confirmLabel="Khôi phục"
          onConfirm={restoreSubmission}
          onClose={() => setRestoring(null)}
          returnFocusRef={triggerRef}
        />
      )}
    </section>
  );
}

const STAT_TONES = ["blue", "red", "yellow", "green"] as const;

/** Bốn thẻ tổng quan của bảng toàn cục; `value` null nghĩa là chưa có dữ liệu. */
function SubmissionStats({
  stats,
  pending,
}: {
  stats: AdminSubmissionsResponse["stats"] | null;
  pending: boolean;
}) {
  return (
    <section className="admin-accounts-stats" aria-label="Tổng quan bài nộp">
      <StatCard
        tone={STAT_TONES[0]}
        label="Tổng bài nộp"
        detail="Trong bộ lọc hiện tại"
        value={stats?.total ?? null}
        pending={pending}
        glyph={<IconSubmission />}
      />
      <StatCard
        tone={STAT_TONES[1]}
        label="Cuộc thi"
        detail="Có bài nộp trong bộ lọc"
        value={stats?.competitions ?? null}
        pending={pending}
        glyph={<IconTrophy />}
      />
      <StatCard
        tone={STAT_TONES[2]}
        label="Đội đã nộp"
        detail="Tài khoản có bài nộp"
        value={stats?.teams ?? null}
        pending={pending}
        glyph={<IconTeam />}
      />
      {/* Bài bị từ chối vẫn đã chấm điểm nhưng không nằm trong con số này. */}
      <StatCard
        tone={STAT_TONES[3]}
        label="Được tính kết quả"
        detail="Bài đã chấm và được chấp nhận"
        value={stats?.completed ?? null}
        pending={pending}
        glyph={<IconScored />}
      />
    </section>
  );
}

/** `value` null nghĩa là chưa có dữ liệu - không được hiện số giả. */
function StatCard({
  tone,
  label,
  detail,
  value,
  pending,
  glyph,
}: {
  tone: (typeof STAT_TONES)[number];
  label: string;
  detail: string;
  value: number | null;
  pending: boolean;
  glyph: ReactNode;
}) {
  return (
    <article className="admin-account-stat" data-tone={tone}>
      <span className="admin-account-stat-icon" aria-hidden="true">{glyph}</span>
      <div className="admin-account-stat-body">
        <p className="admin-account-stat-label">{label}</p>
        {value === null ? (
          <>
            <span className="admin-account-stat-placeholder" aria-hidden="true" />
            <span className="sr-only">{pending ? "Đang tải thống kê" : "Chưa tải được thống kê"}</span>
          </>
        ) : (
          <span className="admin-account-stat-value">{value}</span>
        )}
        <p className="admin-account-stat-detail">{detail}</p>
      </div>
    </article>
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
    <Glyph className={className}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5" />
      <path d="m9 14.5 2 2 4-4.5" />
    </Glyph>
  );
}

function IconTrophy({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" />
      <path d="M7 5.5H4.5v1.2a3 3 0 0 0 2.7 3M17 5.5h2.5v1.2a3 3 0 0 1-2.7 3" />
      <path d="M12 14v3.5M8.5 20.5h7l-.8-3h-5.4l-.8 3Z" />
    </Glyph>
  );
}

function IconTeam({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M3.5 19.5v-1a4.3 4.3 0 0 1 4.3-4.3h2.4a4.3 4.3 0 0 1 4.3 4.3v1" />
      <path d="M16.4 4.9a3.4 3.4 0 0 1 0 6.2M17.6 14.4a4.3 4.3 0 0 1 3.1 4.1v1" />
    </Glyph>
  );
}

function IconScored({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.4 12.3 2.4 2.4 4.8-5.2" />
    </Glyph>
  );
}

/** Icon dùng chung khung SVG; mọi glyph đều decorative nên ẩn khỏi cây accessibility. */
function Glyph({ className, children }: { className?: string; children: ReactNode }) {
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
      {children}
    </svg>
  );
}
