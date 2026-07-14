"""Remote compute API — SSH and Slurm job management."""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from services.compute_service import (
    load_machines, save_machines, probe_machine, submit_job,
)

router = APIRouter(prefix="/api/compute", tags=["compute"])


class SaveMachineRequest(BaseModel):
    host: str
    label: str = ""
    user: str = ""
    port: int = 22
    identity_file: str = ""
    scheduler: str = ""


class SubmitJobRequest(BaseModel):
    machine: str
    command: str
    job_name: str = ""
    input_files: list[str] = []
    output_files: list[str] = []
    slurm: dict = {}


@router.get("/machines")
async def get_machines(cwd: str = Query(".", description="Working directory")):
    """List configured remote machines."""
    return {"machines": load_machines(cwd)}


@router.post("/machines")
async def add_machine(body: SaveMachineRequest, cwd: str = Query(".", description="Working directory")):
    """Add a remote machine configuration."""
    machines = load_machines(cwd)
    machine = body.model_dump()
    if not machine.get("label"):
        machine["label"] = machine["host"]
    # Update if same label exists, otherwise append
    existing = next((i for i, m in enumerate(machines) if m.get("label") == machine["label"]), None)
    if existing is not None:
        machines[existing] = machine
    else:
        machines.append(machine)
    save_machines(cwd, machines)
    return {"ok": True, "machines": machines}


@router.delete("/machines/{label}")
async def remove_machine(label: str, cwd: str = Query(".", description="Working directory")):
    """Remove a remote machine."""
    machines = [m for m in load_machines(cwd) if m.get("label") != label]
    save_machines(cwd, machines)
    return {"ok": True}


@router.post("/probe")
async def probe(host: str = Query(...), user: str = Query(""),
                port: int = Query(22), identity_file: str = Query("")):
    """Probe a remote machine for hardware info."""
    return probe_machine(host, user, port, identity_file)


@router.post("/run")
async def run_job(body: SubmitJobRequest, cwd: str = Query(".", description="Working directory")):
    """Submit a job to a remote machine."""
    try:
        result = submit_job(
            cwd=cwd,
            machine_label=body.machine,
            command=body.command,
            job_name=body.job_name,
            input_files=body.input_files or [],
            output_files=body.output_files or [],
            slurm_opts=body.slurm or {},
        )
        return result
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=str(e))

import subprocess
