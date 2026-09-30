"""Hai file compose phải khai `DATA_DIR` cho mọi service đọc chung thư mục dữ liệu.

Nguồn bộ chấm, ground truth và Markdown thể lệ nằm trong `data_dir` (ổ đĩa, không phải MinIO), nên
một service mount ổ dữ liệu chung mà thiếu `DATA_DIR` sẽ đọc đường dẫn rỗng trong container: nó khởi
động bình thường, health xanh, rồi mọi lượt chấm hỏng với `SCORING_NOT_READY`. Đó là lỗi im lặng đã
xảy ra thật với `scoring-worker` (ADR-048), và test này là chỗ duy nhất bắt được nó trước khi lên máy.
"""

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILES = ("docker-compose.yml", "docker-compose.prod.yml")
DATA_VOLUME = "/data"
#: Nguồn của ổ dữ liệu chung: named volume `data` ở dev, bind mount `${PROD_DATA_ROOT}/app` ở prod.
#: `minio` cũng mount `/data` nhưng nguồn là `minio_data` - dữ liệu nội bộ của nó, không phải `data_dir`.
SHARED_DATA_VOLUME = "data"
SHARED_DATA_BIND = "${PROD_DATA_ROOT"


def _mounts_shared_data(service: dict) -> bool:
    for volume in service.get("volumes", []):
        if not isinstance(volume, str):
            continue
        source, _, target = volume.partition(":")
        if target != DATA_VOLUME:
            continue
        if source == SHARED_DATA_VOLUME or source.startswith(SHARED_DATA_BIND):
            return True
    return False


def test_services_mounting_shared_data_volume_declare_data_dir():
    for name in COMPOSE_FILES:
        compose = yaml.safe_load((REPO_ROOT / name).read_text(encoding="utf-8"))
        for service_name, service in compose["services"].items():
            if not _mounts_shared_data(service):
                continue
            environment = service.get("environment") or {}
            assert environment.get("DATA_DIR") == DATA_VOLUME, (
                f"{name}: service {service_name} mount ổ dữ liệu chung nhưng thiếu DATA_DIR"
            )


def test_runner_and_worker_declare_the_same_concurrency_ceiling():
    """`scoring-worker` phải khai `EVALUATOR_MAX_CONCURRENCY` đúng như `evaluator-runner`.

    Worker so `SCORING_WORKER_CONCURRENCY` với trần runner **trong chính tiến trình nó** (xem
    `config.py`), nên hai service phải cùng đọc một biến. Thiếu ở worker thì nó lấy mặc định 2, từ
    chối khởi động khi runner đã được nâng lên 4 và restart vô hạn: hàng đợi đứng im trong khi mọi
    healthcheck của runner vẫn xanh. Lỗi thật đã gặp khi đo tài nguyên 4 slot (ADR-048).
    """
    for name in COMPOSE_FILES:
        services = yaml.safe_load((REPO_ROOT / name).read_text(encoding="utf-8"))["services"]
        runner = (services["evaluator-runner"].get("environment") or {}).get(
            "EVALUATOR_MAX_CONCURRENCY"
        )
        worker = (services["scoring-worker"].get("environment") or {}).get(
            "EVALUATOR_MAX_CONCURRENCY"
        )
        assert runner is not None and runner == worker, (
            f"{name}: evaluator-runner khai {runner!r} còn scoring-worker khai {worker!r}"
        )
