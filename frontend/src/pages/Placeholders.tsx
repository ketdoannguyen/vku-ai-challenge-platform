import { Placeholder } from "../components/ui";

export function DashboardPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Cuộc thi</h1>
          <p className="page-subtitle">Các cuộc thi bạn có thể tham gia</p>
        </div>
      </div>
      <div className="card empty-state">
        <div className="empty-state-icon" aria-hidden>
          🏆
        </div>
        <h2>Chưa có cuộc thi nào</h2>
        <p>Các cuộc thi sẽ xuất hiện tại đây khi được mở (kế hoạch Sprint 03-04).</p>
      </div>
      <Placeholder>Placeholder này sẽ được thay bằng danh sách competition thật ở Sprint 03.</Placeholder>
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
