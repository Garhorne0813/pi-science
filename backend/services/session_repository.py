"""Durable Pi session discovery and message parsing."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import ClassVar, Iterator

from config import get_sessions_dir
from models import SessionInfo


@dataclass(frozen=True)
class _SessionRecord:
    path: Path
    modified: float
    header: dict


class SessionRepository:
    """One interface for the workspace-local JSONL session tree."""

    _index_cache: ClassVar[dict[Path, tuple[float, tuple[_SessionRecord, ...]]]] = {}
    _index_ttl_seconds: ClassVar[float] = 1.0

    def __init__(self, cwd: str | Path):
        self.cwd = Path(cwd).expanduser().resolve()
        self.root = get_sessions_dir(str(self.cwd))

    def _files(self) -> Iterator[Path]:
        if self.root.exists():
            yield from self.root.rglob("*.jsonl")

    def _index(self, *, force: bool = False) -> tuple[_SessionRecord, ...]:
        key = self.root.resolve()
        now = time.monotonic()
        cached = self._index_cache.get(key)
        if not force and cached and cached[0] > now:
            return cached[1]
        records: list[_SessionRecord] = []
        for path in self._files():
            header = self._header(path)
            if not header:
                continue
            try:
                records.append(_SessionRecord(path.resolve(), path.stat().st_mtime, header))
            except OSError:
                continue
        result = tuple(sorted(records, key=lambda record: record.modified, reverse=True))
        self._index_cache[key] = (now + self._index_ttl_seconds, result)
        return result

    @staticmethod
    def _header(path: Path) -> dict | None:
        try:
            with path.open(encoding="utf-8") as handle:
                value = json.loads(handle.readline())
            return value if value.get("type") == "session" else None
        except (OSError, json.JSONDecodeError, AttributeError):
            return None

    def find(self, session_id: str) -> Path | None:
        cached = self._index_cache.get(self.root.resolve())
        cache_was_fresh = bool(cached and cached[0] > time.monotonic())
        for record in self._index():
            if record.header.get("id") == session_id:
                return record.path
        # Pi writes session files outside this repository. Refresh immediately
        # on a miss so the TTL never hides a newly persisted conversation.
        if cache_was_fresh:
            for record in self._index(force=True):
                if record.header.get("id") == session_id:
                    return record.path
        return None

    def latest_id(self) -> str | None:
        for record in self._index():
            if record.header.get("id"):
                return str(record.header["id"])
        return None

    def list(self) -> list[SessionInfo]:
        records: list[SessionInfo] = []
        for record in self._index():
            path, header = record.path, record.header
            records.append(SessionInfo(
                id=header.get("id", path.stem),
                cwd=header.get("cwd", ""),
                name=None,
                created_at=header.get("timestamp"),
                updated_at=datetime.fromtimestamp(record.modified, tz=timezone.utc),
            ))
        return records

    def count(self) -> int:
        return len(self._index())

    def messages(self, session_id: str, *, include_tool_fields: bool = False) -> list[dict]:
        path = self.find(session_id)
        if path is None:
            return []
        messages: list[dict] = []
        try:
            with path.open(encoding="utf-8") as handle:
                for line in handle:
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if entry.get("type") != "message":
                        continue
                    message = entry.get("message", {})
                    row = {
                        "id": entry.get("id", ""),
                        "role": message.get("role", ""),
                        "content": message.get("content", []),
                        "timestamp": entry.get("timestamp"),
                    }
                    if include_tool_fields:
                        row.update({
                            "toolCallId": message.get("toolCallId"),
                            "toolName": message.get("toolName"),
                            "isError": message.get("isError", False),
                        })
                    messages.append(row)
        except OSError:
            return []
        return messages
