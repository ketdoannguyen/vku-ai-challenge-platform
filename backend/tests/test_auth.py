"""Auth flows: login/me/logout, generic errors, cookie flags and abuse protection."""

import logging

from app.core.config import get_settings

COOKIE = "aic_session"


def test_login_ok_sets_cookie_and_me_returns_safe_fields(client):
    resp = client.post("/api/auth/login", json={"identifier": "admin@vku.vn", "password": "adminmatkhau1"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["email"] == "admin@vku.vn"
    assert body["role"] == "admin"
    assert "password_hash" not in body
    assert COOKIE in resp.cookies

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["email"] == "admin@vku.vn"
    assert "password_hash" not in me.json()


def test_login_wrong_password_generic_401(client):
    resp = client.post("/api/auth/login", json={"identifier": "admin@vku.vn", "password": "sai-roi"})
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "INVALID_CREDENTIALS"
    # Không tiết lộ email tồn tại: sai email phải trả cùng response
    resp2 = client.post("/api/auth/login", json={"identifier": "khong-ton-tai@vku.vn", "password": "sai-roi"})
    assert resp2.status_code == 401
    assert resp2.json() == resp.json()


def test_login_rate_limit_normalizes_identifier_and_returns_retry_after(client):
    for attempt in range(10):
        identifier = "  ADMIN@VKU.VN " if attempt % 2 else "admin@vku.vn"
        response = client.post(
            "/api/auth/login",
            json={"identifier": identifier, "password": "sai-roi"},
        )
        assert response.status_code == 401

    limited = client.post(
        "/api/auth/login",
        json={"identifier": "Admin@vku.vn", "password": "sai-roi"},
    )
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "RATE_LIMITED"
    assert 1 <= int(limited.headers["Retry-After"]) <= 900


def test_successful_login_clears_failed_attempts(client):
    for _ in range(9):
        assert client.post(
            "/api/auth/login",
            json={"identifier": "admin@vku.vn", "password": "sai-roi"},
        ).status_code == 401

    assert client.post(
        "/api/auth/login",
        json={"identifier": "admin@vku.vn", "password": "adminmatkhau1"},
    ).status_code == 200
    client.post("/api/auth/logout")
    assert client.post(
        "/api/auth/login",
        json={"identifier": "admin@vku.vn", "password": "sai-roi"},
    ).status_code == 401


def test_production_login_cookie_has_required_flags(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "auto")
    monkeypatch.setenv("SESSION_COOKIE_SAMESITE", "strict")
    get_settings.cache_clear()
    try:
        response = client.post(
            "/api/auth/login",
            json={"identifier": "admin@vku.vn", "password": "adminmatkhau1"},
        )
    finally:
        get_settings.cache_clear()

    cookie = response.headers["set-cookie"]
    assert "aic_session=" in cookie
    assert "HttpOnly" in cookie
    assert "Secure" in cookie
    assert "SameSite=strict" in cookie
    assert "Path=/" in cookie
    assert "Max-Age=86400" in cookie


def test_login_logs_do_not_include_password_or_session_token(client, caplog):
    caplog.set_level(logging.INFO)
    password = "adminmatkhau1"
    response = client.post(
        "/api/auth/login",
        json={"identifier": "admin@vku.vn", "password": password},
    )
    raw_token = response.cookies.get(COOKIE)
    assert raw_token

    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert password not in messages
    assert raw_token not in messages


def test_login_identifier_case_and_space_normalized(client):
    resp = client.post("/api/auth/login", json={"identifier": "  Admin@VKU.vn ", "password": "adminmatkhau1"})
    assert resp.status_code == 200


def test_me_unauthorized_without_session(client):
    resp = client.get("/api/auth/me")
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHORIZED"


def test_logout_invalidates_session(client):
    client.post("/api/auth/login", json={"identifier": "admin@vku.vn", "password": "adminmatkhau1"})
    assert client.get("/api/auth/me").status_code == 200

    logout = client.post("/api/auth/logout")
    assert logout.status_code == 200
    client.cookies.delete(COOKIE)  # cookie bị clear ở response; đảm bảo không gửi lại
    assert client.get("/api/auth/me").status_code == 401


def test_logout_idempotent_without_session(client):
    resp = client.post("/api/auth/logout")
    assert resp.status_code == 200


def test_disabled_account_cannot_login(client, mock_db):
    import asyncio

    from app.accounts.service import ACCOUNTS_COLLECTION

    asyncio.run(
        mock_db[ACCOUNTS_COLLECTION].update_one({"email": "thi.sinh@vku.vn"}, {"$set": {"active": False}})
    )
    resp = client.post("/api/auth/login", json={"identifier": "thi.sinh@vku.vn", "password": "thisinhmatkhau1"})
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "ACCOUNT_DISABLED"


def test_session_with_expired_token_rejected(client, mock_db):
    """Session hết hạn phải bị từ chối kể cả khi document vẫn còn trong DB."""
    import asyncio
    from datetime import datetime, timedelta, timezone

    from app.auth.sessions import create_session, hash_token

    token = asyncio.run(create_session(mock_db, "fake-id", 24))
    asyncio.run(
        mock_db["sessions"].update_one(
            {"_id": hash_token(token)},
            {"$set": {"expires_at": datetime.now(timezone.utc) - timedelta(minutes=1)}},
        )
    )
    client.cookies.set(COOKIE, token)
    assert client.get("/api/auth/me").status_code == 401


def test_session_of_disabled_account_rejected(client, mock_db):
    """Account bị disable sau khi login: session hiện có không còn dùng được."""
    import asyncio

    from app.accounts.service import ACCOUNTS_COLLECTION

    client.post("/api/auth/login", json={"identifier": "thi.sinh@vku.vn", "password": "thisinhmatkhau1"})
    assert client.get("/api/auth/me").status_code == 200

    asyncio.run(
        mock_db[ACCOUNTS_COLLECTION].update_one({"email": "thi.sinh@vku.vn"}, {"$set": {"active": False}})
    )
    assert client.get("/api/auth/me").status_code == 401


def test_db_stores_token_hash_not_raw_token(client, mock_db):
    import asyncio

    client.post("/api/auth/login", json={"identifier": "admin@vku.vn", "password": "adminmatkhau1"})
    docs = asyncio.run(mock_db["sessions"].find({}, {"_id": 1}).to_list(None))
    assert len(docs) == 1
    raw_cookie = client.cookies.get(COOKIE)
    assert docs[0]["_id"] != raw_cookie
    assert len(docs[0]["_id"]) == 64  # sha256 hex
