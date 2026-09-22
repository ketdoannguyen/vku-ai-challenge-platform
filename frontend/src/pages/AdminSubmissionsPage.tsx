/**
 * Bài nộp toàn hệ thống (admin): tra cứu xuyên cuộc thi và tải lại tệp của từng đội.
 * Bảng theo từng cuộc thi nằm ở tab kết quả của trang chi tiết; cả hai dùng chung
 * `AdminSubmissionsPanel`.
 */

import { AdminSubmissionsPanel, IconSubmission } from "../components/AdminSubmissionsPanel";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function AdminSubmissionsPage() {
  useDocumentTitle("Quản lý bài nộp");

  return (
    <div className="page admin-submissions">
      <header className="page-hero">
        <div className="page-hero-row">
          <span className="page-hero-icon" aria-hidden="true">
            <IconSubmission className="page-hero-glyph" />
          </span>
          <div className="page-hero-copy">
            <h1 className="page-hero-title">Quản lý bài nộp</h1>
            <p className="page-hero-subtitle">
              Tra cứu bài nộp của mọi cuộc thi và tải lại tệp dự đoán/notebook của từng đội
            </p>
            <span className="vku-accent" aria-hidden="true">
              <span className="blue" />
              <span className="red" />
              <span className="yellow" />
            </span>
          </div>
        </div>
      </header>

      <AdminSubmissionsPanel
        title="Danh sách bài nộp"
        listLabel="Danh sách bài nộp toàn hệ thống"
      />
    </div>
  );
}
