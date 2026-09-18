import { Link, useNavigate } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

function IconCompass() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="44"
      height="44"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z" />
    </svg>
  );
}

export function NotFoundPage() {
  const navigate = useNavigate();
  useDocumentTitle("Không tìm thấy trang");

  return (
    <div className="page">
      <div className="card empty-state sys-state">
        <span className="vku-accent" aria-hidden="true">
          <span className="blue" />
          <span className="red" />
          <span className="yellow" />
        </span>
        <div className="empty-state-icon" aria-hidden="true">
          <IconCompass />
        </div>
        <h1>404 - Không tìm thấy trang</h1>
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
