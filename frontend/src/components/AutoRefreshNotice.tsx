import type { RefreshStatus } from "../hooks/useAutoRefresh";

/** Không gắn nhãn "realtime": đây là kết quả của lần kiểm tra, không phải sự kiện đẩy. */
export function AutoRefreshNotice({
  state,
  lastSuccessAt,
}: RefreshStatus) {
  if (state !== "retrying" && state !== "stopped") return null;
  const checkedAt = lastSuccessAt?.toLocaleTimeString("vi-VN");
  return (
    <p className="status-banner warning" role="status">
      {state === "retrying"
        ? "Không tải được dữ liệu mới. Hệ thống đang tự thử lại."
        : "Đã dừng tự động làm mới vì phiên hoặc quyền truy cập thay đổi. Hãy kiểm tra quyền truy cập trước khi tải lại trang."}
      {checkedAt && ` Kiểm tra thành công lần cuối lúc ${checkedAt}.`}
    </p>
  );
}
