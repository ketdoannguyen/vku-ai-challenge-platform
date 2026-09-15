/** Join CTA theo join_mode + membership state. Dùng chung dashboard card và competition header. */

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Competition, JoinResponse, Membership } from "../api/competitions";

export function JoinControl({
  competition,
  onJoined,
}: {
  competition: Competition;
  onJoined: (membership: Membership) => void;
}) {
  const membership = competition.membership;

  if (membership.active) {
    return (
      <span className="join-state">
        <span className="status-badge success">Đã tham gia</span>
        <Link className="btn btn-sm" to={`/competitions/${competition.slug}`}>
          Vào cuộc thi
        </Link>
      </span>
    );
  }

  if (membership.joined_at !== null && !membership.active) {
    return (
      <span className="join-state text-muted">
        Membership đã bị vô hiệu hóa — liên hệ Ban Tổ chức.
      </span>
    );
  }

  if (competition.status === "closed") {
    return <span className="join-state text-muted">Cuộc thi đã kết thúc.</span>;
  }

  if (competition.join_mode === "invite_only") {
    return <span className="join-state text-muted">Chỉ dành cho tài khoản được mời.</span>;
  }

  if (competition.join_mode === "code") {
    return <CodeJoin competition={competition} onJoined={onJoined} />;
  }

  return <OpenJoin competition={competition} onJoined={onJoined} />;
}

function OpenJoin({
  competition,
  onJoined,
}: {
  competition: Competition;
  onJoined: (membership: Membership) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function join() {
    setBusy(true);
    setError("");
    try {
      const result = await api.post<JoinResponse>(`/competitions/${competition.slug}/join`, {});
      onJoined(result.membership);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="join-state">
      <button className="btn btn-sm" disabled={busy} onClick={() => void join()}>
        {busy ? "Đang tham gia..." : "Tham gia"}
      </button>
      {error && (
        <span className="error-box" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

function CodeJoin({
  competition,
  onJoined,
}: {
  competition: Competition;
  onJoined: (membership: Membership) => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.post<JoinResponse>(`/competitions/${competition.slug}/join`, {
        join_code: code,
      });
      setCode("");
      setOpen(false);
      onJoined(result.membership);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="join-state">
      <button className="btn btn-sm" onClick={() => setOpen(true)}>
        Nhập mã tham gia
      </button>
      {open && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-label="Nhập mã tham gia">
            <div className="modal-head">
              <h2 className="modal-title">Nhập mã tham gia</h2>
              <button className="modal-close" aria-label="Đóng" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            <form onSubmit={submit}>
              <div className="form-field">
                <label className="field-label" htmlFor="join-code-input">
                  Mã tham gia
                </label>
                <input
                  id="join-code-input"
                  className="input"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  autoFocus
                  autoComplete="off"
                />
              </div>
              {error && (
                <div className="error-box" role="alert">
                  {error}
                </div>
              )}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
                  Hủy
                </button>
                <button className="btn" type="submit" disabled={busy}>
                  {busy ? "Đang kiểm tra..." : "Tham gia"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </span>
  );
}
