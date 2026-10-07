"""Hợp đồng HTTP của runner: thứ `api` nhìn thấy qua mạng, không phải thứ Docker làm.

Sandbox được thay bằng object giả nên bộ test này chạy được ở mọi máy (không cần Docker). Phần thật
sự cần Docker nằm ở `test_evaluator_sandbox.py` (cờ cách ly) và ở lượt diễn tập tay.

Hai thứ ở đây là hợp đồng với `api`, đổi là đổi cả hai đầu:
  - `/health` phân biệt "sẵn sàng" với "có docker nhưng chưa ghim được image runtime";
  - `/evaluate` trả `runtime_id` (ID nội dung) chứ không phải tag, và hết slot là **503 ngay**, không
    xếp hàng - đúng hành vi mà các phép đo đồng thời dựa vào.
"""

import asyncio
import contextlib
import http.client
import threading

import httpx
import pytest
from fastapi.testclient import TestClient

from app.evaluator_runner import server as server_module
from app.evaluator_runner.sandbox import Slots
from app.scoring.errors import EvaluatorError

DIGEST = "sha256:" + "a" * 64
PAYLOAD = {
    "source_code": "def evaluate(truth, submission):\n    return {}\n",
    "ground_truth_csv": "id,label\n1,a\n",
    "submission_csv": "id,prediction\n1,a\n",
}


class FakeSandbox:
    """Runner-giả: đủ thuộc tính mà hai route đọc, và ghi lại payload đã nhận."""

    def __init__(
        self,
        *,
        ready: bool = True,
        error: EvaluatorError | None = None,
        gate: threading.Event | None = None,
    ) -> None:
        self.image = "vku-evaluator-runtime:1"
        self.available = ready
        self.runtime_id = DIGEST if ready else None
        self.error = error
        self.gate = gate
        self.started = threading.Event()
        self.calls: list[dict] = []

    @property
    def ready(self) -> bool:
        return self.available and self.runtime_id is not None

    async def run(self, *, source_code: str, ground_truth_csv: str, submission_csv: str):
        self.calls.append(
            {
                "source_code": source_code,
                "ground_truth_csv": ground_truth_csv,
                "submission_csv": submission_csv,
            }
        )
        self.started.set()
        if self.gate is not None:
            # Chờ trên một luồng khác để event loop còn nhận được request thứ hai.
            await asyncio.get_running_loop().run_in_executor(None, self.gate.wait)
        if self.error is not None:
            raise self.error
        return {"accuracy": 0.75, "n_items": 4.0}, 7


@pytest.fixture(autouse=True)
def no_real_docker(monkeypatch):
    """Lifespan thật gọi `docker image inspect`; ở đây chỉ cần nó không chạm Docker."""

    async def unavailable(_self) -> bool:
        return False

    monkeypatch.setattr(server_module.Sandbox, "load", unavailable)


@contextlib.contextmanager
def runner_client(fake: FakeSandbox, *, concurrency: int | None = None):
    """Client đã chạy lifespan xong rồi mới thay sandbox - lifespan thật dựng sandbox thật."""
    with TestClient(server_module.app) as client:
        client.app.state.sandbox = fake
        if concurrency is not None:
            client.app.state.slots = Slots(concurrency)
        yield client


def test_health_phan_biet_san_sang_voi_chua_ghim_duoc_runtime():
    """`runtime_id: null` là dấu hiệu duy nhất phân biệt "có docker" với "chấm được"."""
    with runner_client(FakeSandbox()) as client:
        body = client.get("/health").json()
    assert body == {
        "status": "ok",
        "docker": True,
        "image": "vku-evaluator-runtime:1",
        "runtime_id": DIGEST,
    }

    with runner_client(FakeSandbox(ready=False)) as client:
        body = client.get("/health").json()
    assert body["status"] == "degraded"
    assert body["docker"] is False
    assert body["runtime_id"] is None


def test_evaluate_tra_noi_dung_da_chay_chu_khong_phai_tag():
    """Điểm ghi lại `runtime_id` này vào `scoring_ref`, nên nó phải là ID nội dung."""
    fake = FakeSandbox()
    with runner_client(fake) as client:
        response = client.post("/evaluate", json=PAYLOAD)
    assert response.status_code == 200
    body = response.json()
    assert body["runtime_id"] == DIGEST
    assert body["metrics"] == {"accuracy": 0.75, "n_items": 4.0}
    assert fake.calls == [PAYLOAD]


def test_evaluate_doi_ma_loi_cua_sandbox_thanh_http_status():
    """Runner hỏng là 503 (thử lại được), code chấm hỏng là 422 (lỗi của chính lượt chấm)."""
    for code, expected in [
        ("EVALUATOR_UNAVAILABLE", 503),
        ("EVALUATOR_TIMEOUT", 422),
        ("EVALUATOR_OUTPUT_MISMATCH", 422),
        ("SUBMISSION_RULE_VIOLATION", 422),
    ]:
        fake = FakeSandbox(error=EvaluatorError(code, "Hỏng."))
        with runner_client(fake) as client:
            response = client.post("/evaluate", json=PAYLOAD)
        assert response.status_code == expected, code
        assert response.json()["code"] == code


def test_evaluate_keeps_checked_class_ids_for_the_api():
    info = {"class_id": 6, "allowed_class_ids": list(range(6))}
    fake = FakeSandbox(error=EvaluatorError(
        "SUBMISSION_CLASS_ID_INVALID", "CSV sai quy tắc.", class_info=info
    ))
    with runner_client(fake) as client:
        response = client.post("/evaluate", json=PAYLOAD)
    assert response.status_code == 422
    assert response.json()["class_info"] == info


def test_het_slot_thi_tu_choi_ngay_chu_khong_xep_hang():
    """Lượt thứ hai phải nhận 503 trong lúc lượt đầu còn chạy - đây là hành vi các phép đo đồng thời đo."""
    gate = threading.Event()
    fake = FakeSandbox(gate=gate)
    results: dict[str, httpx.Response] = {}
    with runner_client(fake, concurrency=1) as client:
        first = threading.Thread(target=lambda: results.setdefault("first", client.post(
            "/evaluate", json=PAYLOAD
        )))
        first.start()
        assert fake.started.wait(timeout=10), "lượt đầu chưa vào sandbox"

        started = threading.Event()
        second: dict[str, httpx.Response] = {}
        worker = threading.Thread(
            target=lambda: (second.setdefault("second", client.post("/evaluate", json=PAYLOAD)),
                            started.set())
        )
        worker.start()
        assert started.wait(timeout=10), "lượt thứ hai chưa trả về"

        gate.set()
        first.join(timeout=10)
        worker.join(timeout=10)

    assert second["second"].status_code == 503
    assert second["second"].json()["code"] == "EVALUATOR_UNAVAILABLE"
    assert results["first"].status_code == 200
    # Lượt bị từ chối không bao giờ vào tới sandbox: từ chối trước, không chấm rồi mới báo.
    assert len(fake.calls) == 1


def test_request_qua_khoi_luong_cho_phep_bi_tu_choi_truoc_khi_doc_body():
    """32 MiB là trần cứng: nhận cả body rồi mới từ chối là cách để một request giết runner."""
    fake = FakeSandbox()
    with runner_client(fake) as client:
        # TestClient tự tính Content-Length theo body thật, nên phải nói thẳng với transport là body
        # lớn hơn trần mà không gửi số byte đó.
        response = client.post(
            "/evaluate",
            json=PAYLOAD,
            headers={"content-length": str(server_module.MAX_REQUEST_BYTES + 1)},
        )
    assert response.status_code == http.client.REQUEST_ENTITY_TOO_LARGE
    assert response.json()["code"] == "EVALUATOR_UNAVAILABLE"
    assert fake.calls == []
