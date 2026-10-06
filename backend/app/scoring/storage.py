"""Truy cập an toàn vào file riêng tư: ground truth và source bộ chấm.

Không bao giờ ghi đè file đang được tham chiếu: tên file gắn hash nội dung, nên một lượt chấm đang
chạy vẫn đọc đúng bản đã được xác minh kể cả khi admin vừa thay file mới.
"""

from pathlib import Path

from app.competitions import tracks as competition_tracks
from app.content import storage as file_storage
from app.core.config import get_settings
from app.scoring.models import EvaluatorConfig


def _root() -> Path:
    return Path(get_settings().data_dir).resolve()


def _relative_path(competition: dict, relative: str) -> str:
    return f"competitions/{competition['_id']}/private/{relative}"


def stored_path(relative_path: str) -> Path:
    root = _root()
    candidate = Path(relative_path)
    if not candidate.is_absolute():
        candidate = root / candidate
    if candidate.is_symlink():
        raise ValueError("Đường dẫn không hợp lệ.")
    return file_storage.ensure_within(root, candidate)


def _write_versioned(relative_path: str, data: bytes) -> Path:
    """Ghi nếu chưa có; cùng nội dung thì cùng đường dẫn nên thao tác này lặp lại được."""
    path = stored_path(relative_path)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        file_storage.write_atomic(path, data)
    return path


def write_ground_truth(competition: dict, data: bytes, *, sha256: str, track: str | None = None) -> str:
    """Ghi ground truth theo hash và trả đường dẫn tương đối để lưu vào metadata.

    Dual tách file theo tên nhánh: hai nhánh có thể có nội dung rất giống nhau, và tên file
    nói ngay bản này thuộc nhánh nào khi soi thư mục dữ liệu.
    """
    name = f"ground_truth-{sha256[:16]}.csv" if track is None else f"ground_truth-{track}-{sha256[:16]}.csv"
    path = _write_versioned(_relative_path(competition, name), data)
    return path.relative_to(_root()).as_posix()


def write_evaluator_source(competition: dict, source: str, *, sha256: str) -> str:
    path = _write_versioned(_relative_path(competition, f"evaluator/{sha256}.py"), source.encode("utf-8"))
    return path.relative_to(_root()).as_posix()


def ground_truth_path(competition: dict, track: str | None = None) -> Path:
    """Đường dẫn ground truth của đúng nhánh; dual không có đường lui về bản cấp cuộc thi.

    Thiếu metadata của nhánh là lỗi cấu hình (fail closed), không phải dịp để đọc nhầm GT của
    nhánh kia - nhầm như vậy nghĩa là chấm bài bằng đáp án sai.
    """
    metadata = competition_tracks.track_ground_truth(competition, track)
    if track is None:
        relative = (
            metadata["path"]
            if metadata and metadata.get("path")
            else _relative_path(competition, "ground_truth.csv")
        )
    else:
        if not metadata or not metadata.get("path"):
            raise KeyError("Track ground truth metadata is missing its path.")
        relative = metadata["path"]
    return stored_path(relative)


def ground_truth_available(competition: dict, track: str | None = None) -> bool:
    if not competition_tracks.track_ground_truth(competition, track):
        return False
    try:
        return ground_truth_path(competition, track).is_file()
    except (KeyError, OSError, ValueError):
        return False


def read_ground_truth(competition: dict, track: str | None = None) -> bytes:
    metadata = competition_tracks.track_ground_truth(competition, track)
    if not metadata or not metadata.get("path"):
        raise KeyError("Ground truth metadata is missing its path.")
    return file_storage.read_bytes(ground_truth_path(competition, track))


def read_evaluator_source(evaluator: EvaluatorConfig) -> bytes:
    if not evaluator.source_path:
        raise KeyError("Evaluator source path is missing.")
    return file_storage.read_bytes(stored_path(evaluator.source_path))
