"""Static MCP connector catalog and non-invasive health checks."""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

from models.mcp import McpServerInfo, McpToolInfo


def _transport(definition: dict[str, Any]) -> str:
    if definition.get("url"):
        value = str(definition.get("transport") or "http").lower()
        return value if value in {"http", "sse"} else "http"
    if definition.get("command"):
        return "stdio"
    return "unknown"


def _egress(definition: dict[str, Any]) -> str:
    explicit = str(definition.get("data_egress") or "").lower()
    if explicit in {"none", "local", "remote", "unknown"}:
        return explicit
    if definition.get("url"):
        return "remote"
    if definition.get("command"):
        return "local"
    return "unknown"


def _auth(definition: dict[str, Any]) -> str:
    if definition.get("auth") in {"not_required", "configured", "missing", "unknown"}:
        return definition["auth"]
    env = definition.get("required_env") or definition.get("requiredEnv") or []
    if isinstance(env, str):
        env = [env]
    if env:
        return "configured" if all(os.environ.get(str(name)) for name in env) else "missing"
    return "unknown"


def _tools(definition: dict[str, Any], egress: str) -> list[McpToolInfo]:
    raw = definition.get("tools") or []
    if isinstance(raw, dict):
        raw = [{"name": key, **(value if isinstance(value, dict) else {})} for key, value in raw.items()]
    result: list[McpToolInfo] = []
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, str):
            result.append(McpToolInfo(name=item, data_egress=egress))
        elif isinstance(item, dict) and item.get("name"):
            result.append(McpToolInfo(
                name=str(item["name"]),
                description=str(item.get("description") or ""),
                input_schema=item.get("input_schema") or item.get("inputSchema") or {},
                data_egress=str(item.get("data_egress") or egress),
            ))
    return result


def catalog_from_definitions(definitions: dict[str, Any], enabled: set[str] | None = None) -> list[McpServerInfo]:
    enabled = set(definitions) if enabled is None else enabled
    result: list[McpServerInfo] = []
    for server_id, raw in sorted(definitions.items()):
        definition = raw if isinstance(raw, dict) else {}
        egress = _egress(definition)
        result.append(McpServerInfo(
            id=server_id,
            name=str(definition.get("name") or server_id),
            description=str(definition.get("description") or ""),
            transport=_transport(definition),
            enabled=server_id in enabled,
            auth=_auth(definition),
            data_egress=egress,
            terms_url=definition.get("terms_url") or definition.get("termsUrl"),
            privacy_url=definition.get("privacy_url") or definition.get("privacyUrl"),
            license=definition.get("license"),
            tags=[str(tag) for tag in definition.get("tags", [])] if isinstance(definition.get("tags", []), list) else [],
            tools=_tools(definition, egress),
        ))
    return result


def _health_sync(server: McpServerInfo, definition: dict[str, Any]) -> McpServerInfo:
    if not server.enabled:
        return server.model_copy(update={"health": "blocked", "error": "server disabled"})
    if server.auth == "missing":
        return server.model_copy(update={"health": "blocked", "error": "required credentials are missing"})
    try:
        if server.transport == "stdio":
            command = str(definition.get("command") or "")
            available = Path(command).exists() if "/" in command else shutil.which(command) is not None
            return server.model_copy(update={"health": "ready" if available else "error", "error": None if available else f"command not found: {command}"})
        if server.transport in {"http", "sse"}:
            url = str(definition.get("url") or "")
            request = Request(url, headers={"Accept": "application/json", "User-Agent": "pi-science/0.1"}, method="GET")
            with urlopen(request, timeout=8) as response:
                status = int(getattr(response, "status", 200))
            return server.model_copy(update={"health": "ready" if 200 <= status < 500 else "degraded", "error": None})
        return server.model_copy(update={"health": "unknown"})
    except Exception as exc:
        return server.model_copy(update={"health": "error", "error": str(exc)[:300]})


async def check_health(server: McpServerInfo, definition: dict[str, Any]) -> McpServerInfo:
    return await asyncio.to_thread(_health_sync, server, definition)

