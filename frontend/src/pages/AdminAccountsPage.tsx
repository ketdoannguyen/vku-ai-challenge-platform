/** Admin accounts: list/search, tạo, reset password, enable/disable. Role check thật ở backend. */

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiClientError } from "../api/client";
import { useOptionalAuth, type Account } from "../auth/AuthContext";
import { ConfirmModal, Modal } from "../components/Modal";
import { ErrorBox, Loading } from "../components/ui";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

/** `total` là số khớp từ khóa tìm kiếm; `stats` là tổng quan toàn hệ thống cho các thẻ KPI. */
interface AccountsResponse {
  accounts: Account[];
  total: number;
  limit: number;
  offset: number;
  stats: AccountStats;
}

interface AccountStats {
  total: number;
  admin: number;
  participant: number;
  active: number;
}

const PAGE_SIZE = 50;

/** Truy vấn đang hiệu lực. `q` và `offset` luôn đổi cùng nhau để không fetch
 *  từ khóa mới ở offset cũ (kết quả sẽ trống oan). */
interface AccountsQuery {
  q: string;
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
  const [query, setQuery] = useState<AccountsQuery>({ q: "", offset: 0 });
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const requestSequence = useRef(0);
  const firstSearch = useRef(true);
  const hasData = useRef(false);
  const messageTimer = useRef<number | null>(null);
  useDocumentTitle("Quản lý tài khoản");

  const load = useCallback(async (q: string, offset: number, keepRows = false) => {
    const sequence = ++requestSequence.current;
    setError(null);
    if (keepRows) setRefreshing(true);
    else setLoading(true);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (q) params.set("q", q);
    try {
      const response = await api.get<AccountsResponse>(`/admin/accounts?${params.toString()}`);
      if (sequence !== requestSequence.current) return;
      hasData.current = true;
      // Trang cuối có thể vừa rỗng đi sau khi vô hiệu hóa/xóa - lùi về trang còn dữ liệu.
      if (response.accounts.length === 0 && response.offset > 0) {
        const lastOffset = Math.max(0, Math.floor(Math.max(response.total - 1, 0) / PAGE_SIZE) * PAGE_SIZE);
        if (lastOffset !== response.offset) {
          setQuery((current) => (current.offset === response.offset ? { ...current, offset: lastOffset } : current));
          return;
        }
      }
      setData(response);
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
      // Trả về chính object cũ khi không có gì đổi để React bỏ qua render và
      // không phát thêm request trùng lúc mount.
      setQuery((current) =>
        current.q === search.trim() && current.offset === 0
          ? current
          : { q: search.trim(), offset: 0 },
      );
    }, delay);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    void load(query.q, query.offset, hasData.current);
  }, [load, query]);

  useEffect(
    () => () => {
      if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    },
    [],
  );

  const shownFrom = data ? data.offset + 1 : 0;
  const shownTo = data ? data.offset + data.accounts.length : 0;
  const hasNext = data ? shownTo < data.total : false;
  const stats = data?.stats ?? null;

  return (
    <div className="page admin-accounts">
      <header className="page-hero">
        <div className="page-hero-row">
          <span className="page-hero-icon" aria-hidden="true">
            <IconUsers className="page-hero-glyph" />
          </span>
          <div className="page-hero-copy">
            <h1 className="page-hero-title">Quản lý tài khoản</h1>
            <p className="page-hero-subtitle">Tạo, đặt lại mật khẩu, vô hiệu hóa tài khoản thí sinh/admin</p>
            <span className="vku-accent" aria-hidden="true">
              <span className="blue" />
              <span className="red" />
              <span className="yellow" />
            </span>
          </div>
        </div>
      </header>

      <section className="admin-accounts-stats" aria-label="Tổng quan tài khoản">
        <AccountStatCard
          tone="blue"
          label="Tổng tài khoản"
          detail="Toàn hệ thống"
          value={stats?.total ?? null}
          pending={!data && !error}
          glyph={<IconUsers />}
        />
        <AccountStatCard
          tone="red"
          label="Tài khoản Admin"
          detail="Có quyền quản trị"
          value={stats?.admin ?? null}
          pending={!data && !error}
          glyph={<IconShield />}
        />
        <AccountStatCard
          tone="yellow"
          label="Tài khoản Thí sinh"
          detail="Tài khoản dự thi"
          value={stats?.participant ?? null}
          pending={!data && !error}
          glyph={<IconGraduationCap />}
        />
        <AccountStatCard
          tone="green"
          label="Đang hoạt động"
          detail="Có thể đăng nhập"
          value={stats?.active ?? null}
          pending={!data && !error}
          glyph={<IconUserCheck />}
        />
      </section>

      <div className="admin-accounts-toolbar">
        <label className="admin-accounts-search">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true" focusable="false">
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
            <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            aria-label="Tìm tài khoản"
            placeholder="Tìm theo email hoặc tên..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {refreshing && <span className="admin-accounts-sync" role="status">Đang cập nhật…</span>}
        </label>
        <button className="admin-accounts-create" type="button" onClick={() => setCreating(true)}>
          <span aria-hidden="true">+</span>
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

      <div className="admin-accounts-card">
        <div className="admin-accounts-card-head">
          <span className="admin-accounts-card-accent" aria-hidden="true" />
          <h2 className="admin-accounts-card-title">Danh sách tài khoản</h2>
          {data && <span className="admin-accounts-card-count">{data.total} tài khoản</span>}
        </div>

        <div
          className="admin-accounts-table-scroll"
          aria-busy={loading || refreshing}
          tabIndex={0}
          role="region"
          aria-label="Bảng tài khoản"
        >
          <table className="admin-accounts-table">
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
                      <button className="admin-accounts-secondary" type="button" onClick={() => void load(query.q, query.offset)}>Thử lại</button>
                    </div>
                  </td>
                </tr>
              ) : data && data.accounts.length > 0 ? (
                data.accounts.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    isCurrent={account.id === currentAccountId}
                    onChanged={() => void load(query.q, query.offset, true)}
                    onMessage={notify}
                  />
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="table-state">
                    <div className="admin-accounts-empty">
                      <span>Không tìm thấy tài khoản nào.</span>
                      {search && <button className="admin-accounts-secondary" type="button" onClick={() => setSearch("")}>Xóa bộ lọc</button>}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pager nằm ngoài vùng cuộn ngang để không trôi theo bảng. */}
        {data && data.total > PAGE_SIZE && (
          <div className="admin-accounts-pagination">
            <div role="status">
              {loading || refreshing ? (
                "Đang cập nhật…"
              ) : (
                <>Đã hiển thị <strong>{shownFrom}–{shownTo}</strong> trong số <strong>{data.total}</strong> tài khoản</>
              )}
            </div>
            <div className="admin-accounts-pager">
              <button
                type="button"
                className="admin-accounts-secondary"
                aria-disabled={loading || refreshing || data.offset === 0}
                onClick={() => {
                  if (!loading && !refreshing && data.offset > 0) {
                    setQuery((current) => ({ ...current, offset: data.offset - PAGE_SIZE }));
                  }
                }}
              >
                Trang trước
              </button>
              <span>{shownFrom}–{shownTo} / {data.total}</span>
              <button
                type="button"
                className="admin-accounts-secondary"
                aria-disabled={loading || refreshing || !hasNext}
                onClick={() => {
                  if (!loading && !refreshing && hasNext) {
                    setQuery((current) => ({ ...current, offset: data.offset + PAGE_SIZE }));
                  }
                }}
              >
                Trang sau
              </button>
            </div>
          </div>
        )}
      </div>

      {creating && (
        <CreateAccountModal
          onClose={() => setCreating(false)}
          onCreated={(email) => {
            setCreating(false);
            notify(`Đã tạo tài khoản ${email}.`);
            void load(query.q, query.offset, true);
          }}
        />
      )}
    </div>
  );
}

const STAT_TONES = ["blue", "red", "yellow", "green"] as const;

/** Một ô KPI. `value` null nghĩa là chưa có dữ liệu - không được hiện số giả. */
function AccountStatCard({
  tone,
  label,
  detail,
  value,
  pending,
  glyph,
}: {
  tone: (typeof STAT_TONES)[number];
  label: string;
  detail: string;
  value: number | null;
  pending: boolean;
  glyph: ReactNode;
}) {
  return (
    <article className="admin-account-stat" data-tone={tone}>
      <span className="admin-account-stat-icon" aria-hidden="true">{glyph}</span>
      <div className="admin-account-stat-body">
        <p className="admin-account-stat-label">{label}</p>
        {value === null ? (
          <>
            <span className="admin-account-stat-placeholder" aria-hidden="true" />
            <span className="sr-only">{pending ? "Đang tải thống kê" : "Chưa tải được thống kê"}</span>
          </>
        ) : (
          <span className="admin-account-stat-value">{value}</span>
        )}
        <p className="admin-account-stat-detail">{detail}</p>
      </div>
    </article>
  );
}

/** Icon dùng chung khung SVG; mọi glyph đều decorative nên ẩn khỏi cây accessibility. */
function Glyph({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function IconUsers({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M3.5 19.5v-1a4.3 4.3 0 0 1 4.3-4.3h2.4a4.3 4.3 0 0 1 4.3 4.3v1" />
      <path d="M16.4 4.9a3.4 3.4 0 0 1 0 6.2M17.6 14.4a4.3 4.3 0 0 1 3.1 4.1v1" />
    </Glyph>
  );
}

function IconShield({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M12 3.2 5.4 6v5.3c0 4.1 2.7 7.6 6.6 9.1 3.9-1.5 6.6-5 6.6-9.1V6L12 3.2Z" />
      <path d="m9.2 11.9 2 2 3.6-3.8" />
    </Glyph>
  );
}

function IconGraduationCap({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M2.8 9.4 12 5l9.2 4.4L12 13.8 2.8 9.4Z" />
      <path d="M6.8 11.5v4.2c0 1.2 2.3 2.4 5.2 2.4s5.2-1.2 5.2-2.4v-4.2" />
    </Glyph>
  );
}

function IconUserCheck({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <circle cx="10" cy="8" r="3.4" />
      <path d="M3.8 19.5v-1a4.3 4.3 0 0 1 4.3-4.3h2.6" />
      <path d="m14.8 16.9 2.1 2.1 3.6-4.2" />
    </Glyph>
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
        <td className="admin-account-email">
          <span>{account.email}</span>
          {isCurrent && <span className="admin-you-badge">Bạn</span>}
        </td>
        <td className="admin-account-name">{account.name}</td>
        <td>
          <span className="admin-role-badge" data-role={account.role}>
            {account.role === "admin" ? "Admin" : "Thí sinh"}
          </span>
        </td>
        <td>
          <span className="admin-status-badge" data-active={account.active}>
            <span className="admin-status-dot" aria-hidden="true" />
            {account.active ? "Hoạt động" : "Vô hiệu"}
          </span>
        </td>
        <td className="col-actions">
          <span className="admin-account-actions">
            <button className="admin-account-action" type="button" disabled={busy} onClick={() => setResetting(true)}>Đặt lại MK</button>
            <button
              className={`admin-account-action${account.active ? " admin-account-action-danger" : ""}`}
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
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true" focusable="false">
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
    <Modal title={`Đặt lại mật khẩu - ${account.email}`} onClose={onClose} variant="account-form">
      <form className="account-form-modal" onSubmit={submit}>
        <div className="form-field">
          <label className="field-label account-required" htmlFor="reset-password">Mật khẩu mới (tối thiểu 10 ký tự)</label>
          <div className="password-field">
            <input id="reset-password" className="input" type={passwordVisible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} autoComplete="new-password" required autoFocus />
            <PasswordToggle visible={passwordVisible} onToggle={() => setPasswordVisible((value) => !value)} />
          </div>
        </div>
        <p className="account-security-note">Mật khẩu mới cần được chuyển cho người dùng qua kênh riêng (email/chat) - hệ thống không gửi tự động.</p>
        {error && <div className="error-box" role="alert">{error}</div>}
        <div className="modal-actions account-form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Hủy</button>
          <button className="btn" type="submit" disabled={busy}>{busy ? "Đang đặt lại..." : "Đặt lại mật khẩu"}</button>
        </div>
      </form>
    </Modal>
  );
}
