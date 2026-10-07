/**
 * Admin sửa một bảng tổng hợp: cấu hình (tên, nguồn, trọng số, quyền xem), công bố/ẩn, xoá
 * và xem trước **bản đã lưu**.
 *
 * Sửa bảng đang công bố phải xác nhận trước khi ghi vì thay đổi áp dụng ngay cho lượt đọc kế tiếp.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  deleteAggregate,
  fetchAdminAggregate,
  fetchAdminAggregateLeaderboard,
  publishAggregate,
  unpublishAggregate,
  updateAggregate,
  type AdminAggregateDetail,
  type AggregateConfigInput,
  type AggregateLeaderboard,
} from "../api/aggregates";
import { api } from "../api/client";
import { TRACKS, TRACK_LABEL, formatLocal, type AdminCompetition, type AdminCompetitionsResponse, type Track } from "../api/competitions";
import { AggregateIcon, AggregateTable, AggregateWaiting } from "../components/AggregateBoard";
import { ConfirmModal } from "../components/Modal";
import { ErrorBox, Loading } from "../components/ui";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { AggregateForm } from "./AdminAggregateManagement";

/** Số dòng xem trước mỗi lượt đọc; bảng thật của thí sinh vẫn phân trang đầy đủ. */
const PREVIEW_LIMIT = 50;

export function AdminAggregateDetailPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<AdminAggregateDetail | null>(null);
  const [competitions, setCompetitions] = useState<AdminCompetition[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [preview, setPreview] = useState<AggregateLeaderboard | null>(null);
  const [previewView, setPreviewView] = useState<Track>("public");
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [previewToken, setPreviewToken] = useState(0);
  useDocumentTitle("Bảng tổng hợp");

  // Xác nhận trước khi ghi đè cấu hình đang công bố: form chờ promise này rồi mới gọi API.
  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false);
  const confirmResolver = useRef<((value: boolean) => void) | null>(null);

  function askConfirmSave(): Promise<boolean> {
    setConfirmSaveOpen(true);
    return new Promise((resolve) => {
      confirmResolver.current = resolve;
    });
  }

  function resolveConfirmSave(value: boolean) {
    setConfirmSaveOpen(false);
    confirmResolver.current?.(value);
    confirmResolver.current = null;
  }

  const load = useCallback(async () => {
    setError(null);
    try {
      const [aggregate, competitionsResponse] = await Promise.all([
        fetchAdminAggregate(slug),
        api.get<AdminCompetitionsResponse>("/admin/competitions"),
      ]);
      setDetail(aggregate);
      setCompetitions(competitionsResponse.competitions);
    } catch (err) {
      setError(err);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    setPreviewError(null);
    setPreview(null);
    fetchAdminAggregateLeaderboard(slug, previewView, PREVIEW_LIMIT, 0)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (!cancelled) setPreviewError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, previewView, previewToken]);

  async function togglePublish() {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const updated = detail.published
        ? await unpublishAggregate(slug)
        : await publishAggregate(slug);
      setDetail(updated);
      setMessage(updated.published ? "Đã công bố bảng tổng hợp." : "Đã ẩn bảng tổng hợp.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (detail === null) {
    return error ? (
      <div className="page ac-page">
        <ErrorBox error={error} />
        <div className="results-retry">
          <Link to="/admin/aggregates" className="btn btn-secondary">Về danh sách</Link>
        </div>
      </div>
    ) : (
      <Loading label="Đang tải cấu hình bảng tổng hợp..." />
    );
  }

  return (
    <div className="page ac-page">
      <header className="page-hero">
        <div className="page-hero-row">
          <span className="page-hero-icon" aria-hidden="true">
            <AggregateIcon className="page-hero-glyph" />
          </span>
          <div className="page-hero-copy">
            <p className="lb-eyebrow">
              <Link to="/admin/aggregates">Bảng tổng hợp</Link>
              <span>/</span>
              <span className="results-slug">{detail.slug}</span>
            </p>
            <h1 className="page-hero-title">{detail.name}</h1>
            <p className="page-hero-subtitle">
              {detail.published ? "Đang công bố" : "Bản nháp — chỉ admin thấy"} · Sửa cấu hình lúc{" "}
              {formatLocal(detail.updated_at)}
            </p>
            <span className="vku-accent" aria-hidden="true">
              <span className="blue" />
              <span className="red" />
              <span className="yellow" />
            </span>
          </div>
          <div className="page-hero-aside agg-admin-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void togglePublish()}>
              {detail.published ? "Ẩn bảng" : "Công bố bảng"}
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setDeleting(true)}>
              Xoá bảng
            </button>
          </div>
        </div>
      </header>

      {message && (
        <div className="ac-toast" role="status">
          <span>{message}</span>
          <button type="button" aria-label="Đóng thông báo" onClick={() => setMessage("")}>×</button>
        </div>
      )}
      {Boolean(error) && <ErrorBox error={error} />}

      <section className="ac-table-card" aria-label="Cấu hình bảng tổng hợp">
        <div className="ac-table-head">
          <div className="ac-table-head-left">
            <span className="ac-head-accent" aria-hidden="true" />
            <h2 className="ac-table-head-title">Cấu hình</h2>
          </div>
        </div>
        <div className="ac-form-body">
          <AggregateForm
            key={formKey}
            initial={detail}
            competitions={competitions}
            submitLabel="Lưu cấu hình"
            confirmSave={detail.published ? askConfirmSave : undefined}
            onSubmit={(input: AggregateConfigInput) => updateAggregate(slug, input)}
            onSaved={(saved) => {
              setDetail(saved);
              setFormKey((current) => current + 1);
              setMessage("Đã lưu cấu hình; thay đổi áp dụng ngay cho lượt đọc kế tiếp.");
              setPreviewToken((current) => current + 1);
            }}
          />
        </div>
      </section>

      <section className="ac-table-card" aria-label="Xem trước bảng tổng hợp">
        <div className="ac-table-head">
          <div className="ac-table-head-left">
            <span className="ac-head-accent" aria-hidden="true" />
            <h2 className="ac-table-head-title">Xem trước</h2>
          </div>
          <div className="ac-toolbar-actions">
            {preview?.has_private && (
              <div className="dash-filters" role="group" aria-label="Chọn nhánh xem trước">
                {TRACKS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className="dash-filter"
                    aria-pressed={item === previewView}
                    onClick={() => setPreviewView(item)}
                  >
                    {TRACK_LABEL[item]}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="btn btn-sm" onClick={() => setPreviewToken((current) => current + 1)}>
              Làm mới
            </button>
          </div>
        </div>
        {previewError ? (
          <ErrorBox error={previewError} />
        ) : preview === null ? (
          <Loading label="Đang tải bảng xem trước..." />
        ) : preview.status === "waiting" ? (
          <AggregateWaiting board={preview} />
        ) : preview.entries.length === 0 ? (
          <p className="text-muted">Các nguồn đã sẵn sàng nhưng chưa có bài hợp lệ nào để ghép.</p>
        ) : (
          <>
            <AggregateTable board={preview} />
            {preview.has_more && (
              <p className="text-muted">Chỉ hiển thị {PREVIEW_LIMIT} dòng đầu của bảng xem trước.</p>
            )}
          </>
        )}
      </section>

      {confirmSaveOpen && (
        <ConfirmModal
          title="Lưu cấu hình bảng đang công bố"
          body="Thay đổi áp dụng ngay và có thể làm thay đổi điểm, thứ hạng hoặc quyền xem của bảng."
          confirmLabel="Lưu thay đổi"
          onConfirm={async () => resolveConfirmSave(true)}
          onClose={() => resolveConfirmSave(false)}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="Xoá bảng tổng hợp"
          body={`Xoá vĩnh viễn bảng "${detail.name}". Bảng đang công bố phải được ẩn trước khi xoá.`}
          confirmLabel="Xoá bảng"
          danger
          requireText={detail.slug}
          onConfirm={async () => {
            await deleteAggregate(slug);
            navigate("/admin/aggregates");
          }}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  );
}
