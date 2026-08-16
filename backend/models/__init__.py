"""Pydantic models for the pi-science scientific runtime API."""

from typing import Dict, Literal, Optional
from pydantic import BaseModel, Field


# ── Kernel ──

class ExecuteCellRequest(BaseModel):
    language: Literal["python", "r"]
    code: str
    notebook_id: Optional[str] = None
    session_id: Optional[str] = None
    environment_revision_id: Optional[str] = None
    environment_prefix: Optional[str] = None
    kernel_instance_id: Optional[str] = None
    timeout_seconds: float = Field(default=120, ge=1, le=600)


class CellResult(BaseModel):
    ok: bool
    stdout: str = ""
    result: Optional[str] = None
    error: Optional[str] = None
    interrupted: bool = False
    mime: Dict[str, str] = Field(default_factory=dict)


__all__ = ["ExecuteCellRequest", "CellResult"]
