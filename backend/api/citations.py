"""Citation normalization and verification endpoints."""

from fastapi import APIRouter

from models.citation import Citation, CitationBatchRequest, CitationVerifyRequest
from services.citation_service import deduplicate, normalize_identifier, verify

router = APIRouter(prefix="/api/citations", tags=["citations"])


@router.post("/normalize")
async def normalize_citations(body: CitationBatchRequest):
    citations: list[Citation] = []
    errors: list[dict[str, str]] = []
    for value in body.identifiers:
        try:
            citations.append(normalize_identifier(value))
        except ValueError as exc:
            errors.append({"identifier": value, "error": str(exc)})
    return {"citations": [item.model_dump() for item in deduplicate(citations)], "errors": errors}


@router.post("/verify")
async def verify_citation(body: CitationVerifyRequest):
    return (await verify(body.citation, force=body.force)).model_dump()
