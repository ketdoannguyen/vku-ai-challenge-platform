"""Admin accounts API: role guard 401/403, list/search, create, reset password, enable/disable, delete."""

import asyncio
from datetime import datetime, timezone

from bson import ObjectId

from app.accounts.service import ACCOUNTS_COLLECTION
from app.auth.sessions import SESSIONS_COLLECTION, create_session
from app.memberships.service import MEMBERSHIPS_COLLECTION
from app.submissions.service import SUBMISSIONS_COLLECTION


def _login(client, email="admin@vku.vn", password="adminmatkhau1"):
    resp = client.post("/api/auth/login", json={"identifier": email, "password": password})
    assert resp.status_code == 200


def _account_id(mock_db, email: str):
    return asyncio.run(mock_db[ACCOUNTS_COLLECTION].find_one({"email": email}))["_id"]


def _seed_submission(mock_db, *, account_id, status: str, reviewed_by=None) -> None:
    document = {
        "competition_id": ObjectId(),
        "account_id": account_id,
        "status": status,
        "created_at": datetime.now(timezone.utc),
    }
    if reviewed_by is not None:
        document["review"] = {"status": "accepted", "reviewed_by": reviewed_by}
    asyncio.run(mock_db[SUBMISSIONS_COLLECTION].insert_one(document))


def test_delete_account_requires_login(client):
    resp = client.delete("/api/admin/accounts/abc", params={"confirm_email": "a@vku.vn"})
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHORIZED"


def test_delete_account_participant_gets_403(client):
    _login_participant(client)
    resp = client.delete("/api/admin/accounts/abc", params={"confirm_email": "a@vku.vn"})
    assert resp.status_code == 403


def test_delete_account_unknown_id_404(client):
    _login(client)
    for account_id in ("000000000000000000000000", "khong-phai-objectid"):
        resp = client.delete(
            f"/api/admin/accounts/{account_id}", params={"confirm_email": "a@vku.vn"}
        )
        assert resp.status_code == 404


def test_delete_account_wrong_confirm_email_422(client, mock_db):
    _login(client)
    target = _account_id(mock_db, "thi.sinh@vku.vn")

    resp = client.delete(
        f"/api/admin/accounts/{target}", params={"confirm_email": "nguoi-khac@vku.vn"}
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "CONFIRM_EMAIL_MISMATCH"
    # Sai xác nhận thì không được xoá gì.
    assert asyncio.run(mock_db[ACCOUNTS_COLLECTION].find_one({"_id": target})) is not None


def test_delete_account_confirm_email_khong_phan_biet_hoa_thuong(client, mock_db):
    _login(client)
    target = _account_id(mock_db, "thi.sinh@vku.vn")

    resp = client.delete(
        f"/api/admin/accounts/{target}", params={"confirm_email": "THI.SINH@VKU.VN"}
    )
    assert resp.status_code == 200
    assert resp.json()["email"] == "thi.sinh@vku.vn"


def test_admin_cannot_delete_self(client):
    _login(client)
    me = client.get("/api/auth/me").json()
    resp = client.delete(f"/api/admin/accounts/{me['id']}", params={"confirm_email": me["email"]})
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_delete_account_with_graded_submission_409(client, mock_db):
    _login(client)
    target = _account_id(mock_db, "thi.sinh@vku.vn")
    _seed_submission(mock_db, account_id=target, status="completed")

    resp = client.delete(
        f"/api/admin/accounts/{target}", params={"confirm_email": "thi.sinh@vku.vn"}
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ACCOUNT_HAS_SUBMISSIONS"
    assert asyncio.run(mock_db[ACCOUNTS_COLLECTION].find_one({"_id": target})) is not None


def test_delete_account_referenced_by_audit_trail_409(client, mock_db):
    """Admin đã duyệt bài là vết hậu kiểm: xoá đi thì không còn truy được ai ra quyết định."""
    _login(client)
    other = client.post(
        "/api/admin/accounts",
        json={"email": "duyet@vku.vn", "name": "Người Duyệt", "password": "matkhau-duyet-1", "role": "admin"},
    ).json()
    reviewer_id = _account_id(mock_db, "duyet@vku.vn")
    _seed_submission(mock_db, account_id=reviewer_id, status="pending", reviewed_by=reviewer_id)

    resp = client.delete(
        f"/api/admin/accounts/{other['id']}", params={"confirm_email": "duyet@vku.vn"}
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ACCOUNT_REFERENCED"
    assert asyncio.run(mock_db[ACCOUNTS_COLLECTION].find_one({"_id": reviewer_id})) is not None


def test_delete_account_cascades_and_leaves_others_alone(client, mock_db):
    _login(client)
    created = client.post(
        "/api/admin/accounts",
        json={"email": "rac@vku.vn", "name": "Tài Khoản Rác", "password": "matkhau-rac-123", "role": "participant"},
    ).json()
    target = _account_id(mock_db, "rac@vku.vn")
    competition_id = ObjectId()

    asyncio.run(create_session(mock_db, target, lifetime_hours=24))
    asyncio.run(
        mock_db[MEMBERSHIPS_COLLECTION].insert_one(
            {"competition_id": competition_id, "account_id": target, "active": True}
        )
    )
    _seed_submission(mock_db, account_id=target, status="pending")

    resp = client.delete(f"/api/admin/accounts/{created['id']}", params={"confirm_email": "rac@vku.vn"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["deleted"] is True
    assert body["email"] == "rac@vku.vn"
    assert body["removed"] == {
        "ai_review_jobs": 0,
        "ai_reviews": 0,
        "submissions": 1,
        "memberships": 1,
        "sessions": 1,
    }

    # Tài khoản và mọi thứ trỏ vào nó biến mất...
    assert asyncio.run(mock_db[ACCOUNTS_COLLECTION].find_one({"_id": target})) is None
    assert asyncio.run(mock_db[SESSIONS_COLLECTION].count_documents({"account_id": target})) == 0
    assert asyncio.run(mock_db[SUBMISSIONS_COLLECTION].count_documents({"account_id": target})) == 0
    assert asyncio.run(mock_db[MEMBERSHIPS_COLLECTION].count_documents({"account_id": target})) == 0
    # ...còn tài khoản khác thì không.
    assert asyncio.run(mock_db[ACCOUNTS_COLLECTION].count_documents({})) == 2


def test_deleted_account_session_token_khong_dang_nhap_duoc(client, mock_db):
    """Xoá account phải kèm session: bỏ sót thì token cũ còn sống trên một tài khoản đã xoá."""
    _login(client)
    created = client.post(
        "/api/admin/accounts",
        json={"email": "tokencu@vku.vn", "name": "Token Cũ", "password": "matkhau-token-1", "role": "participant"},
    ).json()
    target = _account_id(mock_db, "tokencu@vku.vn")
    token = asyncio.run(create_session(mock_db, target, lifetime_hours=24))

    assert client.delete(
        f"/api/admin/accounts/{created['id']}", params={"confirm_email": "tokencu@vku.vn"}
    ).status_code == 200

    client.cookies.set("aic_session", token)
    assert client.get("/api/auth/me").status_code == 401


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


def test_admin_list_returns_global_stats(client):
    _login(client)
    body = client.get("/api/admin/accounts").json()
    assert body["stats"] == {"total": 2, "admin": 1, "participant": 1, "active": 2}


def test_admin_list_stats_ignore_search_and_pagination(client):
    _login(client)
    searched = client.get("/api/admin/accounts", params={"q": "Thí Sinh"}).json()
    assert searched["total"] == 1
    assert searched["stats"] == {"total": 2, "admin": 1, "participant": 1, "active": 2}

    paged = client.get("/api/admin/accounts", params={"limit": 1, "offset": 0}).json()
    assert len(paged["accounts"]) == 1
    assert paged["stats"] == {"total": 2, "admin": 1, "participant": 1, "active": 2}


def test_admin_list_stats_follow_create_and_disable(client):
    _login(client)
    created = client.post(
        "/api/admin/accounts",
        json={"email": "thong.ke@vku.vn", "name": "Thống Kê", "password": "matkhau-thong-ke", "role": "participant"},
    ).json()
    after_create = client.get("/api/admin/accounts").json()["stats"]
    assert after_create == {"total": 3, "admin": 1, "participant": 2, "active": 3}

    client.patch(f"/api/admin/accounts/{created['id']}", json={"active": False})
    after_disable = client.get("/api/admin/accounts").json()["stats"]
    assert after_disable == {"total": 3, "admin": 1, "participant": 2, "active": 2}


def test_admin_list_stats_count_legacy_account_without_active_field(client, mock_db):
    _login(client)
    asyncio.run(mock_db[ACCOUNTS_COLLECTION].insert_one({"email": "legacy@vku.vn", "name": "Legacy", "role": "participant"}))
    body = client.get("/api/admin/accounts").json()
    assert body["stats"] == {"total": 3, "admin": 1, "participant": 2, "active": 3}


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
