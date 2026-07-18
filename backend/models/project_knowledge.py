"""Data contracts for project knowledge, Reviewer proposals, and file plans."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


KnowledgeType = Literal[
    "finding",
    "conclusion",
    "decision",
    "hypothesis",
    "question",
    "task",
    "project_change",
    "artifact",
]
Confidence = Literal["low", "medium", "high"]
Importance = Literal["normal", "important", "critical"]
ProposalStatus = Literal["pending", "accepted", "rejected", "failed", "undone"]
FileOperationType = Literal["mkdir", "move", "rename"]


class SourceReference(BaseModel):
    session_id: Optional[str] = None
    message_ids: list[str] = Field(default_factory=list)
    files: list[str] = Field(default_factory=list)
    run_ids: list[str] = Field(default_factory=list)
    citations: list[str] = Field(default_factory=list)


class FileOperation(BaseModel):
    type: FileOperationType
    source: Optional[str] = None
    target: str = Field(min_length=1, max_length=1000)
    reason: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def validate_source(self):
        if self.type in {"move", "rename"} and not self.source:
            raise ValueError(f"{self.type} requires source")
        if self.type == "mkdir" and self.source:
            raise ValueError("mkdir does not accept source")
        return self


class ReviewerProposalInput(BaseModel):
    proposal_type: Literal["knowledge", "file_operation"]
    knowledge_type: Optional[KnowledgeType] = None
    title: str = Field(min_length=1, max_length=160)
    summary: str = Field(min_length=1, max_length=4000)
    reason: str = Field(min_length=1, max_length=2000)
    confidence: Confidence = "medium"
    importance: Importance = "normal"
    source_message_ids: list[str] = Field(default_factory=list, max_length=100)
    related_files: list[str] = Field(default_factory=list, max_length=100)
    conflicts_with: list[str] = Field(default_factory=list, max_length=100)
    supersedes: list[str] = Field(default_factory=list, max_length=100)
    operations: list[FileOperation] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def validate_shape(self):
        if self.proposal_type == "knowledge":
            if not self.knowledge_type:
                raise ValueError("knowledge proposal requires knowledge_type")
            if self.operations:
                raise ValueError("knowledge proposal cannot include file operations")
        else:
            if self.knowledge_type:
                raise ValueError("file operation proposal cannot include knowledge_type")
            if not self.operations:
                raise ValueError("file operation proposal requires operations")
        return self


class ReviewerResult(BaseModel):
    proposals: list[ReviewerProposalInput] = Field(default_factory=list, max_length=20)


class Proposal(ReviewerProposalInput):
    id: str = Field(default_factory=lambda: f"proposal-{uuid4().hex[:12]}")
    status: ProposalStatus = "pending"
    source: SourceReference = Field(default_factory=SourceReference)
    fingerprint: str = ""
    reviewer_run_id: Optional[str] = None
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)
    decision_reason: Optional[str] = None
    applied_history_id: Optional[str] = None


class KnowledgeItem(BaseModel):
    id: str = Field(default_factory=lambda: f"knowledge-{uuid4().hex[:12]}")
    type: KnowledgeType
    title: str = Field(min_length=1, max_length=160)
    summary: str = Field(min_length=1, max_length=4000)
    confidence: Confidence = "medium"
    importance: Importance = "normal"
    status: Literal["active", "superseded", "archived"] = "active"
    source: SourceReference = Field(default_factory=SourceReference)
    related_files: list[str] = Field(default_factory=list)
    conflicts_with: list[str] = Field(default_factory=list)
    supersedes: list[str] = Field(default_factory=list)
    proposal_id: Optional[str] = None
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)


class ProjectPolicy(BaseModel):
    auto_review: bool = True
    reminder_threshold: int = Field(default=5, ge=1, le=100)
    max_directory_depth: int = Field(default=3, ge=1, le=10)
    minimum_files_for_new_category: int = Field(default=3, ge=1, le=100)
    locked_paths: list[str] = Field(default_factory=list)
    naming_pattern: str = "{date}_{topic}_{kind}_{version}"
    accepted_counts: dict[str, int] = Field(default_factory=dict)
    rejected_counts: dict[str, int] = Field(default_factory=dict)
    external_services_allowed: bool = True
    allowed_egress_domains: list[str] = Field(default_factory=list)
    blocked_data_classes: list[str] = Field(default_factory=list)
    updated_at: str = Field(default_factory=utc_now_iso)


class ReviewRequest(BaseModel):
    cwd: str
    session_id: Optional[str] = None
    include_files: bool = True
    force_full_session: bool = False


class ReviewResponse(BaseModel):
    ok: bool = True
    run_id: str
    created: int
    skipped: int = 0
    proposal_ids: list[str] = Field(default_factory=list)
    message: str = ""


class ProposalDecisionRequest(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=160)
    summary: Optional[str] = Field(default=None, min_length=1, max_length=4000)
    reason: Optional[str] = Field(default=None, max_length=2000)


class ProposalUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=160)
    summary: Optional[str] = Field(default=None, min_length=1, max_length=4000)
    reason: Optional[str] = Field(default=None, min_length=1, max_length=2000)
    confidence: Optional[Confidence] = None
    importance: Optional[Importance] = None
    related_files: Optional[list[str]] = None
    operations: Optional[list[FileOperation]] = None


class BatchDecisionRequest(BaseModel):
    proposal_ids: list[str] = Field(min_length=1, max_length=100)
    action: Literal["accept", "reject"]
    reason: Optional[str] = Field(default=None, max_length=2000)


class ProjectPolicyUpdate(BaseModel):
    auto_review: Optional[bool] = None
    reminder_threshold: Optional[int] = Field(default=None, ge=1, le=100)
    max_directory_depth: Optional[int] = Field(default=None, ge=1, le=10)
    minimum_files_for_new_category: Optional[int] = Field(default=None, ge=1, le=100)
    locked_paths: Optional[list[str]] = None
    naming_pattern: Optional[str] = Field(default=None, max_length=200)
    external_services_allowed: Optional[bool] = None
    allowed_egress_domains: Optional[list[str]] = None
    blocked_data_classes: Optional[list[str]] = None
