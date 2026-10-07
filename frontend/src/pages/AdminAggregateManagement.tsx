/**
 * Admin bảng tổng hợp: danh sách (kể cả nháp) và form tạo cấu hình.
 *
 * `AggregateForm` chỉ là phần thân form (không có vỏ modal) để trang chi tiết dùng lại nguyên
 * vẹn: cùng validate, cùng payload, không có hai bản logic cấu hình.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  AGGREGATE_VISIBILITY_LABEL,
  createAggregate,
  fetchAdminAggregates,
  shortName,
  weightPercent,
  type AdminAggregateDetail,
  type AggregateConfigInput,
  type AggregateVisibility,
} from "../api/aggregates";
import { api } from "../api/client";
import {
  formatLocal,
  normalizationOf,
  type AdminCompetition,
  type AdminCompetitionsResponse,
} from "../api/competitions";
import { resultContract } from "../api/results";
import { AggregateIcon } from "../components/AggregateBoard";
import { Modal } from "../components/Modal";
import { ErrorBox, Loading } from "../components/ui";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

const NAME_MAX = 120;
/** Sai lệch tổng trọng số cho phép, khớp dung sai kỹ thuật 1e-6 của backend trên thang 0–1. */
const WEIGHT_TOLERANCE = 1e-6;

interface SourceRow {
  key: number;
  competition_id: string;
  percent: string;
}

/** Trọng số chia đều; phần lẻ dồn vào nguồn cuối để tổng đúng 100%. */
function equalPercents(count: number): string[] {
  const base = Math.floor(10000 / count) / 100;
  const last = 100 - base * (count - 1);
  return [...Array.from({ length: count - 1 }, () => base.toFixed(2)), last.toFixed(2)];
}

function initialRows(sources: AdminAggregateDetail["sources"] | undefined): SourceRow[] {
  if (!sources || sources.length === 0) {
    return equalPercents(2).map((percent, index) => ({ key: index, competition_id: "", percent }));
  }
  return sources.map((source, index) => ({
    key: index,
    competition_id: source.competition_id,
    percent: String(Number((source.weight * 100).toFixed(4))),
  }));
}

/** Lý do cuộc thi chưa ghép được vào bảng tổng hợp; `null` nghĩa là chọn được. */
function blockedReason(competition: AdminCompetition): string | null {
  const contract = resultContract(competition.submission_config);
  if (contract.primary_metric === null) return "chưa khai báo metric chính";
  if (!contract.higher_is_better && !normalizationOf(competition).enabled) {
    return "xếp thấp-là-tốt nhưng chưa bật chuẩn hóa";
  }
  return null;
}

export function AggregateForm({
  initial,
  competitions,
  submitLabel,
  onSubmit,
  onSaved,
  onCancel,
  confirmSave,
}: {
  /** Cấu hình đang sửa; `null` khi tạo mới. Form không tự gọi API - cha quyết định endpoint. */
  initial: AdminAggregateDetail | null;
  competitions: AdminCompetition[];
  submitLabel: string;
  onSubmit: (input: AggregateConfigInput) => Promise<AdminAggregateDetail>;
  onSaved: (saved: AdminAggregateDetail) => void;
  onCancel?: () => void;
  /** Xác nhận trước khi ghi (bảng đang công bố); trả false để hủy. */
  confirmSave?: () => Promise<boolean>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [rows, setRows] = useState<SourceRow[]>(initialRows(initial?.sources));
  const [visibility, setVisibility] = useState<AggregateVisibility>(
    initial?.visibility ?? "members_any",
  );
  const [nextKey, setNextKey] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const weights = rows.map((row) => Number(row.percent) / 100);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const totalPercent = Number((totalWeight * 100).toFixed(4));

  const chosen = rows.filter((row) => row.competition_id !== "");
  const rawChosen = chosen.filter((row) => {
    const competition = competitions.find((item) => item.id === row.competition_id);
    return competition ? !normalizationOf(competition).enabled : false;
  });

  function updateRow(key: number, patch: Partial<SourceRow>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  /** Mọi thay đổi số nguồn đều chia lại đều nhau; admin vẫn sửa tay từng dòng sau đó. */
  function distribute(rows: SourceRow[]): SourceRow[] {
    const percents = equalPercents(rows.length);
    return rows.map((row, index) => ({ ...row, percent: percents[index] }));
  }

  function addRow() {
    setNextKey((current) => current + 1);
    setRows((current) =>
      distribute([...current, { key: nextKey, competition_id: "", percent: "" }]),
    );
  }

  function removeRow(key: number) {
    setRows((current) => distribute(current.filter((row) => row.key !== key)));
  }

  /** Validate toàn bộ cấu hình theo cùng điều kiện backend; trả payload hoặc câu lỗi. */
  function validate(): { input: AggregateConfigInput } | { message: string } {
    const cleanName = name.trim();
    if (!cleanName) return { message: "Tên bảng tổng hợp không được để trống." };
    if (cleanName.length > NAME_MAX) {
      return { message: `Tên bảng tổng hợp tối đa ${NAME_MAX} ký tự.` };
    }
    if (rows.length < 2) return { message: "Bảng tổng hợp cần ít nhất 2 cuộc thi nguồn." };
    if (rows.some((row) => row.competition_id === "")) {
      return { message: "Mỗi dòng nguồn phải chọn một cuộc thi." };
    }
    const ids = rows.map((row) => row.competition_id);
    if (new Set(ids).size !== ids.length) {
      return { message: "Mỗi cuộc thi chỉ được xuất hiện một lần trong danh sách nguồn." };
    }
    for (const [index, row] of rows.entries()) {
      const value = Number(row.percent);
      if (row.percent.trim() === "" || !Number.isFinite(value) || value <= 0 || value > 100) {
        return {
          message: `Trọng số của nguồn ${index + 1} phải là số lớn hơn 0 và không vượt quá 100%.`,
        };
      }
    }
    if (Math.abs(totalWeight - 1) > WEIGHT_TOLERANCE) {
      return { message: `Tổng trọng số phải bằng 100% (đang là ${totalPercent}%).` };
    }
    return {
      input: {
        name: cleanName,
        sources: rows.map((row) => ({
          competition_id: row.competition_id,
          weight: Number(row.percent) / 100,
        })),
        visibility,
      },
    };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const result = validate();
    if ("message" in result) {
      setError(result.message);
      return;
    }
    if (confirmSave && !(await confirmSave())) return;
    setBusy(true);
    try {
      onSaved(await onSubmit(result.input));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ac-form" onSubmit={submit}>
      {error && (
        <div className="error-box ac-form-error" role="alert">
          {error}
        </div>
      )}

      <div className="ac-form-grid agg-form-grid">
        <div className="ac-form-field">
          <label className="ac-required" htmlFor="agg-name">Tên bảng tổng hợp</label>
          <input
            id="agg-name"
            className="ac-form-control"
            value={name}
            maxLength={NAME_MAX}
            onChange={(event) => setName(event.target.value)}
          />
          {initial && <p className="ac-resource-hint">Đường dẫn bảng giữ nguyên sau khi tạo: {initial.slug}</p>}
        </div>

        <div className="ac-form-field">
          <label className="ac-required" htmlFor="agg-visibility">Quyền xem</label>
          <select
            id="agg-visibility"
            className="ac-form-control"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as AggregateVisibility)}
          >
            {(Object.keys(AGGREGATE_VISIBILITY_LABEL) as AggregateVisibility[]).map((value) => (
              <option key={value} value={value}>
                {AGGREGATE_VISIBILITY_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="ac-join-fieldset agg-source-fieldset">
        <legend className="ac-required">Cuộc thi nguồn và trọng số</legend>
        <div className="agg-source-rows">
          {rows.map((row, index) => (
            <div className="agg-source-row" key={row.key}>
              <select
                className="ac-form-control"
                aria-label={`Cuộc thi nguồn ${index + 1}`}
                value={row.competition_id}
                onChange={(event) => updateRow(row.key, { competition_id: event.target.value })}
              >
                <option value="">— Chọn cuộc thi —</option>
                {competitions.map((competition) => {
                  const blocked = blockedReason(competition);
                  const usedElsewhere = rows.some(
                    (other) => other.key !== row.key && other.competition_id === competition.id,
                  );
                  const label = blocked ? `${competition.name} (${blocked})` : competition.name;
                  return (
                    <option
                      key={competition.id}
                      value={competition.id}
                      disabled={blocked !== null || usedElsewhere}
                    >
                      {label}
                    </option>
                  );
                })}
              </select>
              <div className="agg-weight-box">
                <input
                  className="ac-form-control ac-form-mono"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  aria-label={`Trọng số nguồn ${index + 1} (%)`}
                  value={row.percent}
                  onChange={(event) => updateRow(row.key, { percent: event.target.value })}
                />
                <span className="agg-weight-unit" aria-hidden="true">
                  %
                </span>
              </div>
              <button
                type="button"
                className="btn btn-danger-ghost btn-sm"
                disabled={rows.length <= 2}
                title={rows.length <= 2 ? "Bảng cần ít nhất 2 cuộc thi nguồn" : "Xoá nguồn này"}
                onClick={() => removeRow(row.key)}
              >
                Xoá
              </button>
            </div>
          ))}
        </div>

        <button type="button" className="btn agg-add-source" onClick={addRow}>
          Thêm nguồn
        </button>

        {rawChosen.length > 0 && (
          <p className="ac-resource-hint">
            Nguồn dùng điểm gốc góp nguyên giá trị metric (có thể âm); thiếu kết quả tính 0 điểm.
          </p>
        )}
      </fieldset>

      <footer className="ac-form-footer">
        {onCancel && (
          <button type="button" className="ac-form-button secondary" onClick={onCancel} disabled={busy}>
            Hủy
          </button>
        )}
        <button type="submit" className="ac-form-button primary" disabled={busy}>
          {busy ? "Đang lưu..." : submitLabel}
        </button>
      </footer>
    </form>
  );
}

export function AdminAggregateManagement() {
  const [data, setData] = useState<AdminAggregateDetail[] | null>(null);
  const [competitions, setCompetitions] = useState<AdminCompetition[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  useDocumentTitle("Bảng tổng hợp");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [aggregates, competitionsResponse] = await Promise.all([
        fetchAdminAggregates(),
        api.get<AdminCompetitionsResponse>("/admin/competitions"),
      ]);
      setData(aggregates.aggregates);
      setCompetitions(competitionsResponse.competitions);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page ac-page">
      <header className="page-hero">
        <div className="page-hero-row">
          <span className="page-hero-icon" aria-hidden="true">
            <AggregateIcon className="page-hero-glyph" />
          </span>
          <div className="page-hero-copy">
            <h1 className="page-hero-title">Bảng tổng hợp</h1>
            <p className="page-hero-subtitle">
              Tạo bảng xếp hạng từ nhiều cuộc thi, điều chỉnh trọng số và quyền xem.
              Điểm được tính lại mỗi khi mở bảng.
            </p>
            <span className="vku-accent" aria-hidden="true">
              <span className="blue" />
              <span className="red" />
              <span className="yellow" />
            </span>
          </div>
          <div className="page-hero-aside">
            <button className="ac-create-button" type="button" onClick={() => setCreating(true)}>
              <span aria-hidden="true">+</span>
              Tạo bảng tổng hợp
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

      {data === null ? (
        error ? (
          <ErrorBox error={error} />
        ) : (
          <Loading label="Đang tải danh sách bảng tổng hợp..." />
        )
      ) : (
        <section className="ac-table-card">
          <div className="ac-table-head">
            <div className="ac-table-head-left">
              <span className="ac-head-accent" aria-hidden="true" />
              <h2 className="ac-table-head-title">Danh sách bảng tổng hợp</h2>
            </div>
            <p className="ac-table-head-count">{data.length} bảng</p>
          </div>
          <div className="ac-table-scroll" tabIndex={0} role="region" aria-label="Bảng danh sách bảng tổng hợp">
            <table className="ac-table agg-admin-table">
              <thead>
                <tr>
                  <th scope="col">Tên</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Cuộc thi nguồn</th>
                  <th scope="col">Sửa cấu hình lúc</th>
                </tr>
              </thead>
              <tbody>
                {data.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="ac-table-state">
                      <div className="ac-empty-state">
                        <strong>Chưa có bảng tổng hợp nào.</strong>
                        <button type="button" className="ac-state-button" onClick={() => setCreating(true)}>
                          Tạo bảng tổng hợp
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  data.map((aggregate) => (
                    <tr key={aggregate.slug}>
                      <td>
                        <div className="ac-name-text">
                          <Link to={`/admin/aggregates/${aggregate.slug}`}>{aggregate.name}</Link>
                          <span>{aggregate.slug}</span>
                        </div>
                      </td>
                      <td>
                        <span className={`status-badge ${aggregate.published ? "success" : "neutral"}`}>
                          {aggregate.published ? "Đang công bố" : "Bản nháp — chỉ admin thấy"}
                        </span>
                      </td>
                      <td>
                        <div className="agg-chips agg-chips--stack">
                          {aggregate.sources.map((source) => {
                            const full = source.name ?? "Nguồn đã bị xoá";
                            return (
                              <span key={source.competition_id} className="agg-chip" title={full}>
                                <span className="agg-chip-name">{shortName(full, 32)}</span>
                                <span className="agg-chip-meta">{weightPercent(source.weight)}</span>
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td>{formatLocal(aggregate.updated_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {creating && (
        <Modal title="Tạo bảng tổng hợp" onClose={() => setCreating(false)}>
          <AggregateForm
            initial={null}
            competitions={competitions}
            submitLabel="Lưu bản nháp"
            onSubmit={(input) => createAggregate(input)}
            onSaved={(saved) => {
              setCreating(false);
              setMessage(`Đã tạo bảng "${saved.name}" (bản nháp). Công bố ở trang chi tiết.`);
              void load();
            }}
            onCancel={() => setCreating(false)}
          />
        </Modal>
      )}
    </div>
  );
}
