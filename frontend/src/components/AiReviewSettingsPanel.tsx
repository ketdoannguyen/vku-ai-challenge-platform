/**
 * Cấu hình kiểm tra notebook bằng AI cho một cuộc thi.
 *
 * Hai điều panel này phải nói rõ, vì cả hai đều dễ hiểu nhầm:
 * - Đây không phải Rule Builder. Thể lệ của cuộc thi (tab Nội dung) là nguồn duy nhất để AI đối
 *   chiếu; panel chỉ cho biết page nào sẽ được gửi đi.
 * - Bật AI là gửi nội dung notebook của thí sinh ra ngoài. Vì vậy phải có một lần xác nhận riêng
 *   cho đúng host đó, và đổi host là lần xác nhận cũ hết hiệu lực.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  deleteAiReviewApiKey,
  fetchAiReviewSettings,
  testAiReviewConnection,
  updateAiReviewSettings,
  type AiConnectionTestResult,
  type AiReviewSettings,
  type ContentSourceReason,
} from "../api/aiReview";
import { ConfirmModal } from "./Modal";
import { ErrorBox, Loading } from "./ui";

const CONTENT_SOURCE_REASON_LABEL: Record<ContentSourceReason, string> = {
  OK: "Sẽ được kiểm tra",
  NO_MARKDOWN: "Chưa có nội dung Markdown",
  UNREADABLE: "Không đọc được tệp Markdown",
};

/** Host để đối chiếu lời xác nhận; URL chưa hợp lệ thì coi như chưa có host nào. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function AiReviewSettingsPanel({ competitionId }: { competitionId: string }) {
  const [settings, setSettings] = useState<AiReviewSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [testResult, setTestResult] = useState<AiConnectionTestResult | null>(null);
  const [testError, setTestError] = useState<unknown>(null);
  const [confirmingKeyDelete, setConfirmingKeyDelete] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [autoReview, setAutoReview] = useState(true);
  const [participantVisible, setParticipantVisible] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  /** Chỉ là giá trị đang gõ để gửi lên; key đã lưu không bao giờ được đọc ngược về form. */
  const [apiKey, setApiKey] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await fetchAiReviewSettings(competitionId);
      setSettings(data);
      setEnabled(data.config.enabled);
      setAutoReview(data.config.auto_review);
      setParticipantVisible(data.config.participant_visible);
      setBaseUrl(data.config.base_url);
      setModel(data.config.model);
      setApiKey("");
      setAcknowledge(false);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [competitionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const host = hostOf(baseUrl);
  const alreadyAcknowledged =
    settings?.config.acknowledged_host != null && settings.config.acknowledged_host === host;
  const transferAcknowledged = alreadyAcknowledged || acknowledge;

  function changeBaseUrl(value: string) {
    setBaseUrl(value);
    // Lời xác nhận gắn với một host cụ thể: đổi host thì phải xác nhận lại từ đầu.
    setAcknowledge(false);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage("");
    setTestResult(null);
    setTestError(null);
    try {
      const payload = {
        enabled,
        auto_review: autoReview,
        participant_visible: participantVisible,
        base_url: baseUrl,
        model,
        acknowledge_transfer: transferAcknowledged,
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      };
      await updateAiReviewSettings(competitionId, payload);
      setMessage("Đã lưu cấu hình AI.");
      // Đọc lại từ server: nguồn nội dung có thể vừa đổi, và key đã lưu không bao giờ quay về form.
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function removeKey() {
    const data = await deleteAiReviewApiKey(competitionId);
    setSettings((current) => (current ? { ...current, config: data.config } : current));
    setConfirmingKeyDelete(false);
    setMessage("Đã xóa API key của cuộc thi.");
  }

  async function testConnection() {
    setBusy(true);
    setTestError(null);
    setTestResult(null);
    try {
      const result = await testAiReviewConnection(competitionId, {
        base_url: baseUrl,
        model,
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      });
      setTestResult(result);
    } catch (err) {
      setTestError(err);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading />;

  const config = settings?.config;
  const runtime = settings?.runtime;
  const source = settings?.content_source;

  return (
    <div className="admin-detail-grid">
      <section className="admin-detail-card" data-tone="blue">
        <div className="admin-detail-card-head">
          <div className="admin-detail-section-heading">
            <span className="admin-detail-card-icon" aria-hidden="true">
              <IconSparkle className="admin-detail-card-icon-glyph" />
            </span>
            <div>
              <h2 className="admin-detail-card-title">Kiểm tra notebook bằng AI</h2>
              <p className="admin-detail-card-desc">
                Kết quả chỉ mang tính tham khảo. Điểm số và quyết định của Ban Tổ chức không đổi.
              </p>
            </div>
          </div>
          {config && (
            <span className={`status-badge ${config.enabled ? "success" : "warning"}`}>
              {config.enabled ? "Đang bật" : "Đang tắt"}
            </span>
          )}
        </div>

        {runtime && !runtime.encryption_available && (
          <div className="status-banner warning">
            Máy chủ chưa có khoá mã hoá nên không lưu được API key. Hãy cấu hình{" "}
            <code>LLM_CONFIG_ENCRYPTION_KEY</code> trước khi bật.
          </div>
        )}
        {message && (
          <div className="status-banner success" role="status">
            <span>{message}</span>
            <button
              type="button"
              className="banner-dismiss"
              aria-label="Đóng thông báo"
              onClick={() => setMessage("")}
            >
              ×
            </button>
          </div>
        )}
        {error ? (
          <div className="admin-section-error">
            <ErrorBox error={error} />
            {!config && (
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => void load()}>
                Thử lại
              </button>
            )}
          </div>
        ) : null}

        <form onSubmit={save}>
          <div className="form-grid">
            <div className="form-field ai-form-wide">
              <label className="field-label checkbox-field" htmlFor="ai-enabled">
                <input
                  id="ai-enabled"
                  type="checkbox"
                  checked={enabled}
                  disabled={busy}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                <span>Bật kiểm tra notebook bằng AI</span>
              </label>
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor="ai-base-url">
                Base URL (OpenAI-compatible)
              </label>
              <input
                id="ai-base-url"
                className="input"
                value={baseUrl}
                disabled={busy}
                placeholder="https://api.example.com/v1"
                onChange={(event) => changeBaseUrl(event.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor="ai-model">
                Model
              </label>
              <input
                id="ai-model"
                className="input"
                value={model}
                disabled={busy}
                onChange={(event) => setModel(event.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor="ai-api-key">
                API key
              </label>
              <input
                id="ai-api-key"
                className="input"
                type="password"
                autoComplete="off"
                value={apiKey}
                disabled={busy}
                placeholder={config?.api_key_configured ? "Đã cấu hình" : "Chưa có key"}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <span className="text-muted">
                Để trống nếu giữ nguyên key hiện tại. Key đã lưu không hiển thị lại.
              </span>
            </div>
          </div>

          <div className="form-grid">
            <div className="form-field ai-form-wide">
              <label className="field-label checkbox-field" htmlFor="ai-auto-review">
                <input
                  id="ai-auto-review"
                  type="checkbox"
                  checked={autoReview}
                  disabled={busy}
                  onChange={(event) => setAutoReview(event.target.checked)}
                />
                <span>Tự động kiểm tra notebook sau mỗi bài nộp</span>
              </label>
            </div>
            <div className="form-field ai-form-wide">
              <label className="field-label checkbox-field" htmlFor="ai-participant-visible">
                <input
                  id="ai-participant-visible"
                  type="checkbox"
                  checked={participantVisible}
                  disabled={busy}
                  onChange={(event) => setParticipantVisible(event.target.checked)}
                />
                <span>Hiển thị kết quả AI sơ bộ cho thí sinh</span>
              </label>
            </div>
            <div className="form-field ai-form-wide">
              <label className="field-label checkbox-field" htmlFor="ai-acknowledge">
                <input
                  id="ai-acknowledge"
                  type="checkbox"
                  checked={transferAcknowledged}
                  disabled={busy || !host}
                  onChange={(event) => setAcknowledge(event.target.checked)}
                />
                <span>
                  {host
                    ? `Tôi hiểu notebook của thí sinh và nội dung cuộc thi sẽ được gửi tới ${host}.`
                    : "Nhập Base URL hợp lệ để xác nhận host nhận dữ liệu."}
                </span>
              </label>
              {alreadyAcknowledged && (
                <span className="text-muted">
                  Host này đã được xác nhận trước đó. Đổi Base URL sang host khác thì phải xác nhận
                  lại.
                </span>
              )}
            </div>
          </div>

          <div className="modal-actions">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Đang lưu..." : "Lưu cấu hình"}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy || !baseUrl || !model}
              onClick={() => void testConnection()}
            >
              Kiểm tra kết nối
            </button>
            {config?.api_key_configured && (
              <button
                className="btn btn-secondary"
                type="button"
                disabled={busy}
                onClick={() => setConfirmingKeyDelete(true)}
              >
                Xóa API key
              </button>
            )}
          </div>
        </form>

        {testResult && (
          <div className="status-banner success" role="status">
            Kết nối thành công tới {testResult.host} với model {testResult.model} (
            {testResult.latency_ms} ms).
          </div>
        )}
        {testError ? <ErrorBox error={testError} /> : null}

        <p className="text-muted">
          Đây không phải công cụ soạn luật. AI chỉ đối chiếu notebook với chính các trang nội dung
          của cuộc thi; muốn thêm luật thì sửa ở tab <strong>Nội dung</strong>.
        </p>
      </section>

      <section className="admin-detail-card" data-tone="yellow">
        <div className="admin-detail-card-head">
          <div className="admin-detail-section-heading">
            <span className="admin-detail-card-icon" aria-hidden="true">
              <IconDocument className="admin-detail-card-icon-glyph" />
            </span>
            <div>
              <h2 className="admin-detail-card-title">Nguồn nội dung kiểm tra</h2>
              <p className="admin-detail-card-desc">
                {source
                  ? `${source.included_count} trang sẽ được gửi kèm (${formatBytes(source.total_bytes)}), ${source.excluded_count} trang bị bỏ qua.`
                  : "Đang tải danh sách nội dung."}
              </p>
            </div>
          </div>
        </div>

        {source && source.pages.length === 0 ? (
          <p className="text-muted">
            Cuộc thi chưa có trang nội dung nào, nên chưa có thể lệ để AI đối chiếu.
          </p>
        ) : (
          <ul className="ai-source-list">
            {source?.pages.map((page) => (
              <li key={page.content_id} className="ai-source-item">
                <div>
                  <strong>{page.title}</strong>
                  <span className="cell-secondary">
                    {page.slug} · {page.visibility}
                  </span>
                </div>
                <span
                  className={`status-badge ${page.included ? "success" : "warning"}`}
                  title={CONTENT_SOURCE_REASON_LABEL[page.reason]}
                >
                  {CONTENT_SOURCE_REASON_LABEL[page.reason]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {confirmingKeyDelete && (
        <ConfirmModal
          title="Xóa API key"
          body="Xóa API key đã lưu của cuộc thi? AI sẽ không chạy được cho tới khi có key mới, và các lượt đang chờ sẽ báo lỗi cấu hình."
          confirmLabel="Xóa key"
          danger
          onConfirm={removeKey}
          onClose={() => setConfirmingKeyDelete(false)}
        />
      )}
    </div>
  );
}

/** Icon riêng của tab: tia sáng trong khung, tách khỏi bộ icon nghiệp vụ hiện có. */
export function IconSparkle({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="m6.3 6.3 2.4 2.4M15.3 15.3l2.4 2.4M17.7 6.3l-2.4 2.4M8.7 15.3l-2.4 2.4" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

function IconDocument({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </svg>
  );
}
