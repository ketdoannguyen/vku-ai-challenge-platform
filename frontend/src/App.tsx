import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { RequireAdmin, RequireAuth } from "./auth/RequireAuth";
import { HealthPage } from "./pages/HealthPage";
import { AdminAccountsPage } from "./pages/AdminAccountsPage";
import { LoginPage } from "./pages/LoginPage";
import { CompetitionPage, DashboardPage, NotFoundPage } from "./pages/Placeholders";

function Header() {
  const { account, loading, logout } = useAuth();
  const navigate = useNavigate();

  async function onLogout() {
    await logout();
    navigate("/login");
  }

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <a className="app-brand" href="/">
          AI Challenge Platform
        </a>
        <div className="app-header-right">
          {loading ? null : account ? (
            <>
              <nav className="app-nav" aria-label="Điều hướng chính">
                <NavLink to="/" end>
                  Cuộc thi
                </NavLink>
                {account.role === "admin" && <NavLink to="/admin/accounts">Quản trị</NavLink>}
                <NavLink to="/health">Health</NavLink>
              </nav>
              <div className="user-chip">
                <span className="user-name">{account.name}</span>
                <span className={account.role === "admin" ? "role-badge" : "role-badge badge-muted"}>
                  {account.role === "admin" ? "Admin" : "Thí sinh"}
                </span>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => void onLogout()}>
                Đăng xuất
              </button>
            </>
          ) : (
            <nav className="app-nav" aria-label="Điều hướng chính">
              <NavLink to="/login">Đăng nhập</NavLink>
              <NavLink to="/health">Health</NavLink>
            </nav>
          )}
        </div>
      </div>
    </header>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Header />
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
          path="/competitions/:slug/*"
          element={
            <RequireAuth>
              <CompetitionPage />
            </RequireAuth>
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
        <Route path="/admin" element={<RequireAdmin><AdminAccountsPage /></RequireAdmin>} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  );
}
