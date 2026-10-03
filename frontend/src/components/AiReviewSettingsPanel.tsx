/**
 * Cấu hình kiểm tra notebook bằng AI cho một cuộc thi.
 *
 * Panel chỉ giữ lại những gì admin cần để bật tính năng: một công tắc, ba trường kết nối và hai
 * tuỳ chọn hành vi. Bật/tắt là một control duy nhất - tắt thì phần còn lại bị vô hiệu hoá - và
 * trạng thái xác minh nằm ở một chip cạnh tiêu đề: chỉ xanh khi lần lưu gần nhất vừa ghi được cấu
 * hình vừa gọi provider thành công, nên "Lưu cấu hình" là lần duy nhất admin cần bấm.
 *
 * Chip đọc từ `verified_at` của server chứ không phải một biến của phiên: đó là chuyện của cấu hình
 * đang lưu, nên quay lại tab hay tải lại trang thì câu trả lời vẫn phải như cũ (ADR-043).
 *
 * Panel cũng cho nhập cấu hình từ một cuộc thi khác: server thay thế toàn bộ cấu hình đích (kể cả
 * API key, sao chép nội bộ) và xoá dấu xác minh của đích, nên sau khi nhập admin phải kiểm tra lại
 * kết nối. Trình duyệt chỉ gửi ID nguồn - không có key nào đi qua đây.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  deleteAiReviewApiKey,
  fetchAiReviewSettings,
  importAiReviewSettings,
  testAiReviewConnection,
  updateAiReviewSettings,
  type AiReviewSettings,
} from "../api/aiReview";
import { api } from "../api/client";
import type { AdminCompetition, AdminCompetitionsResponse } from "../api/competitions";
import { ConfirmModal } from "./Modal";
import { ErrorBox, Loading } from "./ui";

/** Chữ phải gõ đúng để xoá key: xoá key là thao tác không hoàn tác được. */
const DELETE_CONFIRMATION_WORD = "delete";

type Notice = { tone: "success" | "warning"; text: string };

export function AiReviewSettingsPanel({ competitionId }: { competitionId: string }) {
  const [settings, setSettings] = useState<AiReviewSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmingKeyDelete, setConfirmingKeyDelete] = useState(false);
  /** Cuộc thi khác lấy từ admin list để chọn nguồn nhập; `null` khi chưa tải xong. */
  const [importSources, setImportSources] = useState<AdminCompetition[] | null>(null);
  const [importError, setImportError] = useState<unknown>(null);
  const [importSourceId, setImportSourceId] = useState("");
  const [confirmingImport, setConfirmingImport] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [autoReview, setAutoReview] = useState(true);
  const [participantVisible, setParticipantVisible] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  /** Chỉ là giá trị đang gõ để gửi lên; key đã lưu không bao giờ được đọc ngược về form. */
  const [apiKey, setApiKey] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await fetchAiReviewSettings(competitionId);
      setSettings(data);
      setEnabled(data.config.enabled);
      setAutoReview(data.config.auto_review);
      setParticipantVisible(data.config.participant_visible);
      setBaseUrl(data.config.base_url);
      setModel(data.config.model);
      setApiKey("");
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [competitionId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Admin list chỉ để chọn nguồn: nhập từ chính cuộc thi này là thao tác vô nghĩa nên lọc bỏ. */
  const loadImportSources = useCallback(async () => {
    try {
      const data = await api.get<AdminCompetitionsResponse>("/admin/competitions");
      setImportSources(data.competitions.filter((item) => item.id !== competitionId));
    } catch (err) {
      setImportError(err);
    }
  }, [competitionId]);

  useEffect(() => {
    void loadImportSources();
  }, [loadImportSources]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      try {
        await updateAiReviewSettings(competitionId, {
          enabled,
          auto_review: autoReview,
          participant_visible: participantVisible,
          base_url: baseUrl,
          model,
          ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        });
      } catch (err) {
        setError(err);
        return;
      }

      // Tắt AI thì không có kết nối nào để kiểm, và gọi thử sẽ chỉ lộ ra lỗi thiếu key.
      if (enabled) await verifyConnection();
      else setNotice({ tone: "success", text: "Đã lưu cấu hình AI." });

      // Đọc lại từ server: base URL có thể vừa được chuẩn hoá, key đã lưu không quay về form, và
      // vết xác minh vừa được probe ghi lại nằm ở đó chứ không phải ở một biến của component.
      await load();
    } finally {
      setBusy(false);
    }
  }

  /** Kiểm tra bằng chính cấu hình vừa lưu: không gửi field nào thì server lấy config đang có. */
  async function verifyConnection() {
    try {
      const result = await testAiReviewConnection(competitionId, {});
      setNotice({
        tone: "success",
        text: `Đã lưu cấu hình và kết nối thành công tới ${result.host} (${result.latency_ms} ms).`,
      });
    } catch (err) {
      setNotice({
        tone: "warning",
        text: "Đã lưu cấu hình, nhưng chưa kết nối được tới provider.",
      });
      setError(err);
    }
  }

  async function removeKey() {
    const data = await deleteAiReviewApiKey(competitionId);
    setSettings((current) => (current ? { ...current, config: data.config } : current));
    setConfirmingKeyDelete(false);
    setNotice({ tone: "success", text: "Đã xóa API key của cuộc thi." });
  }

  /**
   * Nhập từ cuộc thi khác: request chỉ mang ID nguồn, còn key được server sao chép nội bộ. Đích là
   * bản sao độc lập và mọi dấu xác minh đã bị xoá, nên phải nạp lại rồi nhắc admin kiểm tra lại.
   */
  async function importConfig() {
    const origin = importSources?.find((item) => item.id === importSourceId);
    if (!origin) return;
    await importAiReviewSettings(competitionId, origin.id);
    setConfirmingImport(false);
    await load();
    setNotice({
      tone: "warning",
      text: `Đã nhập cấu hình AI từ "${origin.name}". Hãy kiểm tra kết nối trước khi dùng.`,
    });
  }

  if (loading) return <Loading />;

  const config = settings?.config;
  const runtime = settings?.runtime;
  const source = settings?.content_source;
  const includedPages = source?.pages.filter((page) => page.included) ?? [];
  const importSource = importSources?.find((item) => item.id === importSourceId) ?? null;
  const importPlaceholder = importError
    ? "Không tải được danh sách nguồn"
    : importSources === null
      ? "Đang tải danh sách..."
      : importSources.length === 0
        ? "Không có cuộc thi nào khác"
        : "Chọn cuộc thi nguồn";

  // Form đã khác cấu hình đang lưu ở một trong ba trường quyết định gọi được provider hay không:
  // lúc đó vết xác minh của server nói về một cấu hình khác, nên chưa có gì để gọi là đã xác minh.
  const connectionDirty =
    config != null &&
    (baseUrl !== config.base_url || model !== config.model || apiKey.trim() !== "");
  const verified = !connectionDirty && config?.verified_at != null;

  return (
    <div className="admin-detail-grid">
      <section className="admin-detail-card" data-tone="blue">
        <div className="admin-detail-card-head">
          <div className="admin-detail-section-heading">
            <span className="admin-detail-card-icon" aria-hidden="true">
              <IconSparkle className="admin-detail-card-icon-glyph" />
            </span>
            <h2 className="admin-detail-card-title">Kiểm tra notebook bằng AI</h2>
          </div>
          {/* Công tắc đứng cùng hàng với tiêu đề: nó là control của cả thẻ, không phải một trường
              trong form. Tên đọc được giữ ở `aria-label` vì nhãn nhìn thấy đã bỏ. */}
          <div className="ai-enable-control">
            {enabled && (
              <span
                className={`status-badge ai-verify-chip ${verified ? "success" : "warning"}`}
                role="status"
              >
                {verified ? (
                  <IconCheck className="ai-verify-chip-icon" />
                ) : (
                  <IconAlert className="ai-verify-chip-icon" />
                )}
                {verified ? "Đã xác minh" : "Chưa xác minh"}
              </span>
            )}
            <input
              className="switch-input"
              type="checkbox"
              role="switch"
              aria-label="Bật kiểm tra bằng AI"
              checked={enabled}
              disabled={busy}
              onChange={(event) => setEnabled(event.target.checked)}
            />
          </div>
        </div>

        {runtime && !runtime.encryption_available && (
          <div className="status-banner warning">
            Máy chủ chưa có khoá mã hoá nên không lưu được API key. Hãy cấu hình{" "}
            <code>LLM_CONFIG_ENCRYPTION_KEY</code> trước khi bật.
          </div>
        )}
        {notice && (
          <div className={`status-banner ${notice.tone}`} role="status">
            <span>{notice.text}</span>
            <button
              type="button"
              className="banner-dismiss"
              aria-label="Đóng thông báo"
              onClick={() => setNotice(null)}
            >
              ×
            </button>
          </div>
        )}
        {error ? (
          <div className="admin-section-error">
            <ErrorBox error={error} />
            {!config && (
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={() => {
                  setError(null);
                  void load();
                }}
              >
                Thử lại
              </button>
            )}
          </div>
        ) : null}

        <form onSubmit={save}>
          {/* Nhập từ cuộc thi khác đứng ngoài fieldset: thao tác này thay thế toàn bộ cấu hình
              kể cả khi AI đang tắt, và trạng thái bật/tắt của nguồn được nhập về theo. */}
          <div className="form-field ai-import-field">
            <label className="field-label" htmlFor="ai-import-source">
              Nhập cấu hình AI từ cuộc thi khác
            </label>
            <div className="ai-key-row">
              <select
                id="ai-import-source"
                className="input"
                value={importSourceId}
                disabled={busy || !importSources?.length}
                onChange={(event) => setImportSourceId(event.target.value)}
              >
                <option value="">{importPlaceholder}</option>
                {importSources?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={busy || importSource === null}
                onClick={() => setConfirmingImport(true)}
              >
                Nhập cấu hình
              </button>
            </div>
            {importError ? (
              <div className="admin-section-error">
                <ErrorBox error={importError} />
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  onClick={() => {
                    setImportError(null);
                    void loadImportSources();
                  }}
                >
                  Thử lại
                </button>
              </div>
            ) : null}
          </div>

          {/* `fieldset disabled` là một dòng thay cho việc gắn `disabled` vào từng control. */}
          <fieldset className="ai-config-fieldset" disabled={busy || !enabled}>
            <div className="form-grid">
              <div className="form-field">
                <label className="field-label" htmlFor="ai-base-url">
                  Base URL (OpenAI-compatible)
                </label>
                <input
                  id="ai-base-url"
                  className="input"
                  value={baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={(event) => setBaseUrl(event.target.value)}
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
                  onChange={(event) => setModel(event.target.value)}
                />
              </div>
              <div className="form-field ai-form-wide">
                <label className="field-label" htmlFor="ai-api-key">
                  API key
                </label>
                <div className="ai-key-row">
                  <input
                    id="ai-api-key"
                    className="input"
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    placeholder={config?.api_key_configured ? "Đã cấu hình" : "Chưa có key"}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  {config?.api_key_configured && (
                    <button
                      className="btn btn-danger-outline"
                      type="button"
                      onClick={() => setConfirmingKeyDelete(true)}
                    >
                      Xóa API key
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="ai-behaviour-row">
              <label className="checkbox-field" htmlFor="ai-auto-review">
                <input
                  id="ai-auto-review"
                  type="checkbox"
                  checked={autoReview}
                  onChange={(event) => setAutoReview(event.target.checked)}
                />
                <span>Tự động kiểm tra notebook sau mỗi bài nộp</span>
              </label>
              <label className="checkbox-field" htmlFor="ai-participant-visible">
                <input
                  id="ai-participant-visible"
                  type="checkbox"
                  checked={participantVisible}
                  onChange={(event) => setParticipantVisible(event.target.checked)}
                />
                <span>Hiển thị kết quả AI sơ bộ cho thí sinh</span>
              </label>
            </div>
          </fieldset>

          <div className="modal-actions">
            <button className="btn" type="submit" disabled={busy}>
              {busy && <span className="ai-spinner" aria-hidden="true" />}
              {busy ? "Đang kiểm tra kết nối..." : "Lưu cấu hình"}
            </button>
          </div>
        </form>
      </section>

      <section className="admin-detail-card" data-tone="yellow">
        <div className="admin-detail-card-head">
          <div className="admin-detail-section-heading">
            <span className="admin-detail-card-icon" aria-hidden="true">
              <IconDocument className="admin-detail-card-icon-glyph" />
            </span>
            <h2 className="admin-detail-card-title">Nguồn nội dung kiểm tra</h2>
          </div>
        </div>

        {includedPages.length === 0 ? (
          <p className="text-muted">
            {source && source.pages.length > 0
              ? "Chưa trang nội dung nào có Markdown để gửi cho AI."
              : "Cuộc thi chưa có trang nội dung nào để AI đối chiếu."}
          </p>
        ) : (
          <ul className="ai-source-list">
            {includedPages.map((page) => (
              <li key={page.content_id} className="ai-source-item">
                <div>
                  <strong>{page.title}</strong>
                  <span className="cell-secondary">{page.slug}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {confirmingImport && importSource && (
        <ConfirmModal
          title="Nhập cấu hình AI"
          body={`Nhập toàn bộ cấu hình AI từ "${importSource.name}" vào cuộc thi này? Cấu hình AI hiện tại sẽ bị thay thế hoàn toàn, kể cả API key (nếu nguồn có) - đây là bản sao độc lập nên sửa nguồn sau này không ảnh hưởng đích. Dấu xác minh kết nối sẽ bị xoá; hãy kiểm tra lại trước khi dùng.`}
          confirmLabel="Nhập cấu hình"
          onConfirm={importConfig}
          onClose={() => setConfirmingImport(false)}
        />
      )}

      {confirmingKeyDelete && (
        <ConfirmModal
          title="Xóa API key"
          body="Xóa API key đã lưu của cuộc thi? AI sẽ không chạy được cho tới khi có key mới, và các lượt đang chờ sẽ báo lỗi cấu hình."
          confirmLabel="Xóa key"
          requireText={DELETE_CONFIRMATION_WORD}
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

function IconCheck({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

function IconAlert({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5m0 4v.01" />
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
