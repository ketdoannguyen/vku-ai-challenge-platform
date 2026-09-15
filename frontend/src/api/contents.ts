/** Types + fetch helpers cho competition content (Sprint 04). */

import { api } from "./client";

export interface ContentSummary {
  id: string;
  slug: string;
  title: string;
  order: number;
  visibility: "public" | "members";
  size_bytes: number | null;
  updated_at: string;
}

export interface ContentDetail extends ContentSummary {
  markdown?: string;
}

export interface ContentsResponse {
  contents: ContentSummary[];
}

export function fetchContents(slug: string): Promise<ContentsResponse> {
  return api.get<ContentsResponse>(`/competitions/${slug}/contents`);
}

export function fetchContent(slug: string, contentSlug: string): Promise<ContentDetail> {
  return api.get<ContentDetail>(`/competitions/${slug}/contents/${contentSlug}`);
}
