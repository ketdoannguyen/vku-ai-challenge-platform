/** Ô slug tự điền theo tiêu đề; admin gõ tay thì giá trị tay thắng. */

import { useState } from "react";
import { slugify } from "../lib/slug";

/**
 * `follow` quyết định có bám theo tiêu đề ngay khi mở form: form tạo mới bật, form sửa
 * cuộc thi tắt vì slug cuộc thi bị khoá (backend không nhận đổi slug khi sửa).
 *
 * Gõ tay vào ô slug sẽ tắt auto-fill để tiêu đề đổi tiếp không ghi đè; xoá trắng ô slug
 * là cách bật lại.
 */
export function useAutoSlug(initialSlug: string, follow: boolean) {
  const [slug, setSlug] = useState(initialSlug);
  const [autoFill, setAutoFill] = useState(follow);

  function onTitleChange(title: string) {
    if (autoFill) setSlug(slugify(title));
  }

  function onSlugChange(value: string) {
    setSlug(value);
    setAutoFill(value === "");
  }

  return { slug, onTitleChange, onSlugChange };
}
