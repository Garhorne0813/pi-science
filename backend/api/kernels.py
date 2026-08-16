"""Kernel execution API — Python/R code execution endpoints."""

import asyncio
import json
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from models import ExecuteCellRequest, CellResult
from services.kernel_manager import kernel_manager
from services.workspace_context import WorkspaceContext

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
        cwd = str(WorkspaceContext.from_cwd(cwd, allow_process_cwd=True))
        return await kernel_manager.execute(
            notebook_id=body.notebook_id or "default",
            session_id=body.session_id,
            language=body.language,
            code=body.code,
            cwd=cwd,
            environment_revision_id=body.environment_revision_id,
            environment_prefix=body.environment_prefix,
            kernel_instance_id=body.kernel_instance_id,
            timeout_seconds=body.timeout_seconds,
        )
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/execute-stream")
async def execute_cell_stream(
    body: ExecuteCellRequest,
    cwd: str = Query(".", description="Working directory for kernel process"),
):
    """Execute a cell and emit stdout/stderr chunks followed by one result."""
    try:
        cwd = str(WorkspaceContext.from_cwd(cwd, allow_process_cwd=True))
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    async def events():
        queue: asyncio.Queue[dict] = asyncio.Queue()
        loop = asyncio.get_running_loop()
        publish = lambda event: loop.call_soon_threadsafe(queue.put_nowait, event)
        task = asyncio.create_task(kernel_manager.execute(
            notebook_id=body.notebook_id or "default",
            session_id=body.session_id,
            language=body.language,
            code=body.code,
            cwd=cwd,
            environment_revision_id=body.environment_revision_id,
            environment_prefix=body.environment_prefix,
            kernel_instance_id=body.kernel_instance_id,
            timeout_seconds=body.timeout_seconds,
            on_event=publish,
        ))
        while not task.done() or not queue.empty():
            try:
                event = await asyncio.wait_for(queue.get(), timeout=0.1)
            except TimeoutError:
                continue
            yield json.dumps(event, ensure_ascii=False) + "\n"
        try:
            result = await task
            yield json.dumps({"type": "result", **result.model_dump()}, ensure_ascii=False) + "\n"
        except Exception as exc:
            yield json.dumps({"type": "result", "ok": False, "stdout": "", "result": None, "error": str(exc), "interrupted": False, "mime": {}}, ensure_ascii=False) + "\n"

    return StreamingResponse(events(), media_type="application/x-ndjson", headers={"x-accel-buffering": "no", "cache-control": "no-cache"})


@router.post("/{notebook_id}/shutdown")
async def shutdown_notebook(
    notebook_id: str,
    cwd: str | None = Query(None, description="Only shut down kernels in this workspace"),
    language: str | None = Query(None, description="Optionally limit to python or r"),
):
    """Shut down a notebook's kernel."""
    if cwd is not None:
        try:
            cwd = str(WorkspaceContext.from_cwd(cwd, allow_process_cwd=True))
        except ValueError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
    await kernel_manager.shutdown_notebook(notebook_id, cwd=cwd, language=language)
    return {"ok": True}


@router.post("/{notebook_id}/interrupt")
async def interrupt_notebook(
    notebook_id: str,
    cwd: str = Query(".", description="Workspace containing the kernel"),
    language: str | None = Query(None),
):
    try:
        cwd = str(WorkspaceContext.from_cwd(cwd, allow_process_cwd=True))
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    interrupted = await kernel_manager.interrupt_notebook(notebook_id, cwd=cwd, language=language)
    return {"ok": interrupted}


@router.post("/shutdown-all")
async def shutdown_all():
    """Shut down all kernel sessions."""
    await kernel_manager.shutdown_all()
    return {"ok": True}
