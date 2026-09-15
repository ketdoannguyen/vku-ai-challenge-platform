/** Admin accounts: list/search, tạo, reset password, enable/disable. Role check thật ở backend. */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { Account } from "../auth/AuthContext";
import { ErrorBox, Loading } from "../components/ui";

interface AccountsResponse {
  accounts: Account[];
  total: number;
  limit: number;
  offset: number;
}

export function AdminAccountsPage() {
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (q: string) => {
    setError(null);
    try {
      setData(await api.get<AccountsResponse>(`/admin/accounts${q ? `?q=${encodeURIComponent(q)}` : ""}`));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // search đổi → coi như đang load lại; setState trong event handler, không trong effect
  function onSearchChange(value: string) {
    setSearch(value);
    setLoading(true);
  }

  useEffect(() => {
    void load(search);
  }, [load, search]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Quản lý tài khoản</h1>
          <p className="page-subtitle">Tạo, đặt lại mật khẩu, vô hiệu hóa tài khoản thí sinh/admin</p>
        </div>
      </div>

      <div className="toolbar">
        <input
          className="input"
          type="search"
          aria-label="Tìm tài khoản"
          placeholder="Tìm theo email hoặc tên..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <button className="btn" onClick={() => setCreating(true)}>
          Tạo tài khoản
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
              <th>Email</th>
              <th>Tên</th>
              <th>Vai trò</th>
              <th>Trạng thái</th>
              <th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="table-state">
                  <Loading />
                </td>
              </tr>
            ) : data && data.accounts.length > 0 ? (
              data.accounts.map((a) => (
                <AccountRow key={a.id} account={a} onChanged={() => void load(search)} />
              ))
            ) : (
              <tr>
                <td colSpan={5} className="table-state">
                  Không tìm thấy tài khoản nào.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data && <div className="pagination">Tổng số: {data.total}</div>}

      {creating && (
        <CreateAccountModal
          onClose={() => setCreating(false)}
          onCreated={(email) => {
            setCreating(false);
            setMessage(`Đã tạo tài khoản ${email}.`);
            void load(search);
          }}
        />
      )}
    </div>
  );
}

function AccountRow({ account, onChanged }: { account: Account; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [rowError, setRowError] = useState("");

  async function toggleActive() {
    setBusy(true);
    setRowError("");
    try {
      await api.patch(`/admin/accounts/${account.id}`, { active: !account.active });
      onChanged();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr>
        <td className="email-cell">{account.email}</td>
        <td className="name-cell">{account.name}</td>
        <td>
          <span className={account.role === "admin" ? "role-badge" : "role-badge badge-muted"}>
            {account.role === "admin" ? "Admin" : "Thí sinh"}
          </span>
        </td>
        <td>
          <span className={`status-badge ${account.active ? "success" : "danger"}`}>
            {account.active ? "Hoạt động" : "Vô hiệu"}
          </span>
        </td>
        <td className="col-actions">
          <span className="action-group">
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setResetting(true)}>
              Đặt lại MK
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void toggleActive()}>
              {account.active ? "Vô hiệu hóa" : "Kích hoạt"}
            </button>
          </span>
        </td>
      </tr>
      {rowError && (
        <tr>
          <td colSpan={5} className="table-state error-cell">
            {rowError}
          </td>
        </tr>
      )}
      {resetting && (
        <ResetPasswordModal
          account={account}
          onClose={() => setResetting(false)}
          onDone={() => {
            setResetting(false);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button className="modal-close" aria-label="Đóng" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CreateAccountModal({ onClose, onCreated }: { onClose: () => void; onCreated: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"participant" | "admin">("participant");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/admin/accounts", { email, name, password, role });
      onCreated(email);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Tạo tài khoản" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="form-field">
            <label className="field-label" htmlFor="new-email">
              Email
            </label>
            <input
              id="new-email"
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="new-role">
              Vai trò
            </label>
            <select id="new-role" className="input" value={role} onChange={(e) => setRole(e.target.value as "participant" | "admin")}>
              <option value="participant">Thí sinh</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="new-name">
              Tên hiển thị
            </label>
            <input id="new-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="new-password">
              Mật khẩu (tối thiểu 10 ký tự)
            </label>
            <input
              id="new-password"
              className="input"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
        </div>
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
            Tạo
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post(`/admin/accounts/${account.id}/reset-password`, { password });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Đặt lại mật khẩu — ${account.email}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-field">
          <label className="field-label" htmlFor="reset-password">
            Mật khẩu mới (tối thiểu 10 ký tự)
          </label>
          <input
            id="reset-password"
            className="input"
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
        </div>
        <p className="modal-note">
          Mật khẩu mới cần được chuyển cho người dùng qua kênh riêng (email/chat) — hệ thống không gửi tự động.
        </p>
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
            Đặt lại
          </button>
        </div>
      </form>
    </Modal>
  );
}
