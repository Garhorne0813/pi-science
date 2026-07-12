"""Runs API — experiment run tracking with JSONL storage."""

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Query

router = APIRouter(prefix="/api/runs", tags=["runs"])


def _runs_file(cwd: str) -> Path:
    return Path(cwd).resolve() / ".pi-science" / "runs.jsonl"


@router.get("")
async def list_runs(cwd: str = Query(".", description="Working directory")):
    """List all experiment runs."""
    rf = _runs_file(cwd)
    if not rf.exists():
        return []
    runs = []
    async with aiofiles.open(rf) as f:
        async for line in f:
            if line.strip():
                try:
                    runs.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    runs.reverse()
    return runs[:100]


@router.post("")
async def record_run(
    cwd: str = Query(".", description="Working directory"),
    command: str = Query(...),
    surface: str = Query("local"),
    host: str = Query(""),
    status: str = Query("ok"),
    run_id: str = Query(""),
):
    """Record an experiment run. Called by agent tools."""
    rf = _runs_file(cwd)
    rf.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "runId": run_id or f"run_{int(time.time()*1000)}",
        "command": command,
        "surface": surface,
        "host": host,
        "status": status,
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "outputs": [],
    }
    async with aiofiles.open(rf, "a") as f:
        await f.write(json.dumps(record) + "\n")
    return record


@router.get("/{run_id}/log")
async def get_run_log(
    run_id: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Get the log for a specific run."""
    rf = _runs_file(cwd)
    if not rf.exists():
        return {"log": ""}
    async with aiofiles.open(rf) as f:
        async for line in f:
            if line.strip():
                try:
                    rec = json.loads(line)
                    if rec.get("runId") == run_id:
                        return {"log": rec.get("log", ""), "run": rec}
                except json.JSONDecodeError:
                    pass
    return {"log": "", "error": "Run not found"}
