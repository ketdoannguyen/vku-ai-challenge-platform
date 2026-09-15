"""Filesystem guards and atomic content writes."""

from pathlib import Path

import pytest

from app.content.storage import (
    content_file_path,
    ensure_within,
    read_bytes,
    write_atomic,
)


def test_content_path_is_generated_inside_competition_directory(tmp_path):
    path = content_file_path(tmp_path, "64a000000000000000000001", "64b000000000000000000001")
    assert path == (
        tmp_path
        / "competitions"
        / "64a000000000000000000001"
        / "content"
        / "64b000000000000000000001.md"
    )


@pytest.mark.parametrize("name", ["../outside.md", "/etc/passwd", "nested/../../outside"])
def test_ensure_within_rejects_traversal_and_absolute_path(tmp_path, name):
    root = tmp_path / "root"
    root.mkdir()
    with pytest.raises(ValueError):
        ensure_within(root, Path(name))


def test_ensure_within_rejects_symlink_escape(tmp_path):
    root = tmp_path / "root"
    outside = tmp_path / "outside.txt"
    root.mkdir()
    outside.write_text("secret")
    (root / "leak.txt").symlink_to(outside)
    with pytest.raises(ValueError):
        ensure_within(root, root / "leak.txt")


def test_atomic_write_round_trip_and_no_temp_left(tmp_path):
    path = tmp_path / "nested" / "content.md"
    write_atomic(path, "# Tiếng Việt".encode())
    assert read_bytes(path) == "# Tiếng Việt".encode()
    assert list(path.parent.glob(".tmp-*")) == []
