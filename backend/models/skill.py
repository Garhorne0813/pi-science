"""Typed contracts for discoverable Pi-Science skills.

The runtime still accepts the small ``name``/``description`` front matter used
by older Pi skills, but all records are normalised into this contract before
they reach the API or a spawned session.  Keeping the contract in Python
gives the API, CLI validator, and future skill tooling one source of truth.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class SkillThirdParty(BaseModel):
    model_config = ConfigDict(extra="allow")

    kind: Literal["weights", "service", "dataset", "library", "other"] = "other"
    name: str = Field(min_length=1, max_length=200)
    provider: str | None = Field(default=None, max_length=200)
    license: str | None = Field(default=None, max_length=120)
    terms_url: str | None = None
    info_url: str | None = None
    privacy_url: str | None = None


class SkillRequirement(BaseModel):
    """A capability the host may check before loading a skill."""

    model_config = ConfigDict(extra="allow")

    name: str = Field(min_length=1, max_length=120)
    kind: Literal["command", "python", "node", "r", "gpu", "package", "service", "other"] = "other"
    version: str | None = Field(default=None, max_length=120)
    optional: bool = False
    description: str | None = Field(default=None, max_length=500)


class SkillMetadata(BaseModel):
    """Validated metadata from a skill's YAML front matter."""

    model_config = ConfigDict(extra="allow")

    name: str = Field(min_length=1, max_length=80, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    description: str = Field(min_length=1, max_length=4000)
    version: str = Field(default="0.1.0", max_length=80)
    license: str = Field(default="Apache-2.0", max_length=120)
    category: str = Field(default="general", max_length=80)
    requirements: list[SkillRequirement] = Field(default_factory=list)
    third_party: list[SkillThirdParty] = Field(default_factory=list)
    risk: Literal["low", "medium", "high"] = "low"
    entrypoints: list[str] = Field(default_factory=list)
    required_tools: list[str] = Field(default_factory=list)
    required_mcp_tools: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class SkillValidation(BaseModel):
    valid: bool
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    checked_at: str


class SkillFile(BaseModel):
    path: str
    kind: Literal["skill", "reference", "helper", "requirement", "other"] = "other"
    size: int = Field(ge=0)


class SkillInfo(BaseModel):
    """Public skill catalog record.

    ``location`` is deliberately a display path (relative to its source
    root), never an arbitrary absolute host path.  ``source_path`` is kept
    internal and is not part of the API response.
    """

    model_config = ConfigDict(extra="allow")

    skill_id: str
    digest: str
    name: str
    description: str
    version: str
    category: str
    license: str
    risk: Literal["low", "medium", "high"]
    quality: Literal["draft", "validated", "verified", "deprecated"] = "draft"
    location: str
    source: Literal["builtin", "project", "user"]
    enabled: bool = True
    requirements: list[SkillRequirement] = Field(default_factory=list)
    third_party: list[SkillThirdParty] = Field(default_factory=list)
    entrypoints: list[str] = Field(default_factory=list)
    required_tools: list[str] = Field(default_factory=list)
    required_mcp_tools: list[str] = Field(default_factory=list)
    files: list[SkillFile] = Field(default_factory=list)
    validation: SkillValidation
    shadowed: list[str] = Field(default_factory=list)
