/**
 * Trình xem artifact của bài nộp: notebook (.ipynb) và CSV dự đoán.
 *
 * Tệp là dữ liệu không tin cậy: nội dung chỉ được đọc qua parser `artifactPreview` (ảnh nhúng chỉ
 * nhận base64 trong allowlist của parser), markdown của cell đi qua rehype-sanitize và mọi URL
 * trong đó bị vô hiệu - link chỉ còn chữ, ảnh bị bỏ hẳn. Không iframe, không thực thi gì từ tệp.
 * Trình xem chỉ để đọc: không có nút tải riêng, việc tải tệp gốc vẫn nằm ở `ArtifactLinks`.
 *
 * Notebook dài cũng chia lô như bảng CSV: 50 cell đầu rồi "Hiện thêm" tới cell cuối, kèm bộ đếm
 * đang hiện bao nhiêu trên tổng. Nguồn cell bị cắt theo trần ký tự mở lại được tại chỗ nhờ
 * `cell.fullSource` của parser.
 *
 * `ArtifactViewerContent` là phần thân dùng chung, gọi từ modal của trang bài nộp hoặc nhúng
 * trong màn kiểm tra AI; `ArtifactViewerModal` bọc nó trong `Modal`.
 */

import { useEffect, useState, type ComponentProps, type RefObject } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { api } from "../api/client";
import {
  CSV_CELL_TRUNCATED_NOTICE,
  CSV_COLUMN_LIMIT_NOTICE,
  CSV_ROW_LIMIT_NOTICE,
  NOTEBOOK_OMISSION_LABEL,
  NOTEBOOK_TRUNCATED_LABEL,
  parseCsvPreview,
  parseNotebook,
  type CsvPreview,
  type NotebookCell,
  type NotebookCellType,
  type NotebookOutput,
} from "../lib/artifactPreview";
import { Modal } from "./Modal";
import { ErrorBox, Loading } from "./ui";

type ArtifactViewerKind = "prediction" | "notebook";

interface ArtifactViewerProps {
  /** Đường dẫn API tải tệp; `api.download` tự thêm tiền tố `/api`. */
  path: string;
  kind: ArtifactViewerKind;
  /** Tên tệp hiển thị cho người đọc, không dùng để tải. */
  filename: string;
}

/** Số dòng CSV hiện trước, cũng là số dòng thêm vào mỗi lần bấm "Xem thêm". */
const CSV_ROW_BATCH = 100;

/** Số cell notebook hiện trước, cũng là số cell thêm vào mỗi lần bấm "Hiện thêm". */
const NOTEBOOK_CELL_BATCH = 50;

/** Nguồn quá lớn không mở rộng trong DOM: vẫn có bản gốc qua nút tải tệp. */
const MAX_EXPANDED_SOURCE_CHARS = 200_000;

const PARSE_ERROR_MESSAGE = {
  "invalid-json": "Tệp notebook không phải JSON hợp lệ.",
  "invalid-structure": "Cấu trúc notebook không hợp lệ.",
} as const;

const CELL_TYPE_LABEL: Record<NotebookCellType, string> = {
  code: "Code",
  markdown: "Markdown",
  raw: "Raw",
  unknown: "Không rõ loại",
};

/** "Cell 3 · Code · In [12]"; cell code chưa từng chạy được nói rõ là chưa chạy. */
function cellHeading(cell: NotebookCell): string {
  const parts = [`Cell ${cell.index}`, CELL_TYPE_LABEL[cell.cellType]];
  if (cell.cellType === "code") {
    parts.push(cell.executionCount === null ? "Chưa chạy" : `In [${cell.executionCount}]`);
  }
  return parts.join(" · ");
}

/**
 * Link trong notebook là chữ, không phải đích điều hướng: cell không có nguồn tài nguyên nào để
 * trỏ tới nên mọi liên kết từ xa đều bị chặn thay vì mở tab mới.
 */
function InertLink({ children }: ComponentProps<"a">) {
  return <span>{children}</span>;
}

const MARKDOWN_COMPONENTS: Components = {
  a: InertLink,
  img: () => null,
};

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_REHYPE_PLUGINS = [rehypeSanitize];

/** Lớp chặn thứ hai sau `MARKDOWN_COMPONENTS`: không URL nào từ cell ra tới DOM. */
function blockMarkdownUrl(): string {
  return "";
}

function MarkdownCell({ source }: { source: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      urlTransform={blockMarkdownUrl}
      components={MARKDOWN_COMPONENTS}
    >
      {source}
    </ReactMarkdown>
  );
}

/** Nhãn của vùng kết quả, để source và output đọc rõ dù nằm trong cùng một cell. */
function outputLabel(output: NotebookOutput): string {
  if (output.kind === "error") return "Lỗi";
  if (output.kind === "image") return "Hình ảnh";
  if (output.kind === "omitted") return "Output được lược";
  return output.name === "result" ? "Kết quả" : output.name;
}

function OutputView({ output, cellIndex }: { output: NotebookOutput; cellIndex: number }) {
  const tone = output.kind === "error" ? "error" : output.kind === "text" ? output.name : output.kind;
  return (
    <div className="artifact-viewer-output" data-output-tone={tone}>
      <p className="artifact-viewer-output-label">{outputLabel(output)}</p>
      {output.kind === "image" ? (
        <img
          src={`data:${output.mime};base64,${output.base64}`}
          alt={`Ảnh nhúng từ cell ${cellIndex}`}
        />
      ) : output.kind === "omitted" ? (
        <p className="artifact-viewer-note">
          {NOTEBOOK_OMISSION_LABEL[output.reason]}
          {output.mime ? ` (${output.mime})` : ""}
        </p>
      ) : (
        <>
          <pre>{output.text}</pre>
          {output.truncated && <p className="artifact-viewer-note">{NOTEBOOK_TRUNCATED_LABEL}</p>}
        </>
      )}
    </div>
  );
}

/** Dòng cuối chỉ có newline kết thúc không tạo thêm số dòng rỗng trong gutter. */
function sourceLineCount(source: string): number {
  if (!source) return 0;
  const body = source.endsWith("\n") ? source.slice(0, -1) : source;
  return body.split("\n").length;
}

function CodeSource({ source, numbered }: { source: string; numbered: boolean }) {
  const lineCount = numbered ? sourceLineCount(source) : 0;
  return (
    <div className="artifact-viewer-code">
      {numbered && (
        <span className="artifact-viewer-code-gutter" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")}
        </span>
      )}
      <pre>{source}</pre>
    </div>
  );
}

/**
 * Nguồn một cell: markdown render an toàn, còn lại là text nguyên văn. Nguồn dài bị parser cắt kèm
 * `fullSource` mở lại được tại chỗ để xem trọn phần đuôi thay vì phải tải tệp gốc.
 */
function CellSourceView({ cell }: { cell: NotebookCell }) {
  const [expanded, setExpanded] = useState(false);
  const fullSource = cell.fullSource;
  const canExpand = fullSource !== undefined && fullSource.length <= MAX_EXPANDED_SOURCE_CHARS;
  const source = expanded && canExpand ? fullSource : cell.source;

  return (
    <>
      {cell.cellType === "markdown" ? (
        <MarkdownCell source={source} />
      ) : (
        <CodeSource source={source} numbered={cell.cellType === "code"} />
      )}
      {cell.sourceTruncated && !expanded && (
        <p className="artifact-viewer-note">{NOTEBOOK_TRUNCATED_LABEL}</p>
      )}
      {canExpand ? (
        <div>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Thu gọn" : "Xem toàn bộ"}
          </button>
        </div>
      ) : fullSource !== undefined ? (
        <p className="artifact-viewer-note">Nguồn quá dài để mở toàn bộ ở đây; hãy tải notebook gốc để xem đầy đủ.</p>
      ) : null}
    </>
  );
}

/** Một cell: nguồn (markdown render an toàn, còn lại là text nguyên văn) rồi tới output. */
function NotebookCellView({ cell }: { cell: NotebookCell }) {
  return (
    <section className="artifact-viewer-cell">
      <p className="artifact-viewer-cell-head">{cellHeading(cell)}</p>
      <CellSourceView cell={cell} />
      {cell.outputs.map((output, index) => (
        <OutputView key={index} output={output} cellIndex={cell.index} />
      ))}
    </section>
  );
}

/** Danh sách cell: dựng dần từng lô tới cell cuối để notebook dài không dựng hết một lúc. */
function NotebookCells({ cells }: { cells: NotebookCell[] }) {
  const [shown, setShown] = useState(NOTEBOOK_CELL_BATCH);

  if (cells.length === 0) {
    return <p className="artifact-viewer-note">Notebook không có cell nào.</p>;
  }

  const visibleCells = cells.slice(0, shown);
  const remaining = cells.length - visibleCells.length;

  return (
    <>
      {visibleCells.map((cell) => (
        <NotebookCellView key={cell.index} cell={cell} />
      ))}
      {remaining > 0 && (
        <div>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => setShown((current) => current + NOTEBOOK_CELL_BATCH)}
          >
            Hiện thêm {Math.min(NOTEBOOK_CELL_BATCH, remaining)} cell
          </button>
        </div>
      )}
      <p className="artifact-viewer-note">
        Đang hiện {visibleCells.length}/{cells.length} cell.
      </p>
    </>
  );
}

/** Đệm ô thiếu để lưới bảng thẳng cột khi tệp có dòng ngắn hơn dòng dài nhất. */
function padRow(row: string[], columnCount: number): string[] {
  return row.length >= columnCount
    ? row
    : [...row, ...new Array<string>(columnCount - row.length).fill("")];
}

function CsvTable({ preview }: { preview: CsvPreview }) {
  const [shown, setShown] = useState(CSV_ROW_BATCH);
  if (preview.rows.length === 0) {
    return <p className="artifact-viewer-note">Tệp CSV không có dòng nào.</p>;
  }

  const [headerRow, ...dataRows] = preview.rows;
  const visibleRows = dataRows.slice(0, shown);
  const remaining = dataRows.length - visibleRows.length;

  return (
    <>
      <div className="artifact-viewer-table-wrap">
        <table className="artifact-viewer-table">
          <thead>
            <tr>
              {padRow(headerRow, preview.columnCount).map((cell, index) => (
                <th key={index} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {padRow(row, preview.columnCount).map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {remaining > 0 && (
        <div>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => setShown((current) => current + CSV_ROW_BATCH)}
          >
            Xem thêm {Math.min(CSV_ROW_BATCH, remaining)} dòng
          </button>
        </div>
      )}
      {preview.hasMoreRows && <p className="artifact-viewer-note">{CSV_ROW_LIMIT_NOTICE}</p>}
      {preview.columnsOmitted > 0 && <p className="artifact-viewer-note">{CSV_COLUMN_LIMIT_NOTICE}</p>}
      {preview.cellTruncated && <p className="artifact-viewer-note">{CSV_CELL_TRUNCATED_NOTICE}</p>}
    </>
  );
}

type ViewerState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "notebook"; cells: NotebookCell[] }
  | { status: "prediction"; preview: CsvPreview };

export function ArtifactViewerContent({ path, kind, filename }: ArtifactViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    setState({ status: "loading" });

    void (async () => {
      try {
        const { blob } = await api.download(path, controller.signal);
        const text = await blob.text();
        if (cancelled) return;
        if (kind === "notebook") {
          const parsed = parseNotebook(text);
          if (!parsed.ok) {
            setState({ status: "error", error: new Error(PARSE_ERROR_MESSAGE[parsed.reason]) });
            return;
          }
          setState({ status: "notebook", cells: parsed.cells });
        } else {
          setState({ status: "prediction", preview: parseCsvPreview(text) });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            error: controller.signal.aborted
              ? new Error("Tải tệp quá lâu. Vui lòng thử lại.")
              : error,
          });
        }
      } finally {
        window.clearTimeout(timeout);
      }
    })();

    // Tệp cũ về muộn sau khi đổi tệp hoặc unmount không được ghi đè state.
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [path, kind, attempt]);

  return (
    <div className="artifact-viewer">
      <p className="artifact-viewer-file">{filename}</p>
      {state.status === "loading" && <Loading label="Đang tải tệp…" />}
      {state.status === "error" && (
        <>
          <ErrorBox error={state.error} />
          <div>
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => setAttempt((current) => current + 1)}
            >
              Thử lại
            </button>
          </div>
        </>
      )}
      {state.status === "notebook" && <NotebookCells cells={state.cells} />}
      {state.status === "prediction" && <CsvTable preview={state.preview} />}
    </div>
  );
}

const MODAL_TITLE: Record<ArtifactViewerKind, string> = {
  notebook: "Xem notebook",
  prediction: "Xem CSV",
};

export function ArtifactViewerModal({
  path,
  kind,
  filename,
  onClose,
  returnFocusRef,
}: ArtifactViewerProps & { onClose: () => void; returnFocusRef?: RefObject<HTMLElement | null> }) {
  return (
    <Modal title={`${MODAL_TITLE[kind]} · ${filename}`} onClose={onClose} returnFocusRef={returnFocusRef}>
      <ArtifactViewerContent path={path} kind={kind} filename={filename} />
    </Modal>
  );
}
