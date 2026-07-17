"""Session management API — CRUD + SSE event streaming."""

import asyncio
import json
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

from config import get_sessions_dir
from models import (
    CreateSessionRequest,
    CreateSessionResponse,
    SessionInfo,
    PromptRequest,
    ForkSessionRequest,
    SetModelRequest,
    ExtensionUIResponseRequest,
    PiConfig,
)
from services.pi_manager import pi_manager
from services.event_normalizer import normalize_event

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


def _runtime_failure_status(result: dict, default: int = 502) -> int:
    return {
        "busy": 409,
        "not_found": 404,
        "spawn_failed": 503,
        "session_mismatch": 502,
        "timeout": 504,
    }.get(result.get("code"), default)


def _event_replay_cursor(pi, session_id: str, last_event_id: Optional[str]) -> Optional[int]:
    """Choose replay behavior for a fresh connection versus a reconnect.

    Browser reconnects send Last-Event-ID and must receive missed events. A
    brand-new connection to an idle session should start at the live edge,
    otherwise every page load replays the previous completed turn on top of the
    already-restored durable history.
    """
    after_sequence = pi.sequence_after_event_id(last_event_id)
    if not last_event_id and (not pi.busy or pi.session_id != session_id):
        return pi.latest_event_sequence(session_id)
    return after_sequence


@router.post("", response_model=CreateSessionResponse)
async def create_session(body: CreateSessionRequest):
    """Create a new agent session (spawns pi RPC process if needed)."""
    pi, result = await pi_manager.create_session(
        cwd=body.cwd,
        session_dir=str(get_sessions_dir(body.cwd)),
        config=body.config,
    )
    if pi is None:
        code = result.get("code", "create_failed")
        status = 409 if code == "busy" else 503 if code == "spawn_failed" else 500
        return JSONResponse(
            status_code=status,
            content={
                "ok": False,
                "code": code,
                "error": result.get("error", "无法创建新对话，请先停止当前任务"),
            },
        )
    return CreateSessionResponse(id=result.get("session_id", pi.session_id), cwd=body.cwd)


@router.get("", response_model=list[SessionInfo])
async def list_sessions(cwd: str = Query(..., description="Working directory")):
    """List all sessions for a working directory."""
    session_dir = get_sessions_dir(cwd)
    if not session_dir.exists():
        return []

    sessions = []
    seen_ids: set[str] = set()
    for f in sorted(session_dir.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            header = _parse_session_header(f)
            if header:
                sessions.append(header)
                seen_ids.add(header.id)
        except Exception:
            continue

    # The runtime deliberately does not create a session file until an
    # assistant reply exists. Keep the currently active blank conversation in
    # the sidebar without touching Pi's delayed-persistence file contract.
    live = pi_manager.get_by_cwd(cwd)
    if live is not None and live.is_alive and live.session_id not in seen_ids:
        sessions.insert(0, SessionInfo(
            id=live.session_id,
            cwd=str(Path(cwd).resolve()),
            created_at=live._session_started_at,
            updated_at=live._session_started_at,
        ))

    return sessions


@router.delete("/{session_id}")
async def delete_session(
    session_id: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Delete exactly one session from the requested workspace."""
    result = await pi_manager.delete_session(session_id, cwd)
    if result.get("success"):
        return {"ok": True}
    status = 409 if result.get("code") == "busy" else 404 if result.get("code") == "not_found" else 500
    return JSONResponse(
        status_code=status,
        content={"ok": False, "code": result.get("code"), "error": result.get("error")},
    )


@router.get("/{session_id}/messages")
async def get_messages(
    session_id: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Get message history from the session's durable JSONL record."""
    # Reading the active process is racy while another request switches
    # sessions: get_entries can return a newly active blank session under the
    # old ID. The exact persisted file is the stable source for page restores.
    messages = _read_session_from_disk(session_id, cwd)
    return {"messages": messages}


@router.post("/{session_id}/resume")
async def resume_session(
    session_id: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Resume a persisted session in the workspace's pi process."""
    pi, result = await pi_manager.get_session_state(session_id, cwd, PiConfig())
    if not pi or not result.get("success"):
        status = _runtime_failure_status(result)
        return JSONResponse(
            status_code=status,
            content={"ok": False, "code": result.get("code"), "error": result.get("error")},
        )
    return {"ok": True, "id": session_id, "cwd": str(Path(cwd).resolve())}


@router.get("/{session_id}/state")
async def get_session_state(
    session_id: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Return the runtime's authoritative session and connection state."""
    pi, state = await pi_manager.get_session_state(session_id, cwd, PiConfig())
    if not pi:
        status = _runtime_failure_status(state)
        return JSONResponse(
            status_code=status,
            content={"ok": False, "code": state.get("code"), "error": state.get("error")},
        )
    if not state.get("success") or not state.get("data"):
        return JSONResponse(
            status_code=502,
            content={"ok": False, "error": state.get("error", "unable to read session state")},
        )
    data = state["data"]
    model = data.get("model") or {}
    return {
        "ok": True,
        "id": data.get("sessionId", session_id),
        "cwd": str(Path(cwd).resolve()),
        # The backend guard also covers ambiguous prompt acknowledgements and
        # extension preflight work that Pi has not yet reflected as streaming.
        "is_streaming": bool(data.get("isStreaming")) or bool(pi.busy),
        "is_compacting": bool(data.get("isCompacting")),
        "pending_message_count": int(data.get("pendingMessageCount", 0) or 0),
        "model": f"{model.get('provider')}/{model.get('id')}" if model.get("provider") and model.get("id") else None,
        "thinking": data.get("thinkingLevel"),
    }


@router.post("/{session_id}/fork")
async def fork_session(
    session_id: str,
    body: Optional[ForkSessionRequest] = None,
    cwd: str = Query(".", description="Working directory"),
):
    """Fork a persisted session into a new session file."""
    entry_id = body.entry_id if body else None
    command = "fork" if entry_id else "clone"
    params = {"entryId": entry_id} if entry_id else {}
    pi, result = await pi_manager.run_session_command(
        session_id, cwd, PiConfig(), command, **params,
    )
    if not pi:
        status = _runtime_failure_status(result)
        return JSONResponse(
            status_code=status,
            content={"ok": False, "code": result.get("code"), "error": result.get("error")},
        )
    if not result.get("success"):
        status = 409 if result.get("code") == "busy" else 502
        return JSONResponse(
            status_code=status,
            content={"ok": False, "code": result.get("code"), "error": result.get("error", f"{command} failed")},
        )
    return {"ok": True, "id": pi.session_id, "cwd": str(Path(cwd).resolve())}


@router.post("/{session_id}/prompt")
async def send_prompt(
    session_id: str,
    body: PromptRequest,
    cwd: str = Query(".", description="Working directory"),
):
    """Send a user prompt to the agent. Streams response via SSE at /events."""
    # Historical sessions are lazy: restore the process if the backend was
    # restarted or another session in this workspace was active.
    pi, result = await pi_manager.run_session_command(
        session_id, cwd, PiConfig(), "prompt", message=body.message,
    )
    if not pi:
        status = _runtime_failure_status(result)
        return JSONResponse(
            status_code=status,
            content={"ok": False, "code": result.get("code"), "error": result.get("error")},
        )
    if not result.get("success"):
        if result.get("code") == "busy":
            return JSONResponse(
                status_code=409,
                content={"ok": False, "error": result.get("error"), "code": "busy"},
            )
        code = result.get("code") or "prompt_failed"
        return JSONResponse(
            status_code=_runtime_failure_status(result),
            content={"ok": False, "error": result.get("error", "prompt rejected"), "code": code},
        )
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
    pi, result = await pi_manager.configure_session(
        session_id,
        cwd,
        model,
        body.thinking,
    )
    if not pi:
        status = _runtime_failure_status(result)
        return JSONResponse(
            status_code=status,
            content={"ok": False, "code": result.get("code"), "error": result.get("error")},
        )
    if not result.get("success"):
        if result.get("code") == "busy":
            return JSONResponse(
                status_code=409,
                content={"ok": False, "error": result.get("error"), "code": "busy"},
            )
        return {"ok": False, "error": result.get("error", "model not found")}
    return {
        "ok": True,
        "id": result.get("session_id", pi.session_id),
        "model": result.get("model", model),
        "thinking": result.get("thinking", pi.config.thinking),
        "restarted": result.get("restarted", False),
        "replaced_blank": result.get("replaced_blank", False),
    }


@router.post("/{session_id}/abort")
async def abort_session(
    session_id: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Interrupt the current agent turn."""
    pi, result = await pi_manager.run_session_command(session_id, cwd, PiConfig(), "abort")
    if not pi:
        status = _runtime_failure_status(result)
        return JSONResponse(
            status_code=status,
            content={"ok": False, "code": result.get("code"), "error": result.get("error")},
        )
    if not result.get("success"):
        return {"ok": False, "error": result.get("error", "abort failed")}
    return {"ok": True}


@router.post("/{session_id}/interactions/{request_id}")
async def respond_to_interaction(
    session_id: str,
    request_id: str,
    body: ExtensionUIResponseRequest,
    cwd: str = Query(".", description="Working directory"),
):
    """Respond to a select/confirm/input request from a runtime extension."""
    payload: dict = {"id": request_id}
    if body.cancelled:
        payload["cancelled"] = True
    elif body.confirmed is not None:
        payload["confirmed"] = body.confirmed
    elif body.value is not None:
        payload["value"] = body.value
    else:
        payload["cancelled"] = True
    pi, result = await pi_manager.notify_session(
        session_id, cwd, PiConfig(), "extension_ui_response", **payload,
    )
    if not pi or not result.get("success"):
        status = _runtime_failure_status(result)
        return JSONResponse(
            status_code=status,
            content={"ok": False, "code": result.get("code"), "error": result.get("error")},
        )
    return {"ok": True}


@router.get("/{session_id}/commands")
async def get_session_commands(
    session_id: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Return slash commands exposed by the active Pi session."""
    pi, result = await pi_manager.run_session_command(
        session_id, cwd, PiConfig(), "get_commands",
    )
    if not pi or not result.get("success"):
        # Dynamic commands are optional UI metadata; an unavailable session
        # should not prevent the composer from showing built-ins.
        return {"commands": []}
    data = result.get("data") or {}
    commands = data.get("commands", []) if isinstance(data, dict) else []
    return {"commands": commands if isinstance(commands, list) else []}


@router.post("/{session_id}/compact")
async def compact_session(
    session_id: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Compact the active session context."""
    pi, result = await pi_manager.run_session_command(
        session_id, cwd, PiConfig(), "compact",
    )
    if not pi:
        status = _runtime_failure_status(result)
        return JSONResponse(
            status_code=status,
            content={"ok": False, "code": result.get("code"), "error": result.get("error")},
        )
    if not result.get("success"):
        return JSONResponse(
            status_code=409 if result.get("code") == "busy" else 502,
            content={"ok": False, "code": result.get("code"), "error": result.get("error", "compact failed")},
        )
    return {"ok": True}


@router.get("/{session_id}/export")
async def export_session(
    session_id: str,
    cwd: str = Query(".", description="Working directory"),
    format: str = Query("html", description="Export format: html or jsonl"),
):
    """Export a conversation as HTML or JSONL."""
    if format not in {"html", "jsonl"}:
        return JSONResponse(status_code=400, content={"ok": False, "error": "format must be html or jsonl"})

    messages = _read_session_from_disk(session_id, cwd)
    if not messages:
        pi, result = await pi_manager.run_session_command(
            session_id, cwd, PiConfig(), "get_entries",
        )
        if pi and result.get("success"):
            messages = _convert_entries_to_messages(result.get("data") or {})
    if not messages:
        return JSONResponse(status_code=404, content={"ok": False, "error": "session not found in this workspace"})

    from fastapi.responses import HTMLResponse, Response
    filename = f"session-{session_id[:8]}"
    if format == "jsonl":
        content = "".join(json.dumps(message, ensure_ascii=False) + "\n" for message in messages)
        return Response(
            content=content,
            media_type="application/x-ndjson",
            headers={"Content-Disposition": f'attachment; filename="{filename}.jsonl"'},
        )

    import html as html_module
    rows: list[str] = []
    for message in messages:
        role = str(message.get("role", "unknown"))
        parts = message.get("content", [])
        text_parts = [
            str(part.get("text", ""))
            for part in parts if isinstance(part, dict) and part.get("type") == "text"
        ]
        body = html_module.escape("\n".join(text_parts)).replace("\n", "<br>")
        label = {"user": "You", "assistant": "Assistant"}.get(role, role)
        rows.append(
            f'<article class="message"><div class="role">{html_module.escape(label)}</div>'
            f'<div>{body}</div></article>'
        )
    html = (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>{html_module.escape(filename)}</title>"
        "<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;background:#fafafa}"
        ".message{margin:12px 0;padding:12px;border-radius:8px;background:#fff}"
        ".message:first-of-type{background:#f0f4f8}.role{font-size:11px;color:#888;margin-bottom:6px}</style>"
        f"</head><body><h1>{html_module.escape(filename)}</h1>{''.join(rows)}</body></html>"
    )
    return HTMLResponse(
        content=html,
        headers={"Content-Disposition": f'attachment; filename="{filename}.html"'},
    )


@router.get("/{session_id}/events")
async def stream_events(
    session_id: str,
    request: Request,
    cwd: str = Query(".", description="Working directory"),
):
    """SSE event stream — bridges pi JSONL events to SSE for the frontend."""
    # SSE is often opened after a page reload, when the in-memory session map
    # is empty. Restore the durable session before returning a one-shot error.
    pi, activation = await pi_manager.get_event_process(session_id, cwd, PiConfig())
    if not pi:
        return EventSourceResponse(_error_stream(activation.get("error", "session not found"), session_id))

    async def event_generator():
        had_text = False  # Compatibility fallback for older replay entries.
        last_event_id = request.headers.get("last-event-id")
        after_sequence = _event_replay_cursor(pi, session_id, last_event_id)
        event_stream = pi.read_events(session_id, after_sequence=after_sequence)
        event_task: asyncio.Task | None = None
        try:
            event_task = asyncio.create_task(anext(event_stream))
            while True:
                if await request.is_disconnected():
                    break
                done, _pending = await asyncio.wait({event_task}, timeout=15.0)
                if not done:
                    # Keep proxies and browsers from treating an idle but
                    # healthy conversation stream as disconnected.
                    yield {"event": "ping", "data": ""}
                    continue
                try:
                    event = event_task.result()
                except StopAsyncIteration:
                    break
                event_task = asyncio.create_task(anext(event_stream))
                event_session_id = event.get("_piSessionId")
                if event_session_id and event_session_id != session_id:
                    continue
                sequence = event.get("_piSequence")
                event_id = event.get("_piEventId")
                if event.get("_piStreamGap"):
                    yield {
                        "event": "error",
                        "id": event_id or (str(sequence) if sequence is not None else None),
                        "data": json.dumps({
                            "type": "error",
                            "sessionId": session_id,
                            "message": "Conversation stream fell behind; history will be resynchronized.",
                            "recoverable": True,
                        }),
                    }

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
                turn_had_text = bool(event.get("_piTurnHadText", had_text))
                if (
                    event.get("type") == "agent_settled"
                    and not turn_had_text
                    and not event.get("handledWithoutTurn")
                ):
                    yield {
                        "event": "error",
                        "id": event_id or (str(sequence) if sequence is not None else None),
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
                    had_text = False

                event_type = normalized.get("type", "message")
                yield {
                    "event": event_type,
                    "id": event_id or (str(sequence) if sequence is not None else None),
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
        finally:
            if event_task and not event_task.done():
                event_task.cancel()
                try:
                    await event_task
                except asyncio.CancelledError:
                    pass
            await event_stream.aclose()

    return EventSourceResponse(event_generator())


async def _error_stream(message: str, session_id: str):
    """Generate a single error event."""
    yield {
        "event": "error",
        "data": json.dumps({
            "type": "error",
            "sessionId": session_id,
            "message": message,
            # EventSource reconnects automatically after a server-side stream
            # ends. This error is terminal for the requested session, so the
            # frontend must close the source instead of retrying forever.
            "terminal": True,
        }),
    }
    yield {
        "event": "session.idle",
        "data": json.dumps({"type": "session.idle", "sessionId": session_id}),
    }


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
    Session IDs are resolved only inside the requested workspace."""
    roots = [get_sessions_dir(cwd or ".")]
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
                        "toolCallId": msg.get("toolCallId"),
                        "toolName": msg.get("toolName"),
                        "isError": msg.get("isError", False),
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
                "toolCallId": msg.get("toolCallId"),
                "toolName": msg.get("toolName"),
                "isError": msg.get("isError", False),
                "timestamp": entry.get("timestamp"),
            })
    return messages
