/** Overview (index) và content page (theo contentSlug) cho competition portal. */

import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Link, useNavigationType, useOutletContext, useParams } from "react-router-dom";
import type { Competition, SubmissionConfig } from "../api/competitions";
import { METRIC_LABEL, formatLocal } from "../api/competitions";
import { fetchContent, type ContentDetail } from "../api/contents";
import { ErrorBox, Loading } from "../components/ui";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { VISIBILITY_LABEL, type CompetitionContext } from "./CompetitionDetailPage";

/** react-markdown + remark-gfm + rehype-sanitize chỉ cần ở route nội dung; tách khỏi entry chunk. */
const MarkdownView = lazy(() =>
  import("../markdown/MarkdownView").then((module) => ({ default: module.MarkdownView })),
);

/** Mô tả cách tham gia ở phần tóm tắt - khác nhãn chip trên masthead để không lặp chữ trên cùng màn hình. */
const JOIN_MODE_DETAIL: Record<Competition["join_mode"], string> = {
  open: "Mở tự do cho mọi thí sinh",
  code: "Cần mã do Ban Tổ chức cấp",
  invite_only: "Chỉ dành cho thí sinh được mời",
};

/** Nhãn `average` của sklearn - API trả khoá thô, UI cần chữ đọc được. */
const AVERAGE_LABEL: Record<NonNullable<SubmissionConfig["average"]>, string> = {
  binary: "Binary",
  macro: "Macro",
  weighted: "Weighted",
};

/** Giá trị cấu hình chưa được BTC thiết lập - hiển thị chữ thay vì `null`. */
const NOT_CONFIGURED = "Chưa cấu hình";

/** `pos_label` chỉ có với admin/thành viên đang hoạt động; undefined nghĩa là không được phép biết. */
function configValue(value: string | null): string {
  return value === null || value === "" ? NOT_CONFIGURED : value;
}

/** Vì sao chưa nộp được bài - chỉ gọi khi canSubmit sai, tức chưa tham gia và cuộc thi còn nhận bài. */
function submitBlockedReason(c: Competition): string {
  if (c.status === "closed") return "Cuộc thi đã kết thúc nên không nhận thêm bài nộp.";
  if (c.quota_per_day === 0) return "Cuộc thi hiện không nhận bài nộp.";
  if (c.join_mode === "invite_only")
    return "Cuộc thi chỉ dành cho thí sinh được mời - liên hệ Ban Tổ chức để được cấp quyền tham gia.";
  if (c.join_mode === "code")
    return "Nhập mã do Ban Tổ chức cấp ở khối tham gia phía trên để bắt đầu nộp bài.";
  return "Bấm “Tham gia cuộc thi” ở khối phía trên để bắt đầu nộp bài.";
}

/**
 * Tổng quan là một trang thật: thể lệ, quy cách bài nộp và danh sách tài liệu.
 * Danh sách tài liệu tải độc lập nên lỗi ở đây chỉ ảnh hưởng đúng khối tài liệu.
 */
export function CompetitionOverview() {
  const { competition: c, contents, contentsLoading, contentsError, reloadContents } =
    useOutletContext<CompetitionContext>();

  const canSubmit = c.membership.active && c.status !== "closed" && c.quota_per_day > 0;
  const config = c.submission_config;

  return (
    <section className="ov">
      <h2 className="ov-title">Tổng quan</h2>

      <section className="ov-block">
        <h3 className="ov-block-title">Thể lệ &amp; cách tham gia</h3>
        <ul className="ov-facts">
          <li>
            <strong>Thời gian.</strong> Diễn ra từ {formatLocal(c.start_at)} đến{" "}
            {formatLocal(c.end_at)}.
          </li>
          <li>
            <strong>Tham gia.</strong> {JOIN_MODE_DETAIL[c.join_mode]}.
          </li>
          <li>
            <strong>Hạn mức nộp.</strong>{" "}
            {c.quota_per_day > 0
              ? `Tối đa ${c.quota_per_day} lượt mỗi ngày.`
              : "Không nhận bài nộp."}
          </li>
        </ul>
      </section>

      <section className="ov-block">
        <h3 className="ov-block-title">Quy cách bài nộp</h3>
        <ul className="ov-facts">
          <li>
            <strong>Chỉ số chính.</strong> <span>{METRIC_LABEL[c.primary_metric]}</span>
          </li>
          <li>
            <strong>Cột ID.</strong> <span>{configValue(config.id_column)}</span>
          </li>
          <li>
            <strong>Cột dự đoán.</strong> <span>{configValue(config.prediction_column)}</span>
          </li>
          <li>
            <strong>Cách tính điểm.</strong>{" "}
            <span>{config.average ? AVERAGE_LABEL[config.average] : NOT_CONFIGURED}</span>
          </li>
          {/* Backend bỏ hẳn khoá này với người không phải thành viên: nhãn dương là dữ liệu ground truth. */}
          {config.pos_label !== undefined && (
            <li>
              <strong>Nhãn dương.</strong> <span>{configValue(config.pos_label)}</span>
            </li>
          )}
          <li>
            <strong>Dung lượng tối đa.</strong>{" "}
            <span>
              CSV {config.max_upload_mb} MiB, notebook {config.max_notebook_mb} MiB.
            </span>
          </li>
        </ul>
      </section>

      <section className="ov-block">
        <h3 className="ov-block-title">Tài liệu cuộc thi</h3>
        {contentsLoading ? (
          <p className="content-nav-state" role="status">
            Đang tải tài liệu…
          </p>
        ) : contentsError ? (
          <div className="content-nav-state" role="alert">
            <p>Không tải được danh sách tài liệu cuộc thi.</p>
            <button type="button" className="btn btn-secondary" onClick={() => void reloadContents()}>
              Thử lại
            </button>
          </div>
        ) : contents.length > 0 ? (
          <nav aria-label="Tài liệu cuộc thi">
            <ul className="ov-docs">
              {contents.map((item) => (
                <li key={item.id}>
                  <Link className="ov-doc" to={`content/${item.slug}`}>
                    <span className="ov-doc-title">{item.title}</span>
                    <span>
                      {item.visibility === "members" && (
                        <span className="chip">{VISIBILITY_LABEL.members}</span>
                      )}{" "}
                      Cập nhật {formatLocal(item.updated_at)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : (
          <p className="ov-hint">Ban Tổ chức chưa đăng tài liệu cho cuộc thi này.</p>
        )}
      </section>

      <div className="ov-actions">
        {canSubmit ? (
          <Link className="btn" to="submit">
            Nộp bài
          </Link>
        ) : (
          <p className="ov-hint">{submitBlockedReason(c)}</p>
        )}
        {c.leaderboard_visible && (
          <Link className="btn btn-secondary" to="leaderboard">
            Xem bảng xếp hạng
          </Link>
        )}
      </div>
    </section>
  );
}

export function CompetitionContentPanel() {
  const { competition, contents } = useOutletContext<CompetitionContext>();
  const { contentSlug } = useParams<{ contentSlug: string }>();
  const [content, setContent] = useState<ContentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const articleRef = useRef<HTMLElement>(null);
  const navigationType = useNavigationType();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchContent(competition.slug, contentSlug!)
      .then((data) => {
        if (!cancelled) setContent(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [competition.slug, contentSlug, reloadKey]);

  // Đổi trang nội dung thì đưa bài viết lên đầu; bỏ qua POP để back/forward giữ vị trí cũ.
  useEffect(() => {
    if (navigationType === "POP") return;
    const el = articleRef.current;
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start" });
  }, [contentSlug, navigationType]);

  // Khung cuộc thi nhường tiêu đề cho panel này; mục lục đã có sẵn tên tài liệu nên
  // dùng được ngay cả khi bản đầy đủ còn đang tải.
  const summary = contents.find((item) => item.slug === contentSlug);
  useDocumentTitle(
    content?.title ?? (error ? "Không tìm thấy nội dung" : summary?.title ?? "Nội dung cuộc thi"),
  );

  if (loading) return <Loading label="Đang tải nội dung…" />;

  if (error) {
    return (
      <div>
        <ErrorBox error={error} />
        <button type="button" className="btn btn-secondary" onClick={() => setReloadKey((k) => k + 1)}>
          Thử lại
        </button>
      </div>
    );
  }

  if (!content) return null;

  const markdown = content.markdown ?? "";
  const index = contents.findIndex((item) => item.slug === contentSlug);
  const prev = index > 0 ? contents[index - 1] : null;
  const next = index >= 0 && index < contents.length - 1 ? contents[index + 1] : null;

  return (
    <article className="article" ref={articleRef}>
      <header className="article-head">
        <h2 className="article-title">{content.title}</h2>
      </header>

      {markdown.trim() === "" ? (
        <p className="article-empty">Trang nội dung này chưa có nội dung để hiển thị.</p>
      ) : (
        <div className="article-body">
          <Suspense fallback={<Loading label="Đang tải nội dung…" />}>
            <MarkdownView markdown={markdown} competitionSlug={competition.slug} />
          </Suspense>
        </div>
      )}

      {(prev || next) && (
        <nav className="article-nav" aria-label="Chuyển trang nội dung">
          {prev && (
            <Link
              className="article-nav-link"
              to={`/competitions/${competition.slug}/content/${prev.slug}`}
            >
              <span className="article-nav-label">Trang trước</span>
              <span className="article-nav-title">{prev.title}</span>
            </Link>
          )}
          {next && (
            <Link
              className="article-nav-link next"
              to={`/competitions/${competition.slug}/content/${next.slug}`}
            >
              <span className="article-nav-label">Trang sau</span>
              <span className="article-nav-title">{next.title}</span>
            </Link>
          )}
        </nav>
      )}
    </article>
  );
}
