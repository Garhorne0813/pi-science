"""Pydantic models for the pi-science scientific runtime API."""

from typing import Literal, Optional
from pydantic import BaseModel, Field


# ── Kernel ──

class ExecuteCellRequest(BaseModel):
    language: Literal["python", "r"]
    code: str
    notebook_id: Optional[str] = None
    timeout_seconds: float = Field(default=120, ge=1, le=600)


class CellResult(BaseModel):
    ok: bool
    stdout: str = ""
    result: Optional[str] = None
    error: Optional[str] = None


__all__ = ["ExecuteCellRequest", "CellResult"]
