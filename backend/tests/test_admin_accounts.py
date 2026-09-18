"""Admin accounts API: role guard 401/403, list/search, create, reset password, enable/disable."""

import asyncio

from app.accounts.service import ACCOUNTS_COLLECTION


def _login(client, email="admin@vku.vn", password="adminmatkhau1"):
    resp = client.post("/api/auth/login", json={"identifier": email, "password": password})
    assert resp.status_code == 200


def _login_participant(client):
    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")


def test_admin_endpoints_require_login(client):
    for resp in (
        client.get("/api/admin/accounts"),
        client.post("/api/admin/accounts", json={}),
        client.post("/api/admin/accounts/abc/reset-password", json={}),
        client.patch("/api/admin/accounts/abc", json={"active": False}),
    ):
        assert resp.status_code == 401
        assert resp.json()["error"]["code"] == "UNAUTHORIZED"


def test_participant_gets_403(client):
    _login_participant(client)
    resp = client.get("/api/admin/accounts")
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "FORBIDDEN"


def test_admin_list_accounts_no_password_hash(client):
    _login(client)
    resp = client.get("/api/admin/accounts")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    for account in body["accounts"]:
        assert "password_hash" not in account
        assert account["email"] in ("admin@vku.vn", "thi.sinh@vku.vn")


def test_admin_list_search_by_name(client):
    _login(client)
    resp = client.get("/api/admin/accounts", params={"q": "Thí Sinh"})
    assert resp.status_code == 200
    assert [a["email"] for a in resp.json()["accounts"]] == ["thi.sinh@vku.vn"]


def test_admin_list_rejects_out_of_range_pagination(client):
    _login(client)
    for params in ({"limit": 0}, {"limit": 201}, {"offset": -1}):
        resp = client.get("/api/admin/accounts", params=params)
        assert resp.status_code == 422, params
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    ok = client.get("/api/admin/accounts", params={"limit": 1, "offset": 0})
    assert ok.status_code == 200
    assert len(ok.json()["accounts"]) == 1


def test_admin_create_account_and_login_with_it(client):
    _login(client)
    resp = client.post(
        "/api/admin/accounts",
        json={"email": "moi@vku.vn", "name": "Tài Khoản Mới", "password": "matkhau-moi-123", "role": "participant"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["email"] == "moi@vku.vn"
    assert body["active"] is True
    assert "password_hash" not in body

    client.cookies.delete("aic_session")
    login = client.post("/api/auth/login", json={"identifier": "moi@vku.vn", "password": "matkhau-moi-123"})
    assert login.status_code == 200


def test_admin_create_duplicate_email_409(client):
    _login(client)
    resp = client.post(
        "/api/admin/accounts",
        json={"email": "admin@vku.vn", "name": "Trùng", "password": "matkhau-trung-12", "role": "participant"},
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ACCOUNT_EXISTS"


def test_admin_create_weak_password_422(client):
    _login(client)
    resp = client.post(
        "/api/admin/accounts", json={"email": "x@vku.vn", "name": "X", "password": "ngan", "role": "participant"}
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_admin_create_invalid_role_422(client):
    _login(client)
    resp = client.post(
        "/api/admin/accounts", json={"email": "x@vku.vn", "name": "X", "password": "matkhau-hop-le-1", "role": "boss"}
    )
    assert resp.status_code == 422


def test_admin_reset_password_old_stops_working(client):
    _login(client)
    # Tạo participant mới rồi reset mật khẩu
    created = client.post(
        "/api/admin/accounts",
        json={"email": "reset@vku.vn", "name": "Reset", "password": "matkhau-cu-12345", "role": "participant"},
    ).json()

    resp = client.post(f"/api/admin/accounts/{created['id']}/reset-password", json={"password": "matkhau-moi-6789"})
    assert resp.status_code == 200

    client.cookies.delete("aic_session")
    old = client.post("/api/auth/login", json={"identifier": "reset@vku.vn", "password": "matkhau-cu-12345"})
    assert old.status_code == 401
    new = client.post("/api/auth/login", json={"identifier": "reset@vku.vn", "password": "matkhau-moi-6789"})
    assert new.status_code == 200


def test_admin_disable_account_kills_session_and_blocks_login(client, mock_db):
    _login(client)
    created = client.post(
        "/api/admin/accounts",
        json={"email": "khoa@vku.vn", "name": "Khóa", "password": "matkhau-khoa-12", "role": "participant"},
    ).json()

    # Participant login, session hoạt động
    client.cookies.delete("aic_session")
    _login(client, "khoa@vku.vn", "matkhau-khoa-12")
    assert client.get("/api/auth/me").status_code == 200

    # Admin disable
    client.cookies.delete("aic_session")
    _login(client)
    resp = client.patch(f"/api/admin/accounts/{created['id']}", json={"active": False})
    assert resp.status_code == 200
    assert resp.json()["active"] is False

    # Session cũ của participant chết ngay + login bị chặn
    client.cookies.delete("aic_session")
    client.cookies.set("aic_session", None)
    login_blocked = client.post("/api/auth/login", json={"identifier": "khoa@vku.vn", "password": "matkhau-khoa-12"})
    assert login_blocked.status_code == 403
    assert login_blocked.json()["error"]["code"] == "ACCOUNT_DISABLED"


def test_admin_cannot_disable_self(client):
    _login(client)
    me = client.get("/api/auth/me").json()
    resp = client.patch(f"/api/admin/accounts/{me['id']}", json={"active": False})
    assert resp.status_code == 422


def test_reset_password_unknown_account_404(client):
    _login(client)
    resp = client.post("/api/admin/accounts/000000000000000000000000/reset-password", json={"password": "mat-khau-hop-le"})
    assert resp.status_code == 404
    bad = client.post("/api/admin/accounts/khong-phai-objectid/reset-password", json={"password": "mat-khau-hop-le"})
    assert bad.status_code == 404
