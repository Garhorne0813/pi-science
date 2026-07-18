"""Provider-neutral job contract API."""

from fastapi import APIRouter, HTTPException, Query

from models.compute import ComputeRequirement, JobSubmitRequest
from services.compute_service import check_capabilities, get_job_store
from services.workspace_security import validate_workspace_cwd

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


def _workspace(cwd: str):
    try:
        return validate_workspace_cwd(cwd)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.post("/capabilities")
async def capabilities(requirement: ComputeRequirement):
    return check_capabilities(requirement).model_dump()


@router.post("")
async def submit_job(body: JobSubmitRequest, cwd: str = Query(".")):
    store = get_job_store(str(_workspace(cwd)))
    try:
        record = await store.submit(body.command, body.requirement, body.surface)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return record.model_dump()


@router.get("")
async def list_jobs(cwd: str = Query("."), limit: int = Query(100, ge=1, le=1000)):
    records = await get_job_store(str(_workspace(cwd))).list(limit)
    return {"jobs": [record.model_dump() for record in records]}


@router.get("/{job_id}")
async def get_job(job_id: str, cwd: str = Query(".")):
    record = await get_job_store(str(_workspace(cwd))).get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return record.model_dump()


@router.delete("/{job_id}")
async def cancel_job(job_id: str, cwd: str = Query(".")):
    record = await get_job_store(str(_workspace(cwd))).cancel(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return record.model_dump()


@router.get("/{job_id}/logs")
async def job_logs(job_id: str, cwd: str = Query(".")):
    record = await get_job_store(str(_workspace(cwd))).get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job_id": job_id, "stdout": record.stdout, "stderr": record.stderr}

