"""Normalized literature search API."""

from fastapi import APIRouter

from models.literature import LiteratureSearchRequest
from services.literature_service import search

router = APIRouter(prefix="/api/literature", tags=["literature"])


@router.post("/search")
async def search_literature(body: LiteratureSearchRequest):
    return await search(body.query, body.providers, body.limit)

