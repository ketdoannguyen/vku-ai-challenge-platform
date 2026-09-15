"""Shared slug validation for competitions and content pages."""

import re

SLUG_MAX = 64
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def is_valid_slug(value: str) -> bool:
    return len(value) <= SLUG_MAX and bool(SLUG_RE.fullmatch(value))
