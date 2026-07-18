"""Small append-only session manifest for reproducibility metadata."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import aiofiles


def _manifest_path(workspace: str, name: str) -> Path:
    path = Path(workspace).expanduser().resolve() / ".pi-science" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


async def append_session_skill_snapshot(workspace: str, session_id: str, skills: list[dict[str, Any]]) -> dict:
    payload = {
        "type": "skill_snapshot",
        "session_id": session_id,
        "ts": time.time(),
        "skills": [
            {
                "skill_id": item.get("skill_id"),
                "name": item.get("name"),
                "digest": item.get("digest"),
                "source": item.get("source"),
                "enabled": bool(item.get("enabled", True)),
            }
            for item in skills
        ],
    }
    async with aiofiles.open(_manifest_path(workspace, "session-skills.jsonl"), "a", encoding="utf-8") as handle:
        await handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    return payload


async def append_skill_event(
    workspace: str,
    session_id: str,
    event: str,
    *,
    skill_id: str | None = None,
    skill_name: str | None = None,
    tool: str | None = None,
    status: str | None = None,
    duration_ms: float | None = None,
) -> dict:
    payload = {
        "type": "skill_event",
        "session_id": session_id,
        "ts": time.time(),
        "event": event,
        "skill_id": skill_id,
        "skill_name": skill_name,
        "tool": tool,
        "status": status,
        "duration_ms": duration_ms,
    }
    payload = {key: value for key, value in payload.items() if value is not None}
    async with aiofiles.open(_manifest_path(workspace, "skill-events.jsonl"), "a", encoding="utf-8") as handle:
        await handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    return payload


async def read_session_skills(workspace: str, session_id: str) -> dict | None:
    path = _manifest_path(workspace, "session-skills.jsonl")
    if not path.exists():
        return None
    latest = None
    async with aiofiles.open(path, "r", encoding="utf-8") as handle:
        async for line in handle:
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if payload.get("session_id") == session_id:
                latest = payload
    return latest


async def read_skill_events(workspace: str, session_id: str, limit: int = 200) -> list[dict]:
    path = _manifest_path(workspace, "skill-events.jsonl")
    if not path.exists():
        return []
    events: list[dict] = []
    async with aiofiles.open(path, "r", encoding="utf-8") as handle:
        async for line in handle:
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if payload.get("session_id") == session_id:
                events.append(payload)
    return events[-limit:]

