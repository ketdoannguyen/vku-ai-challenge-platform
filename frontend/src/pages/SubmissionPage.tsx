import { useState, type FormEvent } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api } from "../api/client";
import { METRIC_LABEL } from "../api/competitions";
import { ErrorBox } from "../components/ui";
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

export function SubmissionPage() {
  const { competition } = useOutletContext<CompetitionContext>();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<SubmissionResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const unavailableMessage = submissionUnavailableMessage(competition);
  const config = competition.submission_config;

  function validateAndSelectFile(selectedFile: File | null) {
    if (!selectedFile) {
      setFile(null);
      return;
    }
    const maxBytes = config.max_upload_mb * 1024 * 1024;
    if (selectedFile.size > maxBytes) {
      setError(
        new Error(
          `Dung lượng file (${formatBytes(selectedFile.size)}) vượt quá giới hạn tối đa ${config.max_upload_mb} MiB.`,
        ),
      );
      setFile(null);
      return;
    }
    const isCsv =
      selectedFile.name.toLowerCase().endsWith(".csv") ||
      selectedFile.type === "text/csv" ||
      !selectedFile.type;
    if (!isCsv) {
      setError(new Error("File không đúng định dạng. Chỉ chấp nhận tệp CSV (.csv)."));
      setFile(null);
      return;
    }
    setFile(selectedFile);
    setError(null);
    setResult(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || unavailableMessage) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.postFile<SubmissionResult>(
        `/competitions/${competition.id}/submissions`,
        file,
      );
      setResult(response);
      setFile(null);
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
          <h2 className="sub-title">Nộp bài CSV</h2>
          <p className="sub-lead text-muted">
            File được kiểm tra và chấm điểm ngay sau khi upload.
          </p>
        </div>

        {/* Dải 5 quy định bento ribbon */}
        <div
          className="sub-specs-strip submission-rules"
          aria-label="Quy định file submission"
        >
          <div className="sub-spec-item">
            <span className="sub-spec-label">Cột ID</span>
            <span className="sub-spec-val">
              <code>{config.id_column ?? "chưa cấu hình"}</code>
            </span>
            <span className="sr-only">ID: {config.id_column ?? "chưa cấu hình"}</span>
          </div>
          <div className="sub-spec-item">
            <span className="sub-spec-label">Cột Output</span>
            <span className="sub-spec-val">
              <code>{config.prediction_column ?? "chưa cấu hình"}</code>
            </span>
            <span className="sr-only">
              Prediction: {config.prediction_column ?? "chưa cấu hình"}
            </span>
          </div>
          <div className="sub-spec-item">
            <span className="sub-spec-label">Định dạng</span>
            <span className="sub-spec-val">
              {averageLabel(config.average)}
              {config.average === "binary" &&
                config.pos_label != null &&
                ` · positive label: ${config.pos_label}`}
            </span>
          </div>
          <div className="sub-spec-item">
            <span className="sub-spec-label">Dung lượng</span>
            <span className="sub-spec-val">Tối đa {config.max_upload_mb} MiB</span>
          </div>
          <div className="sub-spec-item">
            <span className="sub-spec-label">Hạn mức</span>
            <span className="sub-spec-val">{competition.quota_per_day} lượt/ngày</span>
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
                    <div className="sub-result-metric-name">
                      {metric === "f1" ? "F1 Score" : metric === "precision" ? "Precision" : "Recall"}
                    </div>
                    <p className="sub-result-metric-desc">
                      {metric === "f1"
                        ? `Trung bình điều hòa (${averageLabel(config.average)}) giữa Precision và Recall.`
                        : metric === "precision"
                        ? "Độ chính xác các ca dự đoán dương tính."
                        : "Độ nhạy phát hiện thành công các ca dương tính."}
                    </p>
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
                    setFile(null);
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
              <span>Tệp dự đoán (.csv)</span>
              <span className="sub-upload-hint">Định dạng chuẩn: RFC 4180</span>
            </div>

            {/* Vùng Dropzone / Chọn file */}
            {!file ? (
              <div
                className={`sub-dropzone${unavailableMessage ? " disabled" : ""}${dragOver ? " drag-over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!unavailableMessage && !submitting) setDragOver(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (!unavailableMessage && !submitting && e.dataTransfer.files?.[0]) {
                    validateAndSelectFile(e.dataTransfer.files[0]);
                  }
                }}
              >
                <div className="sub-dropzone-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.75">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                <p className="sub-dropzone-prompt">
                  Kéo thả file CSV vào đây hoặc bấm để duyệt
                </p>
                <p className="sub-dropzone-subtext">
                  UTF-8, dung lượng tối đa {config.max_upload_mb} MiB
                </p>

                <label className="btn btn-secondary sub-dropzone-btn">
                  Chọn file CSV
                  <input
                    aria-label="Chọn file CSV"
                    type="file"
                    accept=".csv,text/csv"
                    hidden
                    disabled={submitting || Boolean(unavailableMessage)}
                    onChange={(event) => {
                      validateAndSelectFile(event.target.files?.[0] ?? null);
                    }}
                  />
                </label>
              </div>
            ) : (
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
                      <strong className="sub-file-name">{file.name}</strong>
                      <span className="sub-file-size">{formatBytes(file.size)}</span>
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
                      title="Bỏ chọn file"
                      aria-label="Bỏ chọn file"
                      onClick={() => {
                        setFile(null);
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
            )}

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
                    Hạn mức: <strong>{competition.quota_per_day} lượt/ngày</strong>
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    className="btn"
                    type="submit"
                    disabled={!file || submitting || Boolean(unavailableMessage)}
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
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
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
          <div className="sub-code-preview">
            <div className="sub-code-head">
              <span>{config.id_column ?? "id"},{config.prediction_column ?? "prediction"}</span>
              <span style={{ color: "#15803d" }}>Mẫu dữ liệu</span>
            </div>
            <div className="sub-code-sample">
              <div><strong>{config.id_column ?? "id"}</strong>,<strong>{config.prediction_column ?? "prediction"}</strong></div>
              <div>sample_0001,1</div>
              <div>sample_0002,0</div>
              <div>sample_0003,0</div>
              <div>sample_0004,1</div>
            </div>
          </div>
        </div>

        {/* Panel 2: Các lỗi thường gặp */}
        <div className="sub-guide-card">
          <div className="sub-guide-head">
            <h3 className="sub-guide-title">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#ba1a1a" strokeWidth="2">
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
            <div className="sub-pitfall-item">
              <div className="sub-pitfall-header">
                <span className="sub-pitfall-code">SCHEMA_MISMATCH</span>
                <span className="sub-pitfall-label">Lỗi định dạng</span>
              </div>
              <p className="sub-pitfall-desc">
                Tên cột không đúng chữ thường (ví dụ <code>ID</code> thay vì <code>{config.id_column ?? "id"}</code>) hoặc thừa/thiếu cột phụ.
              </p>
            </div>
            <div className="sub-pitfall-item">
              <div className="sub-pitfall-header">
                <span className="sub-pitfall-code warning">VALUE_OUT_OF_RANGE</span>
                <span className="sub-pitfall-label">Sai nhãn dự đoán</span>
              </div>
              <p className="sub-pitfall-desc">
                Giá trị cột prediction chứa định dạng không tương thích với cấu hình phân loại của cuộc thi.
              </p>
            </div>
            <div className="sub-pitfall-item">
              <div className="sub-pitfall-header">
                <span className="sub-pitfall-code">MISSING_ROWS</span>
                <span className="sub-pitfall-label">Thiếu ID bản ghi</span>
              </div>
              <p className="sub-pitfall-desc">
                Số lượng dòng hoặc tập ID dự đoán không khớp chính xác với danh sách công bố của tập Test.
              </p>
            </div>
          </div>
        </div>

        {/* Panel 3: Cơ chế chấm điểm */}
        <div className="sub-guide-card">
          <div className="sub-guide-head">
            <h3 className="sub-guide-title">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
              Chấm điểm tự động
            </h3>
          </div>
          <p className="sub-guide-desc">
            Chỉ số chính <strong>{METRIC_LABEL[competition.primary_metric]}</strong> được tính toán tức thì ngay khi tải file lên máy chủ.
          </p>
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
