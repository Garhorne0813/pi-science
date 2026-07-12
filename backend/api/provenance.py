"""Provenance API — query and manage artifact provenance records."""

from fastapi import APIRouter, HTTPException, Query
from typing import Optional

from services.provenance_store import get_store

router = APIRouter(prefix="/api/provenance", tags=["provenance"])


@router.get("")
async def query_provenance(
    cwd: str = Query(".", description="Working directory"),
    path: Optional[str] = Query(None, description="Filter by artifact path"),
    session_id: Optional[str] = Query(None, description="Filter by session ID"),
    limit: int = Query(100, ge=1, le=1000),
):
    """Query provenance records."""
    store = get_store(cwd)
    records = await store.query(path=path, session_id=session_id, limit=limit)
    return {
        "records": [r.model_dump() for r in records],
        "total": store.record_count,
    }


@router.get("/versions/{path:path}")
async def get_versions(
    path: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Get all versions of a specific artifact."""
    store = get_store(cwd)
    records = await store.get_versions(path)
    return {"path": path, "versions": [r.model_dump() for r in records]}


@router.post("/capture")
async def capture_environment(
    cwd: str = Query(".", description="Working directory"),
    label: Optional[str] = Query(None),
):
    """Capture current Python environment snapshot."""
    store = get_store(cwd)
    env_data = await store.capture_environment(label=label)
    return env_data


@router.post("/record")
async def record_provenance(
    cwd: str = Query(".", description="Working directory"),
    path: str = Query(...),
    session_id: str = Query(...),
    tool: str = Query(...),
    tool_call_id: Optional[str] = Query(None),
    model: Optional[str] = Query(None),
    content: Optional[str] = Query(None),
    diff: Optional[str] = Query(None),
    run_id: Optional[str] = Query(None),
):
    """Manually record a provenance entry."""
    store = get_store(cwd)
    record = await store.record(
        path=path,
        session_id=session_id,
        tool=tool,
        tool_call_id=tool_call_id,
        model=model,
        content=content,
        diff=diff,
        run_id=run_id,
    )
    return record.model_dump()
