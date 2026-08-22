from __future__ import annotations

import re
import uuid

_KIND_PREFIX = {
    "character": "chr",
    "location": "loc",
    "organization": "org",
    "concept": "con",
    "plot": "plot",
    "canon": "canon",
    "event": "evt",
    "scene": "scn",
    "relationship": "rel",
}

_ID_RE = re.compile(r"^(?P<prefix>[a-z]+)_(?P<body>[0-9a-f]{32})$")


def new_id(kind: str) -> str:
    """Create a stable typed identifier independent of names and paths."""
    try:
        prefix = _KIND_PREFIX[kind]
    except KeyError as exc:
        raise ValueError(f"unsupported id kind: {kind}") from exc
    return f"{prefix}_{uuid.uuid4().hex}"


def validate_id(value: str, kind: str | None = None) -> bool:
    match = _ID_RE.fullmatch(value)
    if not match:
        return False
    if kind is None:
        return match.group("prefix") in _KIND_PREFIX.values()
    return match.group("prefix") == _KIND_PREFIX.get(kind)
