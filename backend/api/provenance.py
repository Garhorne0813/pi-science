"""Provenance API — query and manage artifact provenance records."""

from fastapi import APIRouter, HTTPException, Query
from typing import Optional
import re

from services.provenance_store import get_store

router = APIRouter(prefix="/api/provenance", tags=["provenance"])


def _workspace_dir(cwd: str) -> str:
    from services.workspace_security import validate_workspace_cwd

    try:
        return str(validate_workspace_cwd(cwd))
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.get("")
async def query_provenance(
    cwd: str = Query(".", description="Working directory"),
    path: Optional[str] = Query(None, description="Filter by artifact path"),
    session_id: Optional[str] = Query(None, description="Filter by session ID"),
    limit: int = Query(100, ge=1, le=1000),
):
    """Query provenance records."""
    store = get_store(_workspace_dir(cwd))
    records = await store.query(path=path, session_id=session_id, limit=limit)
    return {
        "records": [r.model_dump() for r in records],
        "total": store.record_count,
    }


@router.get("/env/{hash}")
async def get_env_lockfile(
    hash: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Read a captured environment lockfile by its content hash."""
    if not re.fullmatch(r"[0-9a-fA-F]{16}", hash):
        raise HTTPException(status_code=400, detail="Invalid environment lockfile hash")
    store = get_store(_workspace_dir(cwd))
    env_file = (store._env_dir / f"{hash}.txt").resolve()
    if not env_file.is_relative_to(store._env_dir.resolve()):
        raise HTTPException(status_code=400, detail="Invalid environment lockfile path")
    if not env_file.exists():
        raise HTTPException(status_code=404, detail="Environment lockfile not found")
    return {"hash": hash, "text": env_file.read_text()}


@router.get("/versions/{path:path}")
async def get_versions(
    path: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Get all versions of a specific artifact."""
    store = get_store(_workspace_dir(cwd))
    records = await store.get_versions(path)
    return {"path": path, "versions": [r.model_dump() for r in records]}


@router.post("/capture")
async def capture_environment(
    cwd: str = Query(".", description="Working directory"),
    label: Optional[str] = Query(None),
):
    """Capture current Python environment snapshot."""
    store = get_store(_workspace_dir(cwd))
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
    store = get_store(_workspace_dir(cwd))
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
