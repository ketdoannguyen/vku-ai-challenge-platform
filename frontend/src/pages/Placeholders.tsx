import { Placeholder } from "../components/ui";

export function LoginPage() {
  return (
    <div className="page">
      <h1>Đăng nhập</h1>
      <Placeholder>
        Form đăng nhập (tài khoản do BTC cấp) sẽ có ở Sprint 02 — hiện chưa có auth.
      </Placeholder>
      <div className="card">
        <form>
          <p>
            <label htmlFor="email">Tài khoản</label>
            <input id="email" className="input" type="text" disabled placeholder="Chưa kích hoạt" />
          </p>
          <p>
            <label htmlFor="password">Mật khẩu</label>
            <input id="password" className="input" type="password" disabled placeholder="Chưa kích hoạt" />
          </p>
          <button className="btn" disabled>
            Đăng nhập
          </button>
        </form>
      </div>
    </div>
  );
}

export function DashboardPage() {
  return (
    <div className="page">
      <h1>Danh sách cuộc thi</h1>
      <Placeholder>Danh sách competition và trạng thái join sẽ có ở Sprint 03-04.</Placeholder>
    </div>
  );
}

export function CompetitionPage() {
  return (
    <div className="page">
      <h1>Competition</h1>
      <Placeholder>
        Trang competition (Overview / Đề bài / Rules / Nộp bài / Leaderboard) sẽ có từ Sprint 03.
      </Placeholder>
    </div>
  );
}

export function AdminPage() {
  return (
    <div className="page">
      <h1>Admin</h1>
      <Placeholder>Quản lý tài khoản và competition sẽ có từ Sprint 02-03 (chỉ admin).</Placeholder>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="page">
      <h1>404 — Không tìm thấy trang</h1>
      <p>
        Trang bạn tìm không tồn tại. <a href="/">Về trang chính</a>
      </p>
    </div>
  );
}
