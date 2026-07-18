"""MCP connector catalog contracts."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class McpToolInfo(BaseModel):
    name: str
    description: str = ""
    input_schema: dict[str, Any] = Field(default_factory=dict)
    data_egress: Literal["none", "local", "remote", "unknown"] = "unknown"


class McpServerInfo(BaseModel):
    id: str
    name: str
    description: str = ""
    transport: Literal["stdio", "http", "sse", "unknown"] = "unknown"
    configured: bool = True
    enabled: bool = True
    health: Literal["unknown", "ready", "degraded", "blocked", "error"] = "unknown"
    auth: Literal["not_required", "configured", "missing", "unknown"] = "unknown"
    data_egress: Literal["none", "local", "remote", "unknown"] = "unknown"
    terms_url: str | None = None
    privacy_url: str | None = None
    license: str | None = None
    tags: list[str] = Field(default_factory=list)
    tools: list[McpToolInfo] = Field(default_factory=list)
    error: str | None = None
    policy_allowed: bool = True
