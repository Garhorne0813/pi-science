"""Provider-neutral job provider interfaces and a deterministic fake provider."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from models.compute import ComputeRequirement, JobRecord


class JobProvider(Protocol):
    name: str

    async def submit(self, command: list[str], requirement: ComputeRequirement) -> JobRecord: ...
    async def status(self, job_id: str) -> JobRecord | None: ...
    async def cancel(self, job_id: str) -> JobRecord | None: ...
    async def logs(self, job_id: str) -> tuple[str, str]: ...


@dataclass
class FakeProvider:
    """Contract-test provider; it never touches a host or external service."""

    name: str = "fake"
    jobs: dict[str, JobRecord] = field(default_factory=dict)

    async def submit(self, command: list[str], requirement: ComputeRequirement) -> JobRecord:
        from datetime import datetime, timezone
        from uuid import uuid4

        record = JobRecord(job_id=f"fake_{uuid4().hex[:12]}", command=command, cwd="fake://workspace", created_at=datetime.now(timezone.utc), requirement=requirement, status="succeeded", stdout="fake provider output")
        self.jobs[record.job_id] = record
        return record

    async def status(self, job_id: str) -> JobRecord | None:
        return self.jobs.get(job_id)

    async def cancel(self, job_id: str) -> JobRecord | None:
        record = self.jobs.get(job_id)
        if record:
            record.status = "cancelled"
        return record

    async def logs(self, job_id: str) -> tuple[str, str]:
        record = self.jobs.get(job_id)
        return (record.stdout, record.stderr) if record else ("", "job not found")

