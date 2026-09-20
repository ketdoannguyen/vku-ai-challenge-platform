import { useState, type FormEvent } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api } from "../api/client";
import { METRIC_LABEL, formatLocal } from "../api/competitions";
import { ErrorBox, FileButton } from "../components/ui";
import {
  SAMPLE_ROWS,
  SUBMISSION_PITFALLS,
  submissionColumns,
} from "../lib/submissionRequirements";
import type { CompetitionContext } from "./CompetitionDetailPage";

interface SubmissionResult {
  id: string;
  competition_id: string;
  status: "completed";
  metrics: {
    f1: number;
    precision: number;
    recall: number;
  };
  primary_score: number;
  created_at: string;
  quota_remaining: number;
}

const METRICS = ["f1", "precision", "recall"] as const;

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

export function SubmissionPage() {
  const { competition, refreshCompetition } = useOutletContext<CompetitionContext>();
  const [files, setFiles] = useState<Record<SlotKind, File | null>>({
    csv: null,
    notebook: null,
  });
  const [result, setResult] = useState<SubmissionResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState<SlotKind | null>(null);

  const unavailableMessage = submissionUnavailableMessage(competition);
  const config = competition.submission_config;
  // Tên cột hiển thị trong phần hướng dẫn nhanh; dùng chung với trang Hướng dẫn.
  const columns = submissionColumns(config);
  // Chỉ có khi backend trả quota (thành viên đang hoạt động, cuộc thi đang mở).
  const quota = competition.quota;
  const quotaLabel = quota
    ? `Còn ${quota.remaining}/${quota.per_day} lượt hôm nay`
    : `${competition.quota_per_day} lượt/ngày`;
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
    setResult(null);
  }

  const ready = SLOTS.every((slot) => files[slot.kind] !== null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || unavailableMessage) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.postFile<SubmissionResult>(
        `/competitions/${competition.id}/submissions`,
        Object.fromEntries(SLOTS.map((slot) => [slot.part, files[slot.kind]!])),
      );
      setResult(response);
      setFiles({ csv: null, notebook: null });
      // POST đã trả quota_remaining tức thời; refetch để header và chỗ nộp bài khớp lại.
      void refreshCompetition();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="submission-page sub-workspace">
      {/* Cột trái: Khu vực nộp bài / Kết quả chấm điểm */}
      <div className="sub-main-col">
        <div className="sub-header submission-head">
          <h2 className="sub-title">Nộp bài dự đoán</h2>
          <p className="sub-lead text-muted">
            Mỗi lượt nộp gồm file CSV dự đoán và notebook tái lập. File được kiểm tra và chấm
            điểm ngay sau khi upload.
          </p>
        </div>

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
              <code>{config.prediction_column ?? "chưa cấu hình"}</code>
            </span>
            <span className="sr-only">
              Prediction: {config.prediction_column ?? "chưa cấu hình"}
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
              {averageLabel(config.average)}
              {config.average === "binary" && config.pos_label != null && (
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

        {/* Khi có kết quả (S06c): hiển thị kết quả chấm điểm; khi chưa: hiển thị form nộp bài */}
        {result ? (
          <section className="score-result sub-result-view" aria-live="polite">
            <div className="sub-result-header">
              <h3 className="sub-result-title">Kết quả chấm điểm</h3>
              <p className="sub-result-lead">
                Hệ thống đã kiểm tra và đối soát kết quả dự đoán với Public Ground Truth.
              </p>
            </div>

            <div className="metric-grid sub-result-cards">
              {METRICS.map((metric) => {
                const isPrimary = competition.primary_metric === metric;
                return (
                  <div
                    className={`metric-card sub-result-card${isPrimary ? " primary" : ""}`}
                    data-metric={metric}
                    key={metric}
                  >
                    <div className="sub-result-card-top">
                      <span className="sub-result-metric-label">
                        {METRIC_LABEL[metric]}
                      </span>
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
                      <strong>{result.metrics[metric].toFixed(6)}</strong>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="sub-result-quota-card">
              <div className="sub-result-quota-info">
                <span className="sub-result-quota-title">Hạn mức nộp trong ngày</span>
                <span className="sub-result-quota-val">
                  Còn {result.quota_remaining} lượt nộp hôm nay.
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
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setResult(null);
                    setFiles({ csv: null, notebook: null });
                  }}
                >
                  Nộp bài khác
                </button>
              </div>
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
                    {submitting ? "Đang chấm điểm..." : "Nộp và chấm điểm"}
                  </button>
                </div>
              </div>

              <p className="sub-notice-footnote">
                Lưu ý: Thao tác nộp bài sẽ trừ 1 lượt nộp hôm nay và chạy kiểm tra ground truth tự động. Điểm số sẽ hiển thị ngay sau khi chấm.
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
            File nộp phải chứa đúng 2 cột, phân cách bằng dấu phẩy (<code>,</code>), không có dấu cách thừa.
          </p>
          <p className="sub-guide-desc">
            Tệp thứ hai là notebook Jupyter (<code>.ipynb</code>) sinh ra kết quả dự đoán. Hệ thống
            chỉ lưu và kiểm tra cấu trúc tệp, tuyệt đối không chạy notebook của bạn.
          </p>
          <div className="sub-code-preview">
            <div className="sub-code-head">
              <span>{columns.id},{columns.prediction}</span>
              <span>Mẫu dữ liệu</span>
            </div>
            <div className="sub-code-sample">
              <div><strong>{columns.id}</strong>,<strong>{columns.prediction}</strong></div>
              {SAMPLE_ROWS.map(([id, prediction]) => (
                <div key={id}>{id},{prediction}</div>
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
                <p className="sub-pitfall-desc">{pitfall.description(columns)}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function submissionUnavailableMessage(
  competition: CompetitionContext["competition"],
): string | null {
  if (!competition.membership.active) {
    return competition.membership.joined_at
      ? "Quyền tham gia cuộc thi của bạn đã bị vô hiệu hóa."
      : "Bạn cần tham gia cuộc thi trước khi nộp bài.";
  }
  if (competition.status !== "published") return "Cuộc thi hiện không nhận bài nộp.";
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
