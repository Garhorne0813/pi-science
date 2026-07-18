"""Treat fetched documents and connector results as untrusted evidence."""

from __future__ import annotations

import re


_INJECTION_PATTERNS = (
    re.compile(r"ignore\s+(?:all\s+)?previous\s+instructions", re.I),
    re.compile(r"you\s+are\s+now\s+the\s+system", re.I),
    re.compile(r"(?:run|execute)\s+(?:this\s+)?(?:shell|bash|python)\s+command", re.I),
    re.compile(r"(?:send|upload|exfiltrate)\s+.*(?:secret|token|key)", re.I),
)


def inspect_untrusted_text(text: str, max_chars: int = 100_000) -> dict:
    value = str(text or "")[:max_chars]
    signals = [pattern.pattern for pattern in _INJECTION_PATTERNS if pattern.search(value)]
    return {
        "text": value,
        "trusted": False,
        "injection_signals": signals,
        "requires_review": bool(signals),
    }

