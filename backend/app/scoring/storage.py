"""Safe access to private ground-truth files."""

from pathlib import Path

from app.content import storage as file_storage
from app.core.config import get_settings


def ground_truth_path(competition: dict) -> Path:
    root = Path(get_settings().data_dir)
    metadata = competition.get("ground_truth")
    relative_path = (
        Path(metadata["path"])
        if metadata and metadata.get("path")
        else Path("competitions", str(competition["_id"]), "private", "ground_truth.csv")
    )
    candidate = relative_path if relative_path.is_absolute() else root / relative_path
    if candidate.is_symlink():
        raise ValueError("Ground truth path cannot be a symlink.")
    return file_storage.ensure_within(root, candidate)


def ground_truth_available(competition: dict) -> bool:
    metadata = competition.get("ground_truth")
    if not metadata or not metadata.get("path"):
        return False
    try:
        return ground_truth_path(competition).is_file()
    except (KeyError, OSError, ValueError):
        return False


def read_ground_truth(competition: dict) -> bytes:
    metadata = competition.get("ground_truth")
    if not metadata or not metadata.get("path"):
        raise KeyError("Ground truth metadata is missing its path.")
    return file_storage.read_bytes(ground_truth_path(competition))
