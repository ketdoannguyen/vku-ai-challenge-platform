"""Admin competitions API: guard, create/validate, edit rules, publish/close/reopen, clone."""

import asyncio
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.competitions import service
from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.config import Settings, get_settings
from app.core.slugs import SLUG_MAX, is_valid_slug
from app.submissions.service import SUBMISSIONS_COLLECTION
from tests.helpers import SCORING_CONFIG, VALID_NOTEBOOK, configure_scoring, publish_competition


def _login(client, email="admin@vku.vn", password="adminmatkhau1"):
    resp = client.post("/api/auth/login", json={"identifier": email, "password": password})
    assert resp.status_code == 200


def _login_participant(client):
    _login(client, "thi.sinh@vku.vn", "thisinhmatkhau1")


def _body(**overrides):
    base = {
        "slug": "ai-challenge-2026",
        "name": "AI Challenge 2026",
        "short_description": "Cuộc thi AI lần thứ nhất",
        "start_at": "2026-10-01T00:00:00Z",
        "end_at": "2026-11-01T00:00:00Z",
    }
    base.update(overrides)
    return base


def test_admin_competition_endpoints_require_login(client):
    for resp in (
        client.get("/api/admin/competitions"),
        client.post("/api/admin/competitions", json={}),
        client.patch("/api/admin/competitions/abc", json={}),
        client.post("/api/admin/competitions/abc/publish"),
        client.post("/api/admin/competitions/abc/close"),
        client.post("/api/admin/competitions/abc/reopen"),
        client.post("/api/admin/competitions/abc/clone"),
    ):
        assert resp.status_code == 401
        assert resp.json()["error"]["code"] == "UNAUTHORIZED"


def test_participant_cannot_call_admin_competition_api(client):
    _login_participant(client)
    for resp in (
        client.get("/api/admin/competitions"),
        client.post("/api/admin/competitions", json=_body()),
    ):
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "FORBIDDEN"


def test_admin_create_competition_defaults_to_draft(client):
    _login(client)
    resp = client.post("/api/admin/competitions", json=_body())
    assert resp.status_code == 201
    body = resp.json()
    assert body["slug"] == "ai-challenge-2026"
    assert body["status"] == "draft"
    assert body["join_mode"] == "open"
    assert body["primary_metric"] == "f1"
    assert body["quota_per_day"] == 5
    assert body["leaderboard_visible"] is True
    assert body["created_by"] == "admin@vku.vn"


def test_admin_create_validates_fields(client):
    _login(client)
    cases = [
        _body(slug="Invalid Slug"),          # slug format
        _body(slug="ai_challenge"),          # underscore không cho
        _body(start_at="2026-11-01T00:00:00Z", end_at="2026-10-01T00:00:00Z"),  # start > end
        _body(primary_metric="accuracy"),    # metric ngoài f1/precision/recall
        _body(quota_per_day=-1),             # quota âm
        _body(quota_per_day=10_000),         # quota phi lý
        _body(join_mode="free"),             # join mode lạ
        _body(name="  "),                    # name rỗng
    ]
    for payload in cases:
        resp = client.post("/api/admin/competitions", json=payload)
        assert resp.status_code == 422, payload
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_slug_unique_enforced_by_api(client):
    _login(client)
    assert client.post("/api/admin/competitions", json=_body()).status_code == 201
    resp = client.post("/api/admin/competitions", json=_body(name="Trùng slug"))
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "SLUG_EXISTS"


def test_admin_list_includes_drafts(client):
    _login(client)
    client.post("/api/admin/competitions", json=_body())
    resp = client.get("/api/admin/competitions")
    assert resp.status_code == 200
    assert [c["slug"] for c in resp.json()["competitions"]] == ["ai-challenge-2026"]
    assert resp.json()["competitions"][0]["status"] == "draft"
    # created_by (email admin) chỉ có ở payload admin, không có ở payload public.
    assert resp.json()["competitions"][0]["created_by"] == "admin@vku.vn"


def test_admin_list_counts_members_and_submissions_per_competition(client):
    """Bảng admin hiển thị số thành viên/bài nộp - phải tách đúng theo từng cuộc thi."""
    _login(client)
    tracked = client.post("/api/admin/competitions", json=_body()).json()["id"]
    other = client.post("/api/admin/competitions", json=_body(slug="other-cup", name="Other Cup")).json()["id"]
    client.post(f"/api/admin/competitions/{tracked}/members", json={"email": "thi.sinh@vku.vn"})
    account_id = ObjectId()
    asyncio.run(
        client.app.state.mongo.db[SUBMISSIONS_COLLECTION].insert_many(
            [
                {"competition_id": ObjectId(tracked), "account_id": account_id, "status": "completed"},
                {"competition_id": ObjectId(tracked), "account_id": account_id, "status": "rejected"},
                {"competition_id": ObjectId(other), "account_id": account_id, "status": "completed"},
            ]
        )
    )

    by_slug = {c["slug"]: c for c in client.get("/api/admin/competitions").json()["competitions"]}
    assert (by_slug["ai-challenge-2026"]["member_count"], by_slug["ai-challenge-2026"]["submission_count"]) == (1, 2)
    assert (by_slug["other-cup"]["member_count"], by_slug["other-cup"]["submission_count"]) == (0, 1)


def test_resources_round_trip_create_edit_and_clear(client):
    _login(client)
    resources = [
        {"label": "Dataset huấn luyện", "url": "https://drive.google.com/drive/folders/abc"},
        {"label": "Sample submission", "url": "https://docs.google.com/spreadsheets/d/xyz"},
    ]
    cid = client.post("/api/admin/competitions", json=_body(resources=resources)).json()["id"]
    assert client.get(f"/api/admin/competitions/{cid}").json()["resources"] == resources

    edited = [{"label": "  Chỉ còn một  ", "url": "https://drive.google.com/file/d/1/view"}]
    resp = client.patch(f"/api/admin/competitions/{cid}", json={"resources": edited})
    assert resp.status_code == 200
    assert resp.json()["resources"] == [
        {"label": "Chỉ còn một", "url": "https://drive.google.com/file/d/1/view"}
    ]

    cleared = client.patch(f"/api/admin/competitions/{cid}", json={"resources": []})
    assert cleared.json()["resources"] == []


def test_create_without_resources_defaults_to_empty(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    assert client.get(f"/api/admin/competitions/{cid}").json()["resources"] == []


def test_resources_reject_unsafe_urls(client):
    _login(client)
    cases = [
        {"label": "http", "url": "http://drive.google.com/x"},
        {"label": "host lạ", "url": "https://evil.example/x"},
        {"label": "giả drive", "url": "https://drive.google.com.evil.example/x"},
        {"label": "credentials", "url": "https://user:pass@drive.google.com/x"},
        {"label": "javascript", "url": "javascript:alert(1)"},
        {"label": "quá dài", "url": "https://drive.google.com/" + "a" * 2048},
        {"label": "rỗng", "url": ""},
    ]
    for index, item in enumerate(cases):
        resp = client.post(
            "/api/admin/competitions", json=_body(slug=f"cup-{index}", resources=[item])
        )
        assert resp.status_code == 422, item
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_resources_reject_bad_label_and_too_many_items(client):
    _login(client)
    blank_label = client.post(
        "/api/admin/competitions",
        json=_body(resources=[{"label": "   ", "url": "https://drive.google.com/x"}]),
    )
    assert blank_label.status_code == 422

    too_many = client.post(
        "/api/admin/competitions",
        json=_body(
            resources=[
                {"label": f"Tài nguyên {index}", "url": f"https://drive.google.com/file/d/{index}"}
                for index in range(11)
            ]
        ),
    )
    assert too_many.status_code == 422
    assert too_many.json()["error"]["code"] == "VALIDATION_ERROR"


def test_clone_copies_resources(client):
    """Clone liệt kê tay từng field - resources phải được truyền để không bị rơi im lặng."""
    _login(client)
    resources = [{"label": "Dataset", "url": "https://drive.google.com/drive/folders/abc"}]
    cid = client.post("/api/admin/competitions", json=_body(resources=resources)).json()["id"]
    clone = client.post(f"/api/admin/competitions/{cid}/clone").json()
    assert clone["resources"] == resources


def _insert_raw_competition(client, slug: str) -> None:
    async def run():
        await client.app.state.mongo.db[COMPETITIONS_COLLECTION].insert_one({"slug": slug})

    asyncio.run(run())


async def _no_competition(db, slug):
    return None


def test_clone_slug_stays_valid_and_within_max_length(client):
    """Slug gốc dài sát giới hạn: cắt cụt phải bỏ gạch ngang cuối, không tạo slug không hợp lệ."""
    _login(client)
    long_bases = [
        "a" * 63,
        "a" * 58 + "-" + "b" * 5,
        "b" * SLUG_MAX,
    ]
    for index, base in enumerate(long_bases):
        cid = client.post(
            "/api/admin/competitions", json=_body(slug=base, name=f"Bản dài {index}")
        ).json()["id"]
        resp = client.post(f"/api/admin/competitions/{cid}/clone")
        assert resp.status_code == 201, base
        slug = resp.json()["slug"]
        assert is_valid_slug(slug), slug
        assert len(slug) <= SLUG_MAX
        assert slug.endswith("-copy")


def test_clone_second_copy_gets_numbered_slug(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    client.post("/api/admin/competitions", json=_body(slug="ai-challenge-2026-copy", name="Bản sao cũ"))
    resp = client.post(f"/api/admin/competitions/{cid}/clone")
    assert resp.status_code == 201
    assert resp.json()["slug"] == "ai-challenge-2026-copy2"


def test_clone_retries_when_candidate_slug_is_taken_at_insert_time(client, monkeypatch):
    """Đối thủ chen vào giữa bước tra và bước ghi: DuplicateKeyError phải được thử lại, không 500."""
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    _insert_raw_competition(client, "ai-challenge-2026-copy")
    # Giả lập khe race: bước tra không thấy slug đã bị request khác chiếm.
    monkeypatch.setattr(service, "find_competition_by_slug", _no_competition)

    resp = client.post(f"/api/admin/competitions/{cid}/clone")
    assert resp.status_code == 201
    assert resp.json()["slug"] == "ai-challenge-2026-copy2"


def test_clone_gives_409_when_every_candidate_is_taken(client, monkeypatch):
    """Hết ứng viên sau số lần thử có hạn → 409 SLUG_EXISTS, không lặp vô hạn."""
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    lookups = []

    async def always_taken(db, slug):
        lookups.append(slug)
        return {"slug": slug}

    monkeypatch.setattr(service, "find_competition_by_slug", always_taken)
    resp = client.post(f"/api/admin/competitions/{cid}/clone")
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "SLUG_EXISTS"
    assert 1 <= len(lookups) <= 10


def test_create_maps_duplicate_key_race_to_409(client, monkeypatch):
    """Hai request cùng slug cùng vượt bước kiểm tra trước → index unique chốt lại bằng 409."""
    _login(client)
    _insert_raw_competition(client, "ai-challenge-2026")
    monkeypatch.setattr(service, "find_competition_by_slug", _no_competition)

    resp = client.post("/api/admin/competitions", json=_body())
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "SLUG_EXISTS"


def test_admin_get_detail_by_id(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    resp = client.get(f"/api/admin/competitions/{cid}")
    assert resp.status_code == 200
    assert resp.json()["id"] == cid
    assert client.get("/api/admin/competitions/000000000000000000000000").status_code == 404


def test_edit_draft_changes_fields_but_not_slug_or_status(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    resp = client.patch(
        f"/api/admin/competitions/{cid}",
        json={"name": "AI Challenge 2026 - Vòng 1", "quota_per_day": 10, "slug": "other-slug", "status": "published"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "AI Challenge 2026 - Vòng 1"
    assert body["quota_per_day"] == 10
    assert body["slug"] == "ai-challenge-2026"  # slug immutable
    assert body["status"] == "draft"  # status chỉ đổi qua publish/close


def test_edit_published_cannot_change_primary_metric(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    assert publish_competition(client, cid).status_code == 200
    resp = client.patch(f"/api/admin/competitions/{cid}", json={"primary_metric": "precision"})
    assert resp.status_code == 422
    # field khác vẫn sửa được
    ok = client.patch(f"/api/admin/competitions/{cid}", json={"name": "Đã đổi tên"})
    assert ok.status_code == 200
    assert ok.json()["name"] == "Đã đổi tên"


def test_edit_single_date_compares_against_stored_value(client):
    """Regression: PATCH một đầu thời gian từng so aware (body) với naive (Mongo) → 500."""
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]

    ok = client.patch(f"/api/admin/competitions/{cid}", json={"end_at": "2026-12-01T00:00:00Z"})
    assert ok.status_code == 200
    assert ok.json()["end_at"] == "2026-12-01T00:00:00Z"

    # start_at mới nằm sau end_at đã lưu (naive trong Mongo) → phải là 422, không phải 500.
    bad = client.patch(f"/api/admin/competitions/{cid}", json={"start_at": "2027-01-01T00:00:00Z"})
    assert bad.status_code == 422
    assert bad.json()["error"]["code"] == "VALIDATION_ERROR"
    assert client.get(f"/api/admin/competitions/{cid}").json()["start_at"] == "2026-10-01T00:00:00Z"


def test_edit_published_validates_dates(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    assert publish_competition(client, cid).status_code == 200
    resp = client.patch(f"/api/admin/competitions/{cid}", json={"start_at": "2026-12-01T00:00:00Z", "end_at": "2026-11-01T00:00:00Z"})
    assert resp.status_code == 422


def test_edit_closed_rejected(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    assert publish_competition(client, cid).status_code == 200
    assert client.post(f"/api/admin/competitions/{cid}/close").status_code == 200
    resp = client.patch(f"/api/admin/competitions/{cid}", json={"name": "Sai"})
    assert resp.status_code == 422


def test_publish_close_reopen_transitions(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    # draft -> closed/reopen trực tiếp bị chặn (chưa từng publish)
    assert client.post(f"/api/admin/competitions/{cid}/close").status_code == 422
    assert client.post(f"/api/admin/competitions/{cid}/reopen").status_code == 422
    assert publish_competition(client, cid).status_code == 200
    assert client.get(f"/api/admin/competitions/{cid}").json()["status"] == "published"
    # published -> publish lại và reopen đều bị chặn
    assert client.post(f"/api/admin/competitions/{cid}/publish").status_code == 422
    assert client.post(f"/api/admin/competitions/{cid}/reopen").status_code == 422
    assert client.post(f"/api/admin/competitions/{cid}/close").status_code == 200
    assert client.get(f"/api/admin/competitions/{cid}").json()["status"] == "closed"
    # closed -> publish/close bị chặn, chỉ reopen đi được
    assert client.post(f"/api/admin/competitions/{cid}/publish").status_code == 422
    assert client.post(f"/api/admin/competitions/{cid}/close").status_code == 422
    reopened = client.post(f"/api/admin/competitions/{cid}/reopen")
    assert reopened.status_code == 200
    assert reopened.json()["status"] == "published"
    assert client.get(f"/api/admin/competitions/{cid}").json()["status"] == "published"
    # reopen lần hai khi đang published bị chặn
    assert client.post(f"/api/admin/competitions/{cid}/reopen").status_code == 422


def test_edit_allowed_again_after_reopen(client):
    """Reopen là hoàn tác việc đóng, nên quyền sửa phải quay lại - nhưng chỉ ở mức của published."""
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    assert publish_competition(client, cid).status_code == 200
    assert client.post(f"/api/admin/competitions/{cid}/close").status_code == 200
    assert client.patch(f"/api/admin/competitions/{cid}", json={"name": "Sai"}).status_code == 422

    assert client.post(f"/api/admin/competitions/{cid}/reopen").status_code == 200
    edited = client.patch(f"/api/admin/competitions/{cid}", json={"name": "Tên mới"})
    assert edited.status_code == 200
    assert edited.json()["name"] == "Tên mới"
    # Khoá primary_metric là của published, không phải của reopen - mở lại không gỡ được.
    assert client.patch(f"/api/admin/competitions/{cid}", json={"primary_metric": "recall"}).status_code == 422


def test_clone_copies_config_not_status_dates_submissions(client):
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body(quota_per_day=9)).json()["id"]
    assert publish_competition(client, cid).status_code == 200
    resp = client.post(f"/api/admin/competitions/{cid}/clone")
    assert resp.status_code == 201
    clone = resp.json()
    assert clone["id"] != cid
    assert clone["slug"] == "ai-challenge-2026-copy"
    assert clone["name"].startswith("AI Challenge 2026")
    assert clone["status"] == "draft"  # clone luôn draft
    assert clone["quota_per_day"] == 9
    # clone không copy submissions/memberships: chỉ cần khẳng định collection đếm đúng (rỗng)
    def count_docs():
        async def run():
            return await client.app.state.mongo.db[COMPETITIONS_COLLECTION].count_documents({})
        return asyncio.run(run())
    assert count_docs() == 2  # gốc + clone, không có bản ghi thứ ba


# ---------- Publish readiness ----------


def _draft(client, **overrides) -> str:
    response = client.post("/api/admin/competitions", json=_body(**overrides))
    assert response.status_code == 201
    return response.json()["id"]


def _ground_truth_file(data_dir, competition_id: str):
    return data_dir / "competitions" / competition_id / "private" / "ground_truth.csv"


def _publish_error(client, cid: str) -> dict:
    response = client.post(f"/api/admin/competitions/{cid}/publish")
    assert response.status_code == 422
    assert client.get(f"/api/admin/competitions/{cid}").json()["status"] == "draft"
    return response.json()["error"]


def test_publish_blocked_without_scoring_config(client):
    _login(client)
    cid = _draft(client)
    error = _publish_error(client, cid)
    assert error["code"] == "SCORING_CONFIG_REQUIRED"


def test_publish_blocked_without_ground_truth(client):
    _login(client)
    cid = _draft(client)
    assert client.put(
        f"/api/admin/competitions/{cid}/scoring", json=SCORING_CONFIG
    ).status_code == 200
    error = _publish_error(client, cid)
    assert error["code"] == "GROUND_TRUTH_REQUIRED"


def test_publish_blocked_when_ground_truth_file_is_missing(client, isolated_data_dir):
    """Publish từng cho qua khi chỉ kiểm tra is_file() - metadata còn nhưng file đã bị xoá."""
    _login(client)
    cid = _draft(client)
    configure_scoring(client, cid)
    _ground_truth_file(isolated_data_dir, cid).unlink()
    error = _publish_error(client, cid)
    assert error["code"] == "GROUND_TRUTH_INVALID"


def test_publish_blocked_when_ground_truth_cannot_be_parsed(client, isolated_data_dir):
    """File còn nhưng parse lại thất bại (binary cần đúng hai nhãn) → mọi bài nộp sẽ 422."""
    _login(client)
    cid = _draft(client)
    configure_scoring(client, cid)
    _ground_truth_file(isolated_data_dir, cid).write_bytes(b"id,label\n1,1\n2,1\n")
    error = _publish_error(client, cid)
    assert error["code"] == "GROUND_TRUTH_INVALID"


def test_join_code_requirement_wins_over_readiness(client):
    _login(client)
    cid = _draft(client, join_mode="code")
    assert _publish_error(client, cid)["code"] == "JOIN_CODE_REQUIRED"


def test_admin_detail_reports_join_code_blocker(client):
    """Banner phải thấy đúng cổng mà endpoint publish enforce, nếu không nút Publish bấm được rồi mới vỡ."""
    _login(client)
    cid = _draft(client, join_mode="code")
    blocked = client.get(f"/api/admin/competitions/{cid}").json()
    assert blocked["publish_ready"] is False
    assert blocked["publish_blocked_reason"]["code"] == "JOIN_CODE_REQUIRED"

    client.put(f"/api/admin/competitions/{cid}/join-code", json={"join_code": "secret-2026"})
    # Hết cổng mã tham gia thì rơi xuống cổng kế tiếp, không nhảy thẳng sang trạng thái sẵn sàng.
    assert (
        client.get(f"/api/admin/competitions/{cid}").json()["publish_blocked_reason"]["code"]
        == "SCORING_CONFIG_REQUIRED"
    )


def test_admin_detail_reports_publish_readiness(client):
    _login(client)
    cid = _draft(client)
    blocked = client.get(f"/api/admin/competitions/{cid}").json()
    assert blocked["publish_ready"] is False
    assert blocked["publish_blocked_reason"]["code"] == "SCORING_CONFIG_REQUIRED"

    configure_scoring(client, cid)
    ready = client.get(f"/api/admin/competitions/{cid}").json()
    assert ready["publish_ready"] is True
    assert ready["publish_blocked_reason"] is None


def test_admin_mutations_return_readiness_so_ui_state_stays_correct(client):
    """UI ghi thẳng response mutate vào state; thiếu readiness ở đây sẽ làm banner publish biến mất sai."""
    _login(client)
    created = client.post("/api/admin/competitions", json=_body()).json()
    assert created["publish_ready"] is False
    assert created["publish_blocked_reason"]["code"] == "SCORING_CONFIG_REQUIRED"

    cid = created["id"]
    edited = client.patch(f"/api/admin/competitions/{cid}", json={"name": "Tên mới"}).json()
    assert edited["publish_ready"] is False

    configure_scoring(client, cid)
    edited_ready = client.patch(f"/api/admin/competitions/{cid}", json={"name": "Tên khác"}).json()
    assert edited_ready["publish_ready"] is True
    assert edited_ready["publish_blocked_reason"] is None

    published = client.post(f"/api/admin/competitions/{cid}/publish")
    assert published.status_code == 200
    assert published.json()["publish_ready"] is True
    closed = client.post(f"/api/admin/competitions/{cid}/close")
    assert closed.status_code == 200
    assert closed.json()["publish_ready"] is True

    cloned = client.post(f"/api/admin/competitions/{cid}/clone").json()
    # Draft mới chưa có scoring config nên bị chặn đúng như một draft vừa tạo.
    assert cloned["publish_ready"] is False
    assert cloned["publish_blocked_reason"]["code"] == "SCORING_CONFIG_REQUIRED"


def test_admin_list_does_not_carry_readiness(client):
    """List không được đọc ground truth cho từng dòng - field chỉ có ở detail."""
    _login(client)
    _draft(client)
    rows = client.get("/api/admin/competitions").json()["competitions"]
    assert "publish_ready" not in rows[0]


def test_published_competition_accepts_a_real_submission(client):
    """Publish chỉ thành công khi đã chấm được - kiểm chứng bằng một bài nộp thật."""
    now = datetime.now(timezone.utc)
    _login(client)
    cid = _draft(
        client,
        start_at=(now - timedelta(days=1)).isoformat(),
        end_at=(now + timedelta(days=1)).isoformat(),
    )
    assert publish_competition(client, cid).status_code == 200

    _login_participant(client)
    assert client.post("/api/competitions/ai-challenge-2026/join", json={}).status_code == 200
    submitted = client.post(
        f"/api/competitions/{cid}/submissions",
        files={
            "file": ("answers.csv", b"id,prediction\n1,1\n2,0\n3,1\n4,0\n", "text/csv"),
            "notebook": ("solution.ipynb", VALID_NOTEBOOK, "application/x-ipynb+json"),
        },
    )
    assert submitted.status_code == 201
    assert submitted.json()["status"] == "completed"


def test_admin_detail_exposes_env_upload_limits(client, monkeypatch):
    """Trần upload là cấu hình môi trường - backend trả về để UI render hint thay vì hardcode."""
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    monkeypatch.setattr(
        "app.competitions.admin_router.get_settings",
        lambda: Settings(max_upload_mb=11, max_content_mb=7, max_asset_mb=9),
    )

    resp = client.get(f"/api/admin/competitions/{cid}")

    assert resp.status_code == 200
    assert resp.json()["upload_limits"] == {
        "submission_mb": 11,
        "notebook_mb": 20,
        "content_mb": 7,
        "asset_mb": 9,
    }


def test_admin_mutate_response_keeps_upload_limits(client, monkeypatch):
    """UI ghi thẳng response mutate vào state nên field này phải có ở mọi response detail."""
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    monkeypatch.setattr(
        "app.competitions.admin_router.get_settings",
        lambda: Settings(max_content_mb=5),
    )

    resp = client.patch(f"/api/admin/competitions/{cid}", json={"name": "Đổi tên"})

    assert resp.status_code == 200
    assert resp.json()["upload_limits"]["content_mb"] == 5


def test_upload_limits_only_on_admin_detail(client):
    """List admin và payload công khai cố ý không mang field detail-only này."""
    _login(client)
    cid = client.post("/api/admin/competitions", json=_body()).json()["id"]
    assert publish_competition(client, cid).status_code == 200

    listed = client.get("/api/admin/competitions").json()["competitions"][0]
    detail = client.get(f"/api/admin/competitions/{cid}").json()
    public = client.get("/api/competitions/ai-challenge-2026").json()

    assert "upload_limits" not in listed
    assert "upload_limits" not in public
    settings = get_settings()
    assert detail["upload_limits"] == {
        "submission_mb": settings.max_upload_mb,
        "notebook_mb": settings.max_notebook_mb,
        "content_mb": settings.max_content_mb,
        "asset_mb": settings.max_asset_mb,
    }
