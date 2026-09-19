"""MinIO giả in-memory cho unit test: không cần container, nhưng giữ đúng hình dạng SDK.

Smoke với MinIO thật nằm ở Phase F (Docker project cô lập), không phải ở đây.
"""

from minio.error import S3Error


def _missing(code: str, name: str) -> S3Error:
    return S3Error(None, code, "not found in fake store", name, "req-fake", "host-fake")


class FakeResponse:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._offset = 0
        self.closed = False
        self.released = False

    def read(self, size: int = -1) -> bytes:
        chunk = (
            self._data[self._offset :]
            if size < 0
            else self._data[self._offset : self._offset + size]
        )
        self._offset += len(chunk)
        return chunk

    def close(self) -> None:
        self.closed = True

    def release_conn(self) -> None:
        self.released = True


class FakeObject:
    def __init__(self, name: str) -> None:
        self.object_name = name


class FakeMinio:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.content_types: dict[str, str] = {}
        self.responses: list[FakeResponse] = []
        # Bật để mô phỏng MinIO không tới được (network/credential sai).
        self.unavailable = False
        self.bucket = "submission-artifacts"

    def put_object(self, bucket_name, object_name, data, length=None, content_type=None):
        self._guard(bucket_name)
        payload = data.read()
        self.objects[object_name] = payload
        self.content_types[object_name] = content_type

    def get_object(self, bucket_name, object_name):
        self._guard(bucket_name)
        if object_name not in self.objects:
            raise _missing("NoSuchKey", object_name)
        response = FakeResponse(self.objects[object_name])
        self.responses.append(response)
        return response

    def remove_object(self, bucket_name, object_name, version_id=None):
        self._guard(bucket_name)
        self.objects.pop(object_name, None)

    def list_objects(self, bucket_name, prefix="", recursive=False):
        self._guard(bucket_name)
        return [FakeObject(name) for name in sorted(self.objects) if name.startswith(prefix)]

    def remove_objects(self, bucket_name, delete_object_list, quiet=False):
        """SDK thật trả về generator các lỗi; rỗng nghĩa là xoá sạch."""
        self._guard(bucket_name)
        errors = []
        for item in delete_object_list:
            self.objects.pop(item.name, None)
        return iter(errors)

    def _guard(self, bucket_name: str) -> None:
        if self.unavailable:
            raise OSError("fake MinIO is unreachable")
        if bucket_name != self.bucket:
            raise _missing("NoSuchBucket", bucket_name)
