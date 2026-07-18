"""User-visible Agent Profile permissions."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class AgentProfile(BaseModel):
    name: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,31}$")
    display_name: str
    description: str = ""
    system_prompt: str = ""
    skills: list[str] = Field(default_factory=list)
    connectors: list[str] = Field(default_factory=list)
    excluded_tools: list[str] = Field(default_factory=list)
    thinking: Literal["off", "minimal", "low", "medium", "high", "max"] = "high"
    read_scope: list[str] = Field(default_factory=lambda: ["workspace"])
    write_scope: list[str] = Field(default_factory=lambda: ["workspace-approved"])
    unrestricted: bool = False
    source: Literal["builtin", "project", "user"] = "user"


class AgentProfileRequest(BaseModel):
    name: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,31}$")
    display_name: str
    description: str = ""
    system_prompt: str = ""
    skills: list[str] = Field(default_factory=list)
    connectors: list[str] = Field(default_factory=list)
    excluded_tools: list[str] = Field(default_factory=list)
    thinking: Literal["off", "minimal", "low", "medium", "high", "max"] = "high"
    read_scope: list[str] = Field(default_factory=lambda: ["workspace"])
    write_scope: list[str] = Field(default_factory=lambda: ["workspace-approved"])
    unrestricted: bool = False

