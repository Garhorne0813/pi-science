"""Normalize pi RPC events to open-science compatible SSE format.

The frontend's foldEvent() reducer (ported from open-science) expects events
in a specific format. This module transforms pi's AgentSessionEvent types
into that format so the frontend rendering components work as-is.
"""

from typing import Any, Optional


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
            "tool": event.get("toolName", "unknown"),
            "status": "running",
            "input": event.get("args", {}),
            "startedAt": _now_iso(),
        }

    elif event_type == "tool_execution_update":
        return {
            "type": "tool.updated",
            "sessionId": session_id,
            "callId": event.get("toolCallId", ""),
            "tool": event.get("toolName", "unknown"),
            "status": "running",
            "input": event.get("args", {}),
            "partialOutput": _stringify_result(event.get("partialResult")),
        }

    elif event_type == "tool_execution_end":
        result = event.get("result", {})
        is_error = event.get("isError", False)
        return {
            "type": "tool.updated",
            "sessionId": session_id,
            "callId": event.get("toolCallId", ""),
            "tool": event.get("toolName", "unknown"),
            "status": "error" if is_error else "done",
            "output": _stringify_result(result),
            "diff": _extract_diff(event.get("toolName", ""), result),
            "endedAt": _now_iso(),
        }

    elif event_type == "agent_settled":
        return {
            "type": "session.idle",
            "sessionId": session_id,
        }

    elif event_type == "error":
        return {
            "type": "error",
            "sessionId": event.get("sessionId", session_id),
            "message": event.get("message", str(event)),
        }

    elif event_type == "extension_ui_request":
        # Forward as interactive question
        method = event.get("method", "")
        if method == "confirm":
            return {
                "type": "permission.asked",
                "sessionId": session_id,
                "requestId": event.get("id", ""),
                "title": event.get("title", "Confirmation"),
                "message": event.get("message", ""),
            }
        return None

    # Unknown event type, forward as-is for extensibility
    return None


def _stringify_result(result: Any) -> str:
    """Convert tool result to string for display."""
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        # Try common output fields
        for key in ("output", "text", "result", "message"):
            if key in result:
                val = result[key]
                return str(val) if val else ""
        # For structured results, return as JSON string
        return str(result.get("content", result)) if len(str(result)) < 5000 else str(result)[:5000]
    return str(result)[:5000]


def _extract_diff(tool_name: str, result: Any) -> Optional[str]:
    """Extract diff from edit tool result."""
    if tool_name == "edit" and isinstance(result, dict):
        return result.get("diff")
    return None


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
