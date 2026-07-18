"""Provider-neutral compute and model endpoint contracts."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class ComputeRequirement(BaseModel):
    cpu: int = Field(default=1, ge=1, le=256)
    memory_mb: int = Field(default=512, ge=1, le=1_048_576)
    gpu: bool = False
    gpu_count: int = Field(default=0, ge=0, le=16)
    runtime: Literal["python", "r", "node", "container", "any"] = "any"
    packages: list[str] = Field(default_factory=list, max_length=200)
    timeout_seconds: int = Field(default=3600, ge=1, le=86_400)
    network: Literal["none", "restricted", "full"] = "restricted"
    secrets_refs: list[str] = Field(default_factory=list, max_length=50)


class CapabilityCheck(BaseModel):
    status: Literal["ready", "degraded", "blocked"]
    checks: dict[str, Any] = Field(default_factory=dict)
    reasons: list[str] = Field(default_factory=list)


JobStatus = Literal["pending", "running", "succeeded", "failed", "cancelled", "timed_out"]


class JobRecord(BaseModel):
    job_id: str
    command: list[str]
    cwd: str
    surface: str = "local"
    status: JobStatus = "pending"
    created_at: datetime
    started_at: datetime | None = None
    ended_at: datetime | None = None
    return_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    artifact_ids: list[str] = Field(default_factory=list)
    environment: dict[str, Any] = Field(default_factory=dict)
    requirement: ComputeRequirement = Field(default_factory=ComputeRequirement)


class JobSubmitRequest(BaseModel):
    command: list[str] | str
    requirement: ComputeRequirement = Field(default_factory=ComputeRequirement)
    surface: str = "local"


class ModelEndpoint(BaseModel):
    endpoint_id: str
    name: str
    base_url: str
    protocol: Literal["openai", "anthropic", "native", "unknown"] = "unknown"
    enabled: bool = True
    health: Literal["unknown", "ready", "degraded", "blocked", "error"] = "unknown"
    model_schema: dict[str, Any] = Field(default_factory=dict)
    rate_limit: dict[str, Any] = Field(default_factory=dict)
    secret_ref: str | None = None
    data_egress: Literal["local", "remote", "unknown"] = "unknown"
    error: str | None = None


class ModelEndpointRequest(BaseModel):
    name: str
    base_url: str
    protocol: Literal["openai", "anthropic", "native", "unknown"] = "unknown"
    secret_ref: str | None = None
    data_egress: Literal["local", "remote", "unknown"] = "remote"
    model_schema: dict[str, Any] = Field(default_factory=dict)
    rate_limit: dict[str, Any] = Field(default_factory=dict)

