"""Đối chiếu dấu hiệu tải dataset trong code notebook với link BTC cấp, không gọi mạng."""

import ast
import io
import re
import tokenize
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse

from app.ai_review import constants
from app.ai_review.models import ModelSourceSignal
from app.ai_review.notebook import CELL_CODE, NormalizedNotebook
from app.ai_review.verdict import _build_snippet

_URL = re.compile(r"(?:https?|s3|gs|ftp)://[^\s\"'<>()[\]{}`]+", re.IGNORECASE)
_ID = re.compile(r"^[A-Za-z0-9_-]+$")
_DATA_CALL = re.compile(
    r"(?:\b(?:gdown\.(?:download|download_folder)|requests\.(?:get|post)|"
    r"read_csv|read_parquet|load_dataset|urlretrieve|urlopen)\s*\(|"
    r"(?:^|\n)\s*!?\s*(?:wget|curl|gdown)\s+)", re.IGNORECASE
)
_ID_ARG = re.compile(r"\bid\s*=\s*(['\"])([A-Za-z0-9_-]+)\1")
_CLI_ID = re.compile(r"--id(?:=|\s+)([A-Za-z0-9_-]+)")
_DATASET_URL = re.compile(r"(?:\.(?:csv|tsv|parquet)(?:[?&#]|$)|/datasets?[/?.#])", re.IGNORECASE)
_DATASET_HINT = re.compile(r"\b(?:data|dataset|train|test|validation)\b|(?:^|_)(?:data|dataset)(?:_|$)", re.IGNORECASE)
# Đường dẫn literal dưới mount point Colab là đọc Drive, không phải tệp cục bộ vô danh.
_MOUNTED_DRIVE_PATH = re.compile(r"^/content/drive(?:/|$)")
# ID Drive thật dài 25-44 ký tự; ngưỡng 20 chặn substring trùng ngẫu nhiên khi quét ID thô.
_MIN_BARE_ID_CHARS = 20
_DRIVE = {"drive.google.com", "drive.usercontent.google.com"}
_DOCS = {"docs.google.com"}


@dataclass(frozen=True)
class SourceSignal:
    cell: int
    start_line: int
    end_line: int
    snippet: str
    reason: str
    match: str
    urls: list[dict]
    warning: bool


@dataclass(frozen=True)
class ResourceMention:
    label: str
    cells: list[int]


def drive_identity(url: str) -> tuple[str, str] | None:
    """Nhận diện các URL Drive tĩnh thường dùng; host phải khớp chính xác."""
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        return None
    parts = [part for part in parsed.path.split("/") if part]
    if host in _DOCS:
        if len(parts) > 3 and parts[1] == "u" and parts[2].isdigit():
            parts = [parts[0], *parts[3:]]
        if len(parts) >= 4 and parts[:3] == ["forms", "d", "e"]:
            kind, identifier = "file", parts[3]
        elif len(parts) >= 3 and parts[0] in {"document", "spreadsheets", "presentation", "forms"} and parts[1] == "d":
            kind, identifier = "file", parts[2]
        else:
            return None
    elif host in _DRIVE:
        if len(parts) > 2 and parts[:2] == ["drive", "u"] and parts[2].isdigit():
            parts = [parts[0], *parts[3:]]
        if len(parts) > 3 and parts[:2] == ["file", "u"] and parts[2].isdigit():
            parts = [parts[0], *parts[3:]]
        if len(parts) >= 3 and parts[:2] == ["file", "d"]:
            kind, identifier = "file", parts[2]
        elif len(parts) >= 3 and parts[:2] == ["drive", "folders"]:
            kind, identifier = "folder", parts[2]
        elif parts == ["open"] or parts == ["uc"] or parts == ["download"]:
            kind, identifier = "file", (parse_qs(parsed.query).get("id") or [""])[0]
        else:
            return None
    else:
        return None
    return (kind, identifier) if _ID.fullmatch(identifier) else None


def _code_views(code: str) -> tuple[str, str]:
    """Giữ vị trí ký tự; ẩn comment ở cả hai view và string ở view tìm lời gọi."""
    starts = [0]
    for line in code.split("\n")[:-1]:
        starts.append(starts[-1] + len(line) + 1)
    without_comments = list(code)
    without_text = list(code)
    try:
        for token in tokenize.generate_tokens(io.StringIO(code).readline):
            if token.type not in {tokenize.COMMENT, tokenize.STRING, tokenize.FSTRING_MIDDLE}:
                continue
            begin = starts[token.start[0] - 1] + token.start[1]
            end = starts[token.end[0] - 1] + token.end[1]
            if token.type == tokenize.COMMENT:
                without_comments[begin:end] = " " * (end - begin)
            without_text[begin:end] = " " * (end - begin)
    except (tokenize.TokenError, IndentationError, SyntaxError):
        # Một range trích dẫn có thể cắt giữa lời gọi; các token đã nhận được vẫn hợp lệ.
        pass
    return "".join(without_comments), "".join(without_text)


def _call_end(code: str, match: re.Match) -> int:
    if not match.group(0).rstrip().endswith("("):
        start = match.end()
        end = code.find("\n", start)
        while end >= 0 and code[start:end].rstrip().endswith("\\"):
            start = end + 1
            end = code.find("\n", start)
        return len(code) if end < 0 else end
    depth = 1
    for position in range(match.end(), len(code)):
        if code[position] == "(":
            depth += 1
        elif code[position] == ")":
            depth -= 1
            if depth == 0:
                return position + 1
    return len(code)


def verify_source_signals(
    signals: list[ModelSourceSignal], *, notebook: NormalizedNotebook, resources: list[dict]
) -> list[SourceSignal]:
    official = {
        identity: item["label"]
        for item in resources
        if (identity := drive_identity(item["url"])) is not None
    }
    has_folder = any(kind == "folder" for kind, _ in official)
    verified = []
    for signal in signals:
        cell = notebook.cell(signal.cell)
        if (cell is None or cell.kind != CELL_CODE or
                not 1 <= signal.start_line <= signal.end_line <= len(cell.lines)):
            continue
        lines = cell.lines[signal.start_line - 1:signal.end_line]
        code, call_view = _code_views("\n".join(lines))
        urls = []
        matches = set()
        for call in _DATA_CALL.finditer(call_view):
            call_name = call.group(0).lower()
            segment = code[call.start():_call_end(call_view, call)]
            is_gdown = "gdown" in call_name
            is_cli = not call_name.rstrip().endswith("(")
            is_reader = "read_csv" in call_name or "read_parquet" in call_name
            source_id = None
            dynamic_source = False
            args = None
            source = None
            if not is_cli:
                expression = "f" + segment[segment.index("("):]
                try:
                    args = ast.parse(expression, mode="eval").body
                except (SyntaxError, ValueError):
                    args = None
                if isinstance(args, ast.Call):
                    keyword = next((kw for kw in args.keywords if kw.arg in {"url", "id"}), None)
                    source = keyword.value if keyword else (args.args[0] if args.args else None)
                    if source is not None:
                        dynamic_source = not isinstance(source, ast.Constant)
                        if is_gdown and keyword is not None and keyword.arg == "id":
                            source_id = source.value if isinstance(source, ast.Constant) else None
                            segment = ""
                        else:
                            segment = ast.get_source_segment(expression, source) or ""
            found_source = False
            static_url = False
            for raw in _URL.findall(segment):
                static_url = True
                url = raw.rstrip(".,;:!?")
                if dynamic_source and "{" in segment:
                    matches.add("UNVERIFIED_SOURCE")
                    continue
                identity = drive_identity(url)
                if identity is None and not (
                    (is_reader or is_gdown) or _DATASET_URL.search(url) or
                    "/file/d/" in url or "/drive/folders/" in url
                ):
                    # API thông thường/model weights không đủ chứng minh đây là dataset.
                    continue
                found_source = True
                if len(url) > constants.MAX_SOURCE_URL_CHARS:
                    status = "UNVERIFIED_SOURCE"
                elif identity in official:
                    status = "MATCHED_RESOURCE"
                elif identity is not None and has_folder:
                    status = "FOLDER_MEMBERSHIP_UNVERIFIED"
                else:
                    status = "EXTERNAL_SOURCE"
                matches.add(status)
                if len(urls) < constants.MAX_SOURCE_URLS_PER_SIGNAL and not any(
                    item["url"] == url for item in urls
                ):
                    urls.append({"url": url[:constants.MAX_SOURCE_URL_CHARS], "match": status,
                                 "resource_label": official.get(identity) if status == "MATCHED_RESOURCE" else None})
            identifiers = []
            if is_gdown:
                if source_id is not None:
                    identifiers.append(str(source_id))
                elif is_cli:
                    identifiers.extend(_CLI_ID.findall(segment))
                    if not identifiers and not static_url:
                        words = segment.strip().split()
                        candidate = words[-1] if words else ""
                        if _ID.fullmatch(candidate) and candidate not in {"gdown", "--folder", "--id"}:
                            identifiers.append(candidate)
                elif isinstance(source, ast.Constant) and isinstance(source.value, str):
                    if _ID.fullmatch(source.value):
                        identifiers.append(source.value)
                elif args is None:
                    original = code[call.start():_call_end(call_view, call)]
                    original_view = call_view[call.start():_call_end(call_view, call)]
                    identifiers.extend(match.group(2) for match in _ID_ARG.finditer(original)
                                       if original_view[match.start():match.start() + 2].lower() == "id")
                for identifier in identifiers:
                    if not _ID.fullmatch(identifier):
                        continue
                    found_source = True
                    kind = "folder" if "download_folder" in call_name or (is_cli and "--folder" in segment.split()) else "file"
                    resource = (kind, identifier)
                    status = ("MATCHED_RESOURCE" if resource in official else
                              "FOLDER_MEMBERSHIP_UNVERIFIED" if has_folder else "EXTERNAL_SOURCE")
                    matches.add(status)
                    if len(urls) < constants.MAX_SOURCE_URLS_PER_SIGNAL and not any(
                        item["url"] == f"id={identifier}" for item in urls
                    ):
                        urls.append({"url": f"id={identifier}", "match": status,
                                     "resource_label": official.get(resource)})
            if not found_source and not static_url:
                # Literal địa phương không chứng minh nguồn; đường dẫn drive mount và nguồn động vẫn
                # cảnh báo khi liên quan dataset.
                if (is_reader and isinstance(args, ast.Call) and isinstance(source, ast.Constant)
                        and isinstance(source.value, str) and "://" not in source.value
                        and not _MOUNTED_DRIVE_PATH.match(source.value)):
                    continue
                if is_reader or is_gdown or _DATASET_HINT.search(segment):
                    matches.add("UNVERIFIED_SOURCE")
        if not matches:
            continue
        if "EXTERNAL_SOURCE" in matches:
            overall = "EXTERNAL_SOURCE"
        elif "FOLDER_MEMBERSHIP_UNVERIFIED" in matches:
            overall = "FOLDER_MEMBERSHIP_UNVERIFIED"
        elif "UNVERIFIED_SOURCE" in matches:
            overall = "UNVERIFIED_SOURCE"
        else:
            overall = "MATCHED_RESOURCE"
        verified.append(SourceSignal(
            cell=signal.cell, start_line=signal.start_line, end_line=signal.end_line,
            snippet=_build_snippet(cell.lines, signal.start_line, signal.end_line),
            reason=signal.reason, match=overall, urls=urls,
            warning=overall != "MATCHED_RESOURCE",
        ))
    return verified


def find_resource_mentions(notebook: NormalizedNotebook, resources: list[dict]) -> list[ResourceMention]:
    """Quét text thô của từng CODE cell để nói tài nguyên BTC xuất hiện ở cell nào.

    Chỉ CODE cell: markdown thường chép đề bài kèm link nên không tính. Khớp mọi dạng URL của cùng
    file/folder qua `drive_identity`, hoặc ID thô đủ dài (gdown). Danh sách rỗng nghĩa là đã quét và
    không cell CODE nào nhắc tới; notebook bị lược cell thì dữ kiện cũng chỉ soi phần model đã thấy.
    """
    mentions = []
    for item in resources:
        identity = drive_identity(item["url"])
        if identity is None:
            continue
        cells = [
            cell.number
            for cell in notebook.cells
            if cell.kind == CELL_CODE and _mentions_identity("\n".join(cell.lines), identity)
        ]
        if cells:
            mentions.append(ResourceMention(label=item["label"], cells=cells))
    return mentions


def _mentions_identity(text: str, identity: tuple[str, str]) -> bool:
    if any(drive_identity(url.rstrip(".,;:!?")) == identity for url in _URL.findall(text)):
        return True
    identifier = identity[1]
    return len(identifier) >= _MIN_BARE_ID_CHARS and identifier in text
