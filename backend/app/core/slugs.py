"""Shared slug validation and generation for competitions, content pages and account artifacts."""

import re
import unicodedata

SLUG_MAX = 64
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

_NON_SLUG = re.compile(r"[^a-z0-9]+")

# `Đ`/`đ` không có phân rã NFKD nên `encode("ascii", "ignore")` sẽ nuốt mất chữ cái đầu của tên
# tiếng Việt ("Đội" -> "oi"). Các nguyên âm còn lại (ă â ê ô ơ ư) tự tách được qua NFKD.
VIETNAMESE_ASCII_FALLBACK = str.maketrans({"Đ": "D", "đ": "d"})


def is_valid_slug(value: str) -> bool:
    return len(value) <= SLUG_MAX and bool(SLUG_RE.fullmatch(value))


def slugify(value: str) -> str:
    """Slug hoá text tự do (tên đội, tiêu đề): bỏ dấu, lowercase, gom run ngoài `[a-z0-9]` thành `-`.

    Trả `""` khi không còn ký tự nào dùng được - caller tự quyết định fallback.
    """
    stripped = (
        unicodedata.normalize("NFKD", (value or "").translate(VIETNAMESE_ASCII_FALLBACK))
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    return _NON_SLUG.sub("-", stripped.lower()).strip("-")[:SLUG_MAX].strip("-")
