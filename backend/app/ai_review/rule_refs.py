"""Phân đoạn Competition Content và sinh `rule_ref` ổn định - Hybrid D.

Backend tự cắt revision thành các block có thể trích dẫn, băm mỗi block thành một ID mờ, rồi đưa
ID đó vào prompt. Model chỉ được nhắc lại ID; title/slug/rule text luôn do backend điền lại từ
revision, nên prose của model không bao giờ trở thành nguồn sự thật.

Parser là line-based chứ không phải một Markdown engine: nó nhận đúng các cấu trúc xuất hiện trong
thể lệ thật (ATX/Setext heading, đoạn văn, list item kèm dòng nối, blockquote, hàng dữ liệu GFM) và
cố tình bỏ qua phần còn lại. Fenced code vẫn được gửi nguyên trong policy context nhưng không sinh
`rule_ref` vì ví dụ trong thể lệ không phải quy định; fence chưa đóng được coi là code tới hết trang
nên phần đuôi không thể trích dẫn.

Digest 96-bit tính trên `canonical(slug) + heading path canonical + canonical text`, có salt
`RULE_REF_VERSION`/`CANONICALIZATION_VERSION`: đổi formatting hay reflow giữ nguyên ref, đổi chữ,
số, phủ định hoặc heading context là đổi ref. Block trùng canonical trong cùng namespace được phân
biệt bằng hậu tố occurrence; quote fallback không resolve khi có nhiều candidate.
"""

import hashlib
import re
from collections import Counter
from dataclasses import dataclass

from app.ai_review import constants
from app.ai_review.rule_text import canonicalize_heading_text, canonicalize_rule_text

KIND_PARAGRAPH = "PARAGRAPH"
KIND_LIST_ITEM = "LIST_ITEM"
KIND_BLOCKQUOTE = "BLOCKQUOTE"
KIND_TABLE_ROW = "TABLE_ROW"

DUPLICATE_PAGE_SLUG = "DUPLICATE_PAGE_SLUG"

# 96-bit là đủ để hai block khác nhau trong một revision thật không đụng nhau, mà ref vẫn ngắn.
DIGEST_BYTES = 12
_UNIT_SEPARATOR = "\x1f"

_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_FENCE_CLOSING = re.compile(r"^ {0,3}(`{3,}|~{3,})[ \t]*$")
_ATX_HEADING = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$")
_CLOSING_HASHES = re.compile(r"[ \t]+#+[ \t]*$")
_SETEXT_UNDERLINE = re.compile(r"^ {0,3}(=+|-+)[ \t]*$")
_BLOCKQUOTE = re.compile(r"^ {0,3}>")
_LIST_ITEM = re.compile(r"^ *(?:[-*+]|\d{1,9}[.)])[ \t]+")
_TABLE_ROW = re.compile(r"^[ \t]*\|.*\|[ \t]*$")
_TABLE_SEPARATOR = re.compile(r"^[ \t]*\|?[\s:|-]*-[\s:|-]*\|?[ \t]*$")


class RuleIndexError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class RuleBlock:
    ref: str
    page_slug: str
    page_title: str
    page_order: int
    heading_path: tuple[str, ...]
    kind: str
    raw_text: str
    canonical_text: str
    start_line: int
    end_line: int


@dataclass(frozen=True)
class RuleIndex:
    blocks: tuple[RuleBlock, ...]
    by_ref: dict[str, RuleBlock]
    by_page: dict[str, tuple[RuleBlock, ...]]
    by_canonical: dict[str, tuple[RuleBlock, ...]]

    def get(self, ref: str) -> RuleBlock | None:
        return self.by_ref.get(ref)

    def candidates_for_quote(self, text: str) -> tuple[RuleBlock, ...]:
        """Mọi block có canonical text bằng đúng canonical của `text` - rỗng, một, hoặc nhiều.

        Trả về cả danh sách thay vì tự chọn giúp người gọi phân biệt được "không khớp quy định nào"
        với "khớp nhiều quy định": hai tình huống đó cần chẩn đoán khác nhau.
        """
        return self.by_canonical.get(canonicalize_rule_text(text), ())


@dataclass(frozen=True)
class _BlockDraft:
    page_slug: str
    page_title: str
    page_order: int
    heading_path: tuple[str, ...]
    kind: str
    raw_text: str
    canonical_text: str
    start_line: int
    end_line: int
    digest: str


def build_rule_index(pages: list[dict]) -> RuleIndex:
    """Dựng index từ đúng `revision["pages"]`; fail closed nếu revision có slug trùng bất thường."""
    seen_slugs: set[str] = set()
    for page in pages:
        slug = page["slug"]
        if slug in seen_slugs:
            raise RuleIndexError(
                DUPLICATE_PAGE_SLUG, f"Hai trang nội dung cùng slug '{slug}'."
            )
        seen_slugs.add(slug)

    drafts = [draft for page in pages for draft in _page_drafts(page)]
    occurrences = Counter((draft.page_slug, draft.digest) for draft in drafts)
    seen: Counter = Counter()

    blocks: list[RuleBlock] = []
    for draft in drafts:
        key = (draft.page_slug, draft.digest)
        suffix = ""
        if occurrences[key] > 1:
            seen[key] += 1
            suffix = f"~{seen[key]}"
        blocks.append(
            RuleBlock(
                ref=f"{draft.page_slug}#{draft.digest}{suffix}",
                page_slug=draft.page_slug,
                page_title=draft.page_title,
                page_order=draft.page_order,
                heading_path=draft.heading_path,
                kind=draft.kind,
                raw_text=draft.raw_text,
                canonical_text=draft.canonical_text,
                start_line=draft.start_line,
                end_line=draft.end_line,
            )
        )

    by_page: dict[str, list[RuleBlock]] = {}
    by_canonical: dict[str, list[RuleBlock]] = {}
    for block in blocks:
        by_page.setdefault(block.page_slug, []).append(block)
        by_canonical.setdefault(block.canonical_text, []).append(block)
    return RuleIndex(
        blocks=tuple(blocks),
        by_ref={block.ref: block for block in blocks},
        by_page={slug: tuple(items) for slug, items in by_page.items()},
        by_canonical={text: tuple(items) for text, items in by_canonical.items()},
    )


def render_annotated_policy(pages: list[dict], index: RuleIndex) -> str:
    """Render lại policy kèm marker `[RULE_REF ...]` trước mỗi block có thể trích dẫn.

    Mọi dòng nguồn được phát đúng một lần, theo đúng thứ tự trang; marker là phần duy nhất được
    thêm vào, nên code example và ngữ cảnh không bị mất hay lặp.
    """
    rendered: list[str] = []
    for position, page in enumerate(pages, start=1):
        rendered.append(
            f"=== PAGE {position} | slug={page['slug']} | order={page['order']} | "
            f"{page['title']} ==="
        )
        starts = {block.start_line: block.ref for block in index.by_page.get(page["slug"], ())}
        for number, line in enumerate(_split_markdown(page["markdown"]), start=1):
            ref = starts.get(number)
            if ref is not None:
                rendered.append(f"[RULE_REF {ref}]")
            rendered.append(line)
        rendered.append("")
    return "\n".join(rendered)


def _page_drafts(page: dict) -> list[_BlockDraft]:
    lines = _split_markdown(page["markdown"])
    drafts: list[_BlockDraft] = []
    heading_path: tuple[str, ...] = ()
    for event in _scan_blocks(lines):
        if event[0] == "heading":
            _, level, text = event
            heading_path = (*heading_path[: level - 1], text)
            continue
        _, kind, start, end = event
        raw_text = "\n".join(lines[start : end + 1])
        canonical_text = canonicalize_rule_text(raw_text)
        if not canonical_text:
            continue
        drafts.append(
            _BlockDraft(
                page_slug=page["slug"],
                page_title=page["title"],
                page_order=page["order"],
                heading_path=heading_path,
                kind=kind,
                raw_text=raw_text,
                canonical_text=canonical_text,
                start_line=start + 1,
                end_line=end + 1,
                digest=_digest(page["slug"], heading_path, canonical_text),
            )
        )
    return drafts


def _scan_blocks(lines: list[str]) -> list[tuple]:
    """Event theo thứ tự tài liệu: `("heading", level, text)` hoặc `("block", kind, start, end)`."""
    events: list[tuple] = []
    index = 0
    total = len(lines)
    fence = ""
    while index < total:
        line = lines[index]
        if fence:
            # Fence chỉ đóng bằng ĐÚNG ký tự đã mở và không ngắn hơn, nếu không `~~~` trong một
            # code block ``` sẽ cắt đôi block và biến phần đuôi thành nội dung trích dẫn được.
            closing = _FENCE_CLOSING.match(line)
            if closing and closing.group(1)[0] == fence[0] and len(closing.group(1)) >= len(fence):
                fence = ""
            index += 1
            continue
        opening = _FENCE.match(line)
        if opening:
            fence = opening.group(1)
            index += 1
            continue
        if not line.strip():
            index += 1
            continue

        heading = _ATX_HEADING.match(line)
        if heading is not None:
            text = _CLOSING_HASHES.sub("", heading.group(2) or "").strip()
            if text:
                events.append(("heading", len(heading.group(1)), text))
            index += 1
            continue

        if _SETEXT_UNDERLINE.match(line):
            if _extends_paragraph(events, index):
                _, _, start, _ = events.pop()
                level = 1 if line.strip()[0] == "=" else 2
                events.append(("heading", level, " ".join(lines[start:index]).strip()))
            # `---`/`===` đứng một mình là đường kẻ ngang, không phải nội dung trích dẫn được.
            index += 1
            continue

        if _BLOCKQUOTE.match(line):
            start = index
            while index < total and _BLOCKQUOTE.match(lines[index]):
                index += 1
            events.append(("block", KIND_BLOCKQUOTE, start, index - 1))
            continue

        if _LIST_ITEM.match(line):
            start = index
            index += 1
            while index < total and lines[index].strip() and not _starts_new_block(lines[index]):
                index += 1
            events.append(("block", KIND_LIST_ITEM, start, index - 1))
            continue

        if _TABLE_ROW.match(line):
            if index + 1 < total and _TABLE_SEPARATOR.match(lines[index + 1]):
                # Header và dòng phân cách là phần trình bày của bảng, không mang quy định.
                index += 2
                while index < total and _TABLE_ROW.match(lines[index]):
                    events.append(("block", KIND_TABLE_ROW, index, index))
                    index += 1
                continue
            events.append(("block", KIND_TABLE_ROW, index, index))
            index += 1
            continue

        start = index
        index += 1
        while index < total and lines[index].strip() and not _starts_new_block(lines[index]):
            index += 1
        events.append(("block", KIND_PARAGRAPH, start, index - 1))
    return events


def _extends_paragraph(events: list[tuple], index: int) -> bool:
    """Setext underline chỉ có nghĩa khi dính liền ngay sau một đoạn văn đang mở."""
    return (
        bool(events)
        and events[-1][0] == "block"
        and events[-1][1] == KIND_PARAGRAPH
        and events[-1][3] == index - 1
    )


def _starts_new_block(line: str) -> bool:
    return bool(
        _FENCE.match(line)
        or _ATX_HEADING.match(line)
        or _SETEXT_UNDERLINE.match(line)
        or _BLOCKQUOTE.match(line)
        or _LIST_ITEM.match(line)
        or _TABLE_ROW.match(line)
    )


def _digest(page_slug: str, heading_path: tuple[str, ...], canonical_text: str) -> str:
    parts = (
        constants.RULE_REF_VERSION,
        constants.CANONICALIZATION_VERSION,
        canonicalize_rule_text(page_slug),
        # Heading `1. Phạm vi` phải giữ số đánh mục: bóc như marker danh sách sẽ khiến hai heading
        # `1. ...`/`2. ...` chung digest dù ngữ cảnh khác nhau.
        *(canonicalize_heading_text(heading) for heading in heading_path),
        canonical_text,
    )
    payload = _UNIT_SEPARATOR.join(parts).encode("utf-8")
    return hashlib.blake2b(payload, digest_size=DIGEST_BYTES).hexdigest()


def _split_markdown(markdown: str) -> list[str]:
    """Tách dòng tất định: CRLF/CR về LF, newline cuối cùng không sinh thêm dòng rỗng."""
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines
