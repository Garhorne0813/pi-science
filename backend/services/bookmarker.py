"""Deterministic transcript breadcrumbs for durable session navigation."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import aiofiles

from services.session_reader import message_text, read_session_messages


_SIGNALS = re.compile(r"\b(?:result|conclusion|finding|decision|saved|created|verified|completed|结果|结论|决定|已保存|已生成)\b", re.I)


async def create_bookmarks(workspace: str, session_id: str) -> list[dict]:
    messages = read_session_messages(session_id, workspace)
    candidates: list[dict] = []
    for message in reversed(messages):
        text = message_text(message, max_chars=2000).strip()
        if not text or not _SIGNALS.search(text):
            continue
        first_line = next((line.strip() for line in text.splitlines() if line.strip()), text)
        candidates.append({"session_id": session_id, "message_id": message.get("id", ""), "quote": first_line[:500]})
        if len(candidates) >= 2:
            break
    candidates.reverse()
    payload = {"session_id": session_id, "created_at": time.time(), "bookmarks": candidates}
    path = Path(workspace) / ".pi-science" / "bookmarks.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    async with aiofiles.open(path, "a", encoding="utf-8") as handle:
        await handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    return candidates

