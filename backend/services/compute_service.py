"""Local provider implementation of the provider-neutral Job Contract."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import platform
import shlex
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

import aiofiles

from models.compute import CapabilityCheck, ComputeRequirement, JobRecord


def check_capabilities(requirement: ComputeRequirement) -> CapabilityCheck:
    checks = {
        "cpu": os.cpu_count() or 1,
        "memory_mb": None,
        "gpu": bool(os.environ.get("CUDA_VISIBLE_DEVICES")) or bool(os.environ.get("NVIDIA_VISIBLE_DEVICES")),
        "runtime": {"python": shutil.which("python3") or shutil.which("python"), "r": shutil.which("Rscript"), "node": shutil.which("node")},
        "packages": {name: importlib.util.find_spec(name.split("==", 1)[0].replace("-", "_")) is not None for name in requirement.packages},
    }
    reasons: list[str] = []
    if checks["cpu"] < requirement.cpu:
        reasons.append(f"requires {requirement.cpu} CPUs, host has {checks['cpu']}")
    if requirement.gpu and not checks["gpu"]:
        reasons.append("GPU requested but no visible GPU was detected")
    if requirement.runtime != "any" and not checks["runtime"].get(requirement.runtime):
        reasons.append(f"runtime not found: {requirement.runtime}")
    missing = [name for name, available in checks["packages"].items() if not available]
    if missing:
        reasons.append("missing packages: " + ", ".join(missing))
    status = "blocked" if any(
        phrase in reason for reason in reasons for phrase in ("requires", "GPU", "runtime not found")
    ) else "degraded" if reasons else "ready"
    return CapabilityCheck(status=status, checks=checks, reasons=reasons)


class JobStore:
    def __init__(self, workspace: str):
        self.workspace = Path(workspace).expanduser().resolve()
        self.directory = self.workspace / ".pi-science" / "jobs"
        self.directory.mkdir(parents=True, exist_ok=True)
        self._records: dict[str, JobRecord] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    def _path(self, job_id: str) -> Path:
        return self.directory / f"{job_id}.json"

    async def _save(self, record: JobRecord) -> None:
        self._records[record.job_id] = record
        async with aiofiles.open(self._path(record.job_id), "w", encoding="utf-8") as handle:
            await handle.write(record.model_dump_json())
        from services.telemetry import record_metric
        await record_metric(str(self.workspace), "job", record.status, metadata={"job_id": record.job_id, "surface": record.surface})

    async def submit(self, command: list[str] | str, requirement: ComputeRequirement, surface: str = "local") -> JobRecord:
        argv = shlex.split(command) if isinstance(command, str) else [str(item) for item in command]
        if not argv:
            raise ValueError("command is empty")
        capability = check_capabilities(requirement)
        if capability.status == "blocked":
            raise ValueError("; ".join(capability.reasons))
        job_id = f"job_{uuid.uuid4().hex[:16]}"
        record = JobRecord(
            job_id=job_id,
            command=argv,
            cwd=str(self.workspace),
            surface=surface,
            status="pending",
            created_at=datetime.now(timezone.utc),
            requirement=requirement,
            environment={"python": platform.python_version(), "platform": platform.platform()},
        )
        await self._save(record)
        self._tasks[job_id] = asyncio.create_task(self._run(record))
        return record

    async def _run(self, record: JobRecord) -> None:
        record.status = "running"
        record.started_at = datetime.now(timezone.utc)
        await self._save(record)
        process = None
        try:
            process = await asyncio.create_subprocess_exec(
                *record.command,
                cwd=str(self.workspace),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=os.environ.copy(),
            )
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=record.requirement.timeout_seconds)
            record.stdout = stdout.decode("utf-8", errors="replace")[-100_000:]
            record.stderr = stderr.decode("utf-8", errors="replace")[-100_000:]
            record.return_code = process.returncode
            record.status = "succeeded" if process.returncode == 0 else "failed"
        except asyncio.TimeoutError:
            if process is not None:
                process.kill()
                await process.wait()
            record.status = "timed_out"
            record.stderr = "job exceeded timeout"
        except asyncio.CancelledError:
            if process is not None:
                process.kill()
                await process.wait()
            record.status = "cancelled"
            raise
        except Exception as exc:
            record.status = "failed"
            record.stderr = str(exc)[:100_000]
        finally:
            record.ended_at = datetime.now(timezone.utc)
            await self._save(record)

    async def get(self, job_id: str) -> JobRecord | None:
        record = self._records.get(job_id)
        if record:
            return record
        path = self._path(job_id)
        if not path.exists():
            return None
        try:
            record = JobRecord.model_validate_json(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        self._records[job_id] = record
        return record

    async def list(self, limit: int = 100) -> list[JobRecord]:
        records: list[JobRecord] = []
        for path in sorted(self.directory.glob("job_*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            item = await self.get(path.stem)
            if item:
                records.append(item)
        return records[:limit]

    async def cancel(self, job_id: str) -> JobRecord | None:
        record = await self.get(job_id)
        if record is None:
            return None
        task = self._tasks.get(job_id)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        record.status = "cancelled"
        record.ended_at = datetime.now(timezone.utc)
        await self._save(record)
        return record


_stores: dict[str, JobStore] = {}


def get_job_store(workspace: str) -> JobStore:
    key = str(Path(workspace).expanduser().resolve())
    if key not in _stores:
        _stores[key] = JobStore(key)
    return _stores[key]
