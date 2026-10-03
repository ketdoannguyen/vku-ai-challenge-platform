"""Tự đăng ký công khai (ADR-049): tạo pending, chờ duyệt, throttle và chống leo quyền."""

import asyncio
import logging

from app.auth.passwords import verify_password
from app.core.config import get_settings


def _register(client, email="moi@vku.vn", name="Người Mới", password="matkhaumoi1"):
    return client.post("/api/auth/register", json={"email": email, "name": name, "password": password})


def _account_doc(mock_db, email):
    return asyncio.run(mock_db["accounts"].find_one({"email": email}))


def test_register_creates_pending_account(client, mock_db):
    response = _register(client)
    assert response.status_code == 202
    body = response.json()
    assert body["ok"] is True
    assert body["pending"] is True
    assert "aic_session" not in response.cookies

    account = _account_doc(mock_db, "moi@vku.vn")
    assert account is not None
    assert account["active"] is False
    assert account["pending_approval"] is True
    assert account["role"] == "participant"
    assert verify_password(account["password_hash"], "matkhaumoi1")
    assert "password_hash" not in body


def test_pending_account_cannot_login(client):
    _register(client)
    response = client.post(
        "/api/auth/login", json={"identifier": "moi@vku.vn", "password": "matkhaumoi1"}
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ACCOUNT_PENDING"
    assert "aic_session" not in response.cookies


def test_approved_account_can_login(client, mock_db):
    _register(client)
    account_id = _account_doc(mock_db, "moi@vku.vn")["_id"]

    client.post("/api/auth/login", json={"identifier": "admin@vku.vn", "password": "adminmatkhau1"})
    approved = client.post(f"/api/admin/accounts/{account_id}/approve")
    assert approved.status_code == 200
    assert approved.json()["pending"] is False
    assert approved.json()["active"] is True
    client.post("/api/auth/logout")

    login = client.post("/api/auth/login", json={"identifier": "moi@vku.vn", "password": "matkhaumoi1"})
    assert login.status_code == 200
    assert login.json()["email"] == "moi@vku.vn"
    assert client.get("/api/auth/me").status_code == 200


def test_register_duplicate_email_returns_same_accepted_response(client, mock_db):
    first = _register(client)
    assert first.status_code == 202
    before = _account_doc(mock_db, "moi@vku.vn")

    second = _register(client)
    assert second.status_code == 202
    assert second.json() == first.json()
    after = _account_doc(mock_db, "moi@vku.vn")
    # Không được ghi đè mật khẩu/trạng thái của lượt đăng ký trước.
    assert after["password_hash"] == before["password_hash"]
    assert after["pending_approval"] is True

    admin_email = _register(client, email="admin@vku.vn")
    assert admin_email.status_code == 202
    assert admin_email.json() == first.json()


def test_register_invalid_input_rejected_without_creating_account(client, mock_db):
    assert _register(client, email="khong-phai-email").status_code == 422
    assert _register(client, password="ngan").status_code == 422
    assert _register(client, name="   ").status_code == 422
    assert _register(client, password="x" * 73).status_code == 422
    assert _account_doc(mock_db, "moi@vku.vn") is None


def test_register_rate_limits_per_email(client, monkeypatch):
    from app.auth import rate_limit

    monkeypatch.setattr(rate_limit.signup_email_limiter, "max_failures", 2)
    assert _register(client, email="spam@vku.vn").status_code == 202
    assert _register(client, email="spam@vku.vn").status_code == 202

    limited = _register(client, email="spam@vku.vn")
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "RATE_LIMITED"
    assert 1 <= int(limited.headers["Retry-After"]) <= 3600
    # Email khác vẫn đăng ký được: trần theo email, không phải trần toàn cục.
    assert _register(client, email="khac@vku.vn").status_code == 202


def test_register_rate_limits_globally(client, monkeypatch):
    from app.auth import rate_limit

    monkeypatch.setattr(rate_limit.signup_global_minute_limiter, "max_failures", 2)
    assert _register(client, email="a1@vku.vn").status_code == 202
    assert _register(client, email="a2@vku.vn").status_code == 202

    limited = _register(client, email="a3@vku.vn")
    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) >= 1


def test_register_kill_switch_blocks_endpoint(client, mock_db, monkeypatch):
    monkeypatch.setenv("PUBLIC_REGISTRATION_ENABLED", "false")
    get_settings.cache_clear()
    try:
        response = _register(client)
    finally:
        get_settings.cache_clear()

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "REGISTRATION_DISABLED"
    assert _account_doc(mock_db, "moi@vku.vn") is None


def test_register_ignores_client_supplied_role_and_active(client, mock_db):
    response = client.post(
        "/api/auth/register",
        json={"email": "moi@vku.vn", "name": "Người Mới", "password": "matkhaumoi1", "role": "admin", "active": True},
    )
    # Field lạ trong body (kể cả `role`) phải bị bỏ qua hoàn toàn, không bao giờ leo quyền.
    assert response.status_code == 202
    account = _account_doc(mock_db, "moi@vku.vn")
    assert account["role"] == "participant"
    assert account["active"] is False
    assert account["pending_approval"] is True


def test_register_logs_do_not_include_password(client, caplog):
    caplog.set_level(logging.INFO)
    password = "matkhaumoi1"
    assert _register(client, password=password).status_code == 202

    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert password not in messages
