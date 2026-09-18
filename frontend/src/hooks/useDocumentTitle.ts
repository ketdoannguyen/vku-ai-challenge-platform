import { useEffect } from "react";

const APP_TITLE = "AI Challenge";

/**
 * Đặt tiêu đề tab cho trang đang mở. Không khôi phục tiêu đề cũ trong cleanup:
 * route lồng nhau đổi tiêu đề theo dữ liệu tải bất đồng bộ nên việc khôi phục sẽ
 * tạo nháy tiêu đề giữa hai lần chuyển trang.
 *
 * `undefined` dành cho route cha khi trang con tự quản tiêu đề - hook không ghi đè.
 */
export function useDocumentTitle(page: string | undefined) {
  useEffect(() => {
    if (page === undefined) return;
    document.title = `${page} - ${APP_TITLE}`;
  }, [page]);
}
