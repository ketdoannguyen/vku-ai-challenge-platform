/** Admin quản lý nội dung, assets, scoring và thành viên của một competition. */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { Competition } from "../api/competitions";
import { STATUS_LABEL } from "../api/competitions";
import type { ContentSummary } from "../api/contents";
import { ErrorBox, Loading } from "../components/ui";

type Tab = "contents" | "assets" | "scoring" | "members";

interface AdminContent extends ContentSummary {
  markdown?: string;
}

interface AssetItem {
  name: string;
  size_bytes: number;
  content_type: string;
  url: string;
}

interface MemberItem {
  account_id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  joined_at: string;
}

interface ScoringConfig {
  id_column: string;
  prediction_column: string;
  label_column: string;
  average: "binary" | "macro" | "weighted";
  pos_label: string | null;
  higher_is_better: true;
}

interface ScoringStatus {
  ready: boolean;
  locked: boolean;
  config: ScoringConfig | null;
  ground_truth: {
    row_count: number;
    columns: string[];
    uploaded_at: string;
  } | null;
  primary_metric: "f1" | "precision" | "recall";
  quota_per_day: number;
  max_upload_mb: number;
}

export function AdminCompetitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>("contents");

  const load = useCallback(async () => {
    setError(null);
    try {
      setCompetition(await api.get<Competition>(`/admin/competitions/${id}`));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="page">
        <Loading />
      </div>
    );
  }
  if (error || !competition) {
    return (
      <div className="page">
        <ErrorBox error={error} />
        <p>
          <Link to="/admin/competitions">← Về danh sách cuộc thi</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p>
            <Link className="back-link" to="/admin/competitions">
              ← Quản lý cuộc thi
            </Link>
          </p>
          <h1 className="page-title">{competition.name}</h1>
          <p className="page-subtitle">
            {competition.slug} · {STATUS_LABEL[competition.status]}
          </p>
        </div>
      </div>

      <nav className="tab-nav" aria-label="Quản lý cuộc thi" role="tablist">
        {(
          [
            ["contents", "Nội dung"],
            ["assets", "Assets"],
            ["scoring", "Chấm điểm"],
            ["members", "Thành viên & mã tham gia"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`tab-link${tab === key ? " active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "contents" && <ContentsPanel competitionId={competition.id} />}
      {tab === "assets" && <AssetsPanel competitionId={competition.id} />}
      {tab === "scoring" && <ScoringPanel competition={competition} />}
      {tab === "members" && <MembersPanel competition={competition} />}
    </div>
  );
}

/** ---------- Chấm điểm ---------- */

function ScoringPanel({ competition }: { competition: Competition }) {
  const [status, setStatus] = useState<ScoringStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [idColumn, setIdColumn] = useState("id");
  const [predictionColumn, setPredictionColumn] = useState("prediction");
  const [labelColumn, setLabelColumn] = useState("label");
  const [average, setAverage] = useState<ScoringConfig["average"]>("binary");
  const [posLabel, setPosLabel] = useState("1");

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<ScoringStatus>(
        `/admin/competitions/${competition.id}/scoring`,
      );
      setStatus(data);
      if (data.config) {
        setIdColumn(data.config.id_column);
        setPredictionColumn(data.config.prediction_column);
        setLabelColumn(data.config.label_column);
        setAverage(data.config.average);
        setPosLabel(data.config.pos_label ?? "");
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [competition.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      const data = await api.put<ScoringStatus>(
        `/admin/competitions/${competition.id}/scoring`,
        {
          id_column: idColumn,
          prediction_column: predictionColumn,
          label_column: labelColumn,
          average,
          pos_label: average === "binary" ? posLabel : null,
          higher_is_better: true,
        },
      );
      setStatus(data);
      setMessage("Đã lưu cấu hình chấm điểm.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function uploadGroundTruth(file: File) {
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      const data = await api.upload<ScoringStatus>(
        `/admin/competitions/${competition.id}/ground-truth`,
        file,
      );
      setStatus(data);
      setMessage("Đã upload và kiểm tra ground truth.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading />;

  return (
    <div className="scoring-admin-grid">
      <div className="card scoring-panel">
        <div className="scoring-panel-head">
          <div>
            <h2>Cấu hình CSV</h2>
            <p className="text-muted">
              Metric chính: {competition.primary_metric.toUpperCase()} · Quota: {competition.quota_per_day} lượt/ngày
            </p>
          </div>
          {status && (
            <span className={`status-badge ${status.ready ? "success" : "warning"}`}>
              {status.ready ? "Sẵn sàng chấm điểm" : "Chưa sẵn sàng"}
            </span>
          )}
        </div>

        {status?.locked && (
          <div className="status-banner warning">
            Cấu hình đã bị khóa vì cuộc thi đã đóng hoặc đã có bài được chấm điểm.
          </div>
        )}
        {message && <div className="status-banner success" role="status">{message}</div>}
        <ErrorBox error={error} />

        <form onSubmit={saveConfig}>
          <div className="form-grid">
            <div className="form-field">
              <label className="field-label" htmlFor="scoring-id-column">Cột ID</label>
              <input
                id="scoring-id-column"
                className="input"
                value={idColumn}
                disabled={busy || status?.locked}
                onChange={(event) => setIdColumn(event.target.value)}
                required
              />
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor="scoring-prediction-column">Cột prediction</label>
              <input
                id="scoring-prediction-column"
                className="input"
                value={predictionColumn}
                disabled={busy || status?.locked}
                onChange={(event) => setPredictionColumn(event.target.value)}
                required
              />
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor="scoring-label-column">Cột label trong ground truth</label>
              <input
                id="scoring-label-column"
                className="input"
                value={labelColumn}
                disabled={busy || status?.locked}
                onChange={(event) => setLabelColumn(event.target.value)}
                required
              />
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor="scoring-average">Average</label>
              <select
                id="scoring-average"
                className="input"
                value={average}
                disabled={busy || status?.locked}
                onChange={(event) => setAverage(event.target.value as ScoringConfig["average"])}
              >
                <option value="binary">Binary</option>
                <option value="macro">Macro</option>
                <option value="weighted">Weighted</option>
              </select>
            </div>
            {average === "binary" && (
              <div className="form-field">
                <label className="field-label" htmlFor="scoring-pos-label">Positive label</label>
                <input
                  id="scoring-pos-label"
                  className="input"
                  value={posLabel}
                  disabled={busy || status?.locked}
                  onChange={(event) => setPosLabel(event.target.value)}
                  required
                />
              </div>
            )}
          </div>
          <button className="btn" type="submit" disabled={busy || status?.locked}>
            {busy ? "Đang lưu..." : "Lưu cấu hình"}
          </button>
        </form>
      </div>

      <div className="card scoring-panel">
        <h2>Ground truth private</h2>
        <p className="text-muted">
          CSV UTF-8, tối đa <strong>{status?.max_upload_mb ?? 10} MiB</strong>. File không có public download URL.
        </p>
        {status?.ground_truth ? (
          <dl className="scoring-metadata">
            <div><dt>Dữ liệu</dt><dd>{status.ground_truth.row_count} dòng</dd></div>
            <div><dt>Các cột</dt><dd>{status.ground_truth.columns.join(", ")}</dd></div>
            <div><dt>Upload lúc</dt><dd>{new Date(status.ground_truth.uploaded_at).toLocaleString()}</dd></div>
          </dl>
        ) : (
          <p className="text-muted">Chưa có ground truth.</p>
        )}
        <label className="btn btn-secondary">
          {status?.ground_truth ? "Thay ground truth CSV" : "Upload ground truth CSV"}
          <input
            aria-label="Upload ground truth CSV"
            type="file"
            accept=".csv,text/csv"
            hidden
            disabled={busy || status?.locked || !status?.config}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadGroundTruth(file);
              event.target.value = "";
            }}
          />
        </label>
        {!status?.config && <p className="text-muted">Lưu cấu hình CSV trước khi upload.</p>}
      </div>
    </div>
  );
}

/** ---------- Nội dung ---------- */

function ContentsPanel({ competitionId }: { competitionId: string }) {
  const [contents, setContents] = useState<AdminContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminContent | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<{ contents: AdminContent[] }>(
        `/admin/competitions/${competitionId}/contents`,
      );
      setContents(data.contents);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [competitionId]);

  useEffect(() => {
    void load();
  }, [load]);

  function notify(text: string) {
    setMessage(text);
    void load();
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= contents.length) return;
    const swapped = [...contents];
    [swapped[index], swapped[target]] = [swapped[target], swapped[index]];
    const items = swapped.map((c, i) => ({ id: c.id, order: (i + 1) * 10 }));
    try {
      await api.post(`/admin/competitions/${competitionId}/contents/reorder`, { items });
      await load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="toolbar">
        <button className="btn" onClick={() => setCreating(true)}>
          Thêm trang nội dung
        </button>
      </div>
      {message && (
        <div className="status-banner success" role="status">
          {message}
        </div>
      )}
      <ErrorBox error={error} />
      <div className="table-wrap" aria-busy={loading}>
        <table className="table">
          <thead>
            <tr>
              <th>Thứ tự</th>
              <th>Tiêu đề</th>
              <th>Slug</th>
              <th>Hiển thị</th>
              <th>File</th>
              <th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="table-state">
                  <Loading />
                </td>
              </tr>
            ) : contents.length > 0 ? (
              contents.map((content, index) => (
                <ContentRow
                  key={content.id}
                  competitionId={competitionId}
                  content={content}
                  first={index === 0}
                  last={index === contents.length - 1}
                  onEdit={() => setEditing(content)}
                  onMove={(d) => void move(index, d)}
                  onChanged={notify}
                />
              ))
            ) : (
              <tr>
                <td colSpan={6} className="table-state">
                  Chưa có trang nội dung nào.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {creating && (
        <ContentFormModal
          competitionId={competitionId}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            notify("Đã tạo trang nội dung.");
          }}
        />
      )}
      {editing && (
        <ContentFormModal
          competitionId={competitionId}
          content={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            notify("Đã cập nhật trang nội dung.");
          }}
        />
      )}
    </div>
  );
}

function ContentRow({
  competitionId,
  content,
  first,
  last,
  onEdit,
  onMove,
  onChanged,
}: {
  competitionId: string;
  content: AdminContent;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onMove: (direction: -1 | 1) => void;
  onChanged: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState("");

  async function run(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    setRowError("");
    try {
      await action();
      onChanged(successMessage);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr>
        <td>
          <span className="action-group">
            <button
              className="btn btn-ghost btn-sm"
              aria-label={`Đưa ${content.title} lên`}
              disabled={first || busy}
              onClick={() => onMove(-1)}
            >
              ↑
            </button>
            <button
              className="btn btn-ghost btn-sm"
              aria-label={`Đưa ${content.title} xuống`}
              disabled={last || busy}
              onClick={() => onMove(1)}
            >
              ↓
            </button>
          </span>
        </td>
        <td className="name-cell">{content.title}</td>
        <td className="slug-cell">{content.slug}</td>
        <td>{content.visibility === "members" ? "Chỉ thành viên" : "Mọi người đăng nhập"}</td>
        <td>
          {content.size_bytes !== null ? (
            <span className="status-badge success">Đã upload</span>
          ) : (
            <span className="status-badge warning">Chưa có file</span>
          )}
        </td>
        <td className="col-actions">
          <span className="action-group">
            <label className="btn btn-secondary btn-sm">
              {content.size_bytes !== null ? "Thay .md" : "Upload .md"}
              <input
                type="file"
                accept=".md,text/markdown"
                hidden
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    void run(
                      () => api.upload(`/admin/competitions/${competitionId}/contents/${content.id}/file`, file),
                      `Đã upload Markdown cho "${content.title}".`,
                    );
                  }
                  e.target.value = "";
                }}
              />
            </label>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={onEdit}>
              Sửa
            </button>
            <button
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.del(`/admin/competitions/${competitionId}/contents/${content.id}`),
                  `Đã xóa "${content.title}".`,
                )
              }
            >
              Xóa
            </button>
          </span>
        </td>
      </tr>
      {rowError && (
        <tr>
          <td colSpan={6} className="table-state error-cell">
            {rowError}
          </td>
        </tr>
      )}
    </>
  );
}

function ContentFormModal({
  competitionId,
  content,
  onClose,
  onSaved,
}: {
  competitionId: string;
  content?: AdminContent;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = content !== undefined;
  const [title, setTitle] = useState(content?.title ?? "");
  const [slug, setSlug] = useState(content?.slug ?? "");
  const [visibility, setVisibility] = useState<"public" | "members">(content?.visibility ?? "public");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const payload = { title, slug: slug.trim().toLowerCase(), visibility };
    try {
      if (isEdit) {
        await api.patch(`/admin/competitions/${competitionId}/contents/${content.id}`, payload);
      } else {
        await api.post(`/admin/competitions/${competitionId}/contents`, payload);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={isEdit ? `Sửa nội dung — ${content.title}` : "Thêm trang nội dung"} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="form-field">
            <label className="field-label" htmlFor="content-title">
              Tiêu đề
            </label>
            <input
              id="content-title"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="content-slug">
              Slug {isEdit && "(không hiển thị cho participant khi đổi)"}
            </label>
            <input
              id="content-slug"
              className="input"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              title="Chỉ a-z, 0-9 và dấu gạch ngang"
              required
            />
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="content-visibility">
              Hiển thị cho
            </label>
            <select
              id="content-visibility"
              className="input"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as "public" | "members")}
            >
              <option value="public">Mọi người đã đăng nhập</option>
              <option value="members">Chỉ thành viên của cuộc thi</option>
            </select>
          </div>
        </div>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Hủy
          </button>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Đang lưu..." : isEdit ? "Lưu" : "Tạo"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** ---------- Assets ---------- */

function AssetsPanel({ competitionId }: { competitionId: string }) {
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<{ assets: AssetItem[] }>(`/admin/competitions/${competitionId}/assets`);
      setAssets(data.assets);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [competitionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      await api.postFile(`/admin/competitions/${competitionId}/assets`, file);
      setMessage(`Đã upload "${file.name}".`);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/admin/competitions/${competitionId}/assets/${name}`);
      setMessage("Đã xóa ảnh.");
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setMessage(`Đã copy: ${url}`);
    } catch {
      setMessage(url);
    }
  }

  return (
    <div>
      <div className="toolbar">
        <label className="btn">
          {busy ? "Đang xử lý..." : "Upload ảnh (PNG/JPEG/GIF/WebP ≤ 2 MiB)"}
          <input
            type="file"
            accept=".png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp"
            hidden
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {message && (
        <div className="status-banner success" role="status">
          {message}
        </div>
      )}
      <ErrorBox error={error} />
      <div className="table-wrap" aria-busy={loading}>
        <table className="table">
          <thead>
            <tr>
              <th>Tên file</th>
              <th>Loại</th>
              <th>Dung lượng</th>
              <th>URL dùng trong Markdown</th>
              <th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="table-state">
                  <Loading />
                </td>
              </tr>
            ) : assets.length > 0 ? (
              assets.map((asset) => (
                <tr key={asset.name}>
                  <td className="slug-cell">{asset.name}</td>
                  <td>{asset.content_type}</td>
                  <td>{(asset.size_bytes / 1024).toFixed(1)} KB</td>
                  <td>
                    <code>assets/{asset.name}</code>
                  </td>
                  <td className="col-actions">
                    <span className="action-group">
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={busy}
                        onClick={() => void copyUrl(`assets/${asset.name}`)}
                      >
                        Copy tham chiếu
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => void remove(asset.name)}
                      >
                        Xóa
                      </button>
                    </span>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="table-state">
                  Chưa có ảnh nào. Trong Markdown dùng đường dẫn tương đối
                  <code> assets/ten-file.png </code>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** ---------- Thành viên & mã tham gia ---------- */

function MembersPanel({ competition }: { competition: Competition }) {
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [codeConfigured] = useState(competition.join_code_configured);
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<{ members: MemberItem[]; total: number }>(
        `/admin/competitions/${competition.id}/members`,
      );
      setMembers(data.members);
      setTotal(data.total);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [competition.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMessage(successMessage);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Mã tham gia</h2>
        {competition.join_mode !== "code" ? (
          <p className="text-muted" style={{ margin: 0 }}>
            Cuộc thi này dùng chế độ tham gia{" "}
            {competition.join_mode === "open" ? "tự do" : "chỉ mời"} — không dùng mã.
          </p>
        ) : (
          <form
            className="toolbar"
            style={{ marginBottom: 0 }}
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  api.put(`/admin/competitions/${competition.id}/join-code`, {
                    join_code: joinCode,
                  }),
                "Đã cập nhật mã tham gia.",
              );
              setJoinCode("");
            }}
          >
            <input
              className="input"
              type="text"
              aria-label="Mã tham gia mới"
              placeholder={codeConfigured ? "Đã đặt mã — nhập mã mới để đổi" : "Chưa đặt mã"}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              minLength={8}
              maxLength={128}
              required
              autoComplete="off"
            />
            <button className="btn" type="submit" disabled={busy}>
              {codeConfigured ? "Đổi mã" : "Đặt mã"}
            </button>
          </form>
        )}
      </div>

      <div className="toolbar">
        <form
          className="toolbar"
          style={{ marginBottom: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => api.post(`/admin/competitions/${competition.id}/members`, { email }),
              `Đã thêm thành viên ${email}.`,
            );
            setEmail("");
          }}
        >
          <input
            className="input"
            type="email"
            aria-label="Email thành viên"
            placeholder="email@vku.vn"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button className="btn" type="submit" disabled={busy}>
            Thêm thành viên
          </button>
        </form>
      </div>
      {message && (
        <div className="status-banner success" role="status">
          {message}
        </div>
      )}
      <ErrorBox error={error} />
      <div className="table-wrap" aria-busy={loading}>
        <table className="table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Tên</th>
              <th>Trạng thái</th>
              <th>Tham gia lúc</th>
              <th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="table-state">
                  <Loading />
                </td>
              </tr>
            ) : members.length > 0 ? (
              members.map((member) => (
                <tr key={member.account_id}>
                  <td className="email-cell">{member.email}</td>
                  <td className="name-cell">{member.name}</td>
                  <td>
                    <span className={`status-badge ${member.active ? "success" : "danger"}`}>
                      {member.active ? "Đang hoạt động" : "Đã vô hiệu"}
                    </span>
                  </td>
                  <td>{member.joined_at}</td>
                  <td className="col-actions">
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            api.patch(
                              `/admin/competitions/${competition.id}/members/${member.account_id}`,
                              { active: !member.active },
                            ),
                          member.active ? "Đã vô hiệu hóa thành viên." : "Đã kích hoạt lại thành viên.",
                        )
                      }
                    >
                      {member.active ? "Vô hiệu hóa" : "Kích hoạt"}
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="table-state">
                  Chưa có thành viên nào.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {total > 0 && <div className="pagination">Tổng số: {total}</div>}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal modal-lg" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button className="modal-close" aria-label="Đóng" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
