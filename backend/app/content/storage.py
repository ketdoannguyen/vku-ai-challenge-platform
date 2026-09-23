"""Safe on-disk storage for Markdown and competition image assets."""

import os
from pathlib import Path
from uuid import uuid4


ASSET_TYPES = {
    ".png": ("image/png", b"\x89PNG\r\n\x1a\n"),
    ".jpg": ("image/jpeg", b"\xff\xd8\xff"),
    ".jpeg": ("image/jpeg", b"\xff\xd8\xff"),
    ".gif": ("image/gif", b"GIF8"),
    ".webp": ("image/webp", b"RIFF"),
}


def competition_root(data_dir: str | Path, competition_id: str) -> Path:
    return Path(data_dir) / "competitions" / competition_id


def content_file_path(data_dir: str | Path, competition_id: str, content_id: str) -> Path:
    return competition_root(data_dir, competition_id) / "content" / f"{content_id}.md"


def assets_dir(data_dir: str | Path, competition_id: str) -> Path:
    return competition_root(data_dir, competition_id) / "assets"


def ensure_within(root: Path, candidate: Path) -> Path:
    if candidate.is_absolute() and not candidate.resolve(strict=False).is_relative_to(root.resolve()):
        raise ValueError("Đường dẫn không hợp lệ.")
    if not candidate.is_absolute():
        if ".." in candidate.parts:
            raise ValueError("Đường dẫn không hợp lệ.")
        candidate = root / candidate
    resolved_root = root.resolve()
    resolved = candidate.resolve(strict=False)
    if not resolved.is_relative_to(resolved_root):
        raise ValueError("Đường dẫn không hợp lệ.")
    return resolved


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.parent / f".tmp-{uuid4().hex}"
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def read_bytes(path: Path) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, "rb") as stream:
        return stream.read()


class ContentFileMissing(Exception):
    """Markdown của content không đọc được: thiếu file, symlink, đường dẫn sai, hoặc không phải UTF-8."""


def read_markdown(data_dir: str | Path, markdown_path: str) -> str:
    """Đọc Markdown qua `ensure_within` + `O_NOFOLLOW`; mọi trục trặc đều thành một lỗi tường minh."""
    try:
        path = ensure_within(Path(data_dir), Path(markdown_path))
        return read_bytes(path).decode("utf-8")
    except (ValueError, OSError, UnicodeDecodeError) as exc:
        raise ContentFileMissing(markdown_path) from exc


def validate_asset(filename: str, data: bytes) -> tuple[str, str]:
    extension = Path(filename).suffix.lower()
    spec = ASSET_TYPES.get(extension)
    if spec is None:
        raise ValueError("Chỉ hỗ trợ ảnh PNG, JPEG, GIF hoặc WebP.")
    content_type, signature = spec
    if not data.startswith(signature):
        raise ValueError("Nội dung file không khớp định dạng ảnh.")
    if extension == ".webp" and (len(data) < 12 or data[8:12] != b"WEBP"):
        raise ValueError("Nội dung file không khớp định dạng WebP.")
    return extension, content_type
