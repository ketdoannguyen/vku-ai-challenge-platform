/** Protected routes: chờ auth bootstrap xong rồi chặn theo trạng thái/role. */

import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Loading } from "../components/ui";
import { useAuth } from "./AuthContext";
import { returnToFromLocation } from "./returnTo";

/**
 * Khởi động phiên là trạng thái đầu tiên người dùng thấy, nên dùng nhận diện VKU thay vì
 * một spinner trần. Vẫn dùng đúng primitive `Loading` để giữ `role="status"` và thông báo.
 */
function AuthBoot() {
  return (
    <div className="boot-state">
      <img className="boot-logo" src="/vku-logo.png" alt="VKU" />
      <Loading label="Đang kiểm tra phiên đăng nhập..." />
      <span className="vku-accent" aria-hidden="true">
        <span className="blue" />
        <span className="red" />
        <span className="yellow" />
      </span>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { account, loading } = useAuth();
  const location = useLocation();
  if (loading) return <AuthBoot />;
  if (!account) {
    return (
      <Navigate
        to="/login"
        state={{ from: returnToFromLocation(location) }}
        replace
      />
    );
  }
  return children;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { account, loading } = useAuth();
  const location = useLocation();
  if (loading) return <AuthBoot />;
  if (!account) {
    return (
      <Navigate
        to="/login"
        state={{ from: returnToFromLocation(location) }}
        replace
      />
    );
  }
  if (account.role !== "admin") return <Navigate to="/" replace />;
  return children;
}
