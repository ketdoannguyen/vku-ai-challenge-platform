"""Dấu vân tay của cấu hình chấm và bộ đếm revision.

Một lượt chạy thử chỉ còn giá trị khi mọi thứ nó đã chạy vẫn đúng là thứ đang được lưu: source,
ground truth, schema và runtime. `execution_fingerprint` gói đúng bốn thứ đó lại; đổi bất kỳ thứ nào
làm lượt chạy thử cũ mất hiệu lực, nên publish không thể dựa vào bằng chứng đã cũ.
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
    """Bổ sung phần trình bày kết quả: đổi metric chính hay chiều xếp hạng cũng là đổi cấu hình."""
    payload = {
        "execution": execution,
        "contract": contract.model_dump(mode="json") if contract else None,
    }
    return sha256_bytes(canonical_json(payload).encode("utf-8"))


def verification_matches(verification, *, execution: str, contract: OutputContract | None) -> bool:
    """Lượt chạy thử đã lưu còn hiệu lực cho đúng cấu hình đang có hay không."""
    if verification is None or verification.state != "passed":
        return False
    if verification.execution_fingerprint != execution:
        return False
    return verification.config_fingerprint == config_fingerprint(execution, contract)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
