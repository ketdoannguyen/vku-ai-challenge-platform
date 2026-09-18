import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth, loginErrorMessage } from "../auth/AuthContext";
import { safeReturnTo } from "../auth/returnTo";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

function Emblem() {
  return (
    <img
      src="/vku-logo.png"
      alt="VKU"
      className="login-emblem"
    />
  );
}

function IconArrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 11h12.17l-5.59-5.59L12 4l8 8-8 8-1.41-1.41L16.17 13H4z" />
    </svg>
  );
}

function IconBack() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

function IconEye() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />
    </svg>
  );
}

function IconEyeOff() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65a3 3 0 0 0 3 3c.22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53a5 5 0 0 1-5-5c0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16a3 3 0 0 0-3-3l-.17.01z" />
    </svg>
  );
}

interface FieldErrors {
  identifier?: string;
  password?: string;
}

export function LoginPage() {
  const { account, loading: authLoading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const identifierRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const serverErrorRef = useRef<HTMLDivElement>(null);
  useDocumentTitle("Đăng nhập");

  // Lỗi credentials không gắn với field nào: đưa focus vào alert để screen reader đọc.
  useEffect(() => {
    if (serverError) serverErrorRef.current?.focus();
  }, [serverError]);

  if (!authLoading && account) {
    const from = safeReturnTo((location.state as { from?: unknown } | null)?.from);
    return <Navigate to={from} replace />;
  }

  function changeIdentifier(value: string) {
    setIdentifier(value);
    setFieldErrors((prev) => (prev.identifier ? { ...prev, identifier: undefined } : prev));
    setServerError((prev) => (prev ? "" : prev));
  }

  function changePassword(value: string) {
    setPassword(value);
    setFieldErrors((prev) => (prev.password ? { ...prev, password: undefined } : prev));
    setServerError((prev) => (prev ? "" : prev));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();

    const errors: FieldErrors = {};
    if (!identifier.trim()) errors.identifier = "Vui lòng nhập email.";
    if (!password) errors.password = "Vui lòng nhập mật khẩu.";
    if (errors.identifier || errors.password) {
      setFieldErrors(errors);
      setServerError("");
      if (errors.identifier) identifierRef.current?.focus();
      else passwordRef.current?.focus();
      return;
    }

    setServerError("");
    setSubmitting(true);
    try {
      await login(identifier, password);
      const from = safeReturnTo((location.state as { from?: unknown } | null)?.from);
      navigate(from, { replace: true });
    } catch (err) {
      setServerError(loginErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <button
        type="button"
        className="login-back"
        aria-label="Về trang chủ"
        onClick={() => navigate("/")}
      >
        <IconBack />
      </button>

      <div className="login-capsule">
        <form className="card login-card" onSubmit={onSubmit} noValidate>
          <div className="login-head">
            <Emblem />
            <h1 className="login-title">VKU AI Challenge Platform</h1>
            <p className="login-subtitle">Đăng nhập bằng tài khoản được cấp</p>
            <span className="vku-accent" aria-hidden="true">
              <span className="blue" />
              <span className="red" />
              <span className="yellow" />
            </span>
          </div>

          {serverError && (
            <div
              id="login-error"
              ref={serverErrorRef}
              className="form-error login-error"
              role="alert"
              tabIndex={-1}
            >
              <p>{serverError}</p>
            </div>
          )}

          <div className="login-form">
            <div className="login-field">
              <label className="field-label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                ref={identifierRef}
                className="input login-input"
                type="email"
                value={identifier}
                onChange={(e) => changeIdentifier(e.target.value)}
                autoComplete="username"
                required
                disabled={submitting}
                aria-invalid={fieldErrors.identifier ? true : undefined}
                aria-describedby={
                  fieldErrors.identifier ? "email-error" : serverError ? "login-error" : undefined
                }
              />
              {fieldErrors.identifier && (
                <span className="account-field-error" id="email-error">
                  {fieldErrors.identifier}
                </span>
              )}
            </div>

            <div className="login-field">
              <label className="field-label" htmlFor="password">
                Mật khẩu
              </label>
              <div className="login-password-wrap">
                <input
                  id="password"
                  ref={passwordRef}
                  className="input login-input"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => changePassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  disabled={submitting}
                  aria-invalid={fieldErrors.password ? true : undefined}
                  aria-describedby={
                    fieldErrors.password ? "password-error" : serverError ? "login-error" : undefined
                  }
                />
                <button
                  type="button"
                  className="login-toggle"
                  aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? <IconEyeOff /> : <IconEye />}
                </button>
              </div>
              {fieldErrors.password && (
                <span className="account-field-error" id="password-error">
                  {fieldErrors.password}
                </span>
              )}
            </div>

            <button className="btn login-submit" type="submit" disabled={submitting}>
              {submitting ? "Đang đăng nhập..." : "Đăng nhập"}
              {!submitting && <IconArrow />}
            </button>
          </div>

          <div className="login-divider" />
          <p className="login-note">Liên hệ Ban Tổ chức nếu bạn chưa có tài khoản.</p>
        </form>
      </div>
    </div>
  );
}
