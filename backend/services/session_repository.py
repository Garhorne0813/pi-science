"""Durable Pi session discovery and message parsing."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from config import get_sessions_dir
from models import SessionInfo


class SessionRepository:
    """One interface for the workspace-local JSONL session tree."""

    def __init__(self, cwd: str | Path):
        self.cwd = Path(cwd).expanduser().resolve()
        self.root = get_sessions_dir(str(self.cwd))

    def _files(self) -> Iterator[Path]:
        if self.root.exists():
            yield from self.root.rglob("*.jsonl")

    @staticmethod
    def _header(path: Path) -> dict | None:
        try:
            with path.open(encoding="utf-8") as handle:
                value = json.loads(handle.readline())
            return value if value.get("type") == "session" else None
        except (OSError, json.JSONDecodeError, AttributeError):
            return None

    def find(self, session_id: str) -> Path | None:
        for path in self._files():
            header = self._header(path)
            if header and header.get("id") == session_id:
                return path.resolve()
        return None

    def latest_id(self) -> str | None:
        paths = sorted(self._files(), key=lambda path: path.stat().st_mtime, reverse=True)
        for path in paths:
            header = self._header(path)
            if header and header.get("id"):
                return str(header["id"])
        return None

    def list(self) -> list[SessionInfo]:
        records: list[SessionInfo] = []
        paths = sorted(self._files(), key=lambda path: path.stat().st_mtime, reverse=True)
        for path in paths:
            header = self._header(path)
            if not header:
                continue
            records.append(SessionInfo(
                id=header.get("id", path.stem),
                cwd=header.get("cwd", ""),
                name=None,
                created_at=header.get("timestamp"),
                updated_at=datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc),
            ))
        return records

    def count(self) -> int:
        return sum(1 for path in self._files() if self._header(path))

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
