"""Xoá cuộc thi: draft/closed (không published), xác nhận bằng slug, cascade con trước cha sau và dọn file best-effort."""

import asyncio
from datetime import datetime, timezone
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
    """Nhét sẵn dữ liệu con trực tiếp vào DB - DELETE phải dọn hết, không phụ thuộc luồng API."""
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


def test_delete_rejects_published_competition(client):
    """Cuộc thi đang chạy phải Kết thúc trước: đóng là bước xác nhận có chủ đích trước khi mất lịch sử thi."""
    published_id = _create_draft(client, slug="da-publish")
    assert publish_competition(client, published_id).status_code == 200

    blocked = client.delete(f"/api/admin/competitions/{published_id}?confirm_slug=da-publish")
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "COMPETITION_NOT_DELETABLE"
    assert _count(client, COMPETITIONS_COLLECTION, {"_id": ObjectId(published_id)}) == 1


def test_delete_closed_cascades_children_and_files(client, tmp_path):
    """Đã kết thúc vẫn xoá được, và phải dọn sạch y hệt draft - cascade không phụ thuộc status."""
    competition_id = _create_draft(client, slug="da-dong")
    # Publish (kèm cấu hình chấm điểm) phải xong trước khi seed bài completed - có bài rồi thì
    # ground truth bị khoá và bước configure_scoring sẽ 422.
    assert publish_competition(client, competition_id).status_code == 200
    assert client.post(f"/api/admin/competitions/{competition_id}/close").status_code == 200

    account = asyncio.run(_db(client)[ACCOUNTS_COLLECTION].find_one({"email": "thi.sinh@vku.vn"}))
    _seed_children(client, competition_id, account["_id"])
    competition_root, submission_root = _make_files(tmp_path, competition_id)

    resp = client.delete(f"/api/admin/competitions/{competition_id}?confirm_slug=da-dong")
    assert resp.status_code == 200
    assert resp.json()["deleted"] is True
    assert resp.json()["files_removed"] is True

    cid = ObjectId(competition_id)
    assert _count(client, COMPETITIONS_COLLECTION, {"_id": cid}) == 0
    assert _count(client, MEMBERSHIPS_COLLECTION, {"competition_id": cid}) == 0
    assert _count(client, SUBMISSIONS_COLLECTION, {"competition_id": cid}) == 0
    assert _count(client, CONTENTS_COLLECTION, {"competition_id": cid}) == 0
    assert not competition_root.exists()
    assert not submission_root.exists()


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
    # Chỉ gỡ đúng patch delete_many - `monkeypatch.undo()` sẽ gỡ luôn cả MinIO giả ở conftest.
    monkeypatch.setattr(mongomock.Collection, "delete_many", original)
    retry = client.delete(f"/api/admin/competitions/{competition_id}?confirm_slug=cuoc-thi-nhap")
    assert retry.status_code == 200
    assert retry.json()["files_removed"] is True
    assert _count(client, COMPETITIONS_COLLECTION, {"_id": ObjectId(competition_id)}) == 0
    assert not competition_root.exists()
    assert not submission_root.exists()


def _seed_artifact_objects(client, competition_id: str, keys: list[str]) -> None:
    """Artifact của submission giờ nằm trên object storage: xoá cuộc thi phải dọn theo prefix."""
    db = _db(client)
    account = asyncio.run(db[ACCOUNTS_COLLECTION].find_one({"email": "thi.sinh@vku.vn"}))
    documents = []
    for key in keys:
        submission_id = ObjectId()
        documents.append(
            {
                "_id": submission_id,
                "competition_id": ObjectId(competition_id),
                "account_id": account["_id"],
                "status": "completed",
                "metrics": None,
                "primary_score": 0.5,
                "created_at": datetime.now(timezone.utc),
                "artifacts": {
                    "prediction": {
                        "object_key": key,
                        "original_filename": "answers.csv",
                        "size_bytes": 4,
                    }
                },
            }
        )
    asyncio.run(db[SUBMISSIONS_COLLECTION].insert_many(documents))


def test_delete_removes_artifact_objects_under_both_competition_prefixes(
    client, fake_artifact_storage
):
    """Bài nộp cũ nằm dưới prefix theo ObjectId, bài từ ADR-033 nằm dưới prefix theo slug - dọn cả hai."""
    competition_id = _create_draft(client, slug="co-artifact")
    other_id = _create_draft(client, slug="khong-dinh-xoa")
    legacy = f"competitions/{competition_id}/accounts/a1/submissions/s1/prediction.csv"
    fresh = "competitions/co-artifact/accounts/doi-a/submissions/submission-0001/prediction.csv"
    theirs_by_id = f"competitions/{other_id}/accounts/a1/submissions/s1/prediction.csv"
    theirs_by_slug = (
        "competitions/khong-dinh-xoa/accounts/doi-b/submissions/submission-0001/prediction.csv"
    )
    fake_artifact_storage.objects.update(
        {legacy: b"data", fresh: b"data", theirs_by_id: b"data", theirs_by_slug: b"data"}
    )
    _seed_artifact_objects(client, competition_id, [legacy, fresh])

    resp = client.delete(f"/api/admin/competitions/{competition_id}?confirm_slug=co-artifact")
    assert resp.status_code == 200
    assert resp.json()["files_removed"] is True
    assert legacy not in fake_artifact_storage.objects
    assert fresh not in fake_artifact_storage.objects
    # Cuộc thi khác không bị đụng tới, dù dưới prefix theo id hay theo slug.
    assert theirs_by_id in fake_artifact_storage.objects
    assert theirs_by_slug in fake_artifact_storage.objects


def test_delete_reports_partial_cleanup_when_storage_is_unavailable(client, fake_artifact_storage):
    """Storage hỏng không được chặn xoá cuộc thi: DB xoá trước, file chỉ được báo là dọn chưa xong."""
    competition_id = _create_draft(client, slug="co-artifact-hong")
    key = f"competitions/{competition_id}/accounts/a1/submissions/s1/prediction.csv"
    fake_artifact_storage.objects[key] = b"data"
    _seed_artifact_objects(client, competition_id, [key])
    fake_artifact_storage.unavailable = True

    resp = client.delete(f"/api/admin/competitions/{competition_id}?confirm_slug=co-artifact-hong")
    assert resp.status_code == 200
    assert resp.json()["files_removed"] is False
    assert _count(client, COMPETITIONS_COLLECTION, {"_id": ObjectId(competition_id)}) == 0
    assert _count(client, SUBMISSIONS_COLLECTION, {"competition_id": ObjectId(competition_id)}) == 0
