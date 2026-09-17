import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth, type Account } from "./auth/AuthContext";
import { RequireAdmin, RequireAuth } from "./auth/RequireAuth";
import { FOCUSABLE } from "./components/Modal";
import { useRouteFocus } from "./hooks/useRouteFocus";
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

// Chữ "VKU" đã nằm trong logo cạnh bên nên phần chữ chỉ còn tên cuộc thi.
const BRAND = "AI Challenge";

function BrandMark() {
  return (
    <img
      src="/vku-logo.png"
      alt="VKU"
      className="app-brand-logo"
    />
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
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  );
}

type NavItem = { to: string; label: string; end?: boolean };

function useNavItems(): NavItem[] {
  const { account } = useAuth();
  // "Cuộc thi" đọc công khai (ADR-014) nên khách cũng thấy; mục quản trị thì không.
  const items: NavItem[] = [{ to: "/", label: "Cuộc thi", end: true }];
  if (account?.role === "admin") {
    items.push({ to: "/admin/competitions", label: "Quản trị" });
    items.push({ to: "/admin/accounts", label: "Tài khoản", end: true });
  }
  return items;
}

function roleLabel(role: string) {
  return role === "admin" ? "Admin" : "Thí sinh";
}

/** Lý do đóng drawer quyết định focus trả về đâu (xem `closeDrawer`). */
type DrawerCloseReason = "escape" | "overlay" | "close" | "navigation";

/**
 * Drawer điều hướng dưới 64rem. Portal ra `document.body` để `#root` có thể ở
 * trạng thái `inert` mà không vô hiệu hoá chính drawer, và để không phụ thuộc
 * vào cascade `pointer-events` của `.app-header`.
 */
function MobileDrawer({
  account,
  navItems,
  returnFocusRef,
  onClose,
  onLogout,
}: {
  account: Account | null;
  navItems: NavItem[];
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onLogout: () => void | Promise<void>;
}) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  /**
   * Focus phải trả về hamburger *sau* khi `#root` hết `inert`, nên việc restore
   * nằm trong cleanup của effect bên dưới chứ không ở handler đóng drawer.
   * Điều hướng thì không trả về: `useRouteFocus` đưa focus tới main của trang mới.
   */
  const restoreFocus = useRef(false);

  /** Ghi nhớ lý do đóng trước khi unmount, vì cleanup không nhận được tham số. */
  const requestClose = useCallback((reason: DrawerCloseReason) => {
    restoreFocus.current = reason !== "navigation";
    onCloseRef.current();
  }, []);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const root = document.getElementById("root");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (root) root.inert = true;
    drawerRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        requestClose("escape");
        return;
      }
      if (event.key !== "Tab") return;

      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const outside = !(active instanceof HTMLElement) || !drawer.contains(active);

      if (event.shiftKey && (outside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (outside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (root) root.inert = false;
      // Focus chỉ vào được sau khi `inert` đã gỡ, nên phải đặt ở đây.
      if (restoreFocus.current) returnFocusRef.current?.focus();
    };
  }, [requestClose, returnFocusRef]);

  return createPortal(
    <>
      <div className="app-drawer-overlay" onClick={() => requestClose("overlay")} />
      <div
        ref={drawerRef}
        className="app-drawer"
        id="app-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Menu điều hướng"
      >
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
            onClick={() => requestClose("close")}
          >
            <IconClose />
          </button>
        </div>
        <nav className="app-drawer-nav" aria-label="Điều hướng chính (menu di động)">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} onClick={() => requestClose("navigation")}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        {/* Dưới 40rem nút "Đăng nhập" trên header bị ẩn nên drawer là lối vào
            duy nhất cho khách trên điện thoại. */}
        <div className="app-drawer-foot">
          {account ? (
            <button className="btn btn-secondary" onClick={() => void onLogout()}>
              <IconLogout />
              Đăng xuất
            </button>
          ) : (
            <Link className="btn" to="/login" onClick={() => requestClose("navigation")}>
              Đăng nhập
            </Link>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

function Header() {
  const { account, loading, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const navItems = useNavItems();

  async function onLogout() {
    setMenuOpen(false);
    await logout();
    navigate("/login");
  }

  /** Việc trả focus về hamburger do chính drawer làm khi unmount (xem `MobileDrawer`). */
  function closeDrawer() {
    setMenuOpen(false);
  }

  // S01 (login) không có app shell: chỉ còn nút quay lại trong trang.
  if (pathname === "/login") return null;

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
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="app-header-right">
          {loading ? null : account ? (
            <>
              {/* Ảnh mẫu chỉ để 2 control ở cột phải: capsule tài khoản + nút icon.
                  Vai trò rời khỏi navbar nên giữ lại ở dạng sr-only — ở desktop
                  drawer không mở được (.app-menu-toggle ẩn từ md). */}
              <span className="user-pill">
                <span className="app-avatar" aria-hidden="true">
                  <IconPerson />
                </span>
                <span className="user-name">{account.name}</span>
                <span className="sr-only">{roleLabel(account.role)}</span>
              </span>
              <button className="app-logout" aria-label="Đăng xuất" onClick={() => void onLogout()}>
                <IconLogout />
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
            aria-label={menuOpen ? "Đóng menu điều hướng" : "Mở menu điều hướng"}
            aria-expanded={menuOpen}
            aria-controls="app-drawer"
            onClick={() => (menuOpen ? closeDrawer() : setMenuOpen(true))}
          >
            {menuOpen ? <IconClose /> : <IconMenu />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <MobileDrawer
          account={account}
          navItems={navItems}
          returnFocusRef={toggleRef}
          onClose={closeDrawer}
          onLogout={onLogout}
        />
      )}
    </header>
  );
}

export function App() {
  const { pathname } = useLocation();
  // Trang login không có header nên không giữ chỗ cho header.
  const bare = pathname === "/login";
  // Dashboard là lưới 3 cột nên cần trần rộng hơn các màn còn lại.
  const dashboard = pathname === "/";
  useRouteFocus();
  return (
    <AuthProvider>
      <Header />
      <main
        className={`app-main${bare ? " app-main-bare" : ""}${dashboard ? " app-main-dashboard" : ""}`}
        id="main-content"
        tabIndex={-1}
      >
        <Routes>
          {/* Danh sách và chi tiết cuộc thi đọc công khai (ADR-014); chỉ các trang
              gắn với danh tính mới chặn. */}
          <Route path="/" element={<DashboardPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/competitions/:slug" element={<CompetitionDetailPage />}>
            <Route index element={<CompetitionOverview />} />
            <Route path="content/:contentSlug" element={<CompetitionContentPanel />} />
            <Route
              path="submit"
              element={
                <RequireAuth>
                  <SubmissionPage />
                </RequireAuth>
              }
            />
            <Route
              path="submissions"
              element={
                <RequireAuth>
                  <MySubmissionsPage />
                </RequireAuth>
              }
            />
            <Route
              path="leaderboard"
              element={
                <RequireAuth>
                  <LeaderboardPage />
                </RequireAuth>
              }
            />
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
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </AuthProvider>
  );
}
