import { useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { api } from "../api/client";
import type { AdminCompetition, Competition, CompetitionResource } from "../api/competitions";
import {
  JOIN_MODE_LABEL,
  MAX_COMPETITION_RESOURCES,
  METRIC_LABEL,
  isoToLocalInput,
  localInputToIso,
} from "../api/competitions";
import { useAutoSlug } from "../hooks/useAutoSlug";
import { cleanCompetitionResources } from "../lib/competitionResources";
import { SLUG_MAX } from "../lib/slug";
import { ConfirmModal, Modal } from "./Modal";

export type CompetitionAction = "publish" | "close" | "reopen" | "clone";

/** Copy xác nhận theo từng action, tách khỏi component để khỏi lồng ternary bốn nhánh. */
const CONFIRMATION: Record<
  CompetitionAction,
  (name: string) => { title: string; body: string; label: string; danger: boolean }
> = {
  publish: (name) => ({
    title: "Publish cuộc thi",
    body: `Publish "${name}" - thí sinh sẽ thấy cuộc thi này. Thao tác này không tự hoàn tác.`,
    label: "Publish",
    danger: false,
  }),
  close: (name) => ({
    title: "Kết thúc cuộc thi",
    body: `Kết thúc "${name}" - không nhận submission mới. Cuộc thi vẫn mở lại được sau đó.`,
    label: "Kết thúc",
    danger: true,
  }),
  reopen: (name) => ({
    title: "Mở lại cuộc thi",
    body: `Mở lại "${name}" - cuộc thi nhận bài trở lại nếu chưa quá thời gian kết thúc.`,
    label: "Mở lại",
    danger: false,
  }),
  clone: (name) => ({
    title: "Clone cuộc thi",
    body: `Clone "${name}" thành một bản nháp mới?`,
    label: "Clone",
    danger: false,
  }),
};

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

function IconTrophy({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" />
      <path d="M8 5.5H5.5A2.5 2.5 0 0 0 8 10M16 5.5h2.5A2.5 2.5 0 0 1 16 10" />
      <path d="M12 13v4M9 20h6M10 20l.5-3h3l.5 3" />
    </Icon>
  );
}

function IconInfo({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8v.01" />
    </Icon>
  );
}

function IconCalendar({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3.5V6M16 3.5V6" />
    </Icon>
  );
}

function IconUserPlus({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="10" cy="8" r="3.5" />
      <path d="M4 20a6 6 0 0 1 12 0M18 8v6M15 11h6" />
    </Icon>
  );
}

function IconGauge({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="M12 18l4-5M4 18h16" />
    </Icon>
  );
}

function IconFolder({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3.5 7a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.6.8l1 1.2H18.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7Z" />
      <path d="M12 10.5v5M9.5 13h5" />
    </Icon>
  );
}

function IconUsersRound({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.4A6.5 6.5 0 0 1 21.5 20" />
    </Icon>
  );
}

function IconKeyRound({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="15" r="3.5" />
      <path d="M10.6 12.6 19 4.5M16.5 7l2 2M14 9.5l2 2" />
    </Icon>
  );
}

function IconMailCheck({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3.5 6.5h17v11h-17z" />
      <path d="m3.5 7.5 8.5 6 8.5-6M14.5 20l2 2 4-4" />
    </Icon>
  );
}

type SectionTone = "blue" | "red" | "yellow";

/** Icon và tone trang trí cho từng chế độ tham gia - không đọc trạng thái nghiệp vụ nào khác. */
const JOIN_MODE_TONE: Record<Competition["join_mode"], SectionTone> = {
  open: "blue",
  code: "red",
  invite_only: "yellow",
};

const JOIN_MODE_ICON: Record<Competition["join_mode"], ReactNode> = {
  open: <IconUsersRound />,
  code: <IconKeyRound />,
  invite_only: <IconMailCheck />,
};

/**
 * Khung một nhóm field của dialog tạo/sửa cuộc thi. Số thứ tự và icon block chỉ là trang
 * trí; tên nhóm do `h3` mang để heading hierarchy và accessible name không bị lẫn.
 */
function FormSection({
  index,
  title,
  tone,
  icon,
  children,
}: {
  index: string;
  title: string;
  tone: SectionTone;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ac-form-section" data-tone={tone}>
      <div className="ac-form-section-head">
        <span className="ac-form-section-num" aria-hidden="true">
          {index}
        </span>
        <span className="ac-form-section-icon" aria-hidden="true">
          {icon}
        </span>
        <h3 className="ac-form-section-title">{title}</h3>
      </div>
      <div className="ac-form-section-body">{children}</div>
    </section>
  );
}

export function CompetitionActionConfirmModal({
  action,
  competition,
  onSuccess,
  onClose,
  returnFocusRef,
}: {
  action: CompetitionAction;
  competition: Competition;
  onSuccess: (
    action: CompetitionAction,
    clonedCompetition?: Competition,
  ) => void | Promise<void>;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const confirmation = CONFIRMATION[action](competition.name);

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
      returnFocusRef={returnFocusRef}
    />
  );
}

/** Xoá cuộc thi (nháp hoặc đã kết thúc): backend cascade nội dung/thành viên/bài nộp nên phải gõ đúng slug mới cho bấm. */
export function CompetitionDeleteModal({
  competition,
  onDeleted,
  onClose,
  returnFocusRef,
}: {
  competition: Competition;
  onDeleted: () => void | Promise<void>;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
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
    <Modal title="Xóa cuộc thi" onClose={onClose} large={false} returnFocusRef={returnFocusRef}>
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
  returnFocusRef,
}: {
  competition?: Competition;
  onClose: () => void;
  onSaved: (competition: AdminCompetition) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const isEdit = competition !== undefined;
  const [name, setName] = useState(competition?.name ?? "");
  // Sửa cuộc thi thì slug bị khoá nên không bám theo tên: backend bỏ qua field này khi PATCH.
  const { slug, onTitleChange: onNameChange, onSlugChange } = useAutoSlug(
    competition?.slug ?? "",
    !isEdit,
  );
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
    ? `Sửa cuộc thi - ${competition.slug}`
    : "Tạo cuộc thi";
  const metricLocked = isEdit && competition.status === "published";

  function updateResource(index: number, patch: Partial<CompetitionResource>) {
    setResources((rows) =>
      rows.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
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

    let resourcesPayload: CompetitionResource[] | undefined;
    if (!isEdit) {
      const cleanedResources = cleanCompetitionResources(resources);
      if (!cleanedResources.ok) {
        setResourceError(cleanedResources.message);
        return;
      }
      resourcesPayload = cleanedResources.resources;
    }

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
      resources: resourcesPayload,
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
    <Modal title={title} onClose={onClose} variant="competition-form" returnFocusRef={returnFocusRef}>
      <form className="ac-form" onSubmit={submit}>
        <span className="ac-form-emblem" aria-hidden="true">
          <IconTrophy />
        </span>
        <div className="ac-form-eyebrow">CẤU HÌNH CUỘC THI / COMPETITION SETUP</div>

        <div className="ac-form-body">
          <FormSection
            index="01"
            title="Thông tin cơ bản"
            tone="blue"
            icon={<IconInfo />}
          >
            <div className="ac-form-field">
              <label className="ac-required" htmlFor="comp-name">
                Tên cuộc thi
              </label>
              <input
                id="comp-name"
                className="ac-form-control"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  onNameChange(event.target.value);
                }}
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
                  onChange={(event) => onSlugChange(event.target.value)}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  title="Chỉ a-z, 0-9 và dấu gạch ngang"
                  maxLength={SLUG_MAX}
                  disabled={isEdit}
                  required
                />
                {isEdit && <IconLock className="ac-form-lock" />}
              </div>
              <small>
                Slug dùng làm URL định danh: /competitions/{slug || "slug-cuoc-thi"}
                {!isEdit && " - tự điền theo tên cuộc thi, gõ tay để đổi."}
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
          </FormSection>

          <FormSection index="02" title="Thời gian" tone="red" icon={<IconCalendar />}>
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
          </FormSection>

          <FormSection
            index="03"
            title="Cách tham gia"
            tone="yellow"
            icon={<IconUserPlus />}
          >
            <fieldset className="ac-join-fieldset">
              <legend className="ac-required sr-only">Cách tham gia</legend>
              <div className="ac-join-options">
                {(Object.keys(JOIN_MODE_LABEL) as Competition["join_mode"][]).map(
                  (mode) => (
                    <label
                      key={mode}
                      className={joinMode === mode ? "selected" : ""}
                      data-tone={JOIN_MODE_TONE[mode]}
                    >
                      <input
                        type="radio"
                        name="comp-join"
                        value={mode}
                        checked={joinMode === mode}
                        onChange={() => setJoinMode(mode)}
                      />
                      <span className="ac-join-icon" aria-hidden="true">
                        {JOIN_MODE_ICON[mode]}
                      </span>
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
          </FormSection>

          <FormSection
            index="04"
            title="Chấm điểm & giới hạn"
            tone="blue"
            icon={<IconGauge />}
          >
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
                  <small>Cuộc thi đã publish - không thể đổi chỉ số chính.</small>
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
          </FormSection>

          {!isEdit && (
            <FormSection
              index="05"
              title="Tài nguyên tải về"
              tone="yellow"
              icon={<IconFolder />}
            >
              <fieldset className="ac-resource-fieldset">
                <legend className="sr-only">Tài nguyên tải về</legend>
                <p className="ac-resource-hint">
                  Chỉ nhận link Google Drive hoặc Google Docs - hệ thống không lưu file dataset.
                  Nhớ đặt quyền chia sẻ “Bất kỳ ai có liên kết” để thí sinh mở được.
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
                  className="ac-form-button ac-resource-add"
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
            </FormSection>
          )}

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
