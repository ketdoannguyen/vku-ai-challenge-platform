import { api } from "../api/client";

/**
 * Tải một tệp từ API rồi lưu xuống máy người dùng.
 *
 * Đi qua fetch thay vì để trình duyệt điều hướng anchor: response lỗi (401/404/503) vẫn là
 * JSON envelope nên phải nổi lên thành lỗi của SPA. Tên file do backend đặt trong
 * `Content-Disposition` - đã kèm slug cuộc thi, tên đội và số thứ tự bài nộp.
 */
export async function downloadArtifact(path: string, fallbackName: string): Promise<void> {
  const { blob, filename } = await api.download(path);
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename ?? fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Trình duyệt đọc blob sau khi click; thu hồi ở macrotask kế tiếp mới không huỷ tải.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
