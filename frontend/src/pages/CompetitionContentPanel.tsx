/** Overview (index) và content page (theo contentSlug) cho competition portal. */

import { useEffect, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { fetchContent, type ContentDetail } from "../api/contents";
import { ErrorBox, Loading } from "../components/ui";
import { MarkdownView } from "../markdown/MarkdownView";
import type { CompetitionContext } from "./CompetitionDetailPage";

export function CompetitionOverview() {
  const { contents } = useOutletContext<CompetitionContext>();
  return (
    <div>
      <h2>Tổng quan</h2>
      {contents.length > 0 ? (
        <p className="text-muted">
          Cuộc thi có {contents.length} trang nội dung — chọn mục ở menu bên trái để đọc đề bài,
          rules và hướng dẫn.
        </p>
      ) : (
        <p className="text-muted">
          Ban Tổ chức chưa đăng nội dung cho cuộc thi này. Thông tin thời gian, cách tham gia và
          giới hạn nộp bài nằm ở phần header phía trên.
        </p>
      )}
    </div>
  );
}

export function CompetitionContentPanel() {
  const { competition } = useOutletContext<CompetitionContext>();
  const { contentSlug } = useParams<{ contentSlug: string }>();
  const [content, setContent] = useState<ContentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

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
  }, [competition.slug, contentSlug]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!content) return null;

  return (
    <article>
      <MarkdownView markdown={content.markdown ?? ""} competitionSlug={competition.slug} />
    </article>
  );
}
