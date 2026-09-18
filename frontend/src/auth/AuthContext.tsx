/** Auth state: bootstrap qua GET /api/auth/me, login/logout; source of truth là backend. */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiClientError } from "../api/client";

export interface Account {
  id: string;
  email: string;
  name: string;
  role: "admin" | "participant";
  active: boolean;
}

interface AuthState {
  account: Account | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Account>("/auth/me")
      .then((me) => {
        if (!cancelled) setAccount(me);
      })
      .catch(() => {
        /* chưa đăng nhập - state mặc định null */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    const me = await api.post<Account>("/auth/login", { identifier, password });
    setAccount(me);
  }, []);

  const logout = useCallback(async () => {
    await api.post("/auth/logout");
    setAccount(null);
  }, []);

  const value = useMemo(() => ({ account, loading, login, logout }), [account, loading, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error("useAuth phải nằm trong AuthProvider");
  return ctx;
}

export function useOptionalAuth(): AuthState | null {
  return useContext(AuthContext);
}

/** Lỗi login hiển thị cho user: message từ API (đã tiếng Việt, dễ hiểu). */
export function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  return "Không kết nối được server. Thử lại sau.";
}
