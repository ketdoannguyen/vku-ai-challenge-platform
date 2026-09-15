"""Admin competition content CRUD, Markdown and image assets."""

import os
from pathlib import Path

import pytest

from app.core.config import get_settings


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


def _login(client, email="admin@vku.vn", password="adminmatkhau1"):
    response = client.post("/api/auth/login", json={"identifier": email, "password": password})
    assert response.status_code == 200


def _competition(client, slug="content-cup"):
    _login(client)
    return client.post(
        "/api/admin/competitions",
        json={
            "slug": slug,
            "name": slug,
            "start_at": "2026-10-01T00:00:00Z",
            "end_at": "2026-11-01T00:00:00Z",
        },
    ).json()


def _create_content(client, cid, **overrides):
    body = {"title": "Đề bài", "slug": "problem", "visibility": "public"}
    body.update(overrides)
    return client.post(f"/api/admin/competitions/{cid}/contents", json=body)


def test_content_admin_requires_login_and_role(client):
    assert client.get("/api/admin/competitions/abc/contents").status_code == 401
    competition = _competition(client)
    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")
    assert client.get(f"/api/admin/competitions/{competition['id']}/contents").status_code == 403


def test_create_list_update_and_delete_content(client, isolated_data_dir):
    competition = _competition(client)
    cid = competition["id"]
    first = _create_content(client, cid)
    second = _create_content(
        client, cid, title="Rules", slug="rules", order=5, visibility="members"
    )
    assert first.status_code == 201
    assert first.json()["order"] == 10
    assert second.status_code == 201

    listed = client.get(f"/api/admin/competitions/{cid}/contents").json()["contents"]
    assert [item["slug"] for item in listed] == ["rules", "problem"]

    content_id = first.json()["id"]
    updated = client.patch(
        f"/api/admin/competitions/{cid}/contents/{content_id}",
        json={"title": "Bài toán", "visibility": "members", "order": 20},
    )
    assert updated.status_code == 200
    assert updated.json()["title"] == "Bài toán"

    upload = client.put(
        f"/api/admin/competitions/{cid}/contents/{content_id}/file",
        files={"file": ("../../evil.md", "# Nội dung", "text/markdown")},
    )
    assert upload.status_code == 200
    expected = isolated_data_dir / "competitions" / cid / "content" / f"{content_id}.md"
    assert expected.read_text() == "# Nội dung"
    assert not (isolated_data_dir / "evil.md").exists()

    detail = client.get(f"/api/admin/competitions/{cid}/contents/{content_id}")
    assert detail.json()["markdown"] == "# Nội dung"
    deleted = client.delete(f"/api/admin/competitions/{cid}/contents/{content_id}")
    assert deleted.status_code == 200
    assert not expected.exists()


def test_content_validation_and_slug_collision(client):
    competition = _competition(client)
    cid = competition["id"]
    assert _create_content(client, cid).status_code == 201
    duplicate = _create_content(client, cid, title="Khác")
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "CONTENT_SLUG_EXISTS"
    for body in (
        {"title": " ", "slug": "x"},
        {"title": "X", "slug": "Bad Slug"},
        {"title": "X", "slug": "x", "order": -1},
        {"title": "X", "slug": "x", "visibility": "private"},
    ):
        response = client.post(f"/api/admin/competitions/{cid}/contents", json=body)
        assert response.status_code == 422


def test_markdown_upload_guards(client):
    competition = _competition(client)
    cid = competition["id"]
    content_id = _create_content(client, cid).json()["id"]
    url = f"/api/admin/competitions/{cid}/contents/{content_id}/file"
    for filename, data in (
        ("problem.txt", b"text"),
        ("problem.md", b""),
        ("problem.md", b"\xff\xfe"),
    ):
        response = client.put(url, files={"file": (filename, data)})
        assert response.status_code == 422
    oversized = b"x" * (2 * 1024 * 1024 + 1)
    response = client.put(url, files={"file": ("large.md", oversized)})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "FILE_TOO_LARGE"


def test_reorder_rejects_foreign_and_duplicate_ids(client):
    first_comp = _competition(client, "first-cup")
    first = _create_content(client, first_comp["id"]).json()
    second_comp = _competition(client, "second-cup")
    second = _create_content(client, second_comp["id"], slug="other").json()
    url = f"/api/admin/competitions/{first_comp['id']}/contents/reorder"
    foreign = client.post(url, json={"items": [{"id": second["id"], "order": 1}]})
    assert foreign.status_code == 422
    duplicate = client.post(
        url,
        json={"items": [{"id": first["id"], "order": 1}, {"id": first["id"], "order": 2}]},
    )
    assert duplicate.status_code == 422


def test_asset_upload_list_delete_and_type_guards(client, isolated_data_dir):
    competition = _competition(client)
    cid = competition["id"]
    url = f"/api/admin/competitions/{cid}/assets"
    png = b"\x89PNG\r\n\x1a\n" + b"payload"
    uploaded = client.post(url, files={"file": ("chart.png", png, "image/png")})
    assert uploaded.status_code == 201
    asset = uploaded.json()
    assert asset["name"].endswith(".png")
    assert "chart" not in asset["name"]
    assert asset["url"].endswith(f"/assets/{asset['name']}")
    assert client.get(url).json()["assets"][0]["name"] == asset["name"]

    asset_path = isolated_data_dir / "competitions" / cid / "assets" / asset["name"]
    assert asset_path.exists()
    assert client.delete(f"{url}/{asset['name']}").status_code == 200
    assert not asset_path.exists()

    for filename, data in (
        ("evil.svg", b"<svg><script>alert(1)</script></svg>"),
        ("fake.png", b"not-png"),
        ("file.txt", b"hello"),
    ):
        response = client.post(url, files={"file": (filename, data)})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_FILE_TYPE"

    response = client.post(
        url,
        files={"file": ("large.png", b"\x89PNG\r\n\x1a\n" + os.urandom(2 * 1024 * 1024))},
    )
    assert response.status_code == 413
