"""Helper dùng chung cho test: đưa một cuộc thi draft tới trạng thái publish được."""

import asyncio
import json
from datetime import datetime, timedelta, timezone

from app.accounts.service import ACCOUNTS_COLLECTION
from app.submissions.service import SUBMISSIONS_COLLECTION

ADMIN_CREDENTIALS = ("admin@vku.vn", "adminmatkhau1")
PARTICIPANT_CREDENTIALS = ("thi.sinh@vku.vn", "thisinhmatkhau1")

SCORING_CONFIG = {
    "id_column": "id",
    "prediction_column": "prediction",
    "label_column": "label",
    "average": "binary",
    "pos_label": "1",
    "higher_is_better": True,
}

GROUND_TRUTH_CSV = b"id,label\n1,1\n2,0\n3,1\n4,0\n"

# Bộ nhãn riêng cho test nộp bài: dự đoán 1,0,1,0 chỉ đạt f1 0.5 nên bắt được lỗi tính điểm.
SUBMISSION_GROUND_TRUTH = b"id,label\n1,1\n2,1\n3,0\n4,0\n"


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


def login(client, email: str = ADMIN_CREDENTIALS[0], password: str = ADMIN_CREDENTIALS[1]) -> None:
    response = client.post("/api/auth/login", json={"identifier": email, "password": password})
    assert response.status_code == 200


def login_participant(client) -> None:
    login(client, *PARTICIPANT_CREDENTIALS)


def notebook_bytes(*, nbformat: int = 4, cells=None) -> bytes:
    return json.dumps(
        {
            "nbformat": nbformat,
            "nbformat_minor": 5,
            "metadata": {},
            "cells": (
                cells
                if cells is not None
                else [{"cell_type": "code", "source": ["print('hi')\n"]}]
            ),
        }
    ).encode()


VALID_NOTEBOOK = notebook_bytes()


def ready_competition(
    client,
    slug: str = "submission-cup",
    quota: int = 5,
    ground_truth: bytes = SUBMISSION_GROUND_TRUTH,
) -> dict:
    """Cuộc thi đã publish, đã cấu hình chấm điểm và participant đã join."""
    now = datetime.now(timezone.utc)
    login(client)
    created = client.post(
        "/api/admin/competitions",
        json={
            "slug": slug,
            "name": slug,
            "start_at": (now - timedelta(days=1)).isoformat(),
            "end_at": (now + timedelta(days=1)).isoformat(),
            "primary_metric": "f1",
            "quota_per_day": quota,
        },
    )
    assert created.status_code == 201
    competition = created.json()
    assert publish_competition(
        client, competition["id"], ground_truth=ground_truth
    ).status_code == 200
    login_participant(client)
    assert client.post(f"/api/competitions/{slug}/join", json={}).status_code == 200
    return competition


def submit(
    client,
    competition_id: str,
    data: bytes,
    filename: str = "answers.csv",
    notebook: bytes | None = VALID_NOTEBOOK,
    notebook_filename: str = "solution.ipynb",
):
    """Nộp bài kèm notebook; `notebook=None` để bỏ hẳn part notebook (test thiếu file)."""
    files = {"file": (filename, data, "text/csv")}
    if notebook is not None:
        files["notebook"] = (notebook_filename, notebook, "application/x-ipynb+json")
    return client.post(f"/api/competitions/{competition_id}/submissions", files=files)


def submission_documents(client, query: dict | None = None) -> list[dict]:
    async def load():
        cursor = client.app.state.mongo.db[SUBMISSIONS_COLLECTION].find(query or {})
        return [document async for document in cursor]

    return asyncio.run(load())


def account_id_by_email(client, email: str):
    async def load():
        account = await client.app.state.mongo.db[ACCOUNTS_COLLECTION].find_one({"email": email})
        return account["_id"]

    return asyncio.run(load())
