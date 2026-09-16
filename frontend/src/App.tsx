import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { RequireAdmin, RequireAuth } from "./auth/RequireAuth";
import { HealthPage } from "./pages/HealthPage";
import { AdminAccountsPage } from "./pages/AdminAccountsPage";
import { AdminCompetitionsPage } from "./pages/AdminCompetitionsPage";
import { AdminCompetitionDetailPage } from "./pages/AdminCompetitionDetailPage";
import { CompetitionDetailPage } from "./pages/CompetitionDetailPage";
import { CompetitionContentPanel, CompetitionOverview } from "./pages/CompetitionContentPanel";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import { SubmissionPage } from "./pages/SubmissionPage";
import { MySubmissionsPage } from "./pages/MySubmissionsPage";
import { LeaderboardPage } from "./pages/LeaderboardPage";
import { NotFoundPage } from "./pages/Placeholders";

const BRAND = "AI Challenge Platform";

function BrandMark() {
  return (
    <svg
      className="app-brand-mark"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="16" cy="16" r="3.5" fill="currentColor" />
      <ellipse cx="16" cy="7.5" rx="3.5" ry="5.5" />
      <ellipse cx="16" cy="24.5" rx="3.5" ry="5.5" />
      <ellipse cx="7.5" cy="16" rx="5.5" ry="3.5" />
      <ellipse cx="24.5" cy="16" rx="5.5" ry="3.5" />
      <ellipse cx="10" cy="10" rx="3.5" ry="5.5" transform="rotate(-45 10 10)" />
      <ellipse cx="22" cy="22" rx="3.5" ry="5.5" transform="rotate(-45 22 22)" />
      <ellipse cx="22" cy="10" rx="3.5" ry="5.5" transform="rotate(45 22 10)" />
      <ellipse cx="10" cy="22" rx="3.5" ry="5.5" transform="rotate(45 10 22)" />
    </svg>
  );
}

function IconMenu() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function IconPerson() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  );
}

function IconLogout() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h9" />
    </svg>
  );
}

type NavItem = { to: string; label: string; end?: boolean };

function useNavItems() {
  const { account } = useAuth();
  if (!account) {
    return [
      { to: "/login", label: "Đăng nhập" },
      { to: "/health", label: "Health" },
    ] satisfies NavItem[];
  }
  const items: NavItem[] = [{ to: "/", label: "Cuộc thi", end: true }];
  if (account.role === "admin") {
    items.push({ to: "/admin/competitions", label: "Quản trị" });
    items.push({ to: "/admin/accounts", label: "Tài khoản", end: true });
  }
  items.push({ to: "/health", label: "Health" });
  return items;
}

function roleLabel(role: string) {
  return role === "admin" ? "Admin" : "Thí sinh";
}

function Header() {
  const { account, loading, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const navItems = useNavItems();

  async function onLogout() {
    setMenuOpen(false);
    await logout();
    navigate("/login");
  }

  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        toggleRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <header className="app-header">
      <a className="skip-link" href="#main-content">
        Bỏ qua tới nội dung chính
      </a>
      <div className="app-header-inner">
        <Link className="app-brand" to="/">
          <BrandMark />
          <span className="app-brand-text">{BRAND}</span>
        </Link>
        <nav className="app-nav" aria-label="Điều hướng chính">
          {navItems
            .filter((item) => item.to !== "/login")
            .map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end}>
                {item.label}
              </NavLink>
            ))}
        </nav>
        <div className="app-header-right">
          {loading ? null : account ? (
            <>
              <div className="user-chip">
                <span className="user-name">{account.name}</span>
                <span className={account.role === "admin" ? "role-badge" : "role-badge badge-muted"}>
                  {roleLabel(account.role)}
                </span>
              </div>
              <span className="app-avatar" aria-hidden="true">
                <IconPerson />
              </span>
              <button className="app-logout" onClick={() => void onLogout()}>
                <IconLogout />
                <span className="app-logout-label">Đăng xuất</span>
              </button>
            </>
          ) : (
            <>
              <Link className="app-login-cta" to="/login">
                Đăng nhập
              </Link>
              <span className="app-avatar" aria-hidden="true">
                <IconPerson />
              </span>
            </>
          )}
          <button
            ref={toggleRef}
            type="button"
            className="app-menu-toggle"
            aria-label="Mở menu điều hướng"
            aria-expanded={menuOpen}
            aria-controls="app-drawer"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <IconClose /> : <IconMenu />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <>
          <div className="app-drawer-overlay" onClick={() => setMenuOpen(false)} />
          <div className="app-drawer" id="app-drawer">
            <div className="app-drawer-head">
              <div className="app-drawer-user">
                {account ? (
                  <>
                    <span className="user-name">{account.name}</span>
                    <span
                      className={account.role === "admin" ? "role-badge" : "role-badge badge-muted"}
                    >
                      {roleLabel(account.role)}
                    </span>
                  </>
                ) : (
                  <span className="user-name">{BRAND}</span>
                )}
              </div>
              <button
                type="button"
                className="modal-close"
                aria-label="Đóng menu"
                onClick={() => {
                  setMenuOpen(false);
                  toggleRef.current?.focus();
                }}
              >
                <IconClose />
              </button>
            </div>
            <nav className="app-drawer-nav" aria-label="Điều hướng chính">
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={() => setMenuOpen(false)}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            {account && (
              <div className="app-drawer-foot">
                <button className="btn btn-secondary" onClick={() => void onLogout()}>
                  <IconLogout />
                  Đăng xuất
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </header>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Header />
      <main className="app-main" id="main-content" tabIndex={-1}>
        <Routes>
          <Route
            path="/"
            element={
              <RequireAuth>
                <DashboardPage />
              </RequireAuth>
            }
          />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/competitions/:slug"
            element={
              <RequireAuth>
                <CompetitionDetailPage />
              </RequireAuth>
            }
          >
            <Route index element={<CompetitionOverview />} />
            <Route path="content/:contentSlug" element={<CompetitionContentPanel />} />
            <Route path="submit" element={<SubmissionPage />} />
            <Route path="submissions" element={<MySubmissionsPage />} />
            <Route path="leaderboard" element={<LeaderboardPage />} />
          </Route>
          <Route
            path="/admin/competitions"
            element={
              <RequireAdmin>
                <AdminCompetitionsPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/competitions/:id"
            element={
              <RequireAdmin>
                <AdminCompetitionDetailPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/accounts"
            element={
              <RequireAdmin>
                <AdminAccountsPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireAdmin>
                <AdminCompetitionsPage />
              </RequireAdmin>
            }
          />
          <Route path="/health" element={<HealthPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </AuthProvider>
  );
}
