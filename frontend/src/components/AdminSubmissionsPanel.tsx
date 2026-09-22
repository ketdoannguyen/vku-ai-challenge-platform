/**
 * Danh sách bài nộp dành cho admin, dùng chung cho hai chỗ:
 * - Trang toàn cục `/admin/submissions`: thẻ thống kê, bộ lọc và trường cuộc thi đều bật.
 * - Tab Kết quả của một cuộc thi: đã khóa vào cuộc thi hiện tại nên ẩn cả ba.
 *
 * Mỗi bài nộp là MỘT thẻ hai tầng: tầng đầu để nhận diện (thời gian, cuộc thi, đội, kết quả),
 * tầng sau để xử lý và phán quyết (tệp, AI, xét duyệt, trạng thái chấm, thao tác). Bảng 12 cột
 * cũ phải cuộn ngang ở 1480px nên không đọc nổi trên màn hẹp.
 *
 * Chiều cao là ràng buộc chính: trong mỗi tầng không giá trị nào được xếp chồng lên nhau, nên
 * nhãn `dt` nằm trên còn `dd` là một dòng ngang. Ba trạng thái (chấm điểm, AI, xét duyệt) chỉ
 * còn icon - hình dạng và màu nói kết luận, chữ nằm trong tooltip và `aria-label` - vì badge
 * chữ chiếm chỗ mà thông tin thì đã có nhãn `dt` ngay cạnh.
 *
 * Lọc, sắp xếp và phân trang đều chạy phía server để tổng số luôn khớp bộ lọc.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import {
  AI_FILTER_OPTIONS,
  AI_STATE_LABEL,
  AI_VERDICT_LABEL,
  AI_VERDICT_TONE,
  hasPendingAiReview,
  type AiReviewFilter,
  type AiVerdict,
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
  type Metrics,
  type ReviewPayload,
} from "../api/results";
import { usePendingPolling } from "../hooks/usePendingPolling";
import { AiReviewDetailModal } from "./AiReviewDetailModal";
import { ArtifactLinks } from "./ArtifactLinks";
import { ConfirmModal } from "./Modal";
import { SubmissionRejectModal } from "./SubmissionReviewModal";
import { ErrorBox } from "./ui";

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

/**
 * Trường sắp xếp của thanh "Sắp xếp theo". Bảng khóa cuộc thi đã biết sẵn cuộc thi của mọi
 * dòng nên bỏ hẳn lựa chọn này thay vì để nó sắp xếp một trường hằng số.
 */
const SORT_OPTIONS: Array<{ value: AdminSortField; label: string; globalOnly?: boolean }> = [
  { value: "created_at", label: "Thời gian" },
  { value: "competition", label: "Cuộc thi", globalOnly: true },
  { value: "team", label: "Đội" },
  { value: "primary_score", label: "Điểm chính" },
  { value: "f1", label: "F1" },
  { value: "precision", label: "Precision" },
  { value: "recall", label: "Recall" },
];

/** Ba metric phụ; Điểm chính đứng riêng vì là metric chính của cuộc thi. */
const METRIC_FIELDS: Array<{ key: keyof Metrics; label: string }> = [
  { key: "f1", label: "F1" },
  { key: "precision", label: "Precision" },
  { key: "recall", label: "Recall" },
];

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
  listLabel,
}: {
  /** Có cuộc thi thì danh sách khóa vào cuộc thi đó: ẩn bộ lọc, trường cuộc thi và thẻ thống kê. */
  competitionId?: string;
  title: string;
  listLabel: string;
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

  /** Chọn trường khác thì về thứ tự mặc định của trường đó, không giữ chiều của trường cũ. */
  function selectSort(field: AdminSortField) {
    setQuery((current) =>
      current.sort === field
        ? current
        : { ...current, sort: field, order: DEFAULT_ORDER[field], offset: 0 },
    );
  }

  /** Đảo chiều của trường đang chọn; đây là cách duy nhất để lật chiều. */
  function toggleOrder() {
    setQuery((current) => ({
      ...current,
      order: current.order === "desc" ? "asc" : "desc",
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

  /**
   * Trạng thái chấm điểm. Chữ nằm trong tooltip; thông báo lỗi của lượt chấm cũng theo vào đó
   * thay vì chiếm một dòng riêng trong thẻ.
   */
  function statusCell(submission: AdminSubmissionItem) {
    const tone = statusTone(submission);
    if (submission.status === "completed") {
      return <StatusBadge tone={tone} glyph="check" label={SUBMISSION_STATUS_LABEL.completed} />;
    }
    if (submission.status === "failed") {
      return (
        <StatusBadge
          tone={tone}
          glyph="alert"
          label={SUBMISSION_STATUS_LABEL.failed}
          tip={submission.error?.message}
        />
      );
    }
    return <StatusBadge tone={tone} glyph="cross" label={SUBMISSION_STATUS_LABEL.rejected} />;
  }

  /**
   * Trạng thái duyệt của một dòng. Record chưa chấm được điểm (`failed`/`rejected` legacy) không
   * bao giờ xét duyệt được nên hiển thị gạch, tránh bị đọc thành "hợp lệ".
   *
   * Lý do, người duyệt và thời điểm đi hết vào tooltip: lý do có thể dài tới 1000 ký tự nên nếu
   * để trong thẻ thì mọi hàng bị từ chối sẽ cao gấp ba lần các hàng còn lại.
   */
  function reviewCell(submission: AdminSubmissionItem) {
    const tone = reviewTone(submission);
    if (submission.status !== "completed") {
      return <StatusBadge tone={tone} glyph="dash" label="Không xét duyệt được" />;
    }
    if (!submission.review) {
      return <StatusBadge tone={tone} glyph="check" label="Hợp lệ" />;
    }
    const rejected = submission.review.status === "rejected";
    return (
      <StatusBadge
        tone={tone}
        glyph={rejected ? "cross" : "check"}
        label={REVIEW_STATUS_LABEL[submission.review.status]}
        tip={[submission.review.note, `${submission.review.reviewed_by.name} · ${formatLocal(submission.review.reviewed_at)}`]
          .filter(Boolean)
          .join("\n")}
      />
    );
  }

  /**
   * Ô AI chỉ để đọc. Bài nộp từ lúc cuộc thi chưa bật AI không có projection - hiển thị là
   * "Chưa đánh giá" chứ không phải "Không phát hiện": thiếu dữ liệu không phải bằng chứng sạch.
   * Nút vẫn phải có: đó là đường duy nhất để BTC khởi tạo lượt kiểm tra cho bài cũ, vì reconciler
   * cố ý không tự chạy cho bài thiếu desired state.
   */
  function aiCell(submission: AdminSubmissionItem) {
    const projection = submission.ai_review;
    const tone = aiTone(submission);
    const tip = projection?.updated_at ? `Cập nhật ${formatLocal(projection.updated_at)}` : undefined;
    return (
      <>
        {projection ? (
          projection.verdict ? (
            <StatusBadge
              tone={tone}
              glyph={AI_VERDICT_GLYPH[projection.verdict]}
              label={AI_VERDICT_LABEL[projection.verdict]}
              tip={tip}
            />
          ) : (
            <StatusBadge tone={tone} glyph="clock" label={AI_STATE_LABEL[projection.state]} tip={tip} />
          )
        ) : (
          <StatusBadge tone={tone} glyph="dash" label="Chưa đánh giá" />
        )}
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={(event) => {
            triggerRef.current = event.currentTarget;
            setAiDetail(submission);
          }}
        >
          <ButtonIcon>
            <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
            <circle cx="12" cy="12" r="3" />
          </ButtonIcon>
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
          <ButtonIcon>
            <path d="M3 2v6h6" />
            <path d="M3.5 15a9 9 0 1 0 2.1-9.4L3 8" />
          </ButtonIcon>
          Khôi phục
        </button>
      );
    }
    return (
      <button
        type="button"
        className="btn btn-danger-outline btn-sm"
        onClick={(event) => {
          triggerRef.current = event.currentTarget;
          setRejecting(submission);
        }}
      >
        <ButtonIcon>
          <circle cx="12" cy="12" r="9" />
          <path d="m5.6 5.6 12.8 12.8" />
        </ButtonIcon>
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
        {/* Nút này gọi đúng đường tải lại mà nút trong băng "tạm dừng tự động làm mới" đang gọi;
            khác chỗ nó luôn có mặt nên BTC chủ động làm mới được bất cứ lúc nào, không phải chờ
            polling cạn ngân sách. Khóa lúc đang tải để hai lượt gọi không chồng nhau. */}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => requestPage(query.offset)}
          disabled={busy}
        >
          <ButtonIcon>{REFRESH_PATHS}</ButtonIcon>
          Làm mới
        </button>
      </div>

      {!competitionId && <SubmissionStats stats={data?.stats ?? null} pending={!data && !error} />}

      {/* Lưới bộ lọc tự dồn cột nên chế độ khóa cuộc thi chỉ đơn giản là bớt một ô. */}
      <form className="results-filters" onSubmit={applySearch}>
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
        // Khung xương thay vòng xoay: ba thẻ giữ đúng nhịp dọc của danh sách thật nên lúc dữ
        // liệu về trang không nhảy. Con số ba chỉ là chiều cao khung nhìn thường thấy, không
        // phải con số nghiệp vụ nào. Chữ báo đang tải vẫn còn cho trình đọc màn hình.
        <>
          <span className="sr-only" role="status">
            Đang tải danh sách bài nộp...
          </span>
          <div className="subm-skeleton" aria-hidden="true">
            {[0, 1, 2].map((row) => (
              <span key={row} className="subm-skeleton-card" />
            ))}
          </div>
        </>
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
        <div aria-busy={busy} role="region" aria-label={listLabel}>
          {/* Sắp xếp chạy phía server nên đứng ngoài thẻ: mỗi thẻ không còn tiêu đề cột để bấm. */}
          <div className="subm-sort-bar">
            <div className="subm-sort-field">
              <label className="subm-sort-label" htmlFor="subm-sort-select">
                Sắp xếp theo
              </label>
              <select
                id="subm-sort-select"
                className="input"
                value={query.sort}
                onChange={(event) => selectSort(event.target.value as AdminSortField)}
              >
                {SORT_OPTIONS.filter((option) => !option.globalOnly || !competitionId).map(
                  (option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ),
                )}
              </select>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm subm-sort-direction"
              onClick={toggleOrder}
            >
              <SortArrow descending={query.order === "desc"} />
              {query.order === "desc" ? "Giảm dần" : "Tăng dần"}
            </button>
          </div>

          <ul className="subm-list">
            {data.submissions.map((submission) => (
              <li key={submission.id} className={`subm-card subm-card-${cardTone(submission)}`}>
                <article className="subm-card-body">
                  <dl className="subm-card-tier">
                    <div className="subm-field">
                      <dt>Thời gian</dt>
                      <dd>
                        <BlockIcon tone="blue">{CALENDAR_PATHS}</BlockIcon>
                        <span>{formatLocal(submission.created_at)}</span>
                      </dd>
                    </div>
                    {!competitionId && (
                      <div className="subm-field subm-field-grow">
                        <dt>Cuộc thi</dt>
                        <dd>
                          <BlockIcon tone="blue">{TROPHY_PATHS}</BlockIcon>
                          {/* Cuộc thi đã xóa trả slug rỗng và không còn trang để mở; slug chỉ dùng
                              làm phép thử đó, không hiện ra nữa. */}
                          {submission.competition?.slug ? (
                            <Link
                              to={`/admin/competitions/${submission.competition.id}`}
                              title={submission.competition.name}
                              className="subm-truncate"
                            >
                              {submission.competition.name}
                            </Link>
                          ) : (
                            <span>{submission.competition?.name}</span>
                          )}
                        </dd>
                      </div>
                    )}
                    <div className="subm-field subm-field-grow">
                      <dt>Đội</dt>
                      <dd>
                        <BlockIcon tone="gold">{TEAM_PATHS}</BlockIcon>
                        <strong className="subm-truncate">{submission.account.name}</strong>
                        <span className="subm-muted subm-truncate">{submission.account.email}</span>
                      </dd>
                    </div>
                    {/* Điểm chính đứng riêng khỏi cụm chỉ số: đây là con số duy nhất dùng để xếp
                        hạng, để lẫn với F1/Precision/Recall thì nó không còn nổi nữa. */}
                    <div className="subm-field">
                      <dt>Điểm chính</dt>
                      <dd>
                        <span className="subm-score">
                          <BlockIcon tone="gold">{STAR_PATHS}</BlockIcon>
                          <span className="subm-result-primary-score">
                            {formatScore(submission.primary_score)}
                          </span>
                        </span>
                      </dd>
                    </div>
                    <div className="subm-field subm-field-result">
                      <dt>Kết quả</dt>
                      <dd>
                        <BlockIcon tone="blue">{CHART_PATHS}</BlockIcon>
                        <span className="subm-result-metrics">
                          {METRIC_FIELDS.map((metric) => (
                            <span key={metric.key} className="subm-metric">
                              <span className="subm-metric-label">{metric.label}</span>
                              <span className="subm-metric-value">
                                {formatScore(submission.metrics?.[metric.key])}
                              </span>
                            </span>
                          ))}
                        </span>
                      </dd>
                    </div>
                  </dl>

                  {/* Ba trục phán quyết đứng liền nhau và theo đúng thứ tự đọc: chấm xong chưa
                      (Trạng thái) → máy nói gì (AI sơ bộ) → người chốt gì (Xét duyệt). Mỗi trục là
                      một badge tự tô theo kết luận của chính nó; vạch nhấn lề trái thẻ vẫn giữ
                      mức nặng nhất trong ba, nên thẻ có tín hiệu tổng và từng trục có tín hiệu
                      riêng, không chỗ nào phải suy ra từ chỗ khác. */}
                  <dl className="subm-card-tier subm-card-tier-detail">
                    <div className="subm-field">
                      <dt>Tệp đã nộp</dt>
                      <dd>
                        <ArtifactLinks
                          basePath="/admin/submissions"
                          submissionId={submission.id}
                          artifacts={submission.artifacts}
                        />
                      </dd>
                    </div>
                    <div className="subm-field">
                      <dt>Trạng thái</dt>
                      <dd>{statusCell(submission)}</dd>
                    </div>
                    <div className="subm-field">
                      <dt>AI sơ bộ</dt>
                      <dd>{aiCell(submission)}</dd>
                    </div>
                    <div className="subm-field">
                      <dt>Xét duyệt</dt>
                      <dd>{reviewCell(submission)}</dd>
                    </div>
                    <div className="subm-field">
                      <dt>Thao tác</dt>
                      <dd>{actionCell(submission)}</dd>
                    </div>
                  </dl>
                </article>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="admin-results-empty">
          <BlockIcon tone="blue">{FILE_SEARCH_PATHS}</BlockIcon>
          {/* Chưa có dữ liệu khác hẳn bị lọc hết: câu chữ "không phù hợp" ở đây gây hiểu nhầm. */}
          {hasFilters ? (
            <>
              <p>Không có bài nộp phù hợp.</p>
              <p className="admin-results-empty-hint">
                Thử thay đổi bộ lọc hoặc từ khóa tìm kiếm.
              </p>
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

/** Tông màu của icon trạng thái; chỉ dùng token sẵn có, không tự đặt mã màu mới. */
type IconTone = "success" | "danger" | "warning" | "info" | "muted";

/**
 * Hình dạng glyph, tách hẳn khỏi màu. Mỗi kết luận có một hình riêng nên người không phân biệt
 * được màu vẫn đọc ra kết luận - màu chỉ là kênh phụ.
 */
type Glyph = "check" | "cross" | "alert" | "question" | "clock" | "dash";

const GLYPHS: Record<Glyph, ReactNode> = {
  check: <path d="m5.4 12.6 4.4 4.4 8.8-9.4" />,
  cross: (
    <>
      <path d="M6.6 6.6 17.4 17.4" />
      <path d="M17.4 6.6 6.6 17.4" />
    </>
  ),
  alert: (
    <>
      <path d="M12 5.6v9.2" />
      <path d="M12 18.6h.01" />
    </>
  ),
  question: (
    <>
      <path d="M9.3 9.4a2.8 2.8 0 1 1 3.4 2.9c-.9.2-1.7.8-1.7 1.8v.7" />
      <path d="M11 18.6h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3.1 2" />
    </>
  ),
  dash: <path d="M8 12h8" />,
};

/** Hình dạng theo kết luận AI: ba mức khác nhau phải khác hình, không chỉ khác màu. */
const AI_VERDICT_GLYPH: Record<AiVerdict, Glyph> = {
  CLEAR: "check",
  FLAGGED: "alert",
  INCONCLUSIVE: "question",
  ERROR: "clock",
};

/** Tone của vạch nhấn ở lề thẻ. Chỉ ba mức, vì vạch thẻ là tín hiệu "bài này có gì đáng xem không". */
type CardTone = "success" | "warning" | "danger";

/**
 * Tone của từng trục phán quyết, tách khỏi hàm dựng icon vì cùng một kết luận phải tô cả icon lẫn
 * vạch nhấn của thẻ. Để mỗi chỗ tự suy ra thì sớm muộn icon và vạch cũng lệch màu.
 */
function statusTone(submission: AdminSubmissionItem): IconTone {
  return submission.status === "completed" ? "success" : "danger";
}

function reviewTone(submission: AdminSubmissionItem): IconTone {
  // Chưa chấm được điểm thì không có gì để xét duyệt - không phải "chờ duyệt".
  if (submission.status !== "completed") return "muted";
  return submission.review?.status === "rejected" ? "danger" : "success";
}

function aiTone(submission: AdminSubmissionItem): IconTone {
  const projection = submission.ai_review;
  if (!projection) return "muted";
  return projection.verdict ? AI_VERDICT_TONE[projection.verdict] : "info";
}

/**
 * Mức nặng nhất trong ba trục: đỏ > vàng > xanh. Cố ý không lấy trục "chính": một bài bị AI gắn
 * cờ nhưng người chưa xét duyệt vẫn cần được nhìn thấy. Suy thẳng từ ba tone chứ không tự đặt lại
 * thang mức, nếu không vạch nhấn và icon sẽ lệch nhau ở lần đổi thang sau.
 */
function cardTone(submission: AdminSubmissionItem): CardTone {
  const tones = [statusTone(submission), aiTone(submission), reviewTone(submission)];
  if (tones.includes("danger")) return "danger";
  if (tones.includes("warning")) return "warning";
  return "success";
}

/** Toạ độ khung nhìn của tooltip đang mở; `null` là đóng. */
type TipAnchor = { left: number; top: number };

/**
 * Một trạng thái trong thẻ bài nộp: badge gồm hình dạng, màu và chữ.
 *
 * Chữ đứng ngay cạnh icon chứ không giấu sau hover. Hình dạng và màu vẫn là kênh chính - người
 * không phân biệt được màu đọc ra kết luận bằng hình - nhưng chữ nói thẳng kết luận nên không
 * phải trỏ chuột mới biết, và trên thiết bị cảm ứng thì không có hover để mà trỏ.
 *
 * Tooltip chỉ còn chở phần chi tiết dài (lý do xét duyệt, thời điểm AI cập nhật) chứ không lặp
 * lại nhãn. Nó là phần tử thật chứ không phải `::after` vì phải đặt được theo vị trí icon: hộp
 * bám thẳng vào icon bằng CSS thì tràn ra ngoài khung nhìn khi icon nằm sát lề (đo được 38px ở
 * dải 1000-1159px và hơn 100px ở 375px), còn bám vào thẻ thì hộp lại nằm tận lề trái, xa icon.
 * Chỉ chuột mở được tooltip nên không thêm tab stop nào cho mỗi thẻ.
 */
function StatusBadge({
  tone,
  glyph,
  label,
  tip,
}: {
  tone: IconTone;
  glyph: Glyph;
  label: string;
  tip?: string;
}) {
  const tipRef = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<TipAnchor | null>(null);

  /**
   * Toạ độ chốt lúc trỏ vào, còn icon thì trôi theo trang khi cuộn. Cuộn mà chuột đứng yên trên
   * icon thì không có `mouseleave` nào để đóng, hộp ở lại một mình và nói về chỗ khác. Đóng hộp
   * khi trang cuộn hoặc đổi bề rộng là cách rẻ nhất để điều đó không xảy ra. Chỉ icon đang mở
   * mới gắn listener nên cùng lúc có tối đa một cặp listener.
   */
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    // `capture` để bắt cả cuộn của khung cuộn lồng bên trong, không riêng `window`.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [anchor]);

  /** Đặt tooltip ngay trên icon vừa trỏ vào rồi kẹp vào trong khung nhìn. */
  function openTip(event: MouseEvent<HTMLSpanElement>) {
    const box = tipRef.current;
    if (!box) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const gap = 8;
    const above = rect.top - gap - box.offsetHeight;
    setAnchor({
      // Kẹp ngang: hộp rộng hơn phần còn lại của khung nhìn thì dạt vào, không tràn ra ngoài.
      left: Math.min(
        Math.max(rect.left, gap),
        Math.max(gap, window.innerWidth - gap - box.offsetWidth),
      ),
      // Thiếu chỗ phía trên (icon ở sát mép trên) thì lật xuống dưới icon.
      top: above >= gap ? above : rect.bottom + gap,
    });
  }

  return (
    <span
      className={`subm-badge subm-badge-${tone}`}
      role="img"
      aria-label={label}
      onMouseEnter={tip ? openTip : undefined}
      onMouseLeave={tip ? () => setAnchor(null) : undefined}
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {GLYPHS[glyph]}
      </svg>
      {/* `role="img"` + `aria-label` khiến trình đọc màn hình đọc kết luận đúng một lần và bỏ
          qua phần chữ này, nên chữ ở đây chỉ phục vụ mắt thường. */}
      <span className="subm-badge-label">{label}</span>
      {/* Chỉ dựng khi thật sự có phần chi tiết: không có gì để mở thì cũng không cần hộp.
          Lúc có, hộp phải nằm sẵn trong DOM kể cả khi đóng vì `openTip` phải đo được bề ngang
          bề cao của nó trước khi biết đặt ở đâu. */}
      {tip && (
        <span
          ref={tipRef}
          className={anchor ? "subm-tip subm-tip-open" : "subm-tip"}
          style={anchor ?? undefined}
        >
          {tip}
        </span>
      )}
    </span>
  );
}

/** Mũi tên chiều sắp xếp đang áp dụng, nằm trong nút đảo chiều. */
function SortArrow({ descending }: { descending: boolean }) {
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
      <path d={descending ? "M6 9l6 6 6-6" : "M6 15l6-6 6 6"} />
    </svg>
  );
}

/**
 * Icon 14px đứng trước chữ trong nút thao tác. Nút luôn có nhãn chữ nên icon là trang trí và
 * bị ẩn khỏi cây accessibility; giữ ẩn cũng để tên nút không đổi khi thêm/bớt icon.
 */
function ButtonIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/**
 * Ô icon đứng trước giá trị của một trường ở tầng nhận diện. Ô nền màu là thứ phân biệt nhanh
 * "đây là thời gian / đội / điểm" khi mắt quét cả danh sách, nên nó chỉ là trang trí: `aria-hidden`
 * để trình đọc màn hình không đọc thêm một tên không mang thông tin gì mới.
 *
 * Cao đúng bằng badge trạng thái ở tầng dưới để hai tầng có cùng nhịp dọc.
 */
function BlockIcon({ tone, children }: { tone: "blue" | "gold"; children: ReactNode }) {
  return (
    <span className={`subm-block-icon subm-block-icon-${tone}`} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        {children}
      </svg>
    </span>
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

/** Nét vẽ dùng chung cho cả icon tiêu đề (20px) lẫn ô icon trong thẻ (16px). */
const TROPHY_PATHS = (
  <>
    <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" />
    <path d="M7 5.5H4.5v1.2a3 3 0 0 0 2.7 3M17 5.5h2.5v1.2a3 3 0 0 1-2.7 3" />
    <path d="M12 14v3.5M8.5 20.5h7l-.8-3h-5.4l-.8 3Z" />
  </>
);

const TEAM_PATHS = (
  <>
    <circle cx="9" cy="8" r="3.4" />
    <path d="M3.5 19.5v-1a4.3 4.3 0 0 1 4.3-4.3h2.4a4.3 4.3 0 0 1 4.3 4.3v1" />
    <path d="M16.4 4.9a3.4 3.4 0 0 1 0 6.2M17.6 14.4a4.3 4.3 0 0 1 3.1 4.1v1" />
  </>
);

const CALENDAR_PATHS = (
  <>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
    <path d="M3.5 10h17M8 3v3.5M16 3v3.5" />
    <path d="M12 13v2.6l1.9 1.1" />
  </>
);

const STAR_PATHS = <path d="m12 3.6 2.6 5.3 5.8.9-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.6 9.8l5.8-.9Z" />;

const CHART_PATHS = (
  <>
    <path d="M4 4v16h16" />
    <path d="M9.5 20v-7M14 20V7M18.5 20v-4.5" />
  </>
);

const REFRESH_PATHS = (
  <>
    <path d="M3.5 12a8.5 8.5 0 0 1 14.4-6.1" />
    <path d="M18 2.5v4h-4" />
    <path d="M20.5 12a8.5 8.5 0 0 1-14.4 6.1" />
    <path d="M6 21.5v-4h4" />
  </>
);

const FILE_SEARCH_PATHS = (
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5" />
    <circle cx="11" cy="14.6" r="2.3" />
    <path d="m12.7 16.3 2.1 2.1" />
  </>
);

function IconTrophy({ className }: { className?: string }) {
  return <Glyph className={className}>{TROPHY_PATHS}</Glyph>;
}

function IconTeam({ className }: { className?: string }) {
  return <Glyph className={className}>{TEAM_PATHS}</Glyph>;
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
