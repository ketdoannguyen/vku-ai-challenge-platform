import { NavLink, Route, Routes } from "react-router-dom";
import { HealthPage } from "./pages/HealthPage";
import { AdminPage, CompetitionPage, DashboardPage, LoginPage, NotFoundPage } from "./pages/Placeholders";

export function App() {
  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <a className="app-brand" href="/">
            AI Challenge Platform
          </a>
          <nav className="app-nav">
            <NavLink to="/">Cuộc thi</NavLink>
            <NavLink to="/login">Đăng nhập</NavLink>
            <NavLink to="/admin">Admin</NavLink>
            <NavLink to="/health">Health</NavLink>
          </nav>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/competitions/:slug/*" element={<CompetitionPage />} />
        <Route path="/admin/*" element={<AdminPage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  );
}
