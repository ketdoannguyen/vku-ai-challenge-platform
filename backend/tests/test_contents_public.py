"""Participant content access: chỉ thành viên đang hoạt động hoặc admin đọc được."""

import pytest

from app.core.config import get_settings
from tests.helpers import publish_competition

PARTICIPANT = ("thi.sinh@vku.vn", "thisinhmatkhau1")


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
    for title, content_slug, order in (("Rules", "rules", 20), ("Problem", "problem", 10)):
        content = client.post(
            f"/api/admin/competitions/{competition['id']}/contents",
            json={"title": title, "slug": content_slug, "order": order},
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
    _login(client, *PARTICIPANT)
    return competition, contents


def _join(client, slug="docs-cup"):
    assert client.post(f"/api/competitions/{slug}/join", json={}).status_code == 200


def test_guest_cannot_read_content(client):
    _setup(client)
    client.post("/api/auth/logout")
    listed = client.get("/api/competitions/docs-cup/contents")
    assert listed.status_code == 401
    assert listed.json()["error"]["code"] == "UNAUTHORIZED"
    assert client.get("/api/competitions/docs-cup/contents/problem").status_code == 401


def test_guest_cannot_read_draft_competition_content(client):
    """Competition draft ẩn hoàn toàn với khách - 404 trước cả khi kiểm quyền đọc."""
    _setup(client, slug="draft-cup", status="draft")
    client.post("/api/auth/logout")
    assert client.get("/api/competitions/draft-cup/contents").status_code == 404


def test_non_member_cannot_read_content(client):
    _setup(client)
    listed = client.get("/api/competitions/docs-cup/contents")
    assert listed.status_code == 403
    assert listed.json()["error"]["code"] == "MEMBERSHIP_REQUIRED"
    assert client.get("/api/competitions/docs-cup/contents/problem").status_code == 403


def test_active_member_sees_all_content_and_closed_is_readable(client):
    """Cuộc thi đã đóng vẫn đọc được với thành viên đang hoạt động; hết nhãn public/members."""
    competition, _ = _setup(client, status="closed")
    _login(client)
    client.post(
        f"/api/admin/competitions/{competition['id']}/members",
        json={"email": "thi.sinh@vku.vn"},
    )
    _login(client, *PARTICIPANT)
    listed = client.get("/api/competitions/docs-cup/contents")
    assert [item["slug"] for item in listed.json()["contents"]] == ["problem", "rules"]
    assert "visibility" not in listed.json()["contents"][0]
    detail = client.get("/api/competitions/docs-cup/contents/rules")
    assert detail.status_code == 200
    assert detail.json()["markdown"] == "# Rules"
    assert "visibility" not in detail.json()


def test_inactive_member_cannot_read_content(client):
    competition, _ = _setup(client)
    _join(client)
    assert client.get("/api/competitions/docs-cup/contents").status_code == 200
    _login(client)
    account_id = client.get(f"/api/admin/competitions/{competition['id']}/members").json()["members"][0]["account_id"]
    assert client.patch(
        f"/api/admin/competitions/{competition['id']}/members/{account_id}",
        json={"active": False},
    ).status_code == 200
    _login(client, *PARTICIPANT)
    listed = client.get("/api/competitions/docs-cup/contents")
    assert listed.status_code == 403
    assert listed.json()["error"]["code"] == "MEMBERSHIP_INACTIVE"
    assert client.get("/api/competitions/docs-cup/contents/rules").status_code == 403


def test_admin_reads_published_content_without_membership(client):
    """Admin xem trước nội dung không cần tham gia; draft vẫn 404 trên route thí sinh."""
    _setup(client)
    _login(client)
    assert client.get("/api/competitions/docs-cup/contents").status_code == 200
    assert client.get("/api/competitions/docs-cup/contents/rules").status_code == 200
    _setup(client, slug="draft-docs", status="draft")
    _login(client)
    assert client.get("/api/competitions/draft-docs/contents").status_code == 404


def test_missing_markdown_file_has_stable_error(client, isolated_data_dir):
    competition, contents = _setup(client)
    _join(client)
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

    client.post("/api/auth/logout")
    assert client.get(asset["url"]).status_code == 401
    _login(client, *PARTICIPANT)
    assert client.get(asset["url"]).status_code == 403
    _join(client)
    response = client.get(asset["url"])
    assert response.status_code == 200
    assert response.content == png
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "private, no-store"

    root = isolated_data_dir / "competitions" / competition["id"] / "assets"
    outside = isolated_data_dir / "outside.png"
    outside.write_bytes(png)
    (root / "leak.png").symlink_to(outside)
    assert client.get("/api/competitions/docs-cup/assets/leak.png").status_code == 404
    assert client.get("/api/competitions/docs-cup/assets/../outside.png").status_code == 404

    # Admin xem trước ảnh của cuộc thi published không cần membership.
    _login(client)
    assert client.get(asset["url"]).status_code == 200
