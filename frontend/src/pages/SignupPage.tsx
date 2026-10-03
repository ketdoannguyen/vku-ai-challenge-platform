import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { authErrorMessage } from "../auth/AuthContext";
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

/** Khớp policy backend (`password_policy_error`, ADR-049); backend vẫn là chốt cuối. */
function passwordPolicyError(password: string): string | null {
  if (password.length < 6) return "Mật khẩu phải có ít nhất 6 ký tự.";
  if (password.trim() !== password) return "Mật khẩu không được bắt đầu/kết thúc bằng khoảng trắng.";
  return null;
}

// Lọc sớm lỗi định dạng thường gặp để người dùng nhận thông điệp tiếng Việt thay vì 422 generic.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldErrors {
  email?: string;
  name?: string;
  password?: string;
  confirm?: string;
}

interface RegisterAccepted {
  ok: boolean;
  pending: boolean;
  message: string;
}

export function SignupPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [acceptedMessage, setAcceptedMessage] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const serverErrorRef = useRef<HTMLDivElement>(null);
  const acceptedRef = useRef<HTMLDivElement>(null);
  useDocumentTitle("Đăng ký");

  // Lỗi chung (429, mạng...) và thông báo đã nhận đăng ký đều phải được screen reader đọc lên.
  useEffect(() => {
    if (serverError) serverErrorRef.current?.focus();
  }, [serverError]);

  useEffect(() => {
    if (acceptedMessage) acceptedRef.current?.focus();
  }, [acceptedMessage]);

  /** Gõ lại vào field nào thì xóa lỗi của field đó và banner lỗi chung. */
  function clearError(field: keyof FieldErrors) {
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
    setServerError((prev) => (prev ? "" : prev));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();

    const errors: FieldErrors = {};
    const trimmedEmail = email.trim();
    if (!trimmedEmail) errors.email = "Vui lòng nhập email.";
    else if (!EMAIL_RE.test(trimmedEmail)) errors.email = "Email không hợp lệ.";
    if (!name.trim()) errors.name = "Vui lòng nhập tên hiển thị.";
    if (!password) errors.password = "Vui lòng nhập mật khẩu.";
    else {
      const policy = passwordPolicyError(password);
      if (policy) errors.password = policy;
    }
    if (!confirm) errors.confirm = "Vui lòng xác nhận mật khẩu.";
    else if (confirm !== password) errors.confirm = "Mật khẩu xác nhận không khớp.";
    if (errors.email || errors.name || errors.password || errors.confirm) {
      setFieldErrors(errors);
      setServerError("");
      if (errors.email) emailRef.current?.focus();
      else if (errors.name) nameRef.current?.focus();
      else if (errors.password) passwordRef.current?.focus();
      else confirmRef.current?.focus();
      return;
    }

    setServerError("");
    setSubmitting(true);
    try {
      // 202 cho cả email mới lẫn email đã tồn tại; message trung tính do backend quyết định.
      const accepted = await api.post<RegisterAccepted>("/auth/register", {
        email: trimmedEmail,
        name: name.trim(),
        password,
      });
      setAcceptedMessage(accepted.message);
    } catch (err) {
      setServerError(authErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (acceptedMessage) {
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
          <div className="card login-card">
            <div className="login-head">
              <Emblem />
              <h1 className="login-title">VKU AI Challenge Platform</h1>
              <p className="login-subtitle">Đã nhận đăng ký</p>
              <span className="vku-accent" aria-hidden="true">
                <span className="blue" />
                <span className="red" />
                <span className="yellow" />
              </span>
            </div>

            <div ref={acceptedRef} className="status-banner success" role="status" tabIndex={-1}>
              {acceptedMessage}
            </div>

            <Link className="btn login-submit" to="/login">
              Quay lại đăng nhập
            </Link>
          </div>
        </div>
      </div>
    );
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
            <p className="login-subtitle">Tự đăng ký tài khoản thí sinh, chờ Ban Tổ chức duyệt</p>
            <span className="vku-accent" aria-hidden="true">
              <span className="blue" />
              <span className="red" />
              <span className="yellow" />
            </span>
          </div>

          {serverError && (
            <div
              id="signup-error"
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
              <label className="field-label" htmlFor="signup-email">
                Email
              </label>
              <input
                id="signup-email"
                ref={emailRef}
                className="input login-input"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clearError("email");
                }}
                autoComplete="email"
                required
                disabled={submitting}
                aria-invalid={fieldErrors.email ? true : undefined}
                aria-describedby={
                  fieldErrors.email ? "signup-email-error" : serverError ? "signup-error" : undefined
                }
              />
              {fieldErrors.email && (
                <span className="account-field-error" id="signup-email-error">
                  {fieldErrors.email}
                </span>
              )}
            </div>

            <div className="login-field">
              <label className="field-label" htmlFor="signup-name">
                Tên hiển thị
              </label>
              <input
                id="signup-name"
                ref={nameRef}
                className="input login-input"
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  clearError("name");
                }}
                autoComplete="name"
                maxLength={100}
                required
                disabled={submitting}
                aria-invalid={fieldErrors.name ? true : undefined}
                aria-describedby={
                  fieldErrors.name ? "signup-name-error" : serverError ? "signup-error" : undefined
                }
              />
              {fieldErrors.name && (
                <span className="account-field-error" id="signup-name-error">
                  {fieldErrors.name}
                </span>
              )}
            </div>

            <div className="login-field">
              <label className="field-label" htmlFor="signup-password">
                Mật khẩu
              </label>
              <div className="login-password-wrap">
                <input
                  id="signup-password"
                  ref={passwordRef}
                  className="input login-input"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    clearError("password");
                  }}
                  autoComplete="new-password"
                  maxLength={72}
                  required
                  disabled={submitting}
                  aria-invalid={fieldErrors.password ? true : undefined}
                  aria-describedby={
                    fieldErrors.password
                      ? "signup-password-error"
                      : serverError
                        ? "signup-error"
                        : undefined
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
                <span className="account-field-error" id="signup-password-error">
                  {fieldErrors.password}
                </span>
              )}
            </div>

            <div className="login-field">
              <label className="field-label" htmlFor="signup-confirm">
                Xác nhận mật khẩu
              </label>
              <input
                id="signup-confirm"
                ref={confirmRef}
                className="input login-input"
                type={showPassword ? "text" : "password"}
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  clearError("confirm");
                }}
                autoComplete="new-password"
                maxLength={72}
                required
                disabled={submitting}
                aria-invalid={fieldErrors.confirm ? true : undefined}
                aria-describedby={
                  fieldErrors.confirm
                    ? "signup-confirm-error"
                    : serverError
                      ? "signup-error"
                      : undefined
                }
              />
              {fieldErrors.confirm && (
                <span className="account-field-error" id="signup-confirm-error">
                  {fieldErrors.confirm}
                </span>
              )}
            </div>

            <button className="btn login-submit" type="submit" disabled={submitting}>
              {submitting ? "Đang gửi đăng ký..." : "Đăng ký"}
              {!submitting && <IconArrow />}
            </button>
          </div>

          <div className="login-divider" />
          <p className="login-note">
            Đã có tài khoản? <Link to="/login">Đăng nhập</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
