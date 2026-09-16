/** Admin competitions: table + tạo/sửa modal + publish/close confirm + clone. */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Competition, CompetitionsResponse } from "../api/competitions";
import { JOIN_MODE_LABEL, METRIC_LABEL, STATUS_LABEL, formatLocal, isoToLocalInput, localInputToIso, statusClass } from "../api/competitions";
import { ConfirmModal, Modal } from "../components/Modal";
import { ErrorBox, Loading } from "../components/ui";

export function AdminCompetitionsPage() {
  const [data, setData] = useState<CompetitionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Competition | null>(null);
  const [confirming, setConfirming] = useState<{ action: "publish" | "close"; competition: Competition } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<CompetitionsResponse>("/admin/competitions"));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function notify(text: string) {
    setMessage(text);
    void load();
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Quản lý cuộc thi</h1>
          <p className="page-subtitle">Tạo, chỉnh sửa, publish/close và clone cuộc thi</p>
        </div>
      </div>

      <div className="toolbar">
        <button className="btn" onClick={() => setCreating(true)}>
          Tạo cuộc thi
        </button>
      </div>

      {message && (
        <div className="status-banner success" role="status">
          {message}
        </div>
      )}
      <ErrorBox error={error} />

      <div className="table-wrap" aria-busy={loading}>
        <table className="table">
          <thead>
            <tr>
              <th>Tên</th>
              <th>Slug</th>
              <th>Trạng thái</th>
              <th>Thời gian</th>
              <th>Metric</th>
              <th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="table-state">
                  <Loading />
                </td>
              </tr>
            ) : data && data.competitions.length > 0 ? (
              data.competitions.map((c) => (
                <CompetitionRow
                  key={c.id}
                  competition={c}
                  onEdit={() => setEditing(c)}
                  onConfirm={(action) => setConfirming({ action, competition: c })}
                  onChanged={notify}
                />
              ))
            ) : (
              <tr>
                <td colSpan={6} className="table-state">
                  Chưa có cuộc thi nào. Tạo cuộc thi đầu tiên.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <CompetitionFormModal
          onClose={() => setCreating(false)}
          onSaved={(name) => {
            setCreating(false);
            notify(`Đã tạo cuộc thi "${name}".`);
          }}
        />
      )}
      {editing && (
        <CompetitionFormModal
          competition={editing}
          onClose={() => setEditing(null)}
          onSaved={(name) => {
            setEditing(null);
            notify(`Đã cập nhật "${name}".`);
          }}
        />
      )}
      {confirming && (
        <ConfirmModal
          title={confirming.action === "publish" ? "Publish cuộc thi" : "Kết thúc cuộc thi"}
          body={
            confirming.action === "publish"
              ? `Publish "${confirming.competition.name}" — thí sinh sẽ thấy cuộc thi này. Thao tác này không tự hoàn tác.`
              : `Kết thúc "${confirming.competition.name}" — không nhận submission mới, cuộc thi không thể mở lại.`
          }
          confirmLabel={confirming.action === "publish" ? "Publish" : "Kết thúc"}
          danger={confirming.action === "close"}
          onConfirm={async () => {
            await api.post(`/admin/competitions/${confirming.competition.id}/${confirming.action}`);
            setConfirming(null);
            notify(confirming.action === "publish" ? "Đã publish cuộc thi." : "Đã kết thúc cuộc thi.");
          }}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

function CompetitionRow({
  competition,
  onEdit,
  onConfirm,
  onChanged,
}: {
  competition: Competition;
  onEdit: () => void;
  onConfirm: (action: "publish" | "close") => void;
  onChanged: (message: string) => void;
}) {
  const c = competition;
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState("");

  async function clone() {
    setBusy(true);
    setRowError("");
    try {
      const clone = await api.post<Competition>(`/admin/competitions/${c.id}/clone`);
      onChanged(`Đã clone thành "${clone.name}" (draft).`);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr>
        <td className="name-cell">{c.name}</td>
        <td className="slug-cell">{c.slug}</td>
        <td>
          <span className={`status-badge ${statusClass(c.status)}`}>{STATUS_LABEL[c.status]}</span>
        </td>
        <td>
          {formatLocal(c.start_at)}
          <br />
          {formatLocal(c.end_at)}
        </td>
        <td>{METRIC_LABEL[c.primary_metric]}</td>
        <td className="col-actions">
          <span className="action-group">
            <Link className="btn btn-secondary btn-sm" to={`/admin/competitions/${c.id}`}>
              Quản lý
            </Link>
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy || c.status === "closed"}
              title={c.status === "closed" ? "Cuộc thi đã kết thúc và không thể chỉnh sửa." : undefined}
              onClick={onEdit}
            >
              Sửa
            </button>
            {c.status === "draft" && (
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onConfirm("publish")}>
                Publish
              </button>
            )}
            {c.status === "published" && (
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onConfirm("close")}>
                Kết thúc
              </button>
            )}
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void clone()}>
              Clone
            </button>
          </span>
        </td>
      </tr>
      {rowError && (
        <tr>
          <td colSpan={6} className="table-state error-cell">
            {rowError}
          </td>
        </tr>
      )}
    </>
  );
}

/** Dùng chung create/edit. Create: nhập mọi field. Edit: slug/status khóa (backend enforce). */
function CompetitionFormModal({
  competition,
  onClose,
  onSaved,
}: {
  competition?: Competition;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const isEdit = competition !== undefined;
  const [name, setName] = useState(competition?.name ?? "");
  const [slug, setSlug] = useState(competition?.slug ?? "");
  const [description, setDescription] = useState(competition?.short_description ?? "");
  const [startAt, setStartAt] = useState(competition ? isoToLocalInput(competition.start_at) : "");
  const [endAt, setEndAt] = useState(competition ? isoToLocalInput(competition.end_at) : "");
  const [joinMode, setJoinMode] = useState<Competition["join_mode"]>(competition?.join_mode ?? "open");
  const [metric, setMetric] = useState<Competition["primary_metric"]>(competition?.primary_metric ?? "f1");
  const [quota, setQuota] = useState(String(competition?.quota_per_day ?? 5));
  const [leaderboardVisible, setLeaderboardVisible] = useState(competition?.leaderboard_visible ?? true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (end <= start) {
      setError("Thời gian kết thúc phải sau thời gian bắt đầu.");
      return;
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
    };
    try {
      const saved = isEdit
        ? await api.patch<Competition>(`/admin/competitions/${competition.id}`, payload)
        : await api.post<Competition>("/admin/competitions", payload);
      onSaved(saved.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={isEdit ? `Sửa cuộc thi — ${competition.slug}` : "Tạo cuộc thi"} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="form-field">
            <label className="field-label" htmlFor="comp-name">
              Tên cuộc thi
            </label>
            <input
              id="comp-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="comp-slug">
              Slug {isEdit && "(không đổi được)"}
            </label>
            <input
              id="comp-slug"
              className="input"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              title="Chỉ a-z, 0-9 và dấu gạch ngang"
              disabled={isEdit}
              required
            />
          </div>
          <div className="form-field form-field-wide">
            <label className="field-label" htmlFor="comp-desc">
              Mô tả ngắn
            </label>
            <input id="comp-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="comp-start">
              Bắt đầu
            </label>
            <input
              id="comp-start"
              className="input"
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="comp-end">
              Kết thúc
            </label>
            <input
              id="comp-end"
              className="input"
              type="datetime-local"
              value={endAt}
              onChange={(e) => setEndAt(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="comp-join">
              Cách tham gia
            </label>
            <select id="comp-join" className="input" value={joinMode} onChange={(e) => setJoinMode(e.target.value as Competition["join_mode"])}>
              <option value="open">{JOIN_MODE_LABEL.open}</option>
              <option value="code">{JOIN_MODE_LABEL.code}</option>
              <option value="invite_only">{JOIN_MODE_LABEL.invite_only}</option>
            </select>
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="comp-metric">
              Chỉ số chính
            </label>
            <select id="comp-metric" className="input" value={metric} onChange={(e) => setMetric(e.target.value as Competition["primary_metric"])} disabled={isEdit && competition.status === "published"}>
              <option value="f1">{METRIC_LABEL.f1}</option>
              <option value="precision">{METRIC_LABEL.precision}</option>
              <option value="recall">{METRIC_LABEL.recall}</option>
            </select>
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="comp-quota">
              Giới hạn nộp bài (lượt/ngày)
            </label>
            <input
              id="comp-quota"
              className="input"
              type="number"
              min={0}
              max={1000}
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
              required
            />
          </div>
          <div className="form-field checkbox-field">
            <label className="checkbox-label" htmlFor="comp-leaderboard">
              <input
                id="comp-leaderboard"
                type="checkbox"
                checked={leaderboardVisible}
                onChange={(e) => setLeaderboardVisible(e.target.checked)}
              />
              Leaderboard hiển thị với thí sinh
            </label>
          </div>
        </div>
        {isEdit && competition.status === "published" && (
          <p className="modal-note">Cuộc thi đã publish — không thể đổi chỉ số chính.</p>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Hủy
          </button>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Đang lưu..." : isEdit ? "Lưu" : "Tạo"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
