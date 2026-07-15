"""Session management API — CRUD + SSE event streaming."""

import asyncio
import json
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from sse_starlette.sse import EventSourceResponse

from config import get_sessions_dir
from models import (
    CreateSessionRequest,
    CreateSessionResponse,
    SessionInfo,
    PromptRequest,
)
from services.pi_manager import pi_manager
from services.event_normalizer import normalize_event
from services.provenance_store import get_store
from services.reviewer_service import schedule_auto_review

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.post("", response_model=CreateSessionResponse)
async def create_session(body: CreateSessionRequest):
    """Create a new agent session (spawns pi RPC process if needed)."""
    # If a pi process already exists for this cwd, reuse it via new_session
    existing = pi_manager.get_by_cwd(body.cwd)
    if existing and existing.is_alive:
        result = await existing.send_command("new_session")
        if result.get("success"):
            return CreateSessionResponse(id=existing.session_id, cwd=body.cwd)
        # new_session failed — return existing session id rather than spawning a duplicate
        if existing.session_id:
            return CreateSessionResponse(id=existing.session_id, cwd=body.cwd)

    # No existing process, spawn a new one (protected by per-cwd mutex)
    pi = await pi_manager.get_or_spawn(
        cwd=body.cwd,
        session_dir=str(get_sessions_dir(body.cwd)),
        config=body.config,
    )
    return CreateSessionResponse(id=pi.session_id, cwd=body.cwd)


@router.get("", response_model=list[SessionInfo])
async def list_sessions(cwd: str = Query(..., description="Working directory")):
    """List all sessions for a working directory."""
    session_dir = get_sessions_dir(cwd)
    if not session_dir.exists():
        return []

    sessions = []
    for f in sorted(session_dir.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            header = _parse_session_header(f)
            if header:
                sessions.append(header)
        except Exception:
            continue

    return sessions


@router.delete("/{session_id}")
async def delete_session(
    session_id: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Delete a session file from disk. Searches all known locations."""
    import glob as glob_mod
    from config import BASE_DIR, WORKSPACES_DIR

    patterns = [
        # CWD-local sessions
        str(Path(cwd).resolve() / ".pi-science" / "sessions" / "**" / f"*{session_id}*.jsonl"),
        # All workspaces
        str(WORKSPACES_DIR / "**" / ".pi-science" / "sessions" / "**" / f"*{session_id}*.jsonl"),
        # Centralized old location
        str(BASE_DIR / "sessions" / "**" / f"*{session_id}*.jsonl"),
    ]

    deleted = False
    for pattern in patterns:
        for path in glob_mod.glob(pattern, recursive=True):
            Path(path).unlink()
            deleted = True

    if deleted:
        return {"ok": True}
    return {"ok": False, "error": "session not found"}


@router.get("/{session_id}/messages")
async def get_messages(session_id: str):
    """Get message history for a session. Falls back to reading JSONL from disk."""
    pi = pi_manager.get_by_session(session_id)
    if pi:
        result = await pi.send_command("get_entries")
        if result.get("success"):
            messages = _convert_entries_to_messages(result.get("data", {}))
            return {"messages": messages}

    # Session not active — read from disk
    messages = _read_session_from_disk(session_id)
    return {"messages": messages}


@router.post("/{session_id}/prompt")
async def send_prompt(session_id: str, body: PromptRequest):
    """Send a user prompt to the agent. Streams response via SSE at /events."""
    pi = pi_manager.get_by_session(session_id)
    if not pi:
        return {"ok": False, "error": "session not found"}

    await pi.send_command("prompt", message=body.message)
    return {"ok": True}


@router.post("/{session_id}/abort")
async def abort_session(session_id: str):
    """Interrupt the current agent turn."""
    pi = pi_manager.get_by_session(session_id)
    if not pi:
        return {"ok": False, "error": "session not found"}

    await pi.send_command("abort")
    return {"ok": True}


@router.get("/{session_id}/commands")
async def get_session_commands(session_id: str):
    """Get all available slash commands including skills for this session."""
    pi = pi_manager.get_by_session(session_id)
    if not pi:
        return {"commands": []}

    result = await pi.send_command("get_commands")
    commands = []
    if result.get("success") and result.get("data"):
        commands = result["data"].get("commands", [])
    return {"commands": commands}


@router.post("/{session_id}/compact")
async def compact_session(session_id: str):
    """Manually trigger context compaction for the session."""
    pi = pi_manager.get_by_session(session_id)
    if not pi:
        return {"ok": False, "error": "session not found"}

    result = await pi.send_command("compact")
    return {"ok": result.get("success", False)}


@router.get("/{session_id}/export")
async def export_session(
    session_id: str,
    format: str = Query("html", description="Export format: html or jsonl"),
):
    """Export a session as HTML or JSONL."""
    import html as html_mod

    messages = _read_session_from_disk(session_id)
    if not messages:
        # Try active session
        pi = pi_manager.get_by_session(session_id)
        if pi:
            result = await pi.send_command("get_entries")
            if result.get("success"):
                messages = _convert_entries_to_messages(result.get("data", {}))

    if not messages:
        raise HTTPException(status_code=404, detail="Session not found")

    if format == "jsonl":
        import io
        buf = io.StringIO()
        for m in messages:
            buf.write(json.dumps(m, ensure_ascii=False) + "\n")
        from fastapi.responses import Response
        return Response(
            content=buf.getvalue(),
            media_type="application/x-ndjson",
            headers={"Content-Disposition": f'attachment; filename="session-{session_id[:8]}.jsonl"'},
        )

    # HTML export
    title = f"Session {session_id[:8]}"
    rows: list[str] = []
    for m in messages:
        role = m.get("role", "unknown")
        content = m.get("content", [])
        text_parts: list[str] = []
        for c in content if isinstance(content, list) else []:
            if isinstance(c, dict) and c.get("type") == "text":
                text_parts.append(c.get("text", ""))
            elif isinstance(c, str):
                text_parts.append(c)
        body = html_mod.escape("\n".join(text_parts)).replace("\n", "<br>")
        role_label = {"user": "🧑 You", "assistant": "🤖 Assistant"}.get(role, role)
        rows.append(
            f'<div style="margin:12px 0;padding:12px;border-radius:8px;'
            f'background:{ "#f0f4f8" if role == "user" else "#fff" };">'
            f'<div style="font-size:11px;color:#888;margin-bottom:6px;">{html_mod.escape(role_label)}</div>'
            f'<div style="font-size:14px;line-height:1.6;">{body}</div></div>'
        )
    html = (
        f"<!DOCTYPE html><html><head><meta charset=utf-8><title>{html_mod.escape(title)}</title>"
        f'<style>body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
        f"max-width:760px;margin:40px auto;padding:0 20px;background:#fafafa;}}</style></head>"
        f"<body><h1>{html_mod.escape(title)}</h1>{''.join(rows)}</body></html>"
    )
    from fastapi.responses import HTMLResponse
    return HTMLResponse(
        content=html,
        headers={"Content-Disposition": f'attachment; filename="session-{session_id[:8]}.html"'},
    )


@router.get("/{session_id}/events")
async def stream_events(session_id: str, request: Request):
    """SSE event stream — bridges pi JSONL events to SSE for the frontend."""
    pi = pi_manager.get_by_session(session_id)
    if not pi:
        return EventSourceResponse(_error_stream("session not found"))

    async def event_generator():
        had_text = False  # Track if any non-empty text was emitted this turn
        try:
            async for event in pi.read_events():
                if await request.is_disconnected():
                    break

                _maybe_record_provenance(event, session_id, pi.cwd)

                # Track whether we got any real text
                if event.get("type") == "message_update":
                    ae = event.get("assistantMessageEvent", {})
                    text = ae.get("text") or ae.get("delta") or ""
                    if text.strip():
                        had_text = True

                normalized = normalize_event(event, session_id)
                if normalized is None:
                    continue

                # If agent settles without producing any text, emit an error
                if event.get("type") == "agent_settled" and not had_text:
                    yield {
                        "event": "error",
                        "data": json.dumps({
                            "type": "error",
                            "sessionId": session_id,
                            "message": (
                                "The model returned an empty response. Possible causes:\n"
                                "- Incorrect API key or model ID\n"
                                "- Unsupported thinking level\n"
                                "- Network or API issue\n"
                                "Check Settings → API Keys."
                            ),
                        }),
                    }
                    # Don't yield the session.idle for this turn
                    had_text = False
                    continue

                event_type = normalized.get("type", "message")
                yield {
                    "event": event_type,
                    "data": json.dumps(normalized, ensure_ascii=False),
                }

                if event.get("type") == "agent_settled":
                    had_text = False  # Reset for next turn
                    schedule_auto_review(pi.cwd, session_id)
        except Exception as e:
            yield {
                "event": "error",
                "data": json.dumps({
                    "type": "error",
                    "sessionId": session_id,
                    "message": str(e),
                }),
            }

    return EventSourceResponse(event_generator())


async def _error_stream(message: str):
    """Generate a single error event."""
    yield {
        "event": "error",
        "data": json.dumps({"type": "error", "message": message}),
    }


def _maybe_record_provenance(event: dict, session_id: str, cwd: str):
    """Auto-record provenance entry when a file-writing tool completes."""
    if event.get("type") != "tool_execution_end":
        return
    if event.get("isError"):
        return

    tool_name = event.get("toolName", "")
    result = event.get("result", {})

    # Determine the file path from tool arguments
    if tool_name == "write":
        file_path = event.get("args", {}).get("file_path", "")
        content = event.get("args", {}).get("content", event.get("args", {}).get("text", ""))
    elif tool_name == "edit":
        file_path = event.get("args", {}).get("file_path", "")
        content = None
        diff = result.get("diff") if isinstance(result, dict) else None
    elif tool_name == "bash":
        # Bash doesn't have a clear file path; skip for now
        return
    else:
        return

    if not file_path:
        return

    try:
        store = get_store(cwd)
        loop = asyncio.get_event_loop()
        loop.create_task(store.record(
            path=file_path,
            session_id=session_id,
            tool=tool_name,
            tool_call_id=event.get("toolCallId"),
            content=content if (tool_name == "write" and content) else None,
            diff=diff if tool_name == "edit" else None,
        ))
    except Exception:
        pass  # Provenance is best-effort, never block the SSE stream


# ── Helpers ──

def _parse_session_header(filepath: Path) -> Optional[SessionInfo]:
    """Parse the header line of a pi session JSONL file."""
    try:
        with open(filepath) as f:
            first_line = f.readline().strip()
            if not first_line:
                return None
            data = json.loads(first_line)
            if data.get("type") != "session":
                return None
            from datetime import datetime, timezone
            mtime = filepath.stat().st_mtime
            return SessionInfo(
                id=data.get("id", filepath.stem),
                cwd=data.get("cwd", ""),
                name=None,
                created_at=data.get("timestamp"),
                updated_at=datetime.fromtimestamp(mtime, tz=timezone.utc),
            )
    except Exception:
        return None


def _read_session_from_disk(session_id: str) -> list[dict]:
    """Read session messages directly from the JSONL file on disk.
    Searches both the centralized dir and workspace-local .pi-science/sessions/."""
    import glob as glob_mod
    from config import BASE_DIR, WORKSPACES_DIR

    patterns = [
        str(BASE_DIR / "sessions" / "**" / f"*{session_id}*.jsonl"),
        str(WORKSPACES_DIR / "**" / ".pi-science" / "sessions" / "**" / f"*{session_id}*.jsonl"),
    ]
    matches = []
    for pattern in patterns:
        matches.extend(glob_mod.glob(pattern, recursive=True))
    if not matches:
        return []

    filepath = Path(matches[0])
    if not filepath.exists():
        return []

    messages = []
    try:
        with open(filepath) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") == "message":
                    msg = entry.get("message", {})
                    messages.append({
                        "id": entry.get("id", ""),
                        "role": msg.get("role", ""),
                        "content": msg.get("content", []),
                        "timestamp": entry.get("timestamp"),
                    })
                elif entry.get("type") in ("thinking_level_change", "model_change"):
                    # Skip non-message entries
                    pass
    except Exception:
        pass

    return messages


def _convert_entries_to_messages(data: dict) -> list[dict]:
    """Convert pi session entries to frontend-compatible message format."""
    entries = data.get("entries", [])
    messages = []
    for entry in entries:
        if entry.get("type") == "message":
            msg = entry.get("message", {})
            messages.append({
                "id": entry.get("id", ""),
                "role": msg.get("role", ""),
                "content": msg.get("content", []),
                "timestamp": entry.get("timestamp"),
            })
    return messages
