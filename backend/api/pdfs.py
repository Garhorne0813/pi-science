"""PDF indexing and page-level evidence search API."""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from services.pdf_index import get_pdf_index
from services.workspace_security import validate_workspace_cwd

router = APIRouter(prefix="/api/pdfs", tags=["pdfs"])


class PdfSearchRequest(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(default=20, ge=1, le=100)


def _workspace(cwd: str):
    try:
        return validate_workspace_cwd(cwd)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.post("/index")
async def index_pdf(path: str = Query(...), cwd: str = Query(".")):
    try:
        return await get_pdf_index(str(_workspace(cwd))).index(path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"PDF not found: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/search")
async def search_pdf(body: PdfSearchRequest, cwd: str = Query(".")):
    try:
        results = await get_pdf_index(str(_workspace(cwd))).search(body.path, body.query, limit=body.limit)
        return {"path": body.path, "query": body.query, "results": results}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"PDF not found: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

