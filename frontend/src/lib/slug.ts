/** Sinh slug từ tiêu đề tiếng Việt, khớp ràng buộc của `backend/app/core/slugs.py`. */

/** Trần ký tự backend chấp nhận; giữ trùng để slug tự điền không bao giờ bị trả 422. */
export const SLUG_MAX = 64;

/**
 * "Đề bài số 1" -> "de-bai-so-1". Luôn trả về slug hợp lệ hoặc chuỗi rỗng, nên gọi thẳng
 * từ ô nhập mà không cần kiểm tra thêm.
 */
export function slugify(text: string): string {
  return (
    text
      .normalize("NFD")
      // Dấu tiếng Việt nằm trong khối combining diacritical marks sau khi tách NFD.
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      // "đ" không có decomposition nên NFD không tách được, phải thay tay.
      .replace(/đ/g, "d")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX)
      // Cắt cụt có thể để lại "-" ở cuối, mà slug kết thúc bằng "-" là không hợp lệ.
      .replace(/-+$/, "")
  );
}
