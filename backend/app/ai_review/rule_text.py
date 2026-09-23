"""Canonical hoá văn bản quy định - Hybrid B, tất định và không fuzzy.

Verifier đối chiếu ngữ nghĩa văn bản luật, nhưng model thường trả về bản đã bỏ marker trình bày
(bold, backtick, bullet, heading) hoặc xuống dòng ở chỗ khác. Canonicalizer chỉ bỏ phần TRÌNH BÀY và
gộp khoảng trắng: nó không case-fold, không bỏ số, không bỏ từ phủ định, không chuẩn hoá dấu câu và
không dùng edit-distance. Nhờ vậy hai câu khác nghĩa luôn khác canonical text, còn hai cách trình
bày của cùng một câu luôn bằng nhau.

Inline code là nội dung LITERAL chứ không phải trình bày: `__init__`, `*args`, `**kwargs` trong
backtick không được hiểu thành emphasis. Vì canonical text là chuỗi nội bộ (đi vào digest `rule_ref`
và tra cứu quote), canonicalizer mã hoá literal bằng escape ngược (`\\`, `\\*`, `\\_`, `` \\` ``,
`\\[`, `\\]`) để dấu câu trọng yếu không còn khả năng bị bóc ở lần chạy sau: mỗi cặp `\\<char>` được
shield nguyên trạng suốt vòng lặp, nên lần canonical tiếp theo tái tạo đúng chuỗi đó
(`c(c(x)) == c(x)`). Chỉ run `*`/`_` nằm trọn giữa hai ký tự chữ (`device_id`, `2*3*4`) mới được giữ
nguyên, vì nó không thể mở/đóng emphasis.

Model thường viết lại quote mà bỏ backtick, nên các dạng token lập trình trần (định danh dunder
`__init__`, tham số `*args`, `**kwargs`) cũng được nhận tất định và mã hoá về CÙNG dạng literal, để
nguồn có backtick và quote không backtick hội tụ về một canonical. Token nhận diện chỉ gồm ASCII:
`__được__`, `*được*` vẫn là emphasis Markdown như thường.

Toàn bộ transform chạy tới điểm bất động có chặn trần: bóc marker đầu dòng có thể làm lộ marker mới
sau khi gộp khoảng trắng (`"*\\na"` -> `"* a"` -> `"a"`), nên phải lặp cho tới khi ổn định mới
idempotent. Vòng lặp chỉ bóc marker đầu dòng thật của Markdown, không tự bịa marker từ nội dung giữa
câu. Đây là nguồn duy nhất cho hai việc: sinh digest `rule_ref` và tra cứu quote dự phòng.

Canonical text chỉ dùng nội bộ; `raw_text`/`rule_text` hiển thị và lưu trữ vẫn là nguồn nguyên văn.
"""

import re
import unicodedata

# Marker trình bày ở đầu dòng: heading ATX, blockquote (mọi cấp), marker danh sách. Cả ba đều buộc
# khớp ở đầu dòng, nếu không `* ` giữa câu hay số trong văn bản sẽ bị cắt mất. Marker danh sách bắt
# buộc có khoảng trắng phía sau, và `>` không được nuốt số, để `2024`, `>95`, `1.5` còn nguyên.
_ATX_MARKER = re.compile(r"^#{1,6}(?:[ \t]+|$)")
_BLOCKQUOTE_MARKER = re.compile(r"^>(?![0-9])[ \t]?")
_LIST_MARKER = re.compile(r"^(?:[-*+]|\d{1,9}[.)])[ \t]+")

_INLINE_CODE = re.compile(r"(`+)(.+?)\1", re.DOTALL)
_LINK_OR_IMAGE = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_REFERENCE_LINK = re.compile(r"\[([^\]]*)\]\[[^\]]*\]")
# `_`/`*` dính liền chữ-số không mở emphasis (theo CommonMark), nên `device_id`, `n_estimators`,
# `load_state_dict`, `next_label`, `2*3*4` giữ nguyên; `\w` bao gồm cả `_` nên `a_b_c` cũng vậy.
# DOTALL vì một cặp `**...**` hoàn toàn có thể bị ngắt giữa hai dòng khi văn bản được wrap lại.
_STRONG = re.compile(r"(?<!\w)(\*\*|__)(?!\s)(.+?)(?<!\s)\1(?!\w)", re.DOTALL)
_EMPHASIS = re.compile(r"(?<!\w)(\*|_)(?!\s)(.+?)(?<!\s)\1(?!\w)", re.DOTALL)

_WHITESPACE = re.compile(r"\s+")

# Placeholder bọc tạm literal trong lúc chạy vòng lặp. NUL không xuất hiện trong Markdown từ DB nên
# không thể đụng nội dung thật; chỉ số đảm bảo hai literal giống nhau vẫn được trả về đúng vị trí.
_PLACEHOLDER = "\x00{}\x00"

# Một cặp `\` + ký tự là escape do canonicalizer sinh ra (hoặc escape có sẵn của văn bản). Nó được
# shield nguyên trạng để vòng lặp không bóc mất; loại trừ NUL để backslash đứng ngay trước
# placeholder không nuốt mất chính placeholder đó.
_ESCAPED_CHAR = re.compile(r"\\(?!\x00).", re.DOTALL)

# Token lập trình trần. Chỉ ASCII và chữ thường ở đầu tên để `__AutoML__`, `__E-R1__`, `*được*`
# vẫn là emphasis Markdown. `*args*`, `a*b` bị loại bởi biên `(?<![\w*])`/`(?![\w*])`.
_BARE_DUNDER = re.compile(r"(?<!\w)__[a-z][A-Za-z0-9_]*[A-Za-z0-9]__(?!\w)")
_BARE_STAR_ARGS = re.compile(r"(?<![\w*])\*{1,2}[A-Za-z_][A-Za-z0-9_]*(?![\w*])")

# Một run các ký tự `*`/`_` liền nhau. Run nằm trọn giữa hai ký tự chữ không thể mở/đóng emphasis
# nên giữ nguyên; run khác phải escape để không bị hiểu thành delimiter ở lần canonical sau.
_EMPHASIS_RUN = re.compile(r"\*+|_+")

# Marker đầu dòng có thể lộ ra khi literal nằm ở đầu dòng. Chỉ escape ký tự mở marker; dạng số thứ
# tự `1.`/`1)` escape dấu chấm/ngoặc để `_LIST_MARKER` không còn khớp.
_LEADING_LINE_MARKER = re.compile(
    r"^[ \t]*(?:(?P<marker>[#>+-])|(?P<digits>\d{1,9})(?P<punct>[.)]))"
)

# Mỗi vòng lặp chỉ đổi được khi bóc bớt ký tự, nên hội tụ rất nhanh; trần 8 là dư cho độ lồng thực
# tế và giữ hàm luôn dừng kể cả với input bệnh lý.
_MAX_PASSES = 8


def canonicalize_rule_text(value: str) -> str:
    """Canonical tất định của một đoạn văn bản luật; idempotent và không phụ thuộc cách trình bày."""
    return _canonicalize(value, strip_line_markers=True)


def canonicalize_heading_text(value: str) -> str:
    """Canonical của text heading cho digest: bỏ inline formatting nhưng GIỮ số đánh mục.

    Heading `1. Phạm vi` phải giữ `1.` vì số thứ tự phân biệt hai mục khác nghĩa; đi qua
    `canonicalize_rule_text` thì `1.` bị bóc như marker danh sách và hai heading chung digest. Text
    đã được parser tách khỏi dòng nên không còn marker đầu dòng nào để bóc.
    """
    return _canonicalize(value, strip_line_markers=False)


def _canonicalize(value: str, *, strip_line_markers: bool) -> str:
    text, spans = _protect(_normalize_newlines(value))
    if strip_line_markers:
        # Bóc marker đầu dòng có thể lộ marker mới sau khi gộp khoảng trắng, nên chạy tới bất động.
        for _ in range(_MAX_PASSES):
            updated = _canonical_pass(text)
            if updated == text:
                break
            text = updated
    else:
        text = _collapse(_unwrap_inline(text))
    # Literal được trả về SAU vòng lặp (dạng đã escape) nên phải gộp khoảng trắng lần cuối: nội dung
    # literal nhiều dòng và khoảng trắng ở mép có thể sinh khoảng trắng đôi tại ranh giới ghép.
    return _collapse(_restore(text, spans))


def _normalize_newlines(value: str) -> str:
    text = unicodedata.normalize("NFC", value)
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _canonical_pass(text: str) -> str:
    text = "\n".join(_strip_line_markers(line) for line in text.split("\n"))
    return _collapse(_unwrap_inline(text))


def _protect(text: str) -> tuple[str, list[str]]:
    """Thay mọi literal bằng placeholder, giữ dạng đã escape trong `spans` để trả về sau vòng lặp."""
    spans: list[str] = []

    def _stash(value: str) -> str:
        spans.append(value)
        return _PLACEHOLDER.format(len(spans) - 1)

    # Code span trước tiên: nội dung trong backtick là literal, nên backslash bên trong do
    # `_escape_literal` xử lý chứ không phải escape Markdown của phần văn bản còn lại.
    text = _INLINE_CODE.sub(lambda match: _stash(_escape_literal(match.group(2))), text)
    # Escape đã có (kể cả do lần canonical trước sinh ra) được shield nguyên trạng để lần chạy sau
    # tái tạo đúng chuỗi đó thay vì bóc mất.
    text = _ESCAPED_CHAR.sub(lambda match: _stash(match.group(0)), text)
    # Token trần nhận cùng dạng literal đã escape như trong code, nên hai cách viết hội tụ. Dunder
    # nhận thẳng; star-args phải tránh span emphasis thật (`**C-R1 ...**` cũng mở bằng `**` + chữ).
    text = _stash_tokens(text, _BARE_DUNDER, _stash, skip_inside_emphasis=False)
    return _stash_tokens(text, _BARE_STAR_ARGS, _stash, skip_inside_emphasis=True), spans


def _stash_tokens(text: str, pattern: re.Pattern, stash, *, skip_inside_emphasis: bool) -> str:
    """Thay token khớp `pattern` bằng placeholder; bỏ qua token nằm trong một span emphasis thật."""
    protected = _emphasis_spans(text) if skip_inside_emphasis else ()
    pieces: list[str] = []
    cursor = 0
    for match in pattern.finditer(text):
        if any(start < match.end() and match.start() < end for start, end in protected):
            continue
        pieces.append(text[cursor : match.start()])
        pieces.append(stash(_escape_literal(match.group(0))))
        cursor = match.end()
    pieces.append(text[cursor:])
    return "".join(pieces)


def _emphasis_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    for pattern in (_STRONG, _EMPHASIS):
        spans.extend(match.span() for match in pattern.finditer(text))
    return spans


def _restore(text: str, spans: list[str]) -> str:
    for position, span in enumerate(spans):
        text = text.replace(_PLACEHOLDER.format(position), span)
    return text


def _escape_literal(content: str) -> str:
    """Mã hoá literal thành chuỗi bất động dưới mọi lần canonical sau.

    Backslash được nhân đôi trước tiên; dấu câu trọng yếu được prefix `\\`. Chỉ run `*`/`_` nằm trọn
    giữa hai ký tự chữ được giữ nguyên để `device_id`/`2*3*4` không bị đổi nghĩa.
    """
    escaped = content.replace("\\", "\\\\").replace("`", "\\`")
    if _LINK_OR_IMAGE.search(content) or _REFERENCE_LINK.search(content):
        # Chỉ escape ngoặc khi span thật sự là link/image/reference; `list[int]` giữ nguyên.
        escaped = escaped.replace("[", "\\[").replace("]", "\\]")
    escaped = _EMPHASIS_RUN.sub(lambda match: _escape_emphasis_run(match, escaped), escaped)
    return _escape_leading_line_marker(escaped)


def _escape_emphasis_run(match: re.Match, text: str) -> str:
    start, end = match.span()
    before = text[start - 1] if start else ""
    after = text[end] if end < len(text) else ""
    if _is_word_char(before) and _is_word_char(after):
        return match.group(0)
    return "".join("\\" + char for char in match.group(0))


def _is_word_char(char: str) -> bool:
    return char.isalnum() or char == "_"


def _escape_leading_line_marker(text: str) -> str:
    match = _LEADING_LINE_MARKER.match(text)
    if match is None:
        return text
    index = match.start("marker") if match.group("marker") else match.start("punct")
    return text[:index] + "\\" + text[index:]


def _collapse(text: str) -> str:
    return _WHITESPACE.sub(" ", text).strip()


def _strip_line_markers(line: str) -> str:
    """Bỏ đệ quy mọi lớp marker trình bày ở đầu dòng, giữ nguyên nội dung phía sau."""
    previous = None
    while line != previous:
        previous = line
        line = line.lstrip(" \t")
        line = _BLOCKQUOTE_MARKER.sub("", line, count=1)
        line = _LIST_MARKER.sub("", line, count=1)
        line = _ATX_MARKER.sub("", line, count=1)
    return line


def _unwrap_inline(text: str) -> str:
    """Lặp tới khi ổn định: construct lồng nhau vẫn về cùng kết quả, lần chạy thứ hai là no-op."""
    while True:
        unwrapped = _unwrap_once(text)
        if unwrapped == text:
            return text
        text = unwrapped


def _unwrap_once(text: str) -> str:
    # Literal (code span, token trần) đã được bọc placeholder từ trước, nên emphasis/link ở đây
    # không thể nuốt nội dung code (`__init__`, `*args`, `**kwargs`) dù delimiter nằm hai bên.
    text = _LINK_OR_IMAGE.sub(r"\1", text)
    text = _REFERENCE_LINK.sub(r"\1", text)
    text = _STRONG.sub(r"\2", text)
    return _EMPHASIS.sub(r"\2", text)
