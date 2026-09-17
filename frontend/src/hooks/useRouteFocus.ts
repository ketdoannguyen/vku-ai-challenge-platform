import { useEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/**
 * Đưa focus về `#main-content` sau mỗi điều hướng PUSH/REPLACE để screen reader
 * đọc được trang mới và bàn phím không tiếp tục ở lại phần tử của trang cũ.
 *
 * Bỏ qua:
 * - Lần render đầu (và lần chạy lại của StrictMode): `location.key` chưa đổi.
 * - POP (back/forward): để trình duyệt tự khôi phục focus và vị trí cuộn.
 * - Có `location.hash`: anchor và skip-link tự quản lý focus.
 */
export function useRouteFocus() {
  const { key, hash } = useLocation();
  const navigationType = useNavigationType();
  const lastKey = useRef(key);

  useEffect(() => {
    if (key === lastKey.current) return;
    lastKey.current = key;
    if (navigationType === "POP") return;
    if (hash) return;
    // `main` cuộn vào tầm nhìn khi nhận focus nên không cần scrollTo(0, 0).
    document.getElementById("main-content")?.focus();
  }, [key, hash, navigationType]);
}
