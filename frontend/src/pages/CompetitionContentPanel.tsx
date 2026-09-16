/** Overview (index) và content page (theo contentSlug) cho competition portal. */

import { useEffect, useRef, useState } from "react";
import { Link, useNavigationType, useOutletContext, useParams } from "react-router-dom";
import type { Competition } from "../api/competitions";
import { METRIC_LABEL, formatLocal } from "../api/competitions";
import { fetchContent, type ContentDetail } from "../api/contents";
import { ErrorBox, Loading } from "../components/ui";
import { MarkdownView } from "../markdown/MarkdownView";
import { VISIBILITY_LABEL, type CompetitionContext } from "./CompetitionDetailPage";

/** Mô tả cách tham gia ở phần tóm tắt — khác nhãn chip trên masthead để không lặp chữ trên cùng màn hình. */
const JOIN_MODE_DETAIL: Record<Competition["join_mode"], string> = {
  open: "Mở tự do cho mọi thí sinh",
  code: "Cần mã do Ban Tổ chức cấp",
  invite_only: "Chỉ dành cho thí sinh được mời",
};

/** Vì sao chưa nộp được bài — chỉ gọi khi canSubmit sai, tức chưa tham gia và cuộc thi còn nhận bài. */
function submitBlockedReason(c: Competition): string {
  if (c.status === "closed") return "Cuộc thi đã kết thúc nên không nhận thêm bài nộp.";
  if (c.quota_per_day === 0) return "Cuộc thi hiện không nhận bài nộp.";
  if (c.join_mode === "invite_only")
    return "Cuộc thi chỉ dành cho thí sinh được mời — liên hệ Ban Tổ chức để được cấp quyền tham gia.";
  if (c.join_mode === "code")
    return "Nhập mã do Ban Tổ chức cấp ở khối tham gia phía trên để bắt đầu nộp bài.";
  return "Bấm “Tham gia cuộc thi” ở khối phía trên để bắt đầu nộp bài.";
}

export function CompetitionOverview() {
  const { competition: c, contents } = useOutletContext<CompetitionContext>();
  const canSubmit = c.membership.active && c.status !== "closed" && c.quota_per_day > 0;

  return (
    <section className="ov">
      <h2 className="ov-title">Tổng quan</h2>
      <p className="text-muted">
        {contents.length > 0
          ? `Cuộc thi có ${contents.length} trang nội dung — chọn mục ở menu bên trái để đọc đề bài, thể lệ và hướng dẫn.`
          : "Chưa có trang nội dung nào để hiển thị."}
      </p>

      <ul className="ov-facts">
        <li>
          <strong>Thời gian.</strong> Diễn ra từ {formatLocal(c.start_at)} đến{" "}
          {formatLocal(c.end_at)}.
        </li>
        <li>
          <strong>Tham gia.</strong> {JOIN_MODE_DETAIL[c.join_mode]}.
        </li>
        <li>
          <strong>Chỉ số chính.</strong> {METRIC_LABEL[c.primary_metric]}.
        </li>
        <li>
          <strong>Hạn mức nộp.</strong>{" "}
          {c.quota_per_day > 0
            ? `Tối đa ${c.quota_per_day} lượt mỗi ngày.`
            : "Không nhận bài nộp."}
        </li>
      </ul>

      {contents.length > 0 && (
        <div className="ov-block">
          <h3 className="ov-block-title">Trang nội dung</h3>
          <ul className="ov-docs">
            {contents.map((item) => (
              <li key={item.id}>
                <Link className="ov-doc" to={`content/${item.slug}`}>
                  <span className="ov-doc-title">{item.title}</span>
                  <span className="chip">{VISIBILITY_LABEL[item.visibility]}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

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
        <p className="article-meta">
          <span className="chip">{VISIBILITY_LABEL[content.visibility]}</span>
          <span>Cập nhật {formatLocal(content.updated_at)}</span>
        </p>
      </header>

      {markdown.trim() === "" ? (
        <p className="article-empty">Trang nội dung này chưa có nội dung để hiển thị.</p>
      ) : (
        <div className="article-body">
          <MarkdownView markdown={markdown} competitionSlug={competition.slug} />
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
