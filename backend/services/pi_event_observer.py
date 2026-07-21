"""Durable side effects for Pi runtime events."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Awaitable, Callable, Optional


PublishEvent = Callable[[dict, Optional[str]], Awaitable[None]]


async def observe_event(
    *,
    cwd: str,
    session_path: Optional[str],
    model: Optional[str],
    event: dict,
    session_id: str,
    publish_event: PublishEvent,
) -> None:
    """Run durable side effects exactly once, independent of SSE readers."""
    if session_path and "reviewer-sessions" in Path(session_path).parts:
        return
    event_type = event.get("type")
    if event_type in {"agent_start", "agent_end", "agent_settled", "error"}:
        try:
            from services.session_manifest import append_skill_event

            asyncio.create_task(
                append_skill_event(
                    cwd,
                    session_id,
                    event_type,
                    status="error" if event_type == "error" else "ok",
                )
            )
        except Exception:
            pass
    if event_type == "tool_execution_end":
        try:
            from services.session_manifest import append_skill_event

            tool_name = str(event.get("toolName") or "")
            asyncio.create_task(
                append_skill_event(
                    cwd,
                    session_id,
                    "tool",
                    tool=tool_name,
                    status="error" if event.get("isError") else "ok",
                )
            )
        except Exception:
            pass
    if event_type == "tool_execution_end" and not event.get("isError"):
        record_provenance(cwd, event, session_id)
        asyncio.create_task(
            publish_artifact_for_event(
                cwd=cwd,
                model=model,
                event=event,
                session_id=session_id,
                publish_event=publish_event,
            )
        )
    if event_type == "agent_settled" and session_id:
        try:
            from services.reviewer_service import schedule_auto_review

            schedule_auto_review(cwd, session_id)
        except Exception:
            pass


async def publish_artifact_for_event(
    *,
    cwd: str,
    model: Optional[str],
    event: dict,
    session_id: str,
    publish_event: PublishEvent,
) -> None:
    """Publish written files and expose their stable manifest over SSE."""
    tool_name = event.get("toolName", "")
    if tool_name not in {"write", "edit"}:
        return
    file_path = event.get("args", {}).get("file_path", "")
    if not file_path:
        return
    try:
        candidate = Path(file_path).expanduser()
        if not candidate.is_absolute():
            candidate = Path(cwd) / candidate
        relative = candidate.resolve().relative_to(Path(cwd).resolve()).as_posix()
        from services.artifact_store import get_artifact_store

        manifest = await get_artifact_store(cwd).publish(
            relative,
            session_id=session_id,
            tool=tool_name,
            model=model,
        )
        await publish_event(
            {
                "type": "artifact_published",
                "artifactId": manifest.artifact_id,
                "path": manifest.path,
                "version": manifest.version,
                "mime": manifest.mime,
                "verification": manifest.verification.model_dump(),
            },
            session_id,
        )
    except Exception:
        return


async def record_skill_snapshot(cwd: str, session_id: str) -> None:
    """Record the effective catalog available when a Pi process starts."""
    try:
        from services.settings_store import load_config
        from services.session_manifest import append_session_skill_snapshot
        from services.skill_catalog import catalog

        settings = load_config()
        enabled_paths = set(settings.get("skill_paths", [])) if settings.get("skills_configured") else None
        records = catalog(cwd, enabled_paths=enabled_paths)
        await append_session_skill_snapshot(
            cwd,
            session_id,
            [item.model_dump() for item in records],
        )
        for record in records:
            if record.enabled:
                from services.session_manifest import append_skill_event

                await append_skill_event(
                    cwd,
                    session_id,
                    "skill_loaded",
                    skill_id=record.skill_id,
                    skill_name=record.name,
                    status="available" if record.validation.valid else "invalid",
                )
    except Exception:
        return


def record_provenance(cwd: str, event: dict, session_id: str) -> None:
    tool_name = event.get("toolName", "")
    result = event.get("result", {})
    if tool_name == "write":
        file_path = event.get("args", {}).get("file_path", "")
        content = event.get("args", {}).get("content", event.get("args", {}).get("text", ""))
        diff = None
    elif tool_name == "edit":
        file_path = event.get("args", {}).get("file_path", "")
        content = None
        diff = result.get("diff") if isinstance(result, dict) else None
    else:
        return
    if not file_path:
        return
    try:
        from services.provenance_store import get_store

        asyncio.get_event_loop().create_task(
            get_store(cwd).record(
                path=file_path,
                session_id=session_id,
                tool=tool_name,
                tool_call_id=event.get("toolCallId"),
                content=content if tool_name == "write" and content else None,
                diff=diff if tool_name == "edit" else None,
            )
        )
    except Exception:
        pass
