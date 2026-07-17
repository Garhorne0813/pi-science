"""Kernel execution API — Python/R code execution endpoints."""

from fastapi import APIRouter, HTTPException, Query
from models import ExecuteCellRequest, CellResult
from services.kernel_manager import kernel_manager

router = APIRouter(prefix="/api/kernels", tags=["kernels"])


@router.get("/status")
async def kernel_status():
    """Get status of all kernel sessions."""
    return {
        "interpreters": await kernel_manager.discover_interpreters(),
        "sessions": kernel_manager.list_sessions(),
        "active_count": kernel_manager.active_count,
    }


@router.post("/execute", response_model=CellResult)
async def execute_cell(
    body: ExecuteCellRequest,
    cwd: str = Query(".", description="Working directory for kernel process"),
):
    """Execute Python or R code in a persistent kernel session."""
    try:
        return await kernel_manager.execute(
            notebook_id=body.notebook_id or "default",
            language=body.language,
            code=body.code,
            cwd=cwd,
            timeout_seconds=body.timeout_seconds,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{notebook_id}/shutdown")
async def shutdown_notebook(
    notebook_id: str,
    cwd: str | None = Query(None, description="Only shut down kernels in this workspace"),
    language: str | None = Query(None, description="Optionally limit to python or r"),
):
    """Shut down a notebook's kernel."""
    await kernel_manager.shutdown_notebook(notebook_id, cwd=cwd, language=language)
    return {"ok": True}


@router.post("/shutdown-all")
async def shutdown_all():
    """Shut down all kernel sessions."""
    await kernel_manager.shutdown_all()
    return {"ok": True}
