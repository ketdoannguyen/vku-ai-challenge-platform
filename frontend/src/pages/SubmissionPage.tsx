import { useState, type FormEvent } from "react";
import { useOutletContext } from "react-router-dom";
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
  const unavailableMessage = submissionUnavailableMessage(competition);

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
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const config = competition.submission_config;
  return (
    <div className="submission-page">
      <div className="submission-head">
        <div>
          <h2>Nộp bài CSV</h2>
          <p className="text-muted">File được kiểm tra và chấm điểm ngay sau khi upload.</p>
        </div>
      </div>

      <div className="submission-rules" aria-label="Quy định file submission">
        <span>ID: <code>{config.id_column ?? "chưa cấu hình"}</code></span>
        <span>Prediction: <code>{config.prediction_column ?? "chưa cấu hình"}</code></span>
        <span>{averageLabel(config.average)}{config.average === "binary" && ` · positive label: ${config.pos_label}`}</span>
        <span>Tối đa {config.max_upload_mb} MiB</span>
        <span>{competition.quota_per_day} lượt/ngày</span>
      </div>

      {unavailableMessage && <div className="status-banner warning">{unavailableMessage}</div>}
      <ErrorBox error={error} />

      <form className="submission-form" onSubmit={submit}>
        <label className="btn btn-secondary">
          Chọn file CSV
          <input
            aria-label="Chọn file CSV"
            type="file"
            accept=".csv,text/csv"
            hidden
            disabled={submitting || Boolean(unavailableMessage)}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setError(null);
              setResult(null);
            }}
          />
        </label>
        <div className="selected-file" aria-live="polite">
          {file ? (
            <><strong>{file.name}</strong><span>{formatBytes(file.size)}</span></>
          ) : (
            <span>Chưa chọn file.</span>
          )}
        </div>
        <button
          className="btn"
          type="submit"
          disabled={!file || submitting || Boolean(unavailableMessage)}
        >
          {submitting ? "Đang chấm điểm..." : "Nộp và chấm điểm"}
        </button>
      </form>

      {result && (
        <section className="score-result" aria-live="polite">
          <h3>Kết quả chấm điểm</h3>
          <div className="metric-grid">
            {METRICS.map((metric) => (
              <div
                className={`metric-card${competition.primary_metric === metric ? " primary" : ""}`}
                key={metric}
              >
                <span>{METRIC_LABEL[metric]}{competition.primary_metric === metric && " · chính"}</span>
                <strong>{result.metrics[metric].toFixed(6)}</strong>
              </div>
            ))}
          </div>
          <p className="text-muted">Còn {result.quota_remaining} lượt nộp hôm nay.</p>
        </section>
      )}
    </div>
  );
}

function submissionUnavailableMessage(competition: CompetitionContext["competition"]): string | null {
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

function averageLabel(average: CompetitionContext["competition"]["submission_config"]["average"]): string {
  if (average === "binary") return "Binary";
  if (average === "macro") return "Macro";
  if (average === "weighted") return "Weighted";
  return "Chưa cấu hình average";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
