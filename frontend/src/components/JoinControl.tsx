/** Join CTA theo join_mode + membership state. Dùng chung dashboard card và competition header. */

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Competition, JoinResponse, Membership } from "../api/competitions";
import { Modal } from "./Modal";

function IconArrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 11h12.17l-5.59-5.59L12 4l8 8-8 8-1.41-1.41L16.17 13H4z" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.2 14.4L6.6 12.2l1.4-1.4 2.8 2.8 5.2-5.2 1.4 1.4-6.6 6.6z" />
    </svg>
  );
}

function IconKey() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14 6a6 6 0 1 0-5.66 8H10v3h3v-3h3v-3h-2.34A6 6 0 0 0 14 6zm-6 7a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" />
    </svg>
  );
}

function IconError() {
  return (
    <svg
      className="form-error-icon"
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
    </svg>
  );
}

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
        <span className="join-state-status">
          <span className="join-state-icon" aria-hidden="true">
            <IconCheck />
          </span>
          <strong>Đã tham gia</strong>
        </span>
        <Link className="btn" to={`/competitions/${competition.slug}`}>
          Vào cuộc thi
          <IconArrow />
        </Link>
      </span>
    );
  }

  if (membership.joined_at !== null && !membership.active) {
    return (
      <span className="join-state">
        <span className="join-state-note">
          Membership đã bị vô hiệu hóa — liên hệ Ban Tổ chức.
        </span>
      </span>
    );
  }

  if (competition.status === "closed") {
    return (
      <span className="join-state">
        <span className="join-state-note">Cuộc thi đã kết thúc.</span>
      </span>
    );
  }

  if (competition.join_mode === "invite_only") {
    return (
      <span className="join-state">
        <span className="join-state-note">Chỉ dành cho tài khoản được mời.</span>
      </span>
    );
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
      <button className="btn" type="button" disabled={busy} onClick={() => void join()}>
        {busy ? "Đang tham gia..." : "Tham gia"}
      </button>
      {error && (
        <span className="join-error" role="alert">
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

  function openModal() {
    setError("");
    setOpen(true);
  }

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
      <button className="btn btn-outline" type="button" onClick={openModal}>
        <IconKey />
        Nhập mã tham gia
      </button>
      {open && (
        <Modal title="Nhập mã tham gia" onClose={() => setOpen(false)} large={false}>
          <form className="join-form" onSubmit={submit}>
            <p className="join-form-competition">
              Cuộc thi: <strong>{competition.name}</strong>
            </p>

            {error && (
              <div className="form-error" role="alert">
                <IconError />
                <p>{error}</p>
              </div>
            )}

            <div className="form-field">
              <div className="join-field-head">
                <label className="field-label" htmlFor="join-code-input">
                  Mã tham gia
                </label>
                <span className="join-required" aria-hidden="true">
                  *
                </span>
              </div>
              <input
                id="join-code-input"
                className="input join-code-input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                type="password"
                required
                autoFocus
                autoComplete="off"
              />
            </div>

            <p className="join-note">
              <span className="join-note-dot" aria-hidden="true" />
              Mã do Ban Tổ chức cấp qua email.
            </p>

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
                Hủy
              </button>
              <button className="btn" type="submit" disabled={busy}>
                {busy ? "Đang kiểm tra..." : "Tham gia"}
                {!busy && <IconArrow />}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </span>
  );
}
