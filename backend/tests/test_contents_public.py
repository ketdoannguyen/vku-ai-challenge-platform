"""Participant content visibility and safe asset serving."""

from pathlib import Path

import pytest

from app.core.config import get_settings
from tests.helpers import publish_competition


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


def _login(client, email="admin@vku.vn", password="adminmatkhau1"):
    response = client.post("/api/auth/login", json={"identifier": email, "password": password})
    assert response.status_code == 200


def _setup(client, slug="docs-cup", status="published"):
    _login(client)
    competition = client.post(
        "/api/admin/competitions",
        json={
            "slug": slug,
            "name": slug,
            "start_at": "2026-10-01T00:00:00Z",
            "end_at": "2026-11-01T00:00:00Z",
        },
    ).json()
    contents = []
    for title, content_slug, order, visibility in (
        ("Rules", "rules", 20, "members"),
        ("Problem", "problem", 10, "public"),
    ):
        content = client.post(
            f"/api/admin/competitions/{competition['id']}/contents",
            json={
                "title": title,
                "slug": content_slug,
                "order": order,
                "visibility": visibility,
            },
        ).json()
        client.put(
            f"/api/admin/competitions/{competition['id']}/contents/{content['id']}/file",
            files={"file": (f"{content_slug}.md", f"# {title}".encode())},
        )
        contents.append(content)
    if status != "draft":
        assert publish_competition(client, competition["id"]).status_code == 200
    if status == "closed":
        client.post(f"/api/admin/competitions/{competition['id']}/close")
    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")
    return competition, contents


def test_guest_sees_only_public_content(client):
    """Khách đọc nội dung công khai, nội dung members vẫn 404 vì không có membership (ADR-014)."""
    _setup(client)
    client.post("/api/auth/logout")
    response = client.get("/api/competitions/docs-cup/contents")
    assert response.status_code == 200
    assert [item["slug"] for item in response.json()["contents"]] == ["problem"]
    assert client.get("/api/competitions/docs-cup/contents/problem").status_code == 200
    assert client.get("/api/competitions/docs-cup/contents/rules").status_code == 404


def test_guest_cannot_read_draft_competition_content(client):
    """Competition draft ẩn hoàn toàn với khách, kể cả nội dung public."""
    _setup(client, slug="draft-cup", status="draft")
    client.post("/api/auth/logout")
    assert client.get("/api/competitions/draft-cup/contents").status_code == 404


def test_non_member_sees_only_public_content_sorted(client):
    _setup(client)
    response = client.get("/api/competitions/docs-cup/contents")
    assert response.status_code == 200
    assert [item["slug"] for item in response.json()["contents"]] == ["problem"]
    assert client.get("/api/competitions/docs-cup/contents/rules").status_code == 404
    detail = client.get("/api/competitions/docs-cup/contents/problem")
    assert detail.status_code == 200
    assert detail.json()["markdown"] == "# Problem"


def test_active_member_sees_members_content_and_closed_is_readable(client):
    competition, _ = _setup(client, status="closed")
    _login(client)
    client.post(
        f"/api/admin/competitions/{competition['id']}/members",
        json={"email": "thi.sinh@vku.vn"},
    )
    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")
    listed = client.get("/api/competitions/docs-cup/contents")
    assert [item["slug"] for item in listed.json()["contents"]] == ["problem", "rules"]
    assert client.get("/api/competitions/docs-cup/contents/rules").status_code == 200


def test_draft_content_is_hidden(client):
    _login(client)
    competition = client.post(
        "/api/admin/competitions",
        json={
            "slug": "draft-docs",
            "name": "Draft",
            "start_at": "2026-10-01T00:00:00Z",
            "end_at": "2026-11-01T00:00:00Z",
        },
    ).json()
    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")
    assert client.get("/api/competitions/draft-docs/contents").status_code == 404


def test_missing_markdown_file_has_stable_error(client, isolated_data_dir):
    competition, contents = _setup(client)
    content_id = next(item["id"] for item in contents if item["slug"] == "problem")
    path = isolated_data_dir / "competitions" / competition["id"] / "content" / f"{content_id}.md"
    path.unlink()
    response = client.get("/api/competitions/docs-cup/contents/problem")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "CONTENT_FILE_MISSING"


def test_asset_serving_has_safe_headers_and_rejects_symlink(client, isolated_data_dir):
    competition, _ = _setup(client)
    _login(client)
    png = b"\x89PNG\r\n\x1a\n" + b"payload"
    asset = client.post(
        f"/api/admin/competitions/{competition['id']}/assets",
        files={"file": ("diagram.png", png)},
    ).json()
    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")
    response = client.get(asset["url"])
    assert response.status_code == 200
    assert response.content == png
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "private, max-age=300"

    root = isolated_data_dir / "competitions" / competition["id"] / "assets"
    outside = isolated_data_dir / "outside.png"
    outside.write_bytes(png)
    (root / "leak.png").symlink_to(outside)
    assert client.get("/api/competitions/docs-cup/assets/leak.png").status_code == 404
    assert client.get("/api/competitions/docs-cup/assets/../outside.png").status_code == 404
