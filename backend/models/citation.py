"""Citation identity and verification contracts."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


CitationKind = Literal["doi", "pmid", "arxiv", "url"]
CitationStatus = Literal[
    "unverified",
    "verified",
    "not_found",
    "network_error",
    "metadata_conflict",
    "retracted_check_pending",
    "retracted",
]


class Citation(BaseModel):
    kind: CitationKind
    identifier: str = Field(min_length=1, max_length=500)
    canonical: str
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    year: int | None = Field(default=None, ge=0, le=3000)
    source: str | None = None
    retrieved_at: datetime | None = None
    verification: CitationStatus = "unverified"
    verification_detail: str | None = None


class CitationBatchRequest(BaseModel):
    identifiers: list[str] = Field(min_length=1, max_length=100)


class CitationVerifyRequest(BaseModel):
    citation: Citation
    force: bool = False

