"""Small append-only session manifest for reproducibility metadata."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

import aiofiles
from config import BASE_DIR


def _manifest_paths(workspace: str, name: str) -> tuple[Path, Path]:
    resolved = Path(workspace).expanduser().resolve()
    primary = resolved / ".pi-science" / name
    workspace_key = hashlib.sha256(str(resolved).encode()).hexdigest()[:24]
    fallback = BASE_DIR / "workspace-metadata" / workspace_key / name
    return primary, fallback


async def _append_payload(workspace: str, name: str, payload: dict[str, Any]) -> None:
    last_error: OSError | None = None
    for path in _manifest_paths(workspace, name):
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            async with aiofiles.open(path, "a", encoding="utf-8") as handle:
                await handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
            return
        except OSError as exc:
            last_error = exc
    assert last_error is not None
    raise last_error


async def _read_payloads(workspace: str, name: str) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    for path in _manifest_paths(workspace, name):
        if not path.exists():
            continue
        try:
            async with aiofiles.open(path, "r", encoding="utf-8") as handle:
                async for line in handle:
                    try:
                        payload = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(payload, dict):
                        payloads.append(payload)
        except OSError:
            continue
    return payloads


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
    await _append_payload(workspace, "session-skills.jsonl", payload)
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
    await _append_payload(workspace, "skill-events.jsonl", payload)
    return payload


async def read_session_skills(workspace: str, session_id: str) -> dict | None:
    latest = None
    for payload in await _read_payloads(workspace, "session-skills.jsonl"):
        if payload.get("session_id") != session_id:
            continue
        if latest is None or float(payload.get("ts", 0) or 0) >= float(latest.get("ts", 0) or 0):
            latest = payload
    return latest


async def read_skill_events(workspace: str, session_id: str, limit: int = 200) -> list[dict]:
    events = [
        payload
        for payload in await _read_payloads(workspace, "skill-events.jsonl")
        if payload.get("session_id") == session_id
    ]
    events.sort(key=lambda payload: float(payload.get("ts", 0) or 0))
    return events[-limit:]
