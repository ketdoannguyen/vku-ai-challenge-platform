"""Xoá cuộc thi: chỉ draft, xác nhận bằng slug, cascade con trước cha sau và dọn file best-effort."""

import asyncio
from pathlib import Path

import mongomock
from bson import ObjectId
from fastapi.testclient import TestClient

from app.accounts.service import ACCOUNTS_COLLECTION
from app.auth.sessions import SESSIONS_COLLECTION
from app.competitions.service import COMPETITIONS_COLLECTION
from app.content.service import CONTENTS_COLLECTION
from app.memberships.service import MEMBERSHIPS_COLLECTION
from app.submissions.service import SUBMISSIONS_COLLECTION
from tests.helpers import configure_scoring, publish_competition


def _login(client, email="admin@vku.vn", password="adminmatkhau1"):
    resp = client.post("/api/auth/login", json={"identifier": email, "password": password})
    assert resp.status_code == 200


def _body(slug="cuoc-thi-nhap"):
    return {
        "slug": slug,
        "name": "Cuộc thi nháp",
        "start_at": "2026-10-01T00:00:00Z",
        "end_at": "2026-11-01T00:00:00Z",
    }


def _create_draft(client, slug="cuoc-thi-nhap") -> str:
    _login(client)
    created = client.post("/api/admin/competitions", json=_body(slug))
    assert created.status_code == 201
    return created.json()["id"]


def _db(client):
    return client.app.state.mongo.db


def _seed_children(client, competition_id: str, account_id: ObjectId) -> None:
    """Nhét sẵn dữ liệu con trực tiếp vào DB — DELETE phải dọn hết, không phụ thuộc luồng API."""
    db = _db(client)
    cid = ObjectId(competition_id)
    asyncio.run(
        db[MEMBERSHIPS_COLLECTION].insert_one(
            {"competition_id": cid, "account_id": account_id, "active": True}
        )
    )
    asyncio.run(
        db[SUBMISSIONS_COLLECTION].insert_one(
            {
                "competition_id": cid,
                "account_id": account_id,
                "status": "completed",
                "file_path": f"submissions/{competition_id}/{account_id}/bai.csv",
            }
        )
    )
    asyncio.run(
        db[CONTENTS_COLLECTION].insert_one({"competition_id": cid, "slug": "de-bai", "title": "Đề bài"})
    )


def _make_files(tmp_path: Path, competition_id: str) -> tuple[Path, Path]:
    competition_root = tmp_path / "competitions" / competition_id
    (competition_root / "content").mkdir(parents=True)
    (competition_root / "content" / "de-bai.md").write_text("# Đề bài", encoding="utf-8")
    # configure_scoring đã tạo sẵn thư mục private/ khi upload ground truth.
    (competition_root / "private").mkdir(exist_ok=True)
    (competition_root / "private" / "ground_truth.csv").write_text("id,label\n1,1\n", encoding="utf-8")
    submission_root = tmp_path / "submissions" / competition_id
    submission_root.mkdir(parents=True)
    (submission_root / "bai.csv").write_text("id,prediction\n1,1\n", encoding="utf-8")
    return competition_root, submission_root


def _count(client, collection: str, query: dict) -> int:
    return asyncio.run(_db(client)[collection].count_documents(query))


def test_delete_requires_admin_and_matching_slug(client):
    competition_id = _create_draft(client)

    client.cookies.clear()
    anonymous = client.delete(f"/api/admin/competitions/{competition_id}?confirm_slug=cuoc-thi-nhap")
    assert anonymous.status_code == 401
    assert anonymous.json()["error"]["code"] == "UNAUTHORIZED"

    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")
    participant = client.delete(f"/api/admin/competitions/{competition_id}?confirm_slug=cuoc-thi-nhap")
    assert participant.status_code == 403
    assert participant.json()["error"]["code"] == "FORBIDDEN"

    _login(client)
    missing = client.delete(f"/api/admin/competitions/{competition_id}")
    assert missing.status_code == 422
    assert missing.json()["error"]["code"] == "VALIDATION_ERROR"

    wrong = client.delete(f"/api/admin/competitions/{competition_id}?confirm_slug=khong-dung")
    assert wrong.status_code == 422
    assert wrong.json()["error"]["code"] == "CONFIRM_SLUG_MISMATCH"

    # Không lần gọi nào được phép xoá khi xác nhận sai.
    assert _count(client, COMPETITIONS_COLLECTION, {"_id": ObjectId(competition_id)}) == 1


def test_delete_rejects_published_and_closed_competitions(client):
    published_id = _create_draft(client, slug="da-publish")
    assert publish_competition(client, published_id).status_code == 200

    blocked = client.delete(f"/api/admin/competitions/{published_id}?confirm_slug=da-publish")
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "COMPETITION_NOT_DELETABLE"

    closed_id = _create_draft(client, slug="da-dong")
    assert publish_competition(client, closed_id).status_code == 200
    assert client.post(f"/api/admin/competitions/{closed_id}/close").status_code == 200

    closed = client.delete(f"/api/admin/competitions/{closed_id}?confirm_slug=da-dong")
    assert closed.status_code == 409
    assert closed.json()["error"]["code"] == "COMPETITION_NOT_DELETABLE"

    assert _count(client, COMPETITIONS_COLLECTION, {"_id": {"$in": [ObjectId(published_id), ObjectId(closed_id)]}}) == 2


def test_delete_draft_cascades_children_and_files(client, tmp_path):
    competition_id = _create_draft(client)
    other_id = _create_draft(client, slug="cuoc-thi-khac")
    account = asyncio.run(
        _db(client)[ACCOUNTS_COLLECTION].find_one({"email": "thi.sinh@vku.vn"})
    )
    configure_scoring(client, competition_id)
    _seed_children(client, competition_id, account["_id"])
    competition_root, submission_root = _make_files(tmp_path, competition_id)
    other_root = tmp_path / "competitions" / other_id
    other_root.mkdir(parents=True)
    sessions_before = _count(client, SESSIONS_COLLECTION, {})

    resp = client.delete(f"/api/admin/competitions/{competition_id}?confirm_slug=cuoc-thi-nhap")
    assert resp.status_code == 200
    assert resp.json() == {
        "deleted": True,
        "competition_id": competition_id,
        "slug": "cuoc-thi-nhap",
        "files_removed": True,
    }

    cid = ObjectId(competition_id)
    assert _count(client, COMPETITIONS_COLLECTION, {"_id": cid}) == 0
    assert _count(client, MEMBERSHIPS_COLLECTION, {"competition_id": cid}) == 0
    assert _count(client, SUBMISSIONS_COLLECTION, {"competition_id": cid}) == 0
    assert _count(client, CONTENTS_COLLECTION, {"competition_id": cid}) == 0
    assert not competition_root.exists()
    assert not submission_root.exists()

    # Cuộc thi khác, tài khoản và phiên đăng nhập không được đụng tới.
    assert _count(client, COMPETITIONS_COLLECTION, {"_id": ObjectId(other_id)}) == 1
    assert other_root.exists()
    assert _count(client, ACCOUNTS_COLLECTION, {}) == 2
    assert _count(client, SESSIONS_COLLECTION, {}) == sessions_before

    gone = client.get(f"/api/admin/competitions/{competition_id}")
    assert gone.status_code == 404


def test_delete_keeps_competition_when_child_cleanup_fails(client, monkeypatch, tmp_path):
    competition_id = _create_draft(client)
    account = asyncio.run(_db(client)[ACCOUNTS_COLLECTION].find_one({"email": "thi.sinh@vku.vn"}))
    _seed_children(client, competition_id, account["_id"])
    competition_root, submission_root = _make_files(tmp_path, competition_id)

    original = mongomock.Collection.delete_many

    def boom(self, *args, **kwargs):
        if self.name == CONTENTS_COLLECTION:
            raise RuntimeError("mongo down")
        return original(self, *args, **kwargs)

    # Lỗi ở bước dọn nội dung: membership/bài nộp đã xoá nhưng competition phải còn để gọi lại.
    # Wrapper motor tạo mới mỗi lần truy cập nên chỉ vá được ở class mongomock bên dưới.
    monkeypatch.setattr(mongomock.Collection, "delete_many", boom)

    with TestClient(client.app, raise_server_exceptions=False) as raw:
        raw.cookies.update(client.cookies)
        failed = raw.delete(f"/api/admin/competitions/{competition_id}?confirm_slug=cuoc-thi-nhap")
    assert failed.status_code == 500

    assert _count(client, COMPETITIONS_COLLECTION, {"_id": ObjectId(competition_id)}) == 1
    assert competition_root.exists()

    # Gọi lại sau khi DB lành: lần này xoá sạch và dọn luôn file.
    monkeypatch.undo()
    retry = client.delete(f"/api/admin/competitions/{competition_id}?confirm_slug=cuoc-thi-nhap")
    assert retry.status_code == 200
    assert retry.json()["files_removed"] is True
    assert _count(client, COMPETITIONS_COLLECTION, {"_id": ObjectId(competition_id)}) == 0
    assert not competition_root.exists()
    assert not submission_root.exists()
