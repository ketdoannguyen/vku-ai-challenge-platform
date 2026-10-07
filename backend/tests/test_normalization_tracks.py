"""Norm 0-100 theo nhánh: mặt bằng riêng từng track và một predicate quyền xem duy nhất.

Phụ lục Public/Private chốt: `can_view_norm = A ∧ N ∧ R ∧ L ∧ M` trên đúng nhánh đã resolve.
Nhóm này khóa phần norm của hợp đồng đó - snapshot ghi theo population của từng nhánh, norm live
và metadata BXH không trộn hai track, tắt master BXH sau công bố thì che lại, metric nguồn ẩn thì
che norm chứ không trả 0, và capability trên DTO thí sinh nói đúng lý do đang chặn.

Vật liệu dual dựng qua helper của `test_competition_tracks.py` để hai bộ test không lệch nhau về
cách publish; các test ở đó lo phần riêng tư chung (điểm/trạng thái), còn ở đây lo phần norm.
"""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from bson import ObjectId

from app.competitions import tracks as competition_tracks
from app.core.datetimes import iso_z
from app.leaderboard import service as leaderboard_service
from app.submissions.service import SUBMISSIONS_COLLECTION
from tests.helpers import (
    PARTICIPANT_CREDENTIALS,
    V2_GROUND_TRUTH,
    V2_SUBMISSION,
    attempt_status,
    login,
    login_participant,
    put_result_display,
    put_scoring_v2,
    run_worker,
    submission_documents,
    submit,
)
from tests.test_competition_tracks import (
    _release_private,
    create_dual_ok,
    dual_body,
    publish_dual_v1,
    publish_dual_v2,
    run_test,
    upload_gt,
)

BASE = datetime(2026, 10, 6, 8, tzinfo=timezone.utc)
# Dự đoán 1,0,1,0: f1 = 1.0 trên GT public của `publish_dual_v1`, f1 = 0.5 trên GT private.
HALF_PREDICTION = b"id,prediction\n1,1\n2,0\n3,1\n4,0\n"
BASELINE = 0.5

# Chỉ số nhỏ hơn là tốt hơn: predicate quyền xem và mặt bằng từng nhánh không được giả định chiều.
LOSS_CONTRACT = {
    "metrics": [{"key": "loss", "label": "Loss", "decimals": 4}],
    "primary_metric": "loss",
    "higher_is_better": False,
    "visible_metrics": None,
}


def _run(awaitable):
    return asyncio.run(awaitable)


def _db(client):
    return client.app.state.mongo.db


def _dual_norm(client, slug: str, *, baseline: float = BASELINE, enabled: bool = True) -> dict:
    """Cuộc thi dual v2 đã publish với norm cấu hình sẵn từ lúc tạo (config khóa sau publish)."""
    login(client)
    body = dual_body(slug=slug)
    # Baseline chỉ có nghĩa khi bật; tắt thì payload chỉ cần `enabled`.
    body["normalization"] = (
        {"enabled": True, "baseline": baseline} if enabled else {"enabled": False}
    )
    payload = create_dual_ok(client, body)
    publish_dual_v2(client, payload["id"], slug=slug)
    return payload


def _dual_norm_v1(client, slug: str, *, baseline: float) -> dict:
    """Cuộc thi dual v1 đã publish để kiểm đường chấm inline (khác đường queue của v2)."""
    login(client)
    body = dual_body(slug=slug)
    body["normalization"] = {"enabled": True, "baseline": baseline}
    payload = create_dual_ok(client, body)
    publish_dual_v1(client, payload["id"], slug=slug)
    login_participant(client)
    return payload


def _dual_norm_loss(client, fake_runner, slug: str, *, baseline: float) -> dict:
    """Cuộc thi dual v2 đã publish với hợp đồng loss (nhỏ hơn tốt hơn) và norm cấu hình sẵn."""
    # Bộ chấm giả phải trả đúng metric của hợp đồng ở cả hai lượt chạy thử xác minh.
    fake_runner.metrics = {"loss": 0.8}
    login(client)
    body = dual_body(slug=slug)
    body["normalization"] = {"enabled": True, "baseline": baseline}
    payload = create_dual_ok(client, body)
    cid = payload["id"]
    assert (
        put_scoring_v2(client, cid, expected_revision=0, output_contract=LOSS_CONTRACT).status_code
        == 200
    )
    assert (
        upload_gt(client, cid, V2_GROUND_TRUTH, track="public", expected_revision=1).status_code
        == 200
    )
    assert (
        upload_gt(client, cid, V2_GROUND_TRUTH, track="private", expected_revision=2).status_code
        == 200
    )
    for track in ("public", "private"):
        assert run_test(client, cid, track=track, expected_revision=3).status_code == 200
    published = client.post(f"/api/admin/competitions/{cid}/publish")
    assert published.status_code == 200, published.text
    login_participant(client)
    assert client.post(f"/api/competitions/{slug}/join", json={}).status_code == 200
    return payload


def _score(client, fake_runner, competition_id: str, track: str, value: float) -> str:
    """Nộp một bài v2 qua worker thật với raw do runner giả trả; trả về id lượt (= id bài nộp)."""
    fake_runner.metrics = {"accuracy": value, "n_items": 4.0}
    posted = submit(client, competition_id, V2_SUBMISSION, track=track)
    assert posted.status_code == 202, posted.text
    attempt_id = posted.json()["attempt_id"]
    assert run_worker(client) == 1
    return attempt_id


def _stored(client, submission_id) -> dict:
    documents = submission_documents(client, {"_id": ObjectId(submission_id)})
    assert len(documents) == 1
    return documents[0]


def _snapshot(client, submission_id) -> dict:
    return _stored(client, submission_id)["normalization_snapshot"]


def _inserted(
    client,
    competition_id: str,
    account_id: ObjectId,
    score: float,
    *,
    track: str,
    minutes: int,
    metrics: dict | None = None,
) -> ObjectId:
    """Bài eligible ghi thẳng vào Mongo: dựng mặt bằng điểm một nhánh mà không cần chấm thật."""
    submission_id = ObjectId()
    _run(
        _db(client)[SUBMISSIONS_COLLECTION].insert_one(
            {
                "_id": submission_id,
                "competition_id": ObjectId(competition_id),
                "account_id": account_id,
                "status": "completed",
                "track": track,
                "created_at": BASE + timedelta(minutes=minutes),
                "metrics": metrics if metrics is not None else {"accuracy": score, "n_items": 4.0},
                "primary_score": score,
            }
        )
    )
    return submission_id


def _account(client, name: str, email: str) -> ObjectId:
    """Account thật trong DB để bảng xếp hạng gắn đúng tên hiển thị cho bài ghi thẳng."""
    account_id = ObjectId()
    _run(
        _db(client)["accounts"].insert_one(
            {
                "_id": account_id,
                "email": email,
                "name": name,
                "password_hash": "unused-in-track-tests",
                "role": "participant",
                "active": True,
                "created_at": BASE,
                "updated_at": BASE,
            }
        )
    )
    return account_id


def _touch(client, competition_id: str) -> None:
    """Bỏ cache BXH sau khi test ghi thẳng Mongo; đường API thật tự làm việc này khi bài đổi."""
    leaderboard_service.invalidate_competition(ObjectId(competition_id))


def _review(client, submission_id, status: str) -> None:
    login(client)
    body = {"status": status}
    if status == "rejected":
        body["note"] = "Lý do kiểm thử"
    response = client.patch(f"/api/admin/submissions/{submission_id}/review", json=body)
    assert response.status_code == 200, response.text


def _board(client, competition_id: str, track: str, **params) -> dict:
    login_participant(client)
    response = client.get(
        f"/api/competitions/{competition_id}/leaderboard", params={"track": track, **params}
    )
    assert response.status_code == 200, response.text
    return response.json()


def _hidden_board(client, competition_id: str, track: str) -> dict:
    login_participant(client)
    response = client.get(
        f"/api/competitions/{competition_id}/leaderboard", params={"track": track}
    )
    assert response.status_code == 403
    return response.json()["error"]


def _history(client, competition_id: str, **params) -> list[dict]:
    login_participant(client)
    response = client.get(
        f"/api/competitions/{competition_id}/submissions/me", params=params
    )
    assert response.status_code == 200, response.text
    return response.json()["submissions"]


def _tracks(client, slug: str) -> dict:
    login_participant(client)
    response = client.get(f"/api/competitions/{slug}")
    assert response.status_code == 200, response.text
    return response.json()["tracks"]


def _card(client, competition_id: str) -> dict:
    login_participant(client)
    listing = client.get("/api/competitions").json()["competitions"]
    return next(card for card in listing if card["id"] == competition_id)


def _set_master(client, competition_id: str, visible: bool) -> None:
    login(client)
    response = client.patch(
        f"/api/admin/competitions/{competition_id}", json={"leaderboard_visible": visible}
    )
    assert response.status_code == 200, response.text
    login_participant(client)


def _revision(client, competition_id: str) -> int:
    login(client)
    response = client.get(f"/api/admin/competitions/{competition_id}/scoring")
    assert response.status_code == 200, response.text
    return response.json()["scoring"]["revision"]


def _dual_doc(*, normalization: dict, leaderboard_visible: bool = True, private_released: bool = False, primary_metric="f1", window: dict | None = None) -> dict:
    """Document dual tối thiểu đủ cho predicate: mode, lịch nhánh, config norm, master BXH, release.

    Cửa sổ mặc định đóng hẳn để phép thử chỉ xoay quanh N/R/L/M; test khóa nhánh truyền `window`
    với giờ mở ở tương lai.
    """
    track_window = window or {"start_at": BASE - timedelta(days=1), "end_at": BASE}
    return {
        "mode": "public_private",
        "normalization": normalization,
        "leaderboard_visible": leaderboard_visible,
        "primary_metric": primary_metric,
        "tracks": {
            "public": dict(track_window),
            "private": {
                **track_window,
                "results_published_at": BASE if private_released else None,
            },
        },
    }


def test_predicate_norm_tra_tung_conjunct_va_thu_tu_ly_do():
    """`can_view_norm` là chỗ duy nhất trả lời: N rồi W rồi R rồi L rồi M, kèm đúng lý do."""
    enabled = {"enabled": True, "baseline": 0.5}
    assert competition_tracks.can_view_norm(_dual_doc(normalization=enabled), "public") == (
        True,
        None,
    )
    # R: release là chuyện của từng nhánh - Public mở, Private còn chờ.
    assert competition_tracks.can_view_norm(_dual_doc(normalization=enabled), "private") == (
        False,
        "private_unpublished",
    )
    released = _dual_doc(normalization=enabled, private_released=True)
    assert competition_tracks.can_view_norm(released, "private") == (True, None)
    # W: nhánh chưa tới giờ mở đứng trước cả R: dời lịch về sau khóa luôn nhánh đã công bố.
    future = datetime.now(timezone.utc) + timedelta(hours=2)
    scheduled = {"start_at": future, "end_at": future + timedelta(hours=2)}
    assert competition_tracks.can_view_norm(
        _dual_doc(normalization=enabled, window=scheduled), "public"
    ) == (False, "track_not_open")
    assert competition_tracks.can_view_norm(
        _dual_doc(normalization=enabled, private_released=True, window=scheduled), "private"
    ) == (False, "track_not_open")
    # L: master tắt, và R đứng trước L khi cả hai cùng chặn.
    assert competition_tracks.can_view_norm(
        {**released, "leaderboard_visible": False}, "private"
    ) == (False, "leaderboard_hidden")
    assert competition_tracks.can_view_norm(
        {**_dual_doc(normalization=enabled), "leaderboard_visible": False}, "private"
    ) == (False, "private_unpublished")
    # M: metric nguồn bị ẩn khỏi thí sinh.
    assert competition_tracks.can_view_norm(
        {**released, "primary_metric": None}, "private"
    ) == (False, "source_metric_hidden")
    # N: chưa bật chuẩn hóa thì không có gì để xem.
    assert competition_tracks.can_view_norm(_dual_doc(normalization={"enabled": False}), "public") == (
        False,
        "normalization_disabled",
    )


def test_snapshot_norm_dung_mat_bang_rieng_tung_nhanh(client, fake_runner):
    """Cùng raw 0,60 nhưng snapshot mỗi nhánh chốt theo best của chính nhánh đó.

    Public best 0,90 và Private best 0,70 với baseline chung 0,50: hai snapshot phải là 25,00 và
    50,00. Nếu mẫu số bị dùng chung, con số của Private đã là 25,00 - đúng thứ phụ lục cấm.
    """
    competition = _dual_norm(client, "norm-track-snapshot")
    cid = competition["id"]

    first_public = _score(client, fake_runner, cid, "public", 0.90)
    first_private = _score(client, fake_runner, cid, "private", 0.70)
    # Bài đầu của mỗi nhánh lấy chính mình làm mẫu số: chạm trần 100 mà không mượn best nhánh kia.
    assert _snapshot(client, first_public)["reference_best"] == 0.90
    assert _snapshot(client, first_public)["score"] == pytest.approx(100.0)
    assert _snapshot(client, first_private)["reference_best"] == 0.70
    assert _snapshot(client, first_private)["score"] == pytest.approx(100.0)

    public_half = _score(client, fake_runner, cid, "public", 0.60)
    private_half = _score(client, fake_runner, cid, "private", 0.60)
    assert _snapshot(client, public_half)["reference_best"] == 0.90
    assert _snapshot(client, public_half)["score"] == pytest.approx(25.0)
    assert _snapshot(client, private_half)["reference_best"] == 0.70
    assert _snapshot(client, private_half)["score"] == pytest.approx(50.0)

    # Private chưa công bố: 50,00 nằm trong DB nhưng không rời backend ở lần poll.
    polled = attempt_status(client, cid, private_half)["submission"]
    assert polled["result_visibility"] == "hidden"
    assert "normalization_snapshot" not in polled

    # Cùng câu trả lời trên history và thẻ cuộc thi: chưa công bố thì Private không mang norm.
    hidden_item = _history(client, cid, track="private")[0]
    assert hidden_item["result_visibility"] == "hidden"
    assert "normalization_snapshot" not in hidden_item
    assert _card(client, cid)["my_stats_by_track"]["private"]["best_normalized_score"] is None
    # Trong khi đó Public đã công bố: snapshot 25,00 của chính thí sinh vẫn hiện đủ.
    public_half_item = next(
        item
        for item in _history(client, cid, track="public")
        if item["primary_score"] == pytest.approx(0.60)
    )
    assert public_half_item["normalization_snapshot"]["score"] == pytest.approx(25.0)


def test_bxh_norm_moi_nhanh_khong_doi_cheo_va_snapshot_khong_bi_viet_lai(client, fake_runner):
    """BXH Private đi theo population Private; thêm/reject/restore bài Public không đụng tới nó.

    Đồng thời khóa tính bất biến của snapshot: norm live đổi theo mặt bằng mới, còn con số lịch
    sử ghi lúc chấm giữ nguyên.
    """
    competition = _dual_norm(client, "norm-track-board")
    cid = competition["id"]
    # Mặt bằng Private ban đầu là 0,70 của đội khác - đủ để snapshot của bài 0,60 ghi ở mốc 50,00.
    _inserted(client, cid, ObjectId(), 0.70, track="private", minutes=10)
    _score(client, fake_runner, cid, "public", 0.80)
    private_half = _score(client, fake_runner, cid, "private", 0.60)
    _release_private(client, cid)
    before = _snapshot(client, private_half)
    assert before["reference_best"] == 0.70
    assert before["score"] == pytest.approx(50.0)
    before_public = _board(client, cid, "public")

    # Bài Private raw 0,90 vào bảng: mặt bằng Private đổi nên norm live của 0,60 thành 25,00;
    # cùng lúc đó Public phải đứng yên từng entry - hai population không trộn.
    _inserted(client, cid, ObjectId(), 0.90, track="private", minutes=11)
    _touch(client, cid)
    private_board = _board(client, cid, "private")
    assert private_board["normalization"]["reference_best"] == 0.90
    assert sorted(entry["primary_score"] for entry in private_board["entries"]) == [
        0.60,
        0.70,
        0.90,
    ]
    norms = {
        entry["primary_score"]: entry["normalized_score"] for entry in private_board["entries"]
    }
    assert norms[0.90] == pytest.approx(100.0)
    assert norms[0.70] == pytest.approx(50.0)  # 100 × (0,70 − 0,50) ÷ (0,90 − 0,50)
    assert norms[0.60] == pytest.approx(25.0)  # 100 × (0,60 − 0,50) ÷ (0,90 − 0,50)
    assert _board(client, cid, "public")["entries"] == before_public["entries"]

    # Thêm rồi từ chối bài tốt nhất Public: chỉ mặt bằng Public đổi, các con số Private đứng yên.
    public_best = _inserted(client, cid, ObjectId(), 0.97, track="public", minutes=12)
    _touch(client, cid)
    assert _board(client, cid, "public")["normalization"]["reference_best"] == 0.97
    _review(client, public_best, "rejected")
    public_board = _board(client, cid, "public")
    assert public_board["normalization"]["reference_best"] == 0.80
    assert public_board["entries"] == before_public["entries"]
    private_board = _board(client, cid, "private")
    assert private_board["normalization"]["reference_best"] == 0.90
    assert {
        entry["primary_score"]: entry["normalized_score"] for entry in private_board["entries"]
    }[0.60] == pytest.approx(25.0)
    _review(client, public_best, "accepted")
    assert _board(client, cid, "public")["normalization"]["reference_best"] == 0.97

    # Mặt bằng Private đã thành 0,90 nhưng snapshot 50,00 không bị viết lại.
    assert _snapshot(client, private_half) == before


def test_master_bxh_tat_sau_cong_bo_che_lai_norm_roi_bat_lai_thi_hien_lai(client, fake_runner):
    """Quyền xem norm suy từ state hiện tại: tắt master là che, bật lại là hiện, dữ liệu giữ nguyên.

    Điểm gốc của bài đã công bố vẫn hiện khi master tắt (§4.4) - chỉ dữ liệu dẫn xuất bị che.
    """
    competition = _dual_norm(client, "norm-master-toggle")
    cid = competition["id"]
    attempt_id = _score(client, fake_runner, cid, "private", 0.70)
    _release_private(client, cid)

    visible = _history(client, cid)[0]["normalization_snapshot"]
    assert set(visible) == {"score", "calculated_at"}
    assert _board(client, cid, "private")["me"]["normalized_score"] == pytest.approx(100.0)
    assert _tracks(client, "norm-master-toggle")["private"]["normalization_visible"] is True

    _set_master(client, cid, False)
    item = _history(client, cid)[0]
    assert item["primary_score"] == 0.70
    assert "normalization_snapshot" not in item
    tracks = _tracks(client, "norm-master-toggle")
    assert tracks["private"]["normalization_visible"] is False
    assert tracks["private"]["normalization_hidden_reason"] == "leaderboard_hidden"
    # Công bố là một chiều: tắt BXH không rút lại release marker.
    assert tracks["private"]["results_released"] is True
    assert _card(client, cid)["my_stats_by_track"]["private"]["best_normalized_score"] is None
    assert _hidden_board(client, cid, "private")["code"] == "LEADERBOARD_HIDDEN"
    # Che lúc đọc không phải xóa dữ liệu: bản ghi và snapshot trong DB còn nguyên.
    assert _snapshot(client, attempt_id)["score"] == pytest.approx(100.0)

    _set_master(client, cid, True)
    assert _history(client, cid)[0]["normalization_snapshot"] == visible
    tracks = _tracks(client, "norm-master-toggle")
    assert tracks["private"]["normalization_visible"] is True
    # Bật lại không đụng dấu công bố một chiều, và BXH trả lại đúng norm của chính thí sinh.
    assert tracks["private"]["results_released"] is True
    assert _board(client, cid, "private")["me"]["normalized_score"] == pytest.approx(100.0)


def test_an_metric_nguon_thi_norm_bi_che_chu_khong_ve_0(client, fake_runner):
    """Metric nguồn bị ẩn: BXH vẫn mở nhưng mọi giá trị norm là null/thiếu, không phải 0."""
    competition = _dual_norm(client, "norm-metric-hidden")
    cid = competition["id"]
    attempt_id = _score(client, fake_runner, cid, "private", 0.70)
    _release_private(client, cid)
    assert _history(client, cid)[0]["normalization_snapshot"] is not None
    # Cache BXH đã ấm với norm đang hiện trước khi cấu hình hiển thị điểm bị đổi.
    warm = _board(client, cid, "private")
    assert warm["normalization"]["reference_best"] == 0.70
    assert warm["entries"][0]["normalized_score"] == pytest.approx(100.0)

    saved = put_result_display(
        client,
        cid,
        expected_revision=_revision(client, cid),
        metrics=[
            {"key": "accuracy", "label": "Accuracy", "decimals": 4},
            {"key": "n_items", "label": "Số mẫu", "decimals": 0},
        ],
        visible_metrics=["n_items"],
    )
    assert saved.status_code == 200, saved.text

    item = _history(client, cid)[0]
    assert item["primary_score"] is None
    assert "normalization_snapshot" not in item
    board = _board(client, cid, "private")
    # Metadata kết quả rỗng hẳn: không giữ `reference_best` cho thí sinh.
    assert board["normalization"] is None
    assert board["entries"][0]["normalized_score"] is None
    assert board["me"]["normalized_score"] is None
    tracks = _tracks(client, "norm-metric-hidden")
    assert tracks["private"]["normalization_hidden_reason"] == "source_metric_hidden"
    assert _card(client, cid)["my_stats_by_track"]["private"]["best_normalized_score"] is None
    # Storage vẫn đủ cho admin hậu kiểm và vận hành.
    assert _snapshot(client, attempt_id)["score"] == pytest.approx(100.0)
    login(client)
    admin_board = client.get(
        f"/api/admin/competitions/{cid}/leaderboard", params={"track": "private"}
    ).json()
    assert admin_board["normalization"]["reference_best"] == 0.70
    # Admin đi qua đúng route thí sinh vẫn nhận projection thí sinh: capability không theo vai trò.
    admin_view = client.get(
        f"/api/competitions/{cid}/leaderboard", params={"track": "private"}
    )
    assert admin_view.status_code == 200, admin_view.text
    admin_payload = admin_view.json()
    assert admin_payload["normalization"] is None
    assert admin_payload["entries"][0]["normalized_score"] is None


def test_capability_norm_noi_dung_ly_do_va_khong_ro_ri_cho_nguoi_ngoai(client, fake_runner):
    """Capability theo nhánh trả lý do đang chặn; người không có quyền đọc không nhận capability."""
    competition = _dual_norm(client, "norm-capability")
    cid = competition["id"]

    tracks = _tracks(client, "norm-capability")
    assert tracks["public"]["normalization_visible"] is True
    assert tracks["public"]["normalization_hidden_reason"] is None
    assert tracks["private"]["normalization_visible"] is False
    assert tracks["private"]["normalization_hidden_reason"] == "private_unpublished"

    # Công bố trong khi master tắt: release marker cập nhật nhưng norm vẫn chưa được xem.
    _set_master(client, cid, False)
    _release_private(client, cid)
    tracks = _tracks(client, "norm-capability")
    assert tracks["private"]["results_released"] is True
    assert tracks["private"]["normalization_visible"] is False
    assert tracks["private"]["normalization_hidden_reason"] == "leaderboard_hidden"
    assert tracks["public"]["normalization_hidden_reason"] == "leaderboard_hidden"
    # BXH đang ẩn thì đọc thẳng cũng bị chặn; bật lại master là hiện ngay nhờ dấu công bố cũ.
    assert _hidden_board(client, cid, "private")["code"] == "LEADERBOARD_HIDDEN"
    _set_master(client, cid, True)
    assert _tracks(client, "norm-capability")["private"]["normalization_visible"] is True
    assert _board(client, cid, "private")["normalization"] is not None

    # Khách không có quyền đọc: vẫn thấy lịch nhánh, nhưng không nhận capability norm nào.
    client.cookies.clear()
    guest = client.get("/api/competitions/norm-capability").json()
    assert guest["tracks"]["private"]["results_released"] is True
    assert "normalization_visible" not in guest["tracks"]["private"]
    assert "normalization_hidden_reason" not in guest["tracks"]["private"]


def test_norm_tat_thi_khong_co_field_gia_va_capability_noi_dung(client, fake_runner):
    """Cuộc thi tắt norm: không snapshot, không metadata, không khoá `normalized_score`."""
    competition = _dual_norm(client, "norm-off", enabled=False)
    cid = competition["id"]
    _score(client, fake_runner, cid, "private", 0.70)
    _release_private(client, cid)

    item = _history(client, cid)[0]
    assert item["primary_score"] == 0.70  # tắt norm không đụng tới raw
    assert "normalization_snapshot" not in item
    board = _board(client, cid, "private")
    assert "normalization" not in board
    assert "normalized_score" not in board["entries"][0]
    tracks = _tracks(client, "norm-off")
    for track in ("public", "private"):
        assert tracks[track]["normalization_visible"] is False
        assert tracks[track]["normalization_hidden_reason"] == "normalization_disabled"
    assert _card(client, cid)["my_stats_by_track"]["private"]["best_normalized_score"] is None


def test_snapshot_duong_inline_v1_dung_nhanh_va_chi_hien_sau_cong_bo(client):
    """Đường chấm inline của dual cũng lọc theo nhánh: bài Private không lấy best Public làm mẫu số."""
    competition = _dual_norm_v1(client, "norm-inline-v1", baseline=0.4)
    cid = competition["id"]
    # Một đối thủ Public rất cao: nếu caller không truyền track, snapshot Private sẽ bám con số này.
    _inserted(client, cid, ObjectId(), 0.99, track="public", minutes=5)

    submitted = submit(client, cid, HALF_PREDICTION, track="private")
    assert submitted.status_code == 201, submitted.text
    response = submitted.json()
    assert response["result_visibility"] == "hidden"
    assert "normalization_snapshot" not in response

    stored = _stored(client, response["id"])
    raw = stored["primary_score"]
    snapshot = stored["normalization_snapshot"]
    assert raw > 0.4  # vượt baseline nên mặt bằng của chính nhánh phải cho trần 100
    assert snapshot["reference_best"] == raw
    assert snapshot["score"] == pytest.approx(100.0)

    _release_private(client, cid)
    item = _history(client, cid)[0]
    assert item["result_visibility"] == "visible"
    assert set(item["normalization_snapshot"]) == {"score", "calculated_at"}
    assert item["normalization_snapshot"]["score"] == pytest.approx(100.0)


def test_bang_rong_khong_muon_best_nhanh_kia(client, fake_runner):
    """Nhánh trống: Private không có bài thì bảng rỗng và mẫu số là None, không mượn best Public."""
    competition = _dual_norm(client, "norm-empty-track")
    cid = competition["id"]
    first = _account(client, "Đội Public", "doi-public@example.com")
    second = _account(client, "Đội Public Hai", "doi-public-hai@example.com")
    _inserted(client, cid, first, 0.90, track="public", minutes=0)
    _inserted(client, cid, second, 0.80, track="public", minutes=1)
    _release_private(client, cid)

    private_board = _board(client, cid, "private")
    assert private_board["entries"] == []
    assert private_board["total"] == 0
    assert private_board["me"] is None
    # Mẫu số của nhánh trống là None; nếu mượn best Public thì con số đã là 0,90.
    assert private_board["normalization"]["reference_best"] is None

    public_board = _board(client, cid, "public")
    assert public_board["normalization"]["reference_best"] == 0.90
    assert [entry["display_name"] for entry in public_board["entries"]] == [
        "Đội Public",
        "Đội Public Hai",
    ]
    assert [entry["normalized_score"] for entry in public_board["entries"]] == [
        pytest.approx(100.0),
        pytest.approx(100 * 0.3 / 0.4),
    ]


def test_nhom_toan_0_mot_nhanh_xep_theo_gio_va_giu_dai_dien(client, fake_runner):
    """Cả nhóm Private dưới baseline: norm 0, xếp theo giờ nộp, đại diện là bài 0 sớm nhất.

    Không raw tie-break, và nhóm 0 của nhánh này không rò sang nhánh kia.
    """
    competition = _dual_norm(client, "norm-zero-track", baseline=0.6)
    cid = competition["id"]
    participant = _run(_db(client)["accounts"].find_one({"email": PARTICIPANT_CREDENTIALS[0]}))
    rival = _account(client, "Đội Nhì", "doi-nhi@example.com")
    early = _inserted(client, cid, participant["_id"], 0.20, track="private", minutes=0)
    _inserted(client, cid, participant["_id"], 0.59, track="private", minutes=10)
    _inserted(client, cid, rival, 0.50, track="private", minutes=5)
    _release_private(client, cid)

    board = _board(client, cid, "private")
    assert [entry["display_name"] for entry in board["entries"]] == ["Thí Sinh", "Đội Nhì"]
    assert [entry["normalized_score"] for entry in board["entries"]] == [0.0, 0.0]
    first = board["entries"][0]
    # Không lấy raw tốt nhất của đội làm đại diện: bài 0 nộp sớm nhất mới là gói đại diện.
    assert first["primary_score"] == 0.20
    assert first["best_submission_id"] == str(early)
    assert first["best_submission_at"] == iso_z(BASE)
    assert first["total_submissions"] == 2
    assert first["metrics"] == {"accuracy": 0.20, "n_items": 4.0}
    # Mẫu số là best thực của nhánh (0,59), không suy từ các bài đang hiển thị.
    assert board["normalization"]["reference_best"] == 0.59
    assert board["me"]["is_current_user"] is True
    assert board["me"]["best_submission_id"] == str(early)

    # Public không có bài nào nên cũng không có nhóm 0 nào để xếp - nhóm 0 không rò qua nhánh.
    public_board = _board(client, cid, "public")
    assert public_board["entries"] == []
    assert public_board["normalization"]["reference_best"] is None


def test_best_nam_ngoai_trang_van_la_mau_so_toan_nhanh(client, fake_runner):
    """Best của nhánh nằm ngoài trang vẫn là mẫu số: BXH không tính lại từ đúng trang đang trả."""
    competition = _dual_norm(client, "norm-page-track")
    cid = competition["id"]
    top = _account(client, "Đội Nhất", "doi-nhat@example.com")
    middle = _account(client, "Đội Giữa", "doi-giua@example.com")
    bottom = _account(client, "Đội Ba", "doi-ba@example.com")
    _inserted(client, cid, top, 0.90, track="private", minutes=0)
    _inserted(client, cid, middle, 0.70, track="private", minutes=1)
    _inserted(client, cid, bottom, 0.60, track="private", minutes=2)
    _release_private(client, cid)

    page = _board(client, cid, "private", limit=1, offset=1)
    assert page["total"] == 3
    assert page["has_more"] is True
    assert [entry["rank"] for entry in page["entries"]] == [2]
    assert page["entries"][0]["display_name"] == "Đội Giữa"
    # Mẫu số vẫn là best toàn nhánh (0,90) dù bài đó không nằm trong trang.
    assert page["normalization"]["reference_best"] == 0.90
    assert page["entries"][0]["normalized_score"] == pytest.approx(50.0)
    assert page["me"] is None


def test_immediate_khong_vuot_master_bxh(client, fake_runner):
    """Chính sách hiện ngay chỉ bỏ cổng công bố, không bỏ cổng master BXH hay metric nguồn."""
    login(client)
    body = dual_body(slug="norm-immediate", result_policy="immediate")
    body["normalization"] = {"enabled": True, "baseline": BASELINE}
    competition = create_dual_ok(client, body)
    cid = competition["id"]
    publish_dual_v2(client, cid, slug="norm-immediate")
    _score(client, fake_runner, cid, "private", 0.70)

    # Hiện ngay: dấu mốc công bố ghi trong lượt publish nên norm của Private đủ điều kiện ngay.
    tracks = _tracks(client, "norm-immediate")
    assert tracks["private"]["results_released"] is True
    assert tracks["private"]["normalization_visible"] is True
    item = _history(client, cid, track="private")[0]
    assert item["normalization_snapshot"]["score"] == pytest.approx(100.0)

    # Master BXH tắt là cổng độc lập: release có sẵn vẫn không đủ để norm rời backend.
    _set_master(client, cid, False)
    tracks = _tracks(client, "norm-immediate")
    assert tracks["private"]["results_released"] is True
    assert tracks["private"]["normalization_visible"] is False
    assert tracks["private"]["normalization_hidden_reason"] == "leaderboard_hidden"
    hidden_item = _history(client, cid, track="private")[0]
    assert hidden_item["primary_score"] == 0.70
    assert "normalization_snapshot" not in hidden_item
    assert _hidden_board(client, cid, "private")["code"] == "LEADERBOARD_HIDDEN"

    _set_master(client, cid, True)
    assert _board(client, cid, "private")["normalization"]["reference_best"] == 0.70
    assert _history(client, cid, track="private")[0]["normalization_snapshot"][
        "score"
    ] == pytest.approx(100.0)


def test_metric_lower_is_better_giu_mat_bang_rieng_tung_nhanh(client, fake_runner):
    """Chiều nhỏ-hơn-tốt-hơn: mẫu số là min của từng nhánh, hai nhánh không dùng chung mặt bằng."""
    competition = _dual_norm_loss(client, fake_runner, "norm-loss-track", baseline=100.0)
    cid = competition["id"]
    public_top = _account(client, "Đội Loss 60", "doi-loss-60@example.com")
    public_high = _account(client, "Đội Loss 90", "doi-loss-90@example.com")
    private_top = _account(client, "Đội Loss 80", "doi-loss-80@example.com")
    private_high = _account(client, "Đội Loss 90 dự bị", "doi-loss-90b@example.com")
    _inserted(client, cid, public_top, 60.0, track="public", minutes=0, metrics={"loss": 60.0})
    _inserted(client, cid, public_high, 90.0, track="public", minutes=1, metrics={"loss": 90.0})
    _inserted(client, cid, private_top, 80.0, track="private", minutes=2, metrics={"loss": 80.0})
    _inserted(client, cid, private_high, 90.0, track="private", minutes=3, metrics={"loss": 90.0})
    _release_private(client, cid)

    public_board = _board(client, cid, "public")
    assert public_board["normalization"]["source_metric"] == "loss"
    assert public_board["normalization"]["higher_is_better"] is False
    assert public_board["normalization"]["reference_best"] == 60.0
    assert [entry["primary_score"] for entry in public_board["entries"]] == [60.0, 90.0]
    public_norms = {
        entry["primary_score"]: entry["normalized_score"] for entry in public_board["entries"]
    }
    assert public_norms[60.0] == pytest.approx(100.0)
    assert public_norms[90.0] == pytest.approx(25.0)  # 100 × (100 − 90) ÷ (100 − 60)

    private_board = _board(client, cid, "private")
    assert private_board["normalization"]["reference_best"] == 80.0
    assert [entry["primary_score"] for entry in private_board["entries"]] == [80.0, 90.0]
    private_norms = {
        entry["primary_score"]: entry["normalized_score"] for entry in private_board["entries"]
    }
    assert private_norms[80.0] == pytest.approx(100.0)
    assert private_norms[90.0] == pytest.approx(50.0)  # 100 × (100 − 90) ÷ (100 − 80)
