"""Remote compute API — SSH and Slurm job management (stub for Phase 3)."""

from fastapi import APIRouter

router = APIRouter(prefix="/api/compute", tags=["compute"])


@router.get("/machines")
async def list_machines():
    """List configured remote compute machines."""
    return {"machines": []}


@router.get("/jobs")
async def list_jobs():
    """List active and recent remote jobs."""
    return {"jobs": []}


@router.post("/run")
async def run_remote():
    """Submit a job to a remote machine."""
    return {"ok": False, "error": "Remote compute not yet implemented"}
