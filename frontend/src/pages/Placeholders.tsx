import { Link, useNavigate } from "react-router-dom";

export function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <div className="page">
      <div className="card empty-state">
        <div className="empty-state-icon" aria-hidden>
          🧭
        </div>
        <h1>404 — Không tìm thấy trang</h1>
        <p>Trang bạn tìm không tồn tại.</p>
        <div className="empty-actions">
          <Link className="btn" to="/">
            Về trang chính
          </Link>
          <button type="button" className="btn btn-secondary" onClick={() => navigate(-1)}>
            Quay lại
          </button>
        </div>
      </div>
    </div>
  );
}
