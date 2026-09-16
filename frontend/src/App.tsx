import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
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
                {account.role === "admin" && (
                <>
                  <NavLink to="/admin/competitions">Quản trị</NavLink>
                  <NavLink to="/admin/accounts" end>
                    Tài khoản
                  </NavLink>
                </>
              )}
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
        <Route path="/admin" element={<RequireAdmin><AdminCompetitionsPage /></RequireAdmin>} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  );
}
