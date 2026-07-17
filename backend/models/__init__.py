"""Pydantic models for pi-science API."""

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, Field

from .project_knowledge import (
    BatchDecisionRequest,
    FileOperation,
    KnowledgeItem,
    ProjectPolicy,
    ProjectPolicyUpdate,
    Proposal,
    ProposalDecisionRequest,
    ProposalUpdateRequest,
    ReviewerProposalInput,
    ReviewerResult,
    ReviewRequest,
    ReviewResponse,
    SourceReference,
)

__all__ = [
    "BatchDecisionRequest",
    "FileOperation",
    "KnowledgeItem",
    "ProjectPolicy",
    "ProjectPolicyUpdate",
    "Proposal",
    "ProposalDecisionRequest",
    "ProposalUpdateRequest",
    "ReviewerProposalInput",
    "ReviewerResult",
    "ReviewRequest",
    "ReviewResponse",
    "SourceReference",
]


# ── Session ──

class PiConfig(BaseModel):
    """Configuration for spawning a pi process."""
    model: Optional[str] = None
    provider: Optional[str] = None
    api_key: Optional[str] = None
    thinking: Optional[str] = None
    skills: List[str] = Field(default_factory=list)
    extensions: List[str] = Field(default_factory=list)


class CreateSessionRequest(BaseModel):
    cwd: str
    config: PiConfig = Field(default_factory=PiConfig)


class CreateSessionResponse(BaseModel):
    id: str
    cwd: str


class SessionInfo(BaseModel):
    id: str
    cwd: str
    name: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class PromptRequest(BaseModel):
    message: str


class SetModelRequest(BaseModel):
    """Select a provider/model pair for an active session."""
    model: str
    thinking: Optional[str] = None


class ExtensionUIResponseRequest(BaseModel):
    """Reply to an interactive request emitted by a pi extension."""
    value: Optional[str] = None
    confirmed: Optional[bool] = None
    cancelled: bool = False


class ForkSessionRequest(BaseModel):
    """Optional entry to fork from; omitted means clone the active branch."""
    entry_id: Optional[str] = None


# ── Agent Messages / Events ──

class AgentMessageBase(BaseModel):
    id: str
    session_id: str
    role: Literal["user", "assistant", "tool"]


class HistoryMessage(BaseModel):
    """Message format returned by GET /sessions/{id}/messages."""
    id: str
    role: str
    content: List[Dict[str, Any]]  # AnthropicContent array
    timestamp: Optional[datetime] = None


# ── SSE Event Format (compatible with open-science foldEvent) ──

class TextUpdatedEvent(BaseModel):
    type: Literal["text.updated"] = "text.updated"
    sessionId: str
    partId: str
    text: str


class ToolUpdatedEvent(BaseModel):
    type: Literal["tool.updated"] = "tool.updated"
    sessionId: str
    callId: str
    tool: str
    status: Literal["running", "done", "error", "waiting-approval"]
    title: Optional[str] = None
    input: Optional[Dict[str, Any]] = None
    output: Optional[str] = None
    partialOutput: Optional[str] = None
    diff: Optional[str] = None
    startedAt: Optional[str] = None
    endedAt: Optional[str] = None
    childSessionId: Optional[str] = None


class SessionIdleEvent(BaseModel):
    type: Literal["session.idle"] = "session.idle"
    sessionId: str


class SessionErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    sessionId: Optional[str] = None
    message: str


PiScienceEvent = Union[TextUpdatedEvent, ToolUpdatedEvent, SessionIdleEvent, SessionErrorEvent]


# ── Files ──

class FileContent(BaseModel):
    path: str
    encoding: Literal["utf8", "base64"]
    data: str
    size: int


class PreviewData(BaseModel):
    kind: str  # molecule, fits, csv, netcdf, mesh, image, text, etc.
    filename: str
    text: Optional[str] = None
    data: Optional[str] = None  # base64 encoded bytes
    metadata: Optional[Dict[str, Any]] = None


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


# ── Provenance ──

class ProvenanceRecord(BaseModel):
    path: str
    version: int
    ts: float
    tool: str
    toolCallId: Optional[str] = None
    sessionId: str
    model: Optional[str] = None
    contentHash: Optional[str] = None
    content: Optional[str] = None
    diff: Optional[str] = None
    log: Optional[str] = None
    runId: Optional[str] = None
    env: Optional[Dict[str, Any]] = None
