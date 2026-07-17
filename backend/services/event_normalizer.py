"""Normalize pi RPC events to open-science compatible SSE format.

The frontend's foldEvent() reducer (ported from open-science) expects events
in a specific format. This module transforms pi's AgentSessionEvent types
into that format so the frontend rendering components work as-is.
"""

from typing import Any, Optional


MAX_DISPLAY_CHARS = 20000


def normalize_event(
    event: dict[str, Any],
    session_id: str,
) -> Optional[dict[str, Any]]:
    """Convert a pi RPC event to an open-science compatible SSE event.

    Returns None for events that don't need to be forwarded to the frontend.
    """
    event_type = event.get("type")

    # Map pi event types to open-science SSE types
    if event_type == "message_start":
        msg = event.get("message", {})
        role = msg.get("role", "")
        if role == "assistant":
            part_id = msg.get("id", "")
            return {
                "type": "text.updated",
                "sessionId": session_id,
                "partId": part_id,
                "text": "",  # Will be built up by message_update events
            }
        # User messages don't need SSE forwarding (frontend already has them)
        return None

    elif event_type == "message_update":
        assistant_event = event.get("assistantMessageEvent", {})
        ae_type = assistant_event.get("type", "")
        if ae_type == "text_delta" or ae_type == "text":
            text = assistant_event.get("text", "")
            if not text:
                text = assistant_event.get("delta", "")
            msg = event.get("message", {})
            part_id = msg.get("id", "")
            return {
                "type": "text.updated",
                "sessionId": session_id,
                "partId": part_id,
                "text": text,
            }
        # thinking_delta events can be forwarded or filtered
        return None

    elif event_type == "message_end":
        # Frontend marks message complete locally
        return None

    elif event_type == "tool_execution_start":
        return {
            "type": "tool.updated",
            "sessionId": session_id,
            "callId": event.get("toolCallId", ""),
            "tool": event.get("toolName") or "unknown",
            "status": "running",
            "input": _sanitize_value(event.get("args", {})),
            "startedAt": _now_iso(),
        }

    elif event_type == "tool_execution_update":
        normalized = {
            "type": "tool.updated",
            "sessionId": session_id,
            "callId": event.get("toolCallId", ""),
            # Updates frequently omit toolName/args. Empty/absent values let the
            # frontend preserve the identity and input from the start event.
            "tool": event.get("toolName") or "",
            "status": "running",
            "partialOutput": _stringify_result(event.get("partialResult")),
        }
        if "args" in event:
            normalized["input"] = _sanitize_value(event.get("args"))
        return normalized

    elif event_type == "tool_execution_end":
        result = event.get("result", {})
        is_error = event.get("isError", False)
        return {
            "type": "tool.updated",
            "sessionId": session_id,
            "callId": event.get("toolCallId", ""),
            "tool": event.get("toolName") or "",
            "status": "error" if is_error else "done",
            "output": _stringify_result(result),
            "diff": _extract_diff(event.get("toolName", ""), result),
            "endedAt": _now_iso(),
        }

    elif event_type == "agent_settled":
        normalized = {
            "type": "session.idle",
            "sessionId": session_id,
        }
        if event.get("handledWithoutTurn"):
            normalized["handledWithoutTurn"] = True
        return normalized

    elif event_type == "error":
        return {
            "type": "error",
            "sessionId": event.get("sessionId", session_id),
            "message": event.get("message", str(event)),
        }

    elif event_type == "extension_ui_request":
        method = event.get("method", "")
        if method == "confirm":
            return {
                "type": "permission.asked",
                "sessionId": session_id,
                "requestId": event.get("id", ""),
                "title": event.get("title", "Confirmation"),
                "message": event.get("message", ""),
            }
        if method in {"select", "input", "editor"}:
            return {
                "type": "question.asked",
                "sessionId": session_id,
                "requestId": event.get("id", ""),
                "method": method,
                "title": event.get("title", "Question"),
                "message": event.get("message", ""),
                "options": event.get("options", []),
                "placeholder": event.get("placeholder", ""),
                "prefill": event.get("prefill", ""),
            }
        return None

    # Unknown event type, forward as-is for extensibility
    return None


def _stringify_result(result: Any) -> str:
    """Convert tool result to string for display."""
    if result is None:
        return ""
    if isinstance(result, str):
        return _cap_string(result)
    if isinstance(result, dict):
        # Try common output fields
        for key in ("output", "text", "result", "message"):
            if key in result:
                val = result[key]
                return _cap_string(str(val)) if val else ""
        # For structured results, return as JSON string
        return _cap_string(str(result.get("content", result)))
    return _cap_string(str(result))


def _extract_diff(tool_name: str, result: Any) -> Optional[str]:
    """Extract diff from edit tool result."""
    if tool_name == "edit" and isinstance(result, dict):
        diff = result.get("diff")
        return _cap_string(str(diff)) if diff is not None else None
    return None


def _cap_string(value: str) -> str:
    if len(value) <= MAX_DISPLAY_CHARS:
        return value
    return value[:MAX_DISPLAY_CHARS] + "\n… [truncated]"


def _sanitize_value(value: Any, depth: int = 0) -> Any:
    if depth >= 6:
        return "[truncated]"
    if isinstance(value, str):
        return _cap_string(value)
    if isinstance(value, dict):
        items = list(value.items())[:100]
        sanitized = {str(key): _sanitize_value(item, depth + 1) for key, item in items}
        if len(value) > len(items):
            sanitized["_truncated"] = True
        return sanitized
    if isinstance(value, (list, tuple)):
        items = list(value)[:100]
        sanitized = [_sanitize_value(item, depth + 1) for item in items]
        if len(value) > len(items):
            sanitized.append("[truncated]")
        return sanitized
    return value


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
