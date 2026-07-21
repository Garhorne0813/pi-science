"""Read persisted pi session messages without activating the runtime."""

from __future__ import annotations

from pathlib import Path
from services.session_repository import SessionRepository


def find_session_file(session_id: str, cwd: str | Path) -> Path | None:
    return SessionRepository(cwd).find(session_id)


def read_session_messages(session_id: str, cwd: str | Path) -> list[dict]:
    return SessionRepository(cwd).messages(session_id)


def message_text(message: dict, max_chars: int = 12000) -> str:
    chunks: list[str] = []
    for part in message.get("content", []):
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text" and isinstance(part.get("text"), str):
            chunks.append(part["text"])
        elif part.get("type") in {"toolCall", "toolResult"}:
            name = part.get("name") or part.get("tool") or part.get("toolName") or "tool"
            chunks.append(f"[{part.get('type')}: {name}]")
    return "\n".join(chunks)[:max_chars]
