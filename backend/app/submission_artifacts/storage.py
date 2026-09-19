"""Private object storage cho artifact của submission (prediction CSV + notebook).

Bucket không public và không expose qua Nginx/Cloudflare: mọi upload/download đều đi qua FastAPI để
enforce quota và authorization (ADR-028). Module này chỉ là lớp mỏng trên MinIO SDK; SDK là sync nên
mọi call network được đẩy sang threadpool để không chặn event loop.
"""

import logging
from functools import lru_cache
from io import BytesIO

from minio import Minio
from minio.deleteobjects import DeleteObject
from minio.error import S3Error
from starlette.concurrency import run_in_threadpool

from app.core.config import get_settings

logger = logging.getLogger(__name__)

# Đuôi file trong object key là hằng số, không lấy từ tên người dùng upload.
PREDICTION_OBJECT_NAME = "prediction.csv"
NOTEBOOK_OBJECT_NAME = "notebook.ipynb"


class ArtifactNotFound(Exception):
    """Object (hoặc bucket) không tồn tại - map thành 404 ở tầng API."""


class ArtifactStorageUnavailable(Exception):
    """MinIO không tới được hoặc trả lỗi khác - map thành 503 ở tầng API."""


def submission_prefix(competition_id, account_id, submission_id) -> str:
    return (
        f"competitions/{competition_id}/accounts/{account_id}"
        f"/submissions/{submission_id}"
    )


def competition_prefix(competition_id) -> str:
    return f"competitions/{competition_id}/"


def prediction_key(competition_id, account_id, submission_id) -> str:
    return f"{submission_prefix(competition_id, account_id, submission_id)}/{PREDICTION_OBJECT_NAME}"


def notebook_key(competition_id, account_id, submission_id) -> str:
    return f"{submission_prefix(competition_id, account_id, submission_id)}/{NOTEBOOK_OBJECT_NAME}"


@lru_cache(maxsize=4)
def _client_for(endpoint: str, access_key: str, secret_key: str, secure: bool) -> Minio:
    """Cache theo tham số kết nối: client MinIO thread-safe trong một process."""
    return Minio(endpoint, access_key=access_key, secret_key=secret_key, secure=secure)


def _client() -> Minio:
    settings = get_settings()
    if not settings.minio_access_key or not settings.minio_secret_key:
        raise ArtifactStorageUnavailable("MinIO credentials are not configured.")
    return _client_for(
        settings.minio_endpoint,
        settings.minio_access_key,
        settings.minio_secret_key,
        settings.minio_secure,
    )


def _bucket() -> str:
    return get_settings().minio_bucket


def _put(client: Minio, bucket: str, key: str, data: bytes, content_type: str) -> None:
    client.put_object(
        bucket,
        key,
        BytesIO(data),
        length=len(data),
        content_type=content_type,
    )


def _get(client: Minio, bucket: str, key: str, max_bytes: int) -> bytes:
    response = None
    try:
        response = client.get_object(bucket, key)
        # Đọc thừa một byte để phát hiện object lớn hơn trần cho phép mà không nạp cả file vào RAM.
        data = response.read(max_bytes + 1)
    except S3Error as exc:
        if exc.code in ("NoSuchKey", "NoSuchBucket"):
            raise ArtifactNotFound(key)
        raise
    finally:
        if response is not None:
            response.close()
            response.release_conn()
    if len(data) > max_bytes:
        raise ArtifactStorageUnavailable("Stored artifact exceeds the download limit.")
    return data


def _remove_object(client: Minio, bucket: str, key: str) -> None:
    client.remove_object(bucket, key)


def _remove_prefix(client: Minio, bucket: str, prefix: str) -> int:
    names = [
        item.object_name
        for item in client.list_objects(bucket, prefix=prefix, recursive=True)
    ]
    failed = 0
    for error in client.remove_objects(
        bucket, [DeleteObject(name) for name in names]
    ):
        failed += 1
        logger.warning("Cannot remove artifact object=%s error=%s", error.object_name, error)
    return failed


async def put_bytes(key: str, data: bytes, content_type: str) -> None:
    """Upload một object; mọi lỗi (kể cả bucket thiếu) đều là storage không sẵn sàng."""
    try:
        client, bucket = _client(), _bucket()
        await run_in_threadpool(_put, client, bucket, key, data, content_type)
    except ArtifactStorageUnavailable:
        raise
    except Exception:
        logger.exception("MinIO upload failed object=%s", key)
        raise ArtifactStorageUnavailable("MinIO upload failed.")


async def get_bytes(key: str, max_bytes: int) -> bytes:
    try:
        client, bucket = _client(), _bucket()
        return await run_in_threadpool(_get, client, bucket, key, max_bytes)
    except (ArtifactNotFound, ArtifactStorageUnavailable):
        raise
    except Exception:
        logger.exception("MinIO download failed object=%s", key)
        raise ArtifactStorageUnavailable("MinIO download failed.")


async def remove_object(key: str) -> bool:
    """Best-effort: dùng cho compensating cleanup, không được che lỗi gốc của request."""
    try:
        client, bucket = _client(), _bucket()
        await run_in_threadpool(_remove_object, client, bucket, key)
        return True
    except Exception:
        logger.warning("Cannot remove artifact object=%s", key, exc_info=True)
        return False


async def remove_prefix(prefix: str) -> bool:
    """Best-effort: dùng khi xoá cuộc thi; trả False nếu còn object không xoá được."""
    try:
        client, bucket = _client(), _bucket()
        failed = await run_in_threadpool(_remove_prefix, client, bucket, prefix)
        return failed == 0
    except Exception:
        logger.warning("Cannot remove artifact prefix=%s", prefix, exc_info=True)
        return False
