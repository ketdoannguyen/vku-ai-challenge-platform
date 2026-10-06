import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { api } from "../api/client";
import type {
  AdminCompetition,
  CompetitionMode,
  CompetitionResource,
  PublishCondition,
  ResultPolicy,
  Track,
} from "../api/competitions";
import {
  JOIN_MODE_LABEL,
  MAX_COMPETITION_RESOURCES,
  MODE_LABEL,
  PUBLISH_CONDITION_LABEL,
  RESULT_POLICY_LABEL,
  TRACKS,
  TRACK_LABEL,
  TRACK_WINDOW_LABEL,
  formatLocal,
  isDual,
  isoToLocalInput,
  localInputToIso,
  primaryMetricLabel,
} from "../api/competitions";
import { resultContract } from "../api/results";
import { useAutoSlug } from "../hooks/useAutoSlug";
import { cleanCompetitionResources } from "../lib/competitionResources";
import { cleanNormalization } from "../lib/normalization";
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
    body: `Clone "${name}" thành một bản nháp độc lập? Bản sao chép đầy đủ đề, ảnh, đáp án, cấu hình chấm và cấu hình AI (kể cả API key), nhưng không chép người dự thi, mã tham gia hay bài nộp. Phải kiểm tra lại bộ chấm và kết nối AI trước khi publish.`,
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

function IconSingleTrack({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M4 12h16" />
      <circle cx="12" cy="12" r="2.75" />
    </Icon>
  );
}

function IconBranch({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M6 8.5v1.5a2 2 0 0 0 2 2h1M18 8.5v1.5a2 2 0 0 1-2 2h-1M12 13v2.5" />
    </Icon>
  );
}

type SectionTone = "blue" | "red" | "yellow";

/** Icon và tone trang trí cho từng chế độ tham gia - không đọc trạng thái nghiệp vụ nào khác. */
const JOIN_MODE_TONE: Record<AdminCompetition["join_mode"], SectionTone> = {
  open: "blue",
  code: "red",
  invite_only: "yellow",
};

const JOIN_MODE_ICON: Record<AdminCompetition["join_mode"], ReactNode> = {
  open: <IconUsersRound />,
  code: <IconKeyRound />,
  invite_only: <IconMailCheck />,
};

/** Mô tả một dòng của từng hình thức, đúng copy trong kế hoạch §11.1. */
const MODE_HINT: Record<CompetitionMode, string> = {
  single: "một luồng nộp bài",
  public_private: "hai luồng trong cùng một cuộc thi",
};

/** Tone trang trí cho hai hình thức - không đọc trạng thái nghiệp vụ nào. */
const MODE_TONE: Record<CompetitionMode, SectionTone> = {
  single: "blue",
  public_private: "yellow",
};

const MODE_ICON: Record<CompetitionMode, ReactNode> = {
  single: <IconSingleTrack />,
  public_private: <IconBranch />,
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
  competition: AdminCompetition;
  onSuccess: (
    action: CompetitionAction,
    clonedCompetition?: AdminCompetition,
  ) => void | Promise<void>;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const confirmation = CONFIRMATION[action](competition.name);

  async function confirm() {
    if (action === "clone") {
      const clone = await api.post<AdminCompetition>(
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
  competition: AdminCompetition;
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

/** Chuỗi `primaryMetricLabel` trả về khi chưa có metric nguồn (nháp v2 chưa khai báo hợp đồng). */
const NO_SOURCE_METRIC = "Chưa cấu hình";

/**
 * Mô tả nguồn điểm chuẩn hóa theo hợp đồng đang cấu hình. Nháp v2 chưa khai báo metric thì nói rõ
 * lấy từ tab Chấm điểm, không mặc định F1. Cuộc thi dual dùng chung một cấu hình/baseline nhưng
 * mỗi nhánh lấy mẫu số riêng từ bài hợp lệ của nhánh đó - hai population độc lập.
 */
function normalizationSourceHint(competition?: AdminCompetition): string {
  const dualNote =
    competition && isDual(competition)
      ? " Cấu hình dùng chung cho cả hai nhánh, nhưng mỗi nhánh có mặt bằng riêng từ bài hợp lệ của nhánh đó."
      : "";
  const label = competition ? primaryMetricLabel(competition) : null;
  if (!competition || !label || label === NO_SOURCE_METRIC) {
    return `Điểm xếp hạng là norm 0–50 lấy từ metric chính ở tab Chấm điểm; điểm gốc vẫn được giữ nguyên.${dualNote}`;
  }
  const direction = resultContract(competition.submission_config).higher_is_better
    ? "cao hơn là tốt hơn"
    : "thấp hơn là tốt hơn";
  return `Điểm xếp hạng là norm 0–50 tính từ metric ${label} (${direction}); điểm gốc vẫn được giữ nguyên.${dualNote}`;
}

/** Lịch và quota của một nhánh trong form tạo cuộc thi dual. */
interface TrackForm {
  startAt: string;
  endAt: string;
  quota: string;
}

/**
 * Timeline hai hàng của cuộc thi dual: hai thanh nằm trên cùng thang thời gian nên khoảng giao
 * nhau tự hiện ra - không cần checkbox "song song" nào. Mỗi hàng kèm khoảng ngày dạng chữ để
 * thông tin không phụ thuộc vị trí/màu của thanh. Chỉ vẽ khi cả bốn mốc đã hợp lệ.
 */
function TrackTimeline({
  windows,
}: {
  windows: Record<Track, { startAt: string; endAt: string }>;
}) {
  const bars = TRACKS.map((track) => ({
    track,
    start: new Date(windows[track].startAt).getTime(),
    end: new Date(windows[track].endAt).getTime(),
  }));
  if (
    bars.some(
      ({ start, end }) => !Number.isFinite(start) || !Number.isFinite(end) || end <= start,
    )
  ) {
    return null;
  }
  const origin = Math.min(...bars.map(({ start }) => start));
  const span = Math.max(...bars.map(({ end }) => end)) - origin;
  return (
    <div className="ac-track-timeline">
      {bars.map(({ track, start, end }) => (
        <div className="ac-track-timeline-row" key={track}>
          <span className="ac-track-timeline-label">
            {TRACK_LABEL[track]}
                      </span>
          <span className="ac-track-timeline-range">
            {formatLocal(windows[track].startAt)} → {formatLocal(windows[track].endAt)}
          </span>
          <span className="ac-track-timeline-track">
            <span
              className="ac-track-timeline-bar"
              data-track={track}
              style={{
                left: `${((start - origin) / span) * 100}%`,
                width: `${((end - start) / span) * 100}%`,
              }}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Danh sách tài nguyên dạng hàng nhập, dùng chung cho tài nguyên cấp cuộc thi và tài nguyên
 * từng nhánh của cuộc thi dual. `namePrefix` phân biệt nhóm trong aria-label.
 */
function ResourceRows({
  rows,
  onChange,
  namePrefix = "",
}: {
  rows: CompetitionResource[];
  onChange: (rows: CompetitionResource[]) => void;
  namePrefix?: string;
}) {
  const prefix = namePrefix ? `${namePrefix} ` : "";
  const patchRow = (index: number, patch: Partial<CompetitionResource>) =>
    onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  return (
    <>
      {rows.length === 0 ? (
        <p className="ac-resource-empty">Chưa có tài nguyên nào.</p>
      ) : (
        rows.map((row, index) => (
          <div className="ac-resource-row" key={index}>
            <input
              className="ac-form-control"
              value={row.label}
              onChange={(event) => patchRow(index, { label: event.target.value })}
              placeholder="Tên tài nguyên"
              aria-label={`Tên tài nguyên ${prefix}${index + 1}`}
            />
            <input
              className="ac-form-control ac-form-mono"
              value={row.url}
              onChange={(event) => patchRow(index, { url: event.target.value })}
              placeholder="https://..."
              aria-label={`Link tài nguyên ${prefix}${index + 1}`}
            />
            <button
              type="button"
              className="ac-resource-remove"
              onClick={() => onChange(rows.filter((_, position) => position !== index))}
              aria-label={`Xóa tài nguyên ${prefix}${index + 1}`}
            >
              ×
            </button>
          </div>
        ))
      )}
      <button
        type="button"
        className="ac-form-button ac-resource-add"
        onClick={() => onChange([...rows, { label: "", url: "" }])}
        disabled={rows.length >= MAX_COMPETITION_RESOURCES}
      >
        + Thêm tài nguyên
      </button>
    </>
  );
}

/** Dùng chung create/edit. Create: nhập mọi field. Edit: slug/status khóa (backend enforce). */
export function CompetitionFormModal({
  competition,
  onClose,
  onSaved,
  returnFocusRef,
}: {
  competition?: AdminCompetition;
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
  // Hình thức chốt lúc tạo: PATCH không nhận `mode`, và đổi hình thức sẽ diễn giải lại dữ liệu
  // đã có (đáp án, bài nộp) nên form sửa chỉ hiển thị lại kèm giải thích.
  const [mode, setMode] = useState<CompetitionMode>(competition?.mode ?? "single");
  const dual = mode === "public_private";
  const [startAt, setStartAt] = useState(
    competition ? isoToLocalInput(competition.start_at) : "",
  );
  const [endAt, setEndAt] = useState(
    competition ? isoToLocalInput(competition.end_at) : "",
  );
  // Lịch nhánh chỉ nhập ở form tạo; cuộc thi dual sửa lịch qua "Gia hạn / Mở lại" ở trang chi tiết.
  const [trackForms, setTrackForms] = useState<Record<Track, TrackForm>>({
    public: { startAt: "", endAt: "", quota: "5" },
    private: { startAt: "", endAt: "", quota: "5" },
  });
  const [resultPolicy, setResultPolicy] = useState<ResultPolicy>(
    competition?.tracks?.private?.result_policy ?? "manual",
  );
  const [publishCondition, setPublishCondition] = useState<PublishCondition>(
    competition?.tracks?.private?.publish_condition ?? "admin_decides",
  );
  const [joinMode, setJoinMode] = useState<AdminCompetition["join_mode"]>(
    competition?.join_mode ?? "open",
  );
  const [quota, setQuota] = useState(
    String(competition?.quota_per_day ?? 5),
  );
  const [leaderboardVisible, setLeaderboardVisible] = useState(
    competition?.leaderboard_visible ?? true,
  );
  const [normEnabled, setNormEnabled] = useState(
    competition?.normalization?.enabled ?? false,
  );
  const [baseline, setBaseline] = useState(
    competition?.normalization?.baseline != null
      ? String(competition.normalization.baseline)
      : "",
  );
  const [sharedResources, setSharedResources] = useState<CompetitionResource[]>(
    competition?.resources ?? [],
  );
  const [publicResources, setPublicResources] = useState<CompetitionResource[]>([]);
  const [privateResources, setPrivateResources] = useState<CompetitionResource[]>([]);
  const [dateError, setDateError] = useState("");
  const [trackError, setTrackError] = useState("");
  const [normError, setNormError] = useState("");
  const [resourceError, setResourceError] = useState("");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<string[]>([]);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const title = isEdit
    ? `Sửa cuộc thi - ${competition.slug}`
    : "Tạo cuộc thi";
  // Cấu hình norm chỉ sửa được khi cuộc thi còn nháp; bản clone là nháp mới nên sửa được như thường.
  const normLocked = isEdit && competition.status !== "draft";

  function updateTrackForm(track: Track, patch: Partial<TrackForm>) {
    setTrackForms((forms) => {
      const next: Record<Track, TrackForm> = { ...forms };
      next[track] = { ...forms[track], ...patch };
      return next;
    });
  }

  /** Chặn submit tại chỗ: lỗi hiện inline và một bản tóm tắt được focus để không bỏ sót mục nào. */
  function fail(message: string, setInlineError: (value: string) => void) {
    setInlineError(message);
    setSummary([message]);
  }

  useEffect(() => {
    if (summary.length > 0) summaryRef.current?.focus();
  }, [summary]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDateError("");
    setTrackError("");
    setNormError("");
    setResourceError("");
    setError("");
    setSummary([]);

    const dualCreate = !isEdit && dual;
    if (dualCreate) {
      for (const track of TRACKS) {
        const window = trackForms[track];
        if (new Date(window.endAt) <= new Date(window.startAt)) {
          fail(
            `Nhánh ${TRACK_LABEL[track]}: thời gian bắt đầu phải trước thời gian kết thúc.`,
            setTrackError,
          );
          return;
        }
      }
    } else if (!dual) {
      const start = new Date(startAt);
      const end = new Date(endAt);
      if (end <= start) {
        fail("Thời gian kết thúc phải sau thời gian bắt đầu.", setDateError);
        return;
      }
    }

    const cleanedNormalization = cleanNormalization(normEnabled, baseline);
    if (!cleanedNormalization.ok) {
      fail(cleanedNormalization.message, setNormError);
      return;
    }

    let sharedPayload: CompetitionResource[] | undefined;
    let publicPayload: CompetitionResource[] | undefined;
    let privatePayload: CompetitionResource[] | undefined;
    if (!isEdit) {
      const shared = cleanCompetitionResources(sharedResources);
      if (!shared.ok) {
        fail(dual ? `Tài nguyên dùng chung: ${shared.message}` : shared.message, setResourceError);
        return;
      }
      sharedPayload = shared.resources;
      if (dual) {
        const publicGroup = cleanCompetitionResources(publicResources);
        if (!publicGroup.ok) {
          fail(`Tài nguyên Public: ${publicGroup.message}`, setResourceError);
          return;
        }
        publicPayload = publicGroup.resources;
        const privateGroup = cleanCompetitionResources(privateResources);
        if (!privateGroup.ok) {
          fail(`Tài nguyên Private: ${privateGroup.message}`, setResourceError);
          return;
        }
        privatePayload = privateGroup.resources;
      }
    }

    setBusy(true);
    // Cố ý không gửi primary_metric: cách chấm của cuộc thi v2 do bộ chấm Python và
    // result_contract khai báo ở tab "Chấm điểm" quyết định, field này chỉ còn là dấu vết dữ liệu v1.
    const payload = dualCreate
      ? {
          name,
          slug: slug.trim().toLowerCase(),
          short_description: description,
          mode: "public_private",
          join_mode: joinMode,
          leaderboard_visible: leaderboardVisible,
          resources: sharedPayload,
          normalization: cleanedNormalization.normalization,
          public_track: {
            start_at: localInputToIso(trackForms.public.startAt),
            end_at: localInputToIso(trackForms.public.endAt),
            quota_per_day: Number(trackForms.public.quota),
            resources: publicPayload,
          },
          private_track: {
            start_at: localInputToIso(trackForms.private.startAt),
            end_at: localInputToIso(trackForms.private.endAt),
            quota_per_day: Number(trackForms.private.quota),
            resources: privatePayload,
            result_policy: resultPolicy,
            // Nhánh hiện ngay không còn cổng điều kiện để chờ: gửi mặc định thay vì giữ giá trị
            // của lựa chọn đang bị ẩn khỏi form.
            publish_condition:
              resultPolicy === "manual" ? publishCondition : "admin_decides",
          },
        }
      : dual
        ? {
            // Cuộc thi hai nhánh: lịch, quota và tài nguyên nhánh thuộc endpoint riêng ở trang
            // chi tiết (kèm revision + lý do); gửi kèm ở đây sẽ bị backend từ chối.
            name,
            slug: slug.trim().toLowerCase(),
            short_description: description,
            join_mode: joinMode,
            leaderboard_visible: leaderboardVisible,
            normalization: normLocked ? undefined : cleanedNormalization.normalization,
          }
        : {
            name,
            slug: slug.trim().toLowerCase(),
            short_description: description,
            start_at: localInputToIso(startAt),
            end_at: localInputToIso(endAt),
            join_mode: joinMode,
            quota_per_day: Number(quota),
            leaderboard_visible: leaderboardVisible,
            resources: sharedPayload,
            // Cuộc thi đã publish/closed bị backend khóa cấu hình norm: bỏ hẳn field để không làm
            // hỏng các chỉnh sửa khác (JSON.stringify bỏ qua giá trị undefined).
            normalization: normLocked ? undefined : cleanedNormalization.normalization,
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
          {summary.length > 0 && (
            <div
              className="ac-form-error-summary"
              role="group"
              aria-labelledby="ac-form-error-summary-title"
              tabIndex={-1}
              ref={summaryRef}
            >
              <h3 className="ac-form-error-summary-title" id="ac-form-error-summary-title">
                Cần kiểm tra lại
              </h3>
              <ul>
                {summary.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          )}

          <FormSection
            index="01"
            title="Hình thức đánh giá"
            tone="yellow"
            icon={<IconBranch />}
          >
            <fieldset className="ac-join-fieldset" disabled={isEdit}>
              <legend className="ac-required sr-only">Hình thức đánh giá</legend>
              <div className="ac-join-options ac-mode-options">
                {(Object.keys(MODE_LABEL) as CompetitionMode[]).map((candidate) => (
                  <label
                    key={candidate}
                    className={mode === candidate ? "selected" : ""}
                    data-tone={MODE_TONE[candidate]}
                  >
                    <input
                      type="radio"
                      name="comp-mode"
                      value={candidate}
                      checked={mode === candidate}
                      onChange={() => setMode(candidate)}
                    />
                    <span className="ac-join-icon" aria-hidden="true">
                      {MODE_ICON[candidate]}
                    </span>
                    <span>
                      <strong>{MODE_LABEL[candidate]}</strong>
                      <small>{MODE_HINT[candidate]}</small>
                    </span>
                    {mode === candidate && <IconCheck className="ac-join-check" />}
                  </label>
                ))}
              </div>
            </fieldset>
            {isEdit && (
              <p className="ac-resource-hint">
                Hình thức đánh giá được chốt lúc tạo cuộc thi và không đổi được: đổi hình thức sẽ
                diễn giải lại toàn bộ dữ liệu đã có (đáp án, bài nộp). Muốn đổi, hãy tạo cuộc thi
                mới.
              </p>
            )}
          </FormSection>

          <FormSection
            index="02"
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

          <FormSection
            index="03"
            title={dual ? "Lịch hai nhánh" : "Thời gian"}
            tone="red"
            icon={<IconCalendar />}
          >
            {dual ? (
              isEdit ? (
                <div className="ac-date-group">
                  <div className="ac-track-summary">
                    {TRACKS.map((track) => {
                      const view = competition?.tracks?.[track];
                      if (!view) return null;
                      return (
                        <div className="ac-track-summary-row" key={track}>
                          <strong>
                            {TRACK_LABEL[track]}
                                                      </strong>
                          <span>
                            {formatLocal(view.start_at)} → {formatLocal(view.end_at)}
                          </span>
                          <span>{view.quota_per_day} lượt/ngày</span>
                          <span>{TRACK_WINDOW_LABEL[view.window_state]}</span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="ac-resource-hint">
                    Lịch nhánh đổi qua “Gia hạn” hoặc “Mở lại” ở trang chi tiết để mỗi lượt đổi đều
                    kèm lý do và chống ghi đè; form này không sửa lịch cấp cuộc thi của cuộc thi hai
                    nhánh.
                  </p>
                </div>
              ) : (
                <div className="ac-date-group">
                  <div className="ac-track-grid">
                    <div className="ac-track-grid-head" aria-hidden="true">
                      <span />
                      <span>PUBLIC</span>
                      <span>PRIVATE</span>
                    </div>
                    <div className="ac-track-grid-row">
                      <span className="ac-track-grid-label">Mở nhận bài</span>
                      {TRACKS.map((track) => (
                        <input
                          key={track}
                          id={`comp-${track}-start`}
                          className="ac-form-control ac-form-mono"
                          type="datetime-local"
                          value={trackForms[track].startAt}
                          onChange={(event) =>
                            updateTrackForm(track, { startAt: event.target.value })
                          }
                          aria-label={`${TRACK_LABEL[track]} mở nhận bài`}
                          required
                        />
                      ))}
                    </div>
                    <div className="ac-track-grid-row">
                      <span className="ac-track-grid-label">Đóng nhận bài</span>
                      {TRACKS.map((track) => (
                        <input
                          key={track}
                          id={`comp-${track}-end`}
                          className="ac-form-control ac-form-mono"
                          type="datetime-local"
                          value={trackForms[track].endAt}
                          onChange={(event) =>
                            updateTrackForm(track, { endAt: event.target.value })
                          }
                          aria-label={`${TRACK_LABEL[track]} đóng nhận bài`}
                          required
                        />
                      ))}
                    </div>
                    <div className="ac-track-grid-row">
                      <span className="ac-track-grid-label">Lượt mỗi ngày</span>
                      {TRACKS.map((track) => (
                        <input
                          key={track}
                          id={`comp-${track}-quota`}
                          className="ac-form-control ac-form-mono"
                          type="number"
                          min={0}
                          max={1000}
                          value={trackForms[track].quota}
                          onChange={(event) =>
                            updateTrackForm(track, { quota: event.target.value })
                          }
                          aria-label={`${TRACK_LABEL[track]} lượt mỗi ngày`}
                          required
                        />
                      ))}
                    </div>
                  </div>
                  {trackError && (
                    <div className="ac-date-error" role="alert">
                      {trackError}
                    </div>
                  )}
                  <TrackTimeline windows={trackForms} />
                </div>
              )
            ) : (
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
            )}
          </FormSection>

          {dual && (
            <FormSection
              index="04"
              title="Kết quả Private"
              tone="blue"
              icon={<IconTrophy />}
            >
              {isEdit ? (
                <>
                  <div className="ac-track-summary">
                    <div className="ac-track-summary-row">
                      <strong>Chính sách</strong>
                      <span>{RESULT_POLICY_LABEL[resultPolicy]}</span>
                      {resultPolicy === "manual" && (
                        <span>Điều kiện: {PUBLISH_CONDITION_LABEL[publishCondition]}</span>
                      )}
                    </div>
                  </div>
                  <p className="ac-resource-hint">
                    Chính sách và thời điểm công bố đổi ở mục “Công bố Private” trong trang chi tiết,
                    nơi mỗi lượt đổi đều kèm lý do và chống ghi đè.
                  </p>
                </>
              ) : (
                <>
                  <fieldset className="ac-join-fieldset">
                    <legend className="ac-required sr-only">Kết quả Private</legend>
                    <div className="ac-policy-options">
                      {(Object.keys(RESULT_POLICY_LABEL) as ResultPolicy[]).map((policy) => (
                        <label
                          key={policy}
                          className={resultPolicy === policy ? "selected" : ""}
                        >
                          <input
                            type="radio"
                            name="comp-policy"
                            value={policy}
                            checked={resultPolicy === policy}
                            onChange={() => setResultPolicy(policy)}
                          />
                          <span>{RESULT_POLICY_LABEL[policy]}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {resultPolicy === "manual" ? (
                    <div className="ac-form-field">
                      <label htmlFor="comp-condition">Điều kiện công bố</label>
                      <select
                        id="comp-condition"
                        className="input"
                        value={publishCondition}
                        onChange={(event) =>
                          setPublishCondition(event.target.value as PublishCondition)
                        }
                      >
                        {(Object.keys(PUBLISH_CONDITION_LABEL) as PublishCondition[]).map(
                          (condition) => (
                            <option key={condition} value={condition}>
                              {PUBLISH_CONDITION_LABEL[condition]}
                            </option>
                          ),
                        )}
                      </select>
                    </div>
                  ) : (
                    <p className="ac-resource-hint">
                      Điểm Private hiện ngay khi chấm xong và không thể trở lại bí mật; nếu cuộc thi
                      đã publish, dấu mốc công bố được ghi ngay tại thời điểm đổi chính sách.
                    </p>
                  )}
                </>
              )}
            </FormSection>
          )}

          <FormSection
            index={dual ? "05" : "04"}
            title="Cách tham gia"
            tone="yellow"
            icon={<IconUserPlus />}
          >
            <fieldset className="ac-join-fieldset">
              <legend className="ac-required sr-only">Cách tham gia</legend>
              <div className="ac-join-options">
                {(Object.keys(JOIN_MODE_LABEL) as AdminCompetition["join_mode"][]).map(
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
            index={dual ? "06" : "05"}
            title="Chấm điểm & giới hạn"
            tone="blue"
            icon={<IconGauge />}
          >
            {!dual && (
              <div className="ac-form-grid">
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
            )}

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

            <div className="ac-leaderboard-field">
              <label htmlFor="comp-normalization">
                <input
                  id="comp-normalization"
                  type="checkbox"
                  checked={normEnabled}
                  onChange={(event) => setNormEnabled(event.target.checked)}
                  disabled={normLocked}
                />
                <span>
                  <strong>Tính điểm chuẩn hóa (0–50)</strong>
                  <small>{normalizationSourceHint(competition)}</small>
                </span>
              </label>
            </div>

            {normEnabled && (
              <div className="ac-form-field">
                <label className="ac-required" htmlFor="comp-baseline">
                  Baseline chuẩn hóa
                </label>
                <input
                  id="comp-baseline"
                  className="ac-form-control ac-form-mono"
                  type="number"
                  step="any"
                  value={baseline}
                  onChange={(event) => setBaseline(event.target.value)}
                  disabled={normLocked}
                />
                <small>
                  Bài không vượt baseline (kể cả bằng) được 0 điểm norm. Baseline
                  0 hoặc âm vẫn hợp lệ với metric tương ứng.
                </small>
              </div>
            )}

            {normLocked && (
              <p className="ac-resource-hint">
                Cấu hình chuẩn hóa chỉ sửa được khi cuộc thi còn nháp. Muốn đổi
                baseline, hãy clone cuộc thi thành bản nháp mới.
              </p>
            )}

            {normError && (
              <div className="ac-date-error" role="alert">
                {normError}
              </div>
            )}
          </FormSection>

          {!isEdit && (
            <FormSection
              index={dual ? "07" : "06"}
              title="Tài nguyên tải về"
              tone="yellow"
              icon={<IconFolder />}
            >
              <fieldset className="ac-resource-fieldset">
                <legend className="sr-only">Tài nguyên tải về</legend>
                <p className="ac-resource-hint">
                  Nhận mọi link https (Google Drive, Google Docs, S3, máy chủ riêng...) - hệ thống
                  không lưu file dataset. Nhớ đặt quyền truy cập để thí sinh mở được.
                </p>

                {dual ? (
                  <>
                    <h4 className="ac-resource-group-title">Dùng chung cho cả hai nhánh</h4>
                    <ResourceRows rows={sharedResources} onChange={setSharedResources} />
                    <h4 className="ac-resource-group-title">Nhánh Public</h4>
                    <ResourceRows
                      rows={publicResources}
                      onChange={setPublicResources}
                      namePrefix="Public"
                    />
                    <h4 className="ac-resource-group-title">Nhánh Private</h4>
                    <ResourceRows
                      rows={privateResources}
                      onChange={setPrivateResources}
                      namePrefix="Private"
                    />
                  </>
                ) : (
                  <ResourceRows rows={sharedResources} onChange={setSharedResources} />
                )}

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
