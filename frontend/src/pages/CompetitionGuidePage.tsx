/**
 * Trang Hướng dẫn: một chỗ duy nhất mô tả cách nộp bài cho mọi cuộc thi.
 *
 * Nội dung lấy từ cấu hình thật của cuộc thi đang mở (tên cột, dung lượng, cách tính điểm)
 * và dùng chung nguồn dữ liệu với tab Nộp bài để hai nơi không lệch nhau.
 */

import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { SubmissionConfig } from "../api/competitions";
import { ErrorBox } from "../components/ui";
import { downloadArtifact } from "../lib/downloadArtifact";
import { SAMPLE_ROWS, submissionColumns } from "../lib/submissionRequirements";
import type { CompetitionContext } from "./CompetitionDetailPage";

/** Nhãn `average` của sklearn - API trả khoá thô, UI cần chữ đọc được. */
const AVERAGE_LABEL: Record<NonNullable<SubmissionConfig["average"]>, string> = {
  binary: "Binary",
  macro: "Macro",
  weighted: "Weighted",
};

const NOT_CONFIGURED = "chưa cấu hình";

/** Tên file dự phòng khi backend không kèm `Content-Disposition`. */
const STARTER_NOTEBOOK_FILENAME = "starter-notebook.ipynb";

export function CompetitionGuidePage() {
  const { competition } = useOutletContext<CompetitionContext>();
  const config = competition.submission_config;
  const columns = submissionColumns(config);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const csvSample = [
    `${columns.id},${columns.prediction}`,
    ...SAMPLE_ROWS.map(([id, prediction]) => `${id},${prediction}`),
  ].join("\n");

  async function downloadStarterNotebook() {
    setDownloading(true);
    setError(null);
    try {
      await downloadArtifact("/starter-notebook", STARTER_NOTEBOOK_FILENAME);
    } catch (err) {
      setError(err);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section className="ov guide">
      <h2 className="ov-title">Hướng dẫn nộp bài</h2>
      <p className="ov-hint">
        Quy định dưới đây áp dụng cho mọi cuộc thi trên nền tảng. Các thông số về tên cột, dung
        lượng và cách tính điểm được điền theo đúng cuộc thi đang xem.
      </p>

      <section className="ov-block">
        <h3 className="ov-block-title">Hai tệp bắt buộc trong mỗi lượt nộp</h3>
        <ul className="ov-facts">
          <li>
            <strong>1. Tệp dự đoán (.csv)</strong> — gồm đúng hai cột <code>{columns.id}</code> và{" "}
            <code>{columns.prediction}</code>; dung lượng tối đa {config.max_upload_mb} MiB.
          </li>
          <li>
            <strong>2. Notebook (.ipynb)</strong> — notebook Jupyter tái lập được kết quả đã nộp;
            dung lượng tối đa {config.max_notebook_mb} MiB.
          </li>
          <li>
            Lượt nộp thiếu một trong hai tệp sẽ bị từ chối. Cách tính điểm của cuộc thi:{" "}
            <strong>{config.average ? AVERAGE_LABEL[config.average] : NOT_CONFIGURED}</strong>
            {config.average === "binary" && config.pos_label != null && (
              <> (nhãn dương: <strong>{config.pos_label}</strong>)</>
            )}
            .
          </li>
        </ul>
      </section>

      <section className="ov-block">
        <h3 className="ov-block-title">Định dạng tệp prediction.csv</h3>
        <p className="ov-facts">
          Dòng đầu tiên ghi tên hai cột; mỗi dòng sau tương ứng với một bản ghi trong tập Test.
          Tên cột phải viết đúng chữ thường và không thêm cột nào khác.
        </p>
        <pre className="guide-code" aria-label="Ví dụ nội dung prediction.csv">
          <code>{csvSample}</code>
        </pre>
      </section>

      <section className="ov-block">
        <h3 className="ov-block-title">Notebook tái lập (.ipynb)</h3>
        <ul className="ov-facts">
          <li>
            Tệp phải là JSON hợp lệ theo định dạng nbformat v4 và có đuôi <code>.ipynb</code>.
          </li>
          <li>
            Bản xuất dạng ZIP, HTML hay PDF đều không được chấp nhận, kể cả khi đổi đuôi thành{" "}
            <code>.ipynb</code>.
          </li>
        </ul>
      </section>

      <section className="ov-block">
        <h3 className="ov-block-title">Notebook khởi đầu</h3>
        <p className="ov-facts">
          Notebook khung đã có sẵn phần khai báo thư viện, đọc và kiểm tra dữ liệu, cùng phần xuất
          tệp kết quả. Thí sinh bổ sung phần tiền xử lý và huấn luyện mô hình của mình vào hai bước
          được đánh dấu <code>TODO</code>.
        </p>
        <div className="ov-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void downloadStarterNotebook()}
            disabled={downloading}
          >
            {downloading ? "Đang tải…" : "Tải notebook khung (.ipynb)"}
          </button>
        </div>
        <ErrorBox error={error} />
      </section>
    </section>
  );
}
