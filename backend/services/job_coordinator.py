"""Provider-neutral job coordination for one workspace."""

from __future__ import annotations

from pathlib import Path

from models.compute import ComputeRequirement, JobRecord
from services.compute_providers import JobProvider
from services.compute_service import JobStore


class LocalJobProvider:
    name = "local"

    def __init__(self, workspace: str):
        self.store = JobStore(workspace)

    async def submit(self, command: list[str], requirement: ComputeRequirement) -> JobRecord:
        return await self.store.submit(command, requirement, self.name)

    async def status(self, job_id: str) -> JobRecord | None:
        return await self.store.get(job_id)

    async def cancel(self, job_id: str) -> JobRecord | None:
        return await self.store.cancel(job_id)

    async def logs(self, job_id: str) -> tuple[str, str]:
        record = await self.store.get(job_id)
        return (record.stdout, record.stderr) if record else ("", "job not found")


class JobCoordinator:
    """Select providers while keeping job state behind one interface."""

    def __init__(self, workspace: str, providers: list[JobProvider] | None = None):
        local = LocalJobProvider(workspace)
        self.providers: dict[str, JobProvider] = {provider.name: provider for provider in (providers or [local])}
        self.local = local

    async def submit(self, command: list[str], requirement: ComputeRequirement, provider: str = "local") -> JobRecord:
        selected = self.providers.get(provider)
        if selected is None:
            raise ValueError(f"unknown job provider: {provider}")
        return await selected.submit(command, requirement)

    async def status(self, job_id: str) -> JobRecord | None:
        for provider in self.providers.values():
            if record := await provider.status(job_id):
                return record
        return None

    async def cancel(self, job_id: str) -> JobRecord | None:
        for provider in self.providers.values():
            if await provider.status(job_id):
                return await provider.cancel(job_id)
        return None

    async def logs(self, job_id: str) -> tuple[str, str] | None:
        for provider in self.providers.values():
            if await provider.status(job_id):
                return await provider.logs(job_id)
        return None

    async def list(self, limit: int = 100) -> list[JobRecord]:
        # Local durable discovery remains available while remote adapters are
        # expected to reconcile their own records into the same journal.
        return await self.local.store.list(limit)


_coordinators: dict[str, JobCoordinator] = {}


def get_job_coordinator(workspace: str) -> JobCoordinator:
    key = str(Path(workspace).expanduser().resolve())
    return _coordinators.setdefault(key, JobCoordinator(key))
