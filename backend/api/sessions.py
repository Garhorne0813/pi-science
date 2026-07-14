"""Session management API — CRUD + SSE event streaming."""

import asyncio
import json
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query, Request
from sse_starlette.sse import EventSourceResponse

from config import get_sessions_dir
from models import (
    CreateSessionRequest,
    CreateSessionResponse,
    SessionInfo,
    PromptRequest,
    ForkSessionRequest,
    SetModelRequest,
    PiConfig,
)
from services.pi_manager import pi_manager
from services.event_normalizer import normalize_event
from services.provenance_store import get_store

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.post("", response_model=CreateSessionResponse)
async def create_session(body: CreateSessionRequest):
    """Create a new agent session (spawns pi RPC process if needed)."""
    # If a pi process already exists for this cwd, create a NEW session within it
    existing = pi_manager.get_by_cwd(body.cwd)
    if existing and existing.is_alive:
        result = await existing.send_command("new_session")
        if result.get("success"):
            new_id = existing.session_id
            return CreateSessionResponse(id=new_id, cwd=body.cwd)

    # No existing process, spawn a new one
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
    from config import BASE_DIR, WORKSPACES_DIR

    deleted = False
    roots = [
        Path(cwd).resolve() / ".pi-science" / "sessions",
        WORKSPACES_DIR,
        BASE_DIR / "sessions",
    ]
    for path in _find_session_files(session_id, roots):
        path.unlink()
        deleted = True

    if deleted:
        pi_manager.unbind_session(session_id)
        return {"ok": True}
    return {"ok": False, "error": "session not found"}


@router.get("/{session_id}/messages")
async def get_messages(
    session_id: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Get message history for a session. Falls back to reading JSONL from disk."""
    pi = pi_manager.get_by_session(session_id)
    if pi:
        result = await pi.send_command("get_entries")
        if result.get("success"):
            messages = _convert_entries_to_messages(result.get("data", {}))
            return {"messages": messages}

    # Session not active — read from disk
    messages = _read_session_from_disk(session_id, cwd)
    return {"messages": messages}


@router.post("/{session_id}/resume")
async def resume_session(
    session_id: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Resume a persisted session in the workspace's pi process."""
    pi = await pi_manager.resume_session(session_id, cwd, PiConfig())
    if not pi:
        return {"ok": False, "error": "session not found or could not be resumed"}
    return {"ok": True, "id": session_id, "cwd": str(Path(cwd).resolve())}


@router.post("/{session_id}/fork")
async def fork_session(
    session_id: str,
    body: Optional[ForkSessionRequest] = None,
    cwd: str = Query(".", description="Working directory"),
):
    """Fork a persisted session into a new session file."""
    pi = await pi_manager.resume_session(session_id, cwd, PiConfig())
    if not pi:
        return {"ok": False, "error": "session not found or could not be resumed"}

    entry_id = body.entry_id if body else None
    command = "fork" if entry_id else "clone"
    params = {"entryId": entry_id} if entry_id else {}
    result = await pi.send_command(command, **params)
    if not result.get("success"):
        return {"ok": False, "error": result.get("error", f"{command} failed")}
    return {"ok": True, "id": pi.session_id, "cwd": str(Path(cwd).resolve())}


@router.post("/{session_id}/prompt")
async def send_prompt(
    session_id: str,
    body: PromptRequest,
    cwd: str = Query(".", description="Working directory"),
):
    """Send a user prompt to the agent. Streams response via SSE at /events."""
    pi = pi_manager.get_by_session(session_id)
    if not pi:
        # Historical sessions are lazy: load them on the first prompt.
        pi = await pi_manager.resume_session(session_id, cwd, PiConfig())
        if not pi:
            return {"ok": False, "error": "session not found or could not be resumed"}

    result = await pi.send_command("prompt", message=body.message)
    if not result.get("success"):
        return {"ok": False, "error": result.get("error", "prompt rejected")}
    return {"ok": True, "id": pi.session_id}


@router.post("/{session_id}/model")
async def set_session_model(
    session_id: str,
    body: SetModelRequest,
    cwd: str = Query(".", description="Working directory"),
):
    """Change the active pi session model using provider/model notation."""
    model = body.model.strip()
    if "/" not in model:
        return {"ok": False, "error": "Model must use provider/model notation"}
    provider, model_id = model.split("/", 1)
    pi = pi_manager.get_by_session(session_id)
    if not pi:
        pi = await pi_manager.resume_session(session_id, cwd, PiConfig())
    if not pi:
        return {"ok": False, "error": "session not found or could not be resumed"}

    result = await pi.send_command("set_model", provider=provider, modelId=model_id)
    if not result.get("success"):
        return {"ok": False, "error": result.get("error", "model not found")}
    return {"ok": True, "id": pi.session_id, "model": model}


@router.post("/{session_id}/abort")
async def abort_session(session_id: str):
    """Interrupt the current agent turn."""
    pi = pi_manager.get_by_session(session_id)
    if not pi:
        return {"ok": False, "error": "session not found"}

    await pi.send_command("abort")
    return {"ok": True}


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


def _read_session_from_disk(session_id: str, cwd: Optional[str] = None) -> list[dict]:
    """Read session messages directly from the JSONL file on disk.
    Searches both the centralized dir and workspace-local .pi-science/sessions/."""
    from config import BASE_DIR, WORKSPACES_DIR

    roots = []
    if cwd:
        roots.append(Path(cwd).resolve() / ".pi-science" / "sessions")
    roots.extend([BASE_DIR / "sessions", WORKSPACES_DIR])
    matches = _find_session_files(session_id, roots)
    if not matches:
        return []

    filepath = matches[0]
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


def _find_session_files(session_id: str, roots: list[Path]) -> list[Path]:
    """Return session files whose JSONL header has the exact requested ID."""
    matches: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        # WORKSPACES_DIR may contain many nested workspace-local session
        # directories; parsing the header keeps the match exact.
        candidates = root.rglob("*.jsonl")
        for path in candidates:
            try:
                with path.open(encoding="utf-8") as f:
                    header = json.loads(f.readline())
                if header.get("type") == "session" and header.get("id") == session_id:
                    matches.append(path)
            except (OSError, json.JSONDecodeError):
                continue
    return matches


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
