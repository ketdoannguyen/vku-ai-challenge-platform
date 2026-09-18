"""Helper dùng chung cho test: đưa một cuộc thi draft tới trạng thái publish được."""

SCORING_CONFIG = {
    "id_column": "id",
    "prediction_column": "prediction",
    "label_column": "label",
    "average": "binary",
    "pos_label": "1",
    "higher_is_better": True,
}

GROUND_TRUTH_CSV = b"id,label\n1,1\n2,0\n3,1\n4,0\n"


def configure_scoring(client, competition_id: str, *, ground_truth: bytes = GROUND_TRUTH_CSV) -> dict:
    """Lưu cấu hình chấm điểm rồi upload ground truth; trả về payload scoring status."""
    configured = client.put(
        f"/api/admin/competitions/{competition_id}/scoring", json=SCORING_CONFIG
    )
    assert configured.status_code == 200, configured.text
    uploaded = client.put(
        f"/api/admin/competitions/{competition_id}/ground-truth",
        files={"file": ("ground_truth.csv", ground_truth, "text/csv")},
    )
    assert uploaded.status_code == 200, uploaded.text
    return uploaded.json()


def publish_competition(client, competition_id: str, *, ground_truth: bytes = GROUND_TRUTH_CSV):
    """Publish kèm cấu hình chấm điểm + ground truth - publish có readiness gate."""
    configure_scoring(client, competition_id, ground_truth=ground_truth)
    return client.post(f"/api/admin/competitions/{competition_id}/publish")
