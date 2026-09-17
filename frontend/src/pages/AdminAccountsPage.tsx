/** Admin accounts: list/search, tạo, reset password, enable/disable. Role check thật ở backend. */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiClientError } from "../api/client";
import { useOptionalAuth, type Account } from "../auth/AuthContext";
import { ConfirmModal, Modal } from "../components/Modal";
import { ErrorBox, Loading } from "../components/ui";

interface AccountsResponse {
  accounts: Account[];
  total: number;
  limit: number;
  offset: number;
}

export function AdminAccountsPage() {
  const auth = useOptionalAuth();
  const currentAccountId = auth?.account?.id ?? null;
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const requestSequence = useRef(0);
  const firstSearch = useRef(true);
  const hasData = useRef(false);
  const messageTimer = useRef<number | null>(null);

  const load = useCallback(async (q: string, keepRows = false) => {
    const sequence = ++requestSequence.current;
    setError(null);
    if (keepRows) setRefreshing(true);
    else setLoading(true);
    const params = new URLSearchParams({ limit: "200" });
    if (q) params.set("q", q);
    try {
      const response = await api.get<AccountsResponse>(`/admin/accounts?${params.toString()}`);
      if (sequence === requestSequence.current) {
        hasData.current = true;
        setData(response);
      }
    } catch (err) {
      if (sequence === requestSequence.current) setError(err);
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  const notify = useCallback((text: string) => {
    if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    setMessage(text);
    messageTimer.current = window.setTimeout(() => {
      setMessage("");
      messageTimer.current = null;
    }, 4500);
  }, []);

  useEffect(() => {
    const delay = firstSearch.current ? 0 : 300;
    firstSearch.current = false;
    const timer = window.setTimeout(() => {
      void load(search.trim(), hasData.current);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  useEffect(
    () => () => {
      if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    },
    [],
  );

  return (
    <div className="page admin-accounts">
      <div className="page-head admin-accounts-head">
        <div>
          <h1 className="page-title">Quản lý tài khoản</h1>
          <p className="page-subtitle">Tạo, đặt lại mật khẩu, vô hiệu hóa tài khoản thí sinh/admin</p>
        </div>
      </div>

      <div className="admin-accounts-toolbar">
        <label className="admin-accounts-search">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
            <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <input
            className="input"
            type="search"
            aria-label="Tìm tài khoản"
            placeholder="Tìm theo email hoặc tên..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {refreshing && <span className="admin-accounts-sync" role="status">Đang cập nhật…</span>}
        </label>
        <button className="btn admin-accounts-create" type="button" onClick={() => setCreating(true)}>
          Tạo tài khoản
        </button>
      </div>

      {message && (
        <div className="status-banner success admin-accounts-message" role="status">
          <span>{message}</span>
          <button type="button" aria-label="Đóng thông báo" onClick={() => setMessage("")}>×</button>
        </div>
      )}
      {Boolean(error) && data && <ErrorBox error={error} />}

      <div className="table-wrap admin-accounts-table-wrap" aria-busy={loading || refreshing}>
        <table className="table admin-accounts-table">
          <thead>
            <tr><th scope="col">Email</th><th scope="col">Tên</th><th scope="col">Vai trò</th><th scope="col">Trạng thái</th><th scope="col">Thao tác</th></tr>
          </thead>
          <tbody>
            {loading && !data ? (
              <tr><td colSpan={5} className="table-state"><Loading /></td></tr>
            ) : error && !data ? (
              <tr>
                <td colSpan={5} className="table-state">
                  <div className="admin-accounts-error">
                    <ErrorBox error={error} />
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => void load(search.trim())}>Thử lại</button>
                  </div>
                </td>
              </tr>
            ) : data && data.accounts.length > 0 ? (
              data.accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  isCurrent={account.id === currentAccountId}
                  onChanged={() => void load(search.trim(), true)}
                  onMessage={notify}
                />
              ))
            ) : (
              <tr>
                <td colSpan={5} className="table-state">
                  <div className="admin-accounts-empty">
                    <span>Không tìm thấy tài khoản nào.</span>
                    {search && <button className="btn btn-secondary btn-sm" type="button" onClick={() => setSearch("")}>Xóa bộ lọc</button>}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {data && (
          <div className="admin-accounts-total">
            {data.accounts.length < data.total
              ? <>Đang hiển thị <strong>{data.accounts.length}</strong> / {data.total}</>
              : <>Tổng số: <strong>{data.total}</strong></>}
          </div>
        )}
      </div>

      {creating && (
        <CreateAccountModal
          onClose={() => setCreating(false)}
          onCreated={(email) => {
            setCreating(false);
            notify(`Đã tạo tài khoản ${email}.`);
            void load(search.trim(), true);
          }}
        />
      )}
    </div>
  );
}

function AccountRow({
  account,
  isCurrent,
  onChanged,
  onMessage,
}: {
  account: Account;
  isCurrent: boolean;
  onChanged: () => void;
  onMessage: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmingActiveChange, setConfirmingActiveChange] = useState(false);

  async function toggleActive() {
    setBusy(true);
    try {
      await api.patch(`/admin/accounts/${account.id}`, { active: !account.active });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const cannotDisableSelf = isCurrent && account.active;

  return (
    <>
      <tr>
        <td className="email-cell admin-account-email">
          <span>{account.email}</span>
          {isCurrent && <span className="admin-you-badge">Bạn</span>}
        </td>
        <td className="name-cell">{account.name}</td>
        <td><span className={`role-badge${account.role === "admin" ? "" : " badge-muted"}`}>{account.role === "admin" ? "Admin" : "Thí sinh"}</span></td>
        <td><span className={`status-badge ${account.active ? "success" : "danger"}`}>{account.active ? "Hoạt động" : "Vô hiệu"}</span></td>
        <td className="col-actions">
          <span className="action-group admin-account-actions">
            <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => setResetting(true)}>Đặt lại MK</button>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              disabled={busy || cannotDisableSelf}
              aria-describedby={cannotDisableSelf ? `self-disable-reason-${account.id}` : undefined}
              onClick={() => setConfirmingActiveChange(true)}
            >
              {account.active ? "Vô hiệu hóa" : "Kích hoạt"}
            </button>
            {cannotDisableSelf && (
              <span className="sr-only" id={`self-disable-reason-${account.id}`}>
                Bạn không thể tự vô hiệu hóa tài khoản đang đăng nhập.
              </span>
            )}
          </span>
        </td>
      </tr>
      {resetting && (
        <ResetPasswordModal
          account={account}
          onClose={() => setResetting(false)}
          onDone={() => {
            setResetting(false);
            onMessage(`Đã đặt lại mật khẩu cho ${account.email}.`);
          }}
        />
      )}
      {confirmingActiveChange && (
        <ConfirmModal
          title={account.active ? "Vô hiệu hóa tài khoản" : "Kích hoạt tài khoản"}
          body={account.active ? `Vô hiệu hóa ${account.email}? Người dùng sẽ mất quyền truy cập ngay lập tức.` : `Kích hoạt lại ${account.email}? Người dùng sẽ có thể đăng nhập trở lại.`}
          confirmLabel={account.active ? "Vô hiệu hóa" : "Kích hoạt"}
          danger={account.active}
          onConfirm={async () => {
            await toggleActive();
            setConfirmingActiveChange(false);
            onMessage(
              account.active
                ? `Đã vô hiệu hóa tài khoản ${account.email}.`
                : `Đã kích hoạt tài khoản ${account.email}.`,
            );
          }}
          onClose={() => setConfirmingActiveChange(false)}
        />
      )}
    </>
  );
}

function PasswordToggle({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return (
    <button
      className="password-toggle"
      type="button"
      aria-label={visible ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
      onClick={onToggle}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
        {visible ? (
          <>
            <path d="M3 3 21 21" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A10.3 10.3 0 0 1 12 5c5.5 0 9 7 9 7a15.7 15.7 0 0 1-2.3 3.2M6.2 6.2C3.9 8 3 12 3 12s3.5 7 9 7c1 0 2-.2 2.9-.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : (
          <>
            <path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.7" />
          </>
        )}
      </svg>
    </button>
  );
}

function CreateAccountModal({ onClose, onCreated }: { onClose: () => void; onCreated: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"participant" | "admin">("participant");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setEmailError("");
    try {
      await api.post("/admin/accounts", { email, name, password, role });
      onCreated(email);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "ACCOUNT_EXISTS") setEmailError(err.message);
      else setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Tạo tài khoản" onClose={onClose} variant="account-form">
      <form className="account-form-modal" onSubmit={submit}>
        <div className="account-form-grid">
          <div className="form-field account-form-wide">
            <label className="field-label account-required" htmlFor="new-email">Email</label>
            <input id="new-email" className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus aria-invalid={Boolean(emailError)} aria-describedby={emailError ? "new-email-error" : undefined} />
            {emailError && <span className="account-field-error" id="new-email-error" role="alert">{emailError}</span>}
          </div>
          <div className="form-field">
            <label className="field-label account-required" htmlFor="new-role">Vai trò</label>
            <select id="new-role" className="input" value={role} onChange={(event) => setRole(event.target.value as "participant" | "admin")}>
              <option value="participant">Thí sinh</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="form-field">
            <label className="field-label account-required" htmlFor="new-name">Tên hiển thị</label>
            <input id="new-name" className="input" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="form-field account-form-wide">
            <label className="field-label account-required" htmlFor="new-password">Mật khẩu (tối thiểu 10 ký tự)</label>
            <div className="password-field">
              <input id="new-password" className="input" type={passwordVisible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} autoComplete="new-password" required />
              <PasswordToggle visible={passwordVisible} onToggle={() => setPasswordVisible((value) => !value)} />
            </div>
          </div>
        </div>
        {error && <div className="error-box" role="alert">{error}</div>}
        <div className="modal-actions account-form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Hủy</button>
          <button className="btn" type="submit" disabled={busy}>{busy ? "Đang tạo..." : "Tạo tài khoản"}</button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
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
    <Modal title={`Đặt lại mật khẩu — ${account.email}`} onClose={onClose} variant="account-form">
      <form className="account-form-modal" onSubmit={submit}>
        <div className="form-field">
          <label className="field-label account-required" htmlFor="reset-password">Mật khẩu mới (tối thiểu 10 ký tự)</label>
          <div className="password-field">
            <input id="reset-password" className="input" type={passwordVisible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} autoComplete="new-password" required autoFocus />
            <PasswordToggle visible={passwordVisible} onToggle={() => setPasswordVisible((value) => !value)} />
          </div>
        </div>
        <p className="account-security-note">Mật khẩu mới cần được chuyển cho người dùng qua kênh riêng (email/chat) — hệ thống không gửi tự động.</p>
        {error && <div className="error-box" role="alert">{error}</div>}
        <div className="modal-actions account-form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Hủy</button>
          <button className="btn" type="submit" disabled={busy}>{busy ? "Đang đặt lại..." : "Đặt lại mật khẩu"}</button>
        </div>
      </form>
    </Modal>
  );
}
