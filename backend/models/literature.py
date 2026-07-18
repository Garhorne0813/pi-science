"""Normalized literature search results."""

from pydantic import BaseModel, Field


class LiteratureRecord(BaseModel):
    title: str
    authors: list[str] = Field(default_factory=list)
    year: int | None = None
    identifier: str | None = None
    identifier_kind: str | None = None
    url: str | None = None
    source: str
    abstract: str | None = None


class LiteratureSearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=500)
    providers: list[str] = Field(default_factory=lambda: ["crossref", "openalex", "pubmed", "arxiv"])
    limit: int = Field(default=10, ge=1, le=50)

