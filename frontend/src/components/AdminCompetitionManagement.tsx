import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api/client";
import type { AdminCompetition, Competition, CompetitionResource } from "../api/competitions";
import {
  JOIN_MODE_LABEL,
  MAX_COMPETITION_RESOURCES,
  METRIC_LABEL,
  isSafeResourceUrl,
  isoToLocalInput,
  localInputToIso,
} from "../api/competitions";
import { ConfirmModal, Modal } from "./Modal";

export type CompetitionAction = "publish" | "close" | "clone";

function Icon({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function IconLock({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
    </Icon>
  );
}

function IconCheck({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 2.5 2.5L16 9" />
    </Icon>
  );
}

export function CompetitionActionConfirmModal({
  action,
  competition,
  onSuccess,
  onClose,
}: {
  action: CompetitionAction;
  competition: Competition;
  onSuccess: (
    action: CompetitionAction,
    clonedCompetition?: Competition,
  ) => void | Promise<void>;
  onClose: () => void;
}) {
  const confirmation =
    action === "publish"
      ? {
          title: "Publish cuộc thi",
          body: `Publish "${competition.name}" — thí sinh sẽ thấy cuộc thi này. Thao tác này không tự hoàn tác.`,
          label: "Publish",
          danger: false,
        }
      : action === "close"
        ? {
            title: "Kết thúc cuộc thi",
            body: `Kết thúc "${competition.name}" — không nhận submission mới, cuộc thi không thể mở lại.`,
            label: "Kết thúc",
            danger: true,
          }
        : {
            title: "Clone cuộc thi",
            body: `Clone "${competition.name}" thành một bản nháp mới?`,
            label: "Clone",
            danger: false,
          };

  async function confirm() {
    if (action === "clone") {
      const clone = await api.post<Competition>(
        `/admin/competitions/${competition.id}/clone`,
      );
      await onSuccess(action, clone);
      return;
    }

    await api.post(`/admin/competitions/${competition.id}/${action}`);
    await onSuccess(action);
  }

  return (
    <ConfirmModal
      title={confirmation.title}
      body={confirmation.body}
      confirmLabel={confirmation.label}
      danger={confirmation.danger}
      onConfirm={confirm}
      onClose={onClose}
    />
  );
}

/** Xoá cuộc thi nháp: backend cascade nội dung/thành viên/bài nộp nên phải gõ đúng slug mới cho bấm. */
export function CompetitionDeleteModal({
  competition,
  onDeleted,
  onClose,
}: {
  competition: Competition;
  onDeleted: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const matches = typed.trim() === competition.slug;

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await api.del(
        `/admin/competitions/${competition.id}?confirm_slug=${encodeURIComponent(typed.trim())}`,
      );
      await onDeleted();
    } catch (err) {
      // Modal vẫn mở để admin đọc lý do (409 sai trạng thái, 422 sai slug) rồi sửa.
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
      setBusy(false);
    }
  }

  return (
    <Modal title="Xóa cuộc thi" onClose={onClose} large={false}>
      <div className="confirm-modal confirm-modal-danger">
        <div className="confirm-modal-body">
          <span className="confirm-modal-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
              <path
                d="M12 8v5m0 3.5v.01M10.3 3.84 2.82 17a2 2 0 0 0 1.74 3h14.88a2 2 0 0 0 1.74-3L13.7 3.84a2 2 0 0 0-3.4 0Z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <p>
            Xóa vĩnh viễn <strong>{competition.name}</strong>? Toàn bộ nội dung, thành viên và bài
            nộp của cuộc thi sẽ bị xoá theo. Thao tác này không hoàn tác được.
          </p>
        </div>

        <div className="form-field">
          <label className="field-label" htmlFor="delete-confirm-slug">
            Gõ chính xác slug <code>{competition.slug}</code> để xác nhận
          </label>
          <input
            id="delete-confirm-slug"
            className="input"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoFocus
          />
        </div>

        {error && (
          <div className="confirm-modal-error" role="alert">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
              <path d="M12 7.5v5m0 4v.01" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        <div className="modal-actions confirm-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void confirm()}
            disabled={!matches || busy}
          >
            {busy ? "Đang xử lý..." : "Xóa vĩnh viễn"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Dùng chung create/edit. Create: nhập mọi field. Edit: slug/status khóa (backend enforce). */
export function CompetitionFormModal({
  competition,
  onClose,
  onSaved,
}: {
  competition?: Competition;
  onClose: () => void;
  onSaved: (competition: AdminCompetition) => void;
}) {
  const isEdit = competition !== undefined;
  const [name, setName] = useState(competition?.name ?? "");
  const [slug, setSlug] = useState(competition?.slug ?? "");
  const [description, setDescription] = useState(
    competition?.short_description ?? "",
  );
  const [startAt, setStartAt] = useState(
    competition ? isoToLocalInput(competition.start_at) : "",
  );
  const [endAt, setEndAt] = useState(
    competition ? isoToLocalInput(competition.end_at) : "",
  );
  const [joinMode, setJoinMode] = useState<Competition["join_mode"]>(
    competition?.join_mode ?? "open",
  );
  const [metric, setMetric] = useState<Competition["primary_metric"]>(
    competition?.primary_metric ?? "f1",
  );
  const [quota, setQuota] = useState(
    String(competition?.quota_per_day ?? 5),
  );
  const [leaderboardVisible, setLeaderboardVisible] = useState(
    competition?.leaderboard_visible ?? true,
  );
  const [resources, setResources] = useState<CompetitionResource[]>(
    competition?.resources ?? [],
  );
  const [dateError, setDateError] = useState("");
  const [resourceError, setResourceError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const title = isEdit
    ? `Sửa cuộc thi — ${competition.slug}`
    : "Tạo cuộc thi";
  const metricLocked = isEdit && competition.status === "published";

  function updateResource(index: number, patch: Partial<CompetitionResource>) {
    setResources((rows) =>
      rows.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
  }

  /** Dòng bỏ trống hoàn toàn bị lọc; gửi [] khi xóa hết để backend clear. */
  function cleanResources(): CompetitionResource[] | null {
    const rows = resources
      .map((row) => ({ label: row.label.trim(), url: row.url.trim() }))
      .filter((row) => row.label !== "" || row.url !== "");
    if (rows.length > MAX_COMPETITION_RESOURCES) {
      setResourceError(`Mỗi cuộc thi tối đa ${MAX_COMPETITION_RESOURCES} tài nguyên.`);
      return null;
    }
    for (const row of rows) {
      if (!row.label) {
        setResourceError("Mỗi tài nguyên cần có tên.");
        return null;
      }
      if (!isSafeResourceUrl(row.url)) {
        setResourceError(
          "Link tài nguyên phải là https://drive.google.com hoặc https://docs.google.com.",
        );
        return null;
      }
    }
    return rows;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDateError("");
    setResourceError("");
    setError("");

    const start = new Date(startAt);
    const end = new Date(endAt);
    if (end <= start) {
      setDateError("Thời gian kết thúc phải sau thời gian bắt đầu.");
      return;
    }

    const cleanedResources = cleanResources();
    if (cleanedResources === null) return;

    setBusy(true);
    const payload = {
      name,
      slug: slug.trim().toLowerCase(),
      short_description: description,
      start_at: localInputToIso(startAt),
      end_at: localInputToIso(endAt),
      join_mode: joinMode,
      primary_metric: metric,
      quota_per_day: Number(quota),
      leaderboard_visible: leaderboardVisible,
      resources: cleanedResources,
    };

    try {
      // Cả hai endpoint admin đều trả detail kèm readiness, không chỉ public projection.
      const saved = isEdit
        ? await api.patch<AdminCompetition>(
            `/admin/competitions/${competition.id}`,
            payload,
          )
        : await api.post<AdminCompetition>("/admin/competitions", payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose} variant="competition-form">
      <form className="ac-form" onSubmit={submit}>
        <div className="ac-form-eyebrow">
          <span aria-hidden="true" />
          CẤU HÌNH CUỘC THI / COMPETITION SETUP
        </div>

        <div className="ac-form-body">
          <div className="ac-form-field">
            <label className="ac-required" htmlFor="comp-name">
              Tên cuộc thi
            </label>
            <input
              id="comp-name"
              className="ac-form-control"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="ac-form-field">
            <div className="ac-form-label-row">
              <label className="ac-required" htmlFor="comp-slug">
                Slug {isEdit && "(không đổi được)"}
              </label>
              {isEdit && <IconLock className="ac-form-lock" />}
            </div>
            <div className={`ac-slug-input${isEdit ? " locked" : ""}`}>
              <span aria-hidden="true">/competitions/</span>
              <input
                id="comp-slug"
                className="ac-form-control"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                title="Chỉ a-z, 0-9 và dấu gạch ngang"
                disabled={isEdit}
                required
              />
              {isEdit && <IconLock className="ac-form-lock" />}
            </div>
            <small>
              Slug dùng làm URL định danh: /competitions/{slug || "slug-cuoc-thi"}
            </small>
          </div>

          <div className="ac-form-field">
            <label htmlFor="comp-desc">Mô tả ngắn</label>
            <textarea
              id="comp-desc"
              className="ac-form-control ac-form-textarea"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="ac-date-group">
            <div className="ac-form-grid">
              <div className="ac-form-field">
                <label className="ac-required" htmlFor="comp-start">
                  Bắt đầu
                </label>
                <input
                  id="comp-start"
                  className="ac-form-control ac-form-mono"
                  type="datetime-local"
                  value={startAt}
                  onChange={(event) => setStartAt(event.target.value)}
                  required
                />
              </div>
              <div className="ac-form-field">
                <label className="ac-required" htmlFor="comp-end">
                  Kết thúc
                </label>
                <input
                  id="comp-end"
                  className="ac-form-control ac-form-mono"
                  type="datetime-local"
                  value={endAt}
                  onChange={(event) => setEndAt(event.target.value)}
                  required
                />
              </div>
            </div>
            {dateError && (
              <div className="ac-date-error" role="alert">
                {dateError}
              </div>
            )}
          </div>

          <fieldset className="ac-join-fieldset">
            <legend className="ac-required">Cách tham gia</legend>
            <div className="ac-join-options">
              {(Object.keys(JOIN_MODE_LABEL) as Competition["join_mode"][]).map(
                (mode) => (
                  <label
                    key={mode}
                    className={joinMode === mode ? "selected" : ""}
                  >
                    <input
                      type="radio"
                      name="comp-join"
                      value={mode}
                      checked={joinMode === mode}
                      onChange={() => setJoinMode(mode)}
                    />
                    <span>
                      <strong>{JOIN_MODE_LABEL[mode]}</strong>
                      <small>{mode}</small>
                    </span>
                    {joinMode === mode && (
                      <IconCheck className="ac-join-check" />
                    )}
                  </label>
                ),
              )}
            </div>
          </fieldset>

          <div className="ac-form-grid">
            <div className="ac-form-field">
              <div className="ac-form-label-row">
                <label className="ac-required" htmlFor="comp-metric">
                  Chỉ số chính
                </label>
                {metricLocked && <IconLock className="ac-form-lock" />}
              </div>
              <select
                id="comp-metric"
                className="ac-form-control ac-form-mono"
                value={metric}
                onChange={(event) =>
                  setMetric(
                    event.target.value as Competition["primary_metric"],
                  )
                }
                disabled={metricLocked}
              >
                <option value="f1">{METRIC_LABEL.f1}</option>
                <option value="precision">{METRIC_LABEL.precision}</option>
                <option value="recall">{METRIC_LABEL.recall}</option>
              </select>
              {metricLocked && (
                <small>Cuộc thi đã publish — không thể đổi chỉ số chính.</small>
              )}
            </div>

            <div className="ac-form-field">
              <label className="ac-required" htmlFor="comp-quota">
                Giới hạn nộp bài (lượt/ngày)
              </label>
              <div className="ac-quota-input">
                <input
                  id="comp-quota"
                  className="ac-form-control ac-form-mono"
                  type="number"
                  min={0}
                  max={1000}
                  value={quota}
                  onChange={(event) => setQuota(event.target.value)}
                  required
                />
                <span aria-hidden="true">lượt / ngày</span>
              </div>
            </div>
          </div>

          <div className="ac-leaderboard-field">
            <label htmlFor="comp-leaderboard">
              <input
                id="comp-leaderboard"
                type="checkbox"
                checked={leaderboardVisible}
                onChange={(event) =>
                  setLeaderboardVisible(event.target.checked)
                }
              />
              <span>
                <strong>Leaderboard hiển thị với thí sinh</strong>
                <small>
                  Nếu tắt, thí sinh sẽ thấy thông báo bảng xếp hạng chưa được
                  công bố.
                </small>
              </span>
            </label>
          </div>

          <fieldset className="ac-resource-fieldset">
            <legend>Tài nguyên tải về (link Google Drive)</legend>
            <p className="ac-resource-hint">
              Chỉ nhận link Google Drive — hệ thống không lưu file dataset. Nhớ đặt quyền
              chia sẻ “Bất kỳ ai có liên kết” để thí sinh mở được.
            </p>

            {resources.length === 0 ? (
              <p className="ac-resource-empty">Chưa có tài nguyên nào.</p>
            ) : (
              resources.map((row, index) => (
                <div className="ac-resource-row" key={index}>
                  <input
                    className="ac-form-control"
                    value={row.label}
                    onChange={(event) => updateResource(index, { label: event.target.value })}
                    placeholder="Tên tài nguyên"
                    aria-label={`Tên tài nguyên ${index + 1}`}
                  />
                  <input
                    className="ac-form-control ac-form-mono"
                    value={row.url}
                    onChange={(event) => updateResource(index, { url: event.target.value })}
                    placeholder="https://drive.google.com/..."
                    aria-label={`Link tài nguyên ${index + 1}`}
                  />
                  <button
                    type="button"
                    className="ac-resource-remove"
                    onClick={() =>
                      setResources((rows) => rows.filter((_, position) => position !== index))
                    }
                    aria-label={`Xóa tài nguyên ${index + 1}`}
                  >
                    ×
                  </button>
                </div>
              ))
            )}

            <button
              type="button"
              className="ac-form-button secondary"
              onClick={() => setResources((rows) => [...rows, { label: "", url: "" }])}
              disabled={resources.length >= MAX_COMPETITION_RESOURCES}
            >
              + Thêm tài nguyên
            </button>

            {resourceError && (
              <div className="ac-date-error" role="alert">
                {resourceError}
              </div>
            )}
          </fieldset>

          {error && (
            <div className="error-box ac-form-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <footer className="ac-form-footer">
          <span>Nhấn phím Esc hoặc bấm Hủy để đóng hộp thoại.</span>
          <div>
            <button
              type="button"
              className="ac-form-button secondary"
              onClick={onClose}
              disabled={busy}
            >
              Hủy
            </button>
            <button
              className="ac-form-button primary"
              type="submit"
              disabled={busy}
            >
              {busy ? "Đang lưu..." : isEdit ? "Lưu" : "Tạo"}
              {!busy && <span aria-hidden="true">→</span>}
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
