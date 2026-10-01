"""Dấu vân tay của cấu hình chấm và bộ đếm revision.

Một lượt chạy thử chỉ còn giá trị khi phần nó đã chạy vẫn đúng là phần đang được lưu — source,
ground truth, schema, runtime (`execution_fingerprint`) — **và** tập khóa metric khai báo đúng bằng
tập khóa lượt đó đã quan sát. Đổi tên hiển thị, số thập phân, ẩn/hiện hay chỉ số chính không làm mất
hiệu lực: lượt chạy thử không quan sát được chúng, nên bắt chạy lại vì chúng chỉ tạo thêm lượt chứ
không thêm bằng chứng.
"""

import hashlib
import json
from datetime import datetime, timezone

from app.scoring.models import (
    PREPROCESSING_VERSION,
    RUNNER_PROTOCOL_VERSION,
    InputSchema,
    OutputContract,
)

# Revision bắt đầu từ 1 ở lần lưu đầu tiên; 0 là "chưa từng lưu".
INITIAL_REVISION = 0


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(payload: object) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def normalized_schema(schema: InputSchema) -> dict:
    """Schema ở dạng ổn định để băm: `id_matching`/`row_alignment` cũng là phần của hợp đồng."""
    return schema.model_dump(mode="json")


def execution_fingerprint(
    *,
    input_schema: InputSchema,
    source_sha256: str | None,
    ground_truth_sha256: str | None,
    runtime_id: str | None,
) -> str:
    payload = {
        "protocol": RUNNER_PROTOCOL_VERSION,
        "preprocessing_version": PREPROCESSING_VERSION,
        "schema": normalized_schema(input_schema),
        "source": source_sha256,
        "ground_truth": ground_truth_sha256,
        "runtime": runtime_id,
    }
    return sha256_bytes(canonical_json(payload).encode("utf-8"))


def config_fingerprint(execution: str, contract: OutputContract | None) -> str:
    """Dấu vết của đúng cấu hình lúc chạy thử, ghim vào bằng chứng và `scoring_ref` để hậu kiểm.

    Không phải điều kiện hiệu lực: hiệu lực so theo tập khóa metric đã quan sát
    (`verification_matches`), không so toàn bộ hợp đồng.
    """
    payload = {
        "execution": execution,
        "contract": contract.model_dump(mode="json") if contract else None,
    }
    return sha256_bytes(canonical_json(payload).encode("utf-8"))


def verification_matches(verification, *, execution: str, contract: OutputContract | None) -> bool:
    """Lượt chạy thử đã lưu còn hiệu lực cho đúng cấu hình đang có hay không.

    Hai phần của hiệu lực: phần đã chạy (schema, source, ground truth, runtime) không đổi, và tập
    khóa metric khai báo đúng bằng tập khóa lượt chạy đã quan sát. Chưa khai hợp đồng (bản nháp dò
    khóa) thì chỉ cần phần đã chạy — nhờ vậy khai đúng tập khóa vừa dò cũng không làm mất hiệu lực.
    """
    if verification is None or verification.state != "passed":
        return False
    if verification.execution_fingerprint != execution:
        return False
    if contract is None:
        return True
    return sorted(verification.observed_keys) == sorted(metric.key for metric in contract.metrics)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
