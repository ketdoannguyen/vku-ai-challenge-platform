/** Protected routes: chờ auth bootstrap xong rồi chặn theo trạng thái/role. */

import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Loading } from "../components/ui";
import { useAuth } from "./AuthContext";
import { returnToFromLocation } from "./returnTo";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { account, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading label="Đang kiểm tra phiên đăng nhập..." />;
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
  if (loading) return <Loading label="Đang kiểm tra phiên đăng nhập..." />;
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
