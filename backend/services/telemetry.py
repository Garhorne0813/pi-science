"""Local, privacy-preserving operational event records."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import aiofiles


_SECRET_KEYS = {"api_key", "apikey", "authorization", "token", "secret", "password"}


def _redact(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        return "[truncated]"
    if isinstance(value, dict):
        return {str(key): "[redacted]" if str(key).lower() in _SECRET_KEYS else _redact(item, depth + 1) for key, item in list(value.items())[:50]}
    if isinstance(value, list):
        return [_redact(item, depth + 1) for item in value[:50]]
    if isinstance(value, str):
        return value[:1000]
    return value


async def record_metric(workspace: str, event: str, status: str, *, duration_ms: float | None = None, metadata: dict[str, Any] | None = None) -> None:
    path = Path(workspace).expanduser().resolve() / ".pi-science" / "observability.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"ts": time.time(), "event": event, "status": status}
    if duration_ms is not None:
        payload["duration_ms"] = round(duration_ms, 3)
    if metadata:
        payload["metadata"] = _redact(metadata)
    async with aiofiles.open(path, "a", encoding="utf-8") as handle:
        await handle.write(json.dumps(payload, ensure_ascii=False) + "\n")

