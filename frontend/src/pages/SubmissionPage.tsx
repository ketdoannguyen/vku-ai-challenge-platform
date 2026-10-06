import { useEffect, useState, type FormEvent } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import type { ParticipantAiReview } from "../api/aiReview";
import { ApiClientError, api } from "../api/client";
import {
  PARTICIPANT_WINDOW_LABEL,
  TRACK_BLOCKED_MESSAGE,
  TRACKS,
  TRACK_LABEL,
  UNPUBLISHED_RESULT_LABEL,
  accessLostReason,
  formatLocal,
  isDual,
  isSafeResourceUrl,
  parseTrack,
  unpublishedNote,
  type ParticipantTrackView,
  type Track,
} from "../api/competitions";
import { formatMetric, resultContract, type Metrics } from "../api/results";
import { ConfirmModal } from "../components/Modal";
import { TrackCard } from "../components/TrackCard";
import { ErrorBox, FileButton } from "../components/ui";
import { useDeadlineClock } from "../hooks/useCountdown";
import {
  currentNormHiddenReason,
  hiddenNormNote,
  PROVISIONAL_NORM_LABEL,
} from "../lib/normalization";
import { SUBMISSION_PITFALLS, submissionSchema } from "../lib/submissionRequirements";
import type { CompetitionContext } from "./CompetitionDetailPage";

interface SubmissionResult {
  id: string;
  competition_id: string;
  status: "completed";
  /** Bộ khóa do bộ chấm của cuộc thi quyết định; hiển thị theo hợp đồng kết quả. */
  metrics: Metrics;
  /** `null` khi chỉ số chính bị admin ẩn khỏi thí sinh. */
  primary_score: number | null;
  created_at: string;
  quota_remaining: number;
  /** Vắng mặt khi cuộc thi chưa bật AI hoặc không công khai kết luận cho thí sinh. */
  ai_review?: ParticipantAiReview;
  /** Norm tạm chốt một lần lúc bài được ghi nhận; vắng khi cuộc thi không bật norm hoặc bị ẩn. */
  normalization_snapshot?: { score: number; calculated_at: string };
  /**
   * Dual: `hidden` khi kết quả đã chấm nhưng chưa được công bố - metrics rỗng và điểm `null`,
   * khác hẳn bài chưa chấm hay điểm 0. Cuộc thi một nhánh không trả khóa này.
   */
  result_visibility?: "hidden" | "visible";
}

/** Hai part bắt buộc của một lượt nộp - thiếu một trong hai thì backend từ chối. */
type SlotKind = "csv" | "notebook";

const SLOTS: {
  kind: SlotKind;
  /** Tên part trong multipart body - khớp tham số của endpoint nộp bài. */
  part: string;
  label: string;
  prompt: string;
  button: string;
  extensions: string[];
  mimeTypes: string[];
}[] = [
  {
    kind: "csv",
    part: "file",
    label: "Tệp dự đoán (.csv)",
    prompt: "Kéo thả file CSV vào đây hoặc bấm để duyệt",
    button: "Chọn file CSV",
    extensions: [".csv"],
    mimeTypes: ["text/csv"],
  },
  {
    kind: "notebook",
    part: "notebook",
    label: "Notebook (.ipynb)",
    prompt: "Kéo thả notebook Jupyter vào đây hoặc bấm để duyệt",
    button: "Chọn notebook",
    extensions: [".ipynb"],
    mimeTypes: ["application/x-ipynb+json"],
  },
];

/**
 * Một lượt chấm trong hàng đợi (ADR-048): POST trả 202 kèm lượt này, kết quả đến sau ở
 * `submission`. Backend chỉ ghi bài nộp khi lượt còn kịp hạn 60 giây, nên hết hạn là hết cơ hội.
 */
interface Attempt {
  attempt_id: string;
  status: "STAGING" | "QUEUED" | "RUNNING" | "RESOLVING" | "COMPLETED" | "FAILED" | "EXPIRED";
  /** Mốc hạn của cả lượt, tính từ lúc API nhận request. */
  deadline_at: string;
  /** Số thứ tự trong hàng chờ, 1 là lượt kế tiếp; null khi lượt đã rời hàng. */
  queue_position: number | null;
  /** Lý do không thành công, backend luôn kèm khi lượt bị đóng. */
  error: { code: string; message: string } | null;
  submission: SubmissionResult | null;
  /** Nhánh của lượt khi cuộc thi dual; cuộc thi một nhánh không trả khóa này. */
  track?: Track | null;
}

/** Lượt còn đang chờ chấm - còn phải hỏi trạng thái. */
const WAITING_ATTEMPT_STATUSES = new Set<Attempt["status"]>([
  "STAGING",
  "QUEUED",
  "RUNNING",
  "RESOLVING",
]);

/** Lượt đã có kết luận: hết chờ thì thôi hỏi. */
const FINAL_ATTEMPT_STATUSES = new Set<Attempt["status"]>(["COMPLETED", "FAILED", "EXPIRED"]);

/** Nhịp hỏi trạng thái lượt: đủ nhanh để kết quả vừa xong hiện ra, đủ thưa để không dồn request. */
const ATTEMPT_POLL_MS = 1_500;

/** Chốt hạn phía trình duyệt: sau mốc 60 giây backend không ghi bài nộp nào nữa. */
const OUT_OF_TIME = {
  code: "SUBMISSION_EXPIRED",
  message: "Bài nộp quá hạn chờ chấm nên không bị tính lượt. Bạn hãy nộp lại.",
};

export function SubmissionPage() {
  const { competition, refreshCompetition, reportAccessLost } = useOutletContext<CompetitionContext>();
  const dual = isDual(competition);
  const [searchParams, setSearchParams] = useSearchParams();
  // Dual: nhánh đọc từ URL nên deep link/refresh/back giữ nguyên context; thiếu hoặc sai thì
  // yêu cầu chọn, không mặc định nhánh nào. Single không có khái niệm nhánh.
  const track: Track | null = dual ? parseTrack(searchParams.get("track")) : null;
  const trackView: ParticipantTrackView | null =
    track !== null ? competition.tracks?.[track] ?? null : null;
  const [files, setFiles] = useState<Record<SlotKind, File | null>>({
    csv: null,
    notebook: null,
  });
  /** Lượt đang theo dõi: vừa gửi xong, hoặc lượt còn dở nhận lại khi mở trang. */
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  /** `Idempotency-Key` của lần nhấn Nút hiện tại; đổi tệp hoặc đã nhận lượt thì bỏ. */
  const [submitKey, setSubmitKey] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState<SlotKind | null>(null);
  /** Nhánh vừa được yêu cầu đổi sang; chỉ có khi còn tệp/lượt nên phải hỏi trước khi bỏ. */
  const [pendingTrack, setPendingTrack] = useState<Track | null>(null);

  const unavailableMessage = submissionUnavailableMessage(competition, trackView);
  const config = competition.submission_config;
  // Cấu trúc CSV và hợp đồng metric hiển thị trong phần hướng dẫn nhanh; dùng chung với trang Hướng dẫn.
  const schema = submissionSchema(config);
  const contract = resultContract(config);
  const valueColumns = schema.columns
    .filter((column) => column.name !== schema.idColumn)
    .map((column) => column.name);
  // Chỉ có khi backend trả quota (thành viên đang hoạt động, cuộc thi đang mở). Dual trả quota
  // theo từng nhánh nên đọc từ nhánh đang mở; quota cấp cuộc thi chỉ tồn tại ở single.
  const quota = trackView ? trackView.quota : competition.quota;
  const quotaPerDay = trackView ? trackView.quota_per_day : competition.quota_per_day;
  const quotaLabel = quota
    ? `Còn ${quota.remaining}/${quota.per_day} lượt hôm nay`
    : quotaPerDay != null && quotaPerDay > 0
      ? `${quotaPerDay} lượt/ngày`
      : "Không nhận bài nộp";
  // Không có số liệu thì không vẽ thanh - một thanh rỗng sẽ bị đọc thành "hết lượt".
  const quotaPercent =
    quota && quota.per_day > 0 ? Math.round((quota.remaining / quota.per_day) * 100) : 0;
  // Mức còn lại chỉ chọn màu cho thanh; con số bên cạnh mới là kênh thông tin chính.
  const quotaLevel = !quota
    ? "unknown"
    : quota.remaining <= 0
      ? "empty"
      : quota.remaining / quota.per_day >= 0.5
        ? "ok"
        : "low";

  // Đồng hồ của lượt đang chờ: hạn 60 giây là mốc thật của backend, không phải nhịp của trang.
  const clock = useDeadlineClock(attempt ? [attempt.deadline_at] : []);
  const secondsLeft =
    attempt && clock !== null
      ? Math.ceil((new Date(attempt.deadline_at).getTime() - clock) / 1000)
      : null;
  // Quá mốc 60 giây thì backend không ghi bài nộp nào nữa, nên lượt chắc chắn không thành công và
  // sẽ được hoàn hạn mức. RESOLVING là ngoại lệ: hệ thống còn nợ kết luận nên vẫn chờ tiếp.
  const timedOut =
    attempt !== null &&
    attempt.status !== "RESOLVING" &&
    clock !== null &&
    clock >= new Date(attempt.deadline_at).getTime();

  const result = attempt?.submission ?? null;
  // Snapshot norm tạm của lượt này; backend đã lọc theo quyền lúc trả payload.
  const snapshot = result?.normalization_snapshot ?? null;
  // Quyền xem norm đọc từ metadata HIỆN TẠI (capability của nhánh, không phải payload lúc nộp):
  // BTC tắt BXH hoặc ẩn metric nguồn giữa chừng thì snapshot đang giữ trong state cũng bị bỏ.
  const normHidden = currentNormHiddenReason(competition, track);
  const shownSnapshot = snapshot !== null && !normHidden ? snapshot : null;
  // Chỉ giải thích khi thật sự có con số vừa bị thu hồi khỏi màn hình - không rắc copy vô cớ.
  const droppedNormNote =
    snapshot !== null && shownSnapshot === null ? hiddenNormNote(normHidden) : null;
  const waiting = attempt !== null && WAITING_ATTEMPT_STATUSES.has(attempt.status) && !timedOut;
  const failure =
    timedOut && !result
      ? OUT_OF_TIME
      : attempt !== null && FINAL_ATTEMPT_STATUSES.has(attempt.status) && !result
        ? attempt.error
        : null;

  // Đổi nhánh (nút Đổi nhánh, back/forward, bookmark): bộ tệp và lượt đang theo dõi thuộc
  // nhánh cũ nên bị bỏ - không tự dùng lại file để nộp nhánh khác.
  useEffect(() => {
    setFiles({ csv: null, notebook: null });
    setSubmitKey(null);
    setAttempt(null);
    setError(null);
    setPendingTrack(null);
  }, [track]);

  // Mở lại trang giữa chừng (đóng tab, mất mạng): nhận lại đúng lượt đang chờ thay vì nộp lần nữa.
  useEffect(() => {
    if (config.version !== 2 || (dual && track === null)) return;
    let cancelled = false;
    // Lượt của nhánh khác không được nhận lại ở đây: lọc theo nhánh khi cuộc thi dual.
    const scope = track ? `?track=${track}` : "";
    void api
      .get<{ attempts: Attempt[] }>(`/competitions/${competition.id}/submissions/attempts${scope}`)
      .then((data) => {
        if (!cancelled && data.attempts.length > 0) setAttempt(data.attempts[0]);
      })
      .catch(() => {
        // Không đọc được thì thôi: lần nộp sau vẫn tạo lượt mới bình thường.
      });
    return () => {
      cancelled = true;
    };
  }, [competition.id, config.version, dual, track]);

  // Theo dõi lượt tới khi có kết luận. Vòng sau hẹn sau khi vòng trước xong nên request không dồn.
  useEffect(() => {
    if (attempt === null || timedOut || !WAITING_ATTEMPT_STATUSES.has(attempt.status)) return;
    const attemptId = attempt.attempt_id;
    let timer: number | null = null;
    let stopped = false;

    async function poll() {
      try {
        const next = await api.get<Attempt>(
          `/competitions/${competition.id}/submissions/attempts/${attemptId}`,
        );
        if (stopped) return;
        setAttempt(next);
        if (!WAITING_ATTEMPT_STATUSES.has(next.status)) {
          if (next.submission !== null) {
            // Chấm xong: form trở về trạng thái trống và hạn mức ở header được tính lại.
            setFiles({ csv: null, notebook: null });
            void refreshCompetition();
          }
          return;
        }
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiClientError && err.status === 404) {
          // Lượt không còn (cuộc thi bị xoá giữa chừng): trả trang về chỗ nộp bài.
          setAttempt(null);
          setError(err);
          return;
        }
        const lost = accessLostReason(err);
        if (lost !== null) {
          // Quyền đọc vừa mất: nhường shell đóng gate, dừng vòng hỏi trạng thái lượt.
          reportAccessLost(lost);
          return;
        }
        // Lỗi khác chỉ là một vòng hỏng: vòng sau thử lại.
      }
      timer = window.setTimeout(poll, ATTEMPT_POLL_MS);
    }

    timer = window.setTimeout(poll, ATTEMPT_POLL_MS);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [attempt, timedOut, competition.id, refreshCompetition, reportAccessLost]);

  /** Trần và định dạng khác nhau theo từng slot nên luật kiểm tra nằm cùng một chỗ. */
  function rejectReason(kind: SlotKind, selectedFile: File): string | null {
    const limitMb = kind === "csv" ? config.max_upload_mb : config.max_notebook_mb;
    if (selectedFile.size > limitMb * 1024 * 1024) {
      return `Dung lượng file (${formatBytes(selectedFile.size)}) vượt quá giới hạn tối đa ${limitMb} MiB.`;
    }
    const slot = SLOTS.find((item) => item.kind === kind)!;
    const name = selectedFile.name.toLowerCase();
    const nameOk = slot.extensions.some((extension) => name.endsWith(extension));
    // Trình duyệt không phải lúc nào cũng suy ra MIME type (nhất là .ipynb), nên type rỗng bỏ qua.
    const typeOk = !selectedFile.type || slot.mimeTypes.includes(selectedFile.type);
    if (!nameOk && !typeOk) {
      return kind === "csv"
        ? "File không đúng định dạng. Chỉ chấp nhận tệp CSV (.csv)."
        : "File không đúng định dạng. Chỉ chấp nhận notebook Jupyter (.ipynb).";
    }
    return null;
  }

  function selectFile(kind: SlotKind, selectedFile: File | null) {
    // Bộ tệp khác đi nghĩa là lượt nộp khác: key cũ không còn dùng lại được.
    setSubmitKey(null);
    if (!selectedFile) {
      setFiles((current) => ({ ...current, [kind]: null }));
      return;
    }
    const reason = rejectReason(kind, selectedFile);
    if (reason) {
      setError(new Error(reason));
      setFiles((current) => ({ ...current, [kind]: null }));
      return;
    }
    setFiles((current) => ({ ...current, [kind]: selectedFile }));
    setError(null);
    setAttempt(null);
  }

  const ready = SLOTS.every((slot) => files[slot.kind] !== null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || unavailableMessage) return;
    setSubmitting(true);
    setError(null);
    // Cùng một lần nhấn Nút giữ nguyên key: gửi lại sau khi mất mạng nhận đúng lượt cũ, không
    // tạo lượt thứ hai và không tiêu thêm quota.
    const key = submitKey ?? crypto.randomUUID();
    setSubmitKey(key);
    try {
      const response = await api.postFile<Attempt | SubmissionResult>(
        `/competitions/${competition.id}/submissions`,
        Object.fromEntries(SLOTS.map((slot) => [slot.part, files[slot.kind]!])),
        // Nhánh là một phần của lượt nộp: gửi kèm để backend ghi nhận đúng nhánh đang mở.
        track ? { track } : undefined,
        { "Idempotency-Key": key },
      );
      setSubmitKey(null);
      if ("attempt_id" in response) {
        // v2: server đã nhận lượt, từ đây theo dõi bằng `attempt_id`; key không còn cần nữa.
        setAttempt(response);
      } else {
        // v1 chấm ngay trong request nên trả thẳng bài nộp đã xong, không có lượt để theo dõi:
        // gói lại thành lượt hoàn tất để dùng chung một đường render kết quả.
        setAttempt({
          attempt_id: "",
          status: "COMPLETED",
          deadline_at: "",
          queue_position: null,
          error: null,
          submission: response,
        });
        setFiles({ csv: null, notebook: null });
        void refreshCompetition();
      }
    } catch (err) {
      const lost = accessLostReason(err);
      if (lost !== null) {
        // Quyền nộp bài vừa mất: nhường shell đóng gate thay vì chỉ hiện lỗi tại chỗ.
        reportAccessLost(lost);
        return;
      }
      setError(err);
      // Nhánh vừa đóng/ngừng nhận bài giữa lúc gửi: làm mới metadata để băng trạng thái nói
      // đúng. Tệp đã chọn giữ nguyên và không tự chuyển sang nhánh còn mở.
      if (
        err instanceof ApiClientError &&
        (err.code === "SUBMISSION_NOT_OPEN" || err.code === "SUBMISSION_DEADLINE_PASSED")
      ) {
        void refreshCompetition();
      }
    } finally {
      setSubmitting(false);
    }
  }

  /** Đổi nhánh: còn tệp đã chọn hoặc lượt đang chạy thì hỏi trước; đổi nhánh luôn bỏ tệp cũ. */
  function switchTrack(next: Track) {
    if (files.csv || files.notebook || attempt) {
      setPendingTrack(next);
      return;
    }
    setSearchParams({ track: next });
  }

  // Lượt AI còn chạy chỉ là dòng nhắc: điểm số đã xong, còn lượt AI thì xem ở lịch sử bài nộp.
  const aiPending =
    result?.ai_review?.state === "QUEUED" || result?.ai_review?.state === "RUNNING";

  // Dual vào thẳng trang nộp mà chưa chọn nhánh: bắt buộc chọn, không mặc định Public.
  if (dual && track === null) {
    return (
      <section className="submission-page sub-track-choice">
        <div className="sub-header submission-head">
          <h2 className="sub-title">Chọn nhánh để nộp bài</h2>
        </div>
        <div className="track-cards">
          {TRACKS.map((item) => (
            <TrackCard
              key={item}
              competition={competition}
              track={item}
              submitTo={`?track=${item}`}
            />
          ))}
        </div>
      </section>
    );
  }

  return (
    <div className="submission-page sub-workspace">
      {/* Cột trái: Khu vực nộp bài / Kết quả chấm điểm */}
      <div className="sub-main-col">
        <div className="sub-header submission-head">
          <h2 className="sub-title">
            {dual && track ? `Nộp bài dự đoán · Nhánh ${TRACK_LABEL[track]}` : "Nộp bài dự đoán"}
          </h2>
          <p className="sub-lead text-muted">
            Mỗi lượt nộp gồm file CSV dự đoán và notebook tái lập. File được kiểm tra ngay khi
            upload rồi vào hàng đợi chấm.
          </p>
        </div>

        {/* Dual: định vị nhánh đang nộp ngay trên form - nhánh, cửa sổ, hạn nộp, tài nguyên
            riêng và lối đổi nhánh. Đổi nhánh còn tệp/lượt sẽ hỏi xác nhận. */}
        {dual && track && trackView && (
          <div className="sub-track-strip">
            <div className="sub-track-strip-main">
              <span className="chip">Nhánh {TRACK_LABEL[track]}</span>
              <span className={`track-window ${trackView.window_state}`}>
                <span className="track-window-dot" aria-hidden="true" />
                {PARTICIPANT_WINDOW_LABEL[trackView.window_state]}
              </span>
              <span className="sub-track-deadline">Hạn nộp {formatLocal(trackView.end_at)}</span>
            </div>
            <div className="sub-track-strip-side">
              {trackView.resources
                .filter((item) => isSafeResourceUrl(item.url))
                .map((item) => (
                  <a
                    key={item.url}
                    className="btn btn-secondary btn-sm"
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                  >
                    {item.label || "Dữ liệu"}
                  </a>
                ))}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => switchTrack(track === "public" ? "private" : "public")}
              >
                Đổi nhánh
              </button>
            </div>
          </div>
        )}

        {/* Bốn quy định định dạng file xếp một hàng, thanh hạn mức nằm riêng một hàng
            ngang bên dưới để đủ dài mà đọc được tỉ lệ còn lại. */}
        <div className="sub-specs-strip" aria-label="Quy định file submission">
          <div className="sub-spec-item">
            <span className="sub-spec-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" focusable="false">
                <path d="M9 3 7 21M17 3l-2 18M3 9h18M3 15h18" />
              </svg>
            </span>
            <span className="sub-spec-label">Cột ID</span>
            <span className="sub-spec-val">
              <code>{config.id_column ?? "chưa cấu hình"}</code>
            </span>
            <span className="sr-only">ID: {config.id_column ?? "chưa cấu hình"}</span>
          </div>
          <div className="sub-spec-item">
            <span className="sub-spec-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" focusable="false">
                <path d="M4 12h11" />
                <path d="m11 8 4 4-4 4" />
                <path d="M19 4v16" />
              </svg>
            </span>
            <span className="sub-spec-label">Cột Output</span>
            <span className="sub-spec-val">
              {/* v2 không có một cột nhãn cố định: cột dự đoán là các cột khác cột ID trong schema. */}
              <code>{valueColumns.length > 0 ? valueColumns.join(", ") : "chưa cấu hình"}</code>
            </span>
            <span className="sr-only">
              Prediction: {valueColumns.length > 0 ? valueColumns.join(", ") : "chưa cấu hình"}
            </span>
          </div>
          <div className="sub-spec-item">
            <span className="sub-spec-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" focusable="false">
                <rect x="2" y="8" width="20" height="8" rx="4" />
                <circle cx="8" cy="12" r="2.5" />
              </svg>
            </span>
            <span className="sub-spec-label">Định dạng</span>
            <span className="sub-spec-val">
              {/* v2 chấm bằng bộ chấm Python của cuộc thi; average/pos_label là cấu hình của bộ chấm sklearn. */}
              {config.version === 2 ? "Bộ chấm Python" : averageLabel(config.average)}
              {config.version !== 2 && config.average === "binary" && config.pos_label != null && (
                <span className="sub-spec-sub">positive label: {config.pos_label}</span>
              )}
            </span>
          </div>
          <div className="sub-spec-item">
            <span className="sub-spec-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" focusable="false">
                <ellipse cx="12" cy="6" rx="8" ry="3" />
                <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
                <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
              </svg>
            </span>
            <span className="sub-spec-label">Dung lượng</span>
            <span className="sub-spec-val">
              CSV {config.max_upload_mb} MiB{" "}
              <span className="sub-spec-sub">
                notebook tối đa {config.max_notebook_mb} MiB
              </span>
            </span>
          </div>

          <div className="sub-quota">
            <div className="sub-quota-head">
              <span className="sub-spec-label">Hạn mức</span>
              <span className="sub-quota-count">{quotaLabel}</span>
            </div>
            {quota && (
              <div className="sub-quota-track" aria-hidden="true">
                <span
                  className="sub-quota-fill"
                  data-level={quotaLevel}
                  style={{ width: `${quotaPercent}%` }}
                />
              </div>
            )}
          </div>
        </div>

        {/* S06b Banner bị chặn (duy nhất một chỗ hiển thị unavailableMessage để test getByText không bị duplicate) */}
        {unavailableMessage && (
          <div className="sub-blocked-banner status-banner warning" role="status">
            <div className="sub-blocked-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <div className="sub-blocked-content">
              <div className="sub-blocked-head">
                <span className="sub-blocked-title">Tình trạng nộp bài</span>
                <span className="sub-blocked-badge">Đang khóa</span>
              </div>
              <p className="sub-blocked-text">{unavailableMessage}</p>
            </div>
          </div>
        )}

        <ErrorBox error={error} />

        {/* Lượt vừa rồi hỏng hay quá hạn: nói rõ lý do và nhắc lại là không bị tính lượt. */}
        {failure && (
          <div className="error-box" role="alert">
            {failure.message} Lượt này không bị tính vào hạn mức nộp.
          </div>
        )}

        {/* Ba trạng thái của trang: có kết quả (S06c), đang chờ chấm (S06d), hoặc form nộp bài */}
        {result ? (
          <section className="score-result sub-result-view" aria-live="polite">
            <div className="sub-result-header">
              <h3 className="sub-result-title">
                {dual && track
                  ? `Kết quả chấm điểm · Nhánh ${TRACK_LABEL[track]}`
                  : "Kết quả chấm điểm"}
              </h3>
              <p className="sub-result-lead">
                {dual && track
                  ? `Hệ thống đã kiểm tra và đối soát kết quả dự đoán với Ground Truth của nhánh ${TRACK_LABEL[track]}.`
                  : "Hệ thống đã kiểm tra và đối soát kết quả dự đoán với Public Ground Truth."}
              </p>
              {/* Đã chấm nhưng chưa công bố: nói rõ vì sao các ô điểm đang để trống thay vì bỏ im lặng. */}
              {result.result_visibility === "hidden" && (
                <p className="sub-result-ai-note text-muted" role="status">
                  {UNPUBLISHED_RESULT_LABEL}. {unpublishedNote(competition)}
                </p>
              )}
              {/* Kết quả chấm điểm vẫn là nội dung chính; dòng này chỉ báo còn việc chạy nền. */}
              {aiPending && (
                <p className="sub-result-ai-note text-muted" role="status">
                  AI đang kiểm tra notebook (kết quả sơ bộ, không ảnh hưởng điểm số).
                </p>
              )}
            </div>

            <div className="metric-grid sub-result-cards">
              {/* Có norm tạm thì norm là điểm nổi bật; điểm gốc và các metric vẫn xem được bên cạnh. */}
              {shownSnapshot && (
                <div className="metric-card sub-result-card primary" data-metric="normalization">
                  <div className="sub-result-card-top">
                    <span className="sub-result-metric-label">{PROVISIONAL_NORM_LABEL}</span>
                    <span className="sub-result-metric-badge">0–50</span>
                  </div>
                  <div className="sub-result-score">
                    <strong>{formatMetric(shownSnapshot.score, 2)}</strong>
                  </div>
                </div>
              )}
              {contract.metrics.map((metric) => {
                // Có norm thì metric nguồn không còn là điểm xếp hạng chính của cuộc thi.
                const isPrimary =
                  shownSnapshot === null && metric.key === contract.primary_metric;
                return (
                  <div
                    className={`metric-card sub-result-card${isPrimary ? " primary" : ""}`}
                    data-metric={metric.key}
                    key={metric.key}
                  >
                    <div className="sub-result-card-top">
                      <span className="sub-result-metric-label">{metric.label}</span>
                      {isPrimary && (
                        <span className="sub-result-metric-badge">
                          <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                          </svg>
                          Chỉ số chính
                        </span>
                      )}
                    </div>
                    <div className="sub-result-score">
                      <strong>{formatMetric(result.metrics[metric.key], metric.decimals)}</strong>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Snapshot là ảnh chụp lúc ghi nhận, không phải norm hiện tại của bảng xếp hạng. */}
            {shownSnapshot && (
              <p className="sub-result-ai-note text-muted">
                Con số tạm tính lúc {formatLocal(shownSnapshot.calculated_at)}; điểm norm hiện tại
                có thể đã đổi theo kết quả tốt nhất của cuộc thi.{" "}
                <Link to="../leaderboard">Xem bảng xếp hạng để đối chiếu</Link>.
              </p>
            )}

            {/* Quyền xem norm vừa bị thu hồi: nói đúng lý do đang chặn thay vì bỏ im lặng. */}
            {droppedNormNote && (
              <p className="sub-result-ai-note text-muted" role="status">
                {droppedNormNote}
              </p>
            )}

            <div className="sub-result-quota-card">
              <div className="sub-result-quota-info">
                <span className="sub-result-quota-title">Hạn mức nộp trong ngày</span>
                <span className="sub-result-quota-val">
                  {dual && track
                    ? `Còn ${result.quota_remaining} lượt nộp nhánh ${TRACK_LABEL[track]} hôm nay.`
                    : `Còn ${result.quota_remaining} lượt nộp hôm nay.`}
                </span>
              </div>
            </div>

            <div className="sub-result-actions-bar">
              <div className="sub-result-action-note">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                <span>Hệ thống tự động lưu kết quả vào lịch sử bài nộp cá nhân của bạn.</span>
              </div>
              <div className="sub-result-action-btns">
                <Link to="../submissions" className="btn btn-secondary">
                  Xem bài đã nộp
                </Link>
                <Link to="../leaderboard" className="btn btn-secondary">
                  Xem bảng xếp hạng
                </Link>
                <button type="button" className="btn" onClick={() => setAttempt(null)}>
                  Nộp bài khác
                </button>
              </div>
            </div>
          </section>
        ) : waiting ? (
          /* S06d Lượt đã vào hàng đợi: thí sinh chỉ cần đợi, không phải bấm nộp lại. */
          <section className="score-result sub-result-view" aria-live="polite">
            <div className="sub-result-header">
              <h3 className="sub-result-title">{waitingTitle(attempt.status)}</h3>
              <p className="sub-result-lead">
                {dual && track
                  ? `Bài của bạn đã được nhận cho nhánh ${TRACK_LABEL[track]} và đang chờ chấm.`
                  : "Bài của bạn đã được nhận và đang chờ chấm."}{" "}
                Bạn không cần bấm nộp lại — kết quả sẽ tự hiện ở đây.
              </p>
              {attempt.queue_position !== null && (
                <p className="sub-result-ai-note text-muted" role="status">
                  Bạn đang ở vị trí thứ {attempt.queue_position} trong hàng chờ.
                </p>
              )}
              {secondsLeft !== null && secondsLeft > 0 && (
                <p className="sub-result-ai-note text-muted" role="status">
                  Lượt này còn tối đa {secondsLeft} giây.
                </p>
              )}
            </div>
          </section>
        ) : (
          /* Form nộp bài */
          <form className="sub-upload-card submission-form" onSubmit={submit}>
            <div className="sub-upload-label">
              <span>Mỗi lượt nộp cần đủ hai tệp</span>
              <span className="sub-upload-hint">Định dạng chuẩn: RFC 4180</span>
            </div>

            {/* Hai slot độc lập: mỗi slot tự chọn/bỏ chọn, nút nộp chỉ mở khi đủ cả hai. */}
            <div className="sub-upload-slots">
              {SLOTS.map((slot) => {
                const selectedFile = files[slot.kind];
                const limitMb =
                  slot.kind === "csv" ? config.max_upload_mb : config.max_notebook_mb;
                const locked = submitting || Boolean(unavailableMessage);
                return (
                  <div className="sub-upload-slot" key={slot.kind}>
                    <div className="sub-upload-slot-head">
                      <span>{slot.label}</span>
                      <span className="sub-upload-hint">tối đa {limitMb} MiB</span>
                    </div>

                    {selectedFile ? (
                      <div className="selected-file sub-file-card" aria-live="polite">
                        <div className="sub-file-info">
                          <div className="sub-file-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                              <line x1="16" y1="13" x2="8" y2="13" />
                              <line x1="16" y1="17" x2="8" y2="17" />
                              <polyline points="10 9 9 9 8 9" />
                            </svg>
                          </div>
                          <div className="sub-file-meta">
                            <div className="sub-file-name-row">
                              <strong className="sub-file-name">{selectedFile.name}</strong>
                              <span className="sub-file-size">
                                {formatBytes(selectedFile.size)}
                              </span>
                            </div>
                            <span className="sub-file-badge">
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                              Đã chọn sẵn sàng nộp
                            </span>
                          </div>
                          {!submitting && (
                            <button
                              type="button"
                              className="sub-file-remove"
                              title={`Bỏ chọn ${slot.label}`}
                              aria-label={`Bỏ chọn ${slot.label}`}
                              onClick={() => {
                                selectFile(slot.kind, null);
                                setError(null);
                              }}
                            >
                              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          )}
                        </div>
                        <div className="sub-file-bar">
                          <div className="sub-file-bar-fill" />
                        </div>
                      </div>
                    ) : (
                      <div
                        className={`sub-dropzone${unavailableMessage ? " disabled" : ""}${dragOver === slot.kind ? " drag-over" : ""}`}
                        onDragOver={(e) => {
                          e.preventDefault();
                          if (!locked) setDragOver(slot.kind);
                        }}
                        onDragLeave={(e) => {
                          e.preventDefault();
                          setDragOver((current) =>
                            current === slot.kind ? null : current,
                          );
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDragOver(null);
                          if (!locked && e.dataTransfer.files?.[0]) {
                            selectFile(slot.kind, e.dataTransfer.files[0]);
                          }
                        }}
                      >
                        <p className="sub-dropzone-prompt">{slot.prompt}</p>
                        <p className="sub-dropzone-subtext">
                          UTF-8, dung lượng tối đa {limitMb} MiB
                        </p>

                        <FileButton
                          className="btn btn-secondary sub-dropzone-btn"
                          inputLabel={slot.button}
                          accept={[...slot.extensions, ...slot.mimeTypes].join(",")}
                          disabled={locked}
                          onFile={(chosen) => selectFile(slot.kind, chosen)}
                        >
                          {slot.button}
                        </FileButton>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Vùng trigger nộp bài và hạn ngạch */}
            <div className="sub-trigger-block">
              <div className="sub-trigger-row">
                <div className="sub-quota-box">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                  <span>
                    Hạn mức: <strong>{quotaLabel}</strong>
                  </span>
                </div>

                <div className="sub-trigger-actions">
                  <button
                    className="btn"
                    type="submit"
                    disabled={!ready || submitting || Boolean(unavailableMessage)}
                  >
                    {submitting
                      ? "Đang gửi bài..."
                      : dual && track
                        ? `Nộp nhánh ${TRACK_LABEL[track]} và chấm điểm`
                        : "Nộp và chấm điểm"}
                  </button>
                </div>
              </div>

              <p className="sub-notice-footnote">
                Lưu ý: Mỗi lượt nộp chạy kiểm tra ground truth tự động và chỉ tính vào hạn mức khi
                chấm xong. Lượt quá 60 giây không bị tính — bạn hãy nộp lại. Upload phải hoàn tất
                trước hạn nộp của nhánh; đồng hồ đếm ngược không bảo đảm nhận bài nếu upload còn
                chạy.
              </p>
            </div>
          </form>
        )}
      </div>

      {/* Cột phải: Hướng dẫn định dạng & lưu ý kỹ thuật (Bento Guidelines) */}
      <div className="sub-guide-col">
        {/* Panel 1: Cấu trúc CSV yêu cầu */}
        <div className="sub-guide-card">
          <div className="sub-guide-head">
            <h3 className="sub-guide-title">
              <svg className="sub-guide-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
              </svg>
              Cấu trúc dữ liệu yêu cầu
            </h3>
            <span className="sub-guide-tag">Header chuẩn</span>
          </div>
          <p className="sub-guide-desc">
            File nộp phải chứa đúng {schema.columns.length} cột, phân cách bằng dấu phẩy (<code>,</code>),
            không có dấu cách thừa.
          </p>
          <p className="sub-guide-desc">
            Tệp thứ hai là notebook Jupyter (<code>.ipynb</code>) sinh ra kết quả dự đoán. Hệ thống
            chỉ lưu và kiểm tra cấu trúc tệp, tuyệt đối không chạy notebook của bạn.
          </p>
          <div className="sub-code-preview">
            <div className="sub-code-head">
              <span>{schema.columns.map((column) => column.name).join(",")}</span>
              <span>Mẫu dữ liệu</span>
            </div>
            <div className="sub-code-sample">
              <div>
                <strong>{schema.columns.map((column) => column.name).join(",")}</strong>
              </div>
              {schema.rows.map((row) => (
                <div key={row[0]}>{row.join(",")}</div>
              ))}
            </div>
          </div>
        </div>

        {/* Panel 2: Các lỗi thường gặp */}
        <div className="sub-guide-card">
          <div className="sub-guide-head">
            <h3 className="sub-guide-title">
              <svg className="sub-guide-icon-warning" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              Các lỗi thường gặp
            </h3>
          </div>
          <p className="sub-guide-desc">
            Các file gặp lỗi bên dưới sẽ bị hệ thống từ chối nộp trước khi trừ lượt quota của bạn.
          </p>
          <div className="sub-pitfalls-list">
            {SUBMISSION_PITFALLS.map((pitfall) => (
              <div className="sub-pitfall-item" key={pitfall.code}>
                <div className="sub-pitfall-header">
                  <span className={`sub-pitfall-code${pitfall.tone ? ` ${pitfall.tone}` : ""}`}>
                    {pitfall.code}
                  </span>
                  <span className="sub-pitfall-label">{pitfall.label}</span>
                </div>
                <p className="sub-pitfall-desc">{pitfall.description(schema)}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Đổi nhánh khi còn tệp đã chọn hoặc lượt đang chạy: hỏi trước khi bỏ bộ tệp cũ. */}
      {pendingTrack && track && (
        <ConfirmModal
          title={`Chuyển sang nhánh ${TRACK_LABEL[pendingTrack]}?`}
          body={switchWarning(track, pendingTrack, attempt)}
          confirmLabel={`Sang nhánh ${TRACK_LABEL[pendingTrack]}`}
          onConfirm={async () => {
            setSearchParams({ track: pendingTrack });
          }}
          onClose={() => setPendingTrack(null)}
        />
      )}
    </div>
  );
}

function submissionUnavailableMessage(
  competition: CompetitionContext["competition"],
  trackView: ParticipantTrackView | null,
): string | null {
  if (!competition.membership.active) {
    return competition.membership.joined_at
      ? "Quyền tham gia cuộc thi của bạn đã bị vô hiệu hóa."
      : "Bạn cần tham gia cuộc thi trước khi nộp bài.";
  }
  if (competition.status !== "published") return "Cuộc thi hiện không nhận bài nộp.";
  // Dual: quyền nộp do backend quyết định theo từng nhánh - không suy từ đồng hồ máy khách.
  if (trackView) {
    if (!trackView.can_submit) {
      return (
        TRACK_BLOCKED_MESSAGE[trackView.blocked_reason ?? ""] ??
        "Nhánh này hiện không nhận bài nộp."
      );
    }
    if (!trackView.submission_ready) return "Nhánh này chưa sẵn sàng chấm điểm.";
    const quota = trackView.quota;
    if (quota && quota.remaining === 0) {
      return `Bạn đã dùng hết ${quota.per_day} lượt nộp hôm nay. Hạn mức làm mới lúc ${formatLocal(
        quota.resets_at,
      )}.`;
    }
    return null;
  }
  const now = Date.now();
  const startAt = new Date(competition.start_at).getTime();
  const endAt = new Date(competition.end_at).getTime();
  if (!Number.isNaN(startAt) && now < startAt) return "Cuộc thi chưa mở nhận bài.";
  if (!Number.isNaN(endAt) && now > endAt) return "Đã hết hạn nộp bài.";
  if (!competition.submission_config.ready) return "Cuộc thi chưa sẵn sàng chấm điểm.";
  // Chỉ khóa theo quota khi backend thực sự trả quota; 429 vẫn là chốt cuối khi tab bị cũ.
  const quota = competition.quota;
  if (quota && quota.remaining === 0) {
    return `Bạn đã dùng hết ${quota.per_day} lượt nộp hôm nay. Hạn mức làm mới lúc ${formatLocal(
      quota.resets_at,
    )}.`;
  }
  return null;
}

/** Câu hỏi xác nhận khi đổi nhánh lúc còn tệp hoặc lượt đang chạy; đổi nhánh luôn bỏ tệp cũ. */
function switchWarning(from: Track, to: Track, attempt: Attempt | null): string {
  if (attempt !== null && WAITING_ATTEMPT_STATUSES.has(attempt.status)) {
    return `Lượt đang chạy ở nhánh ${TRACK_LABEL[from]} vẫn tiếp tục được chấm; quay lại nhánh này để xem kết quả. Chuyển sang nhánh ${TRACK_LABEL[to]} sẽ bỏ các tệp đã chọn.`;
  }
  return `Các tệp đã chọn thuộc nhánh ${TRACK_LABEL[from]} và sẽ bị bỏ để bạn chọn lại cho nhánh ${TRACK_LABEL[to]}.`;
}

/** Tiêu đề của lượt đang chờ: nói đúng việc hệ thống đang làm với bài của thí sinh. */
function waitingTitle(status: Attempt["status"]): string {
  if (status === "RUNNING") return "Đang chấm bài";
  if (status === "RESOLVING") return "Đang đối soát kết quả";
  return "Bài đang chờ chấm";
}

function averageLabel(
  average: CompetitionContext["competition"]["submission_config"]["average"],
): string {
  if (average === "binary") return "Binary";
  if (average === "macro") return "Macro";
  if (average === "weighted") return "Weighted";
  return "Chưa cấu hình average";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
