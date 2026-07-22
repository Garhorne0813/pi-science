"""Serial candidate snapshot and execution support for Research Loops."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
from typing import Any
from uuid import uuid4

from models.compute import ComputeRequirement
from models.research_memory import CandidateProposalRequest, ResearchLoop
from services.job_coordinator import get_job_coordinator
from services.project_memory import ProjectMemoryService
from services.research_loop_policy import ResearchLoopPolicy
from services.workspace_journal import sync_journal_lock


class ResearchLoopWorkerError(ValueError):
    pass


class ResearchLoopWorker:
    def __init__(self, workspace: str | Path):
        self.workspace = Path(workspace).expanduser().resolve()
        self.solutions_dir = self.workspace / ".pi-science" / "solutions"
        self.memory = ProjectMemoryService(self.workspace)

    @staticmethod
    def _safe_relative(value: str) -> Path:
        path = Path(value.replace("\\", "/"))
        if not value or path.is_absolute() or ".." in path.parts or path.name in {"", ".", ".."}:
            raise ResearchLoopWorkerError(f"invalid solution path: {value}")
        return path

    async def propose(self, loop: ResearchLoop, body: CandidateProposalRequest) -> dict[str, Any]:
        if loop.status != "running":
            raise ResearchLoopWorkerError("research loop must be running")
        if reason := await ResearchLoopPolicy(self.memory).budget_exhaustion(loop):
            raise ResearchLoopWorkerError(reason)
        existing = await self.memory.records.list(loop_id=loop.loop_id, record_type="candidate.proposed", limit=100_000)
        if body.idempotency_key:
            previous = next(
                (record for record in existing if record.payload.get("idempotency_key") == body.idempotency_key),
                None,
            )
            if previous:
                solution = previous.payload.get("solution", {})
                return {
                    "candidate_id": previous.candidate_id,
                    "loop_id": loop.loop_id,
                    "approach_summary": previous.payload.get("approach_summary", ""),
                    "entrypoint": solution.get("entrypoint", "solve.sh"),
                    "digest": solution.get("digest", ""),
                    "parent_candidate_ids": previous.payload.get("parent_candidate_ids", []),
                    "inspiration_id": previous.payload.get("inspiration_id"),
                }
        if len(existing) >= loop.budget.max_candidates:
            raise ResearchLoopWorkerError("candidate budget exhausted")
        if loop.mode == "serial":
            started = await self.memory.records.list(loop_id=loop.loop_id, record_type="candidate.execution_started", limit=100_000)
            finished = await self.memory.records.list(loop_id=loop.loop_id, record_type="candidate.execution_finished", limit=100_000)
            finished_ids = {record.candidate_id for record in finished}
            if any(record.candidate_id not in finished_ids for record in started):
                raise ResearchLoopWorkerError("serial loop already has an active candidate")

        candidate_id = f"candidate-{uuid4().hex[:16]}"
        candidate_dir = (self.solutions_dir / candidate_id).resolve()
        if not candidate_dir.is_relative_to(self.solutions_dir.resolve()):
            raise ResearchLoopWorkerError("candidate directory escapes solution root")
        entrypoint = self._safe_relative(body.entrypoint)
        normalized: dict[Path, str] = {}
        total_chars = 0
        for raw, content in body.files.items():
            path = self._safe_relative(raw)
            total_chars += len(content)
            if total_chars > 2_000_000:
                raise ResearchLoopWorkerError("candidate source exceeds 2 MB")
            normalized[path] = content
        if entrypoint not in normalized:
            raise ResearchLoopWorkerError("entrypoint must be included in candidate files")

        digest = hashlib.sha256()
        for path in sorted(normalized, key=lambda item: item.as_posix()):
            digest.update(path.as_posix().encode())
            digest.update(b"\0")
            digest.update(normalized[path].encode())
            digest.update(b"\0")
        solution_digest = "sha256:" + digest.hexdigest()

        self.solutions_dir.mkdir(parents=True, exist_ok=True)
        with sync_journal_lock(candidate_dir):
            candidate_dir.mkdir(parents=False, exist_ok=False)
            for relative, content in normalized.items():
                target = candidate_dir / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            os.chmod(candidate_dir / entrypoint, 0o700)
            manifest = {
                "candidate_id": candidate_id,
                "loop_id": loop.loop_id,
                "approach_summary": body.approach_summary,
                "entrypoint": entrypoint.as_posix(),
                "digest": solution_digest,
                "parent_candidate_ids": body.parent_candidate_ids,
                "inspiration_id": body.inspiration_id,
            }
            manifest_path = candidate_dir / "solution.json"
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            for target in candidate_dir.rglob("*"):
                if target.is_file():
                    os.chmod(target, 0o555 if target == candidate_dir / entrypoint else 0o444)
            for directory in sorted((item for item in candidate_dir.rglob("*") if item.is_dir()), reverse=True):
                os.chmod(directory, 0o555)
            os.chmod(candidate_dir, 0o555)

        await self.memory.records.append(
            "candidate.proposed",
            producer="proposal-worker",
            loop_id=loop.loop_id,
            candidate_id=candidate_id,
            payload={
                "approach_summary": body.approach_summary,
                "solution": {
                    "path": candidate_dir.relative_to(self.workspace).as_posix(),
                    "entrypoint": entrypoint.as_posix(),
                    "digest": solution_digest,
                },
                "parent_candidate_ids": body.parent_candidate_ids,
                "inspiration_id": body.inspiration_id,
                "idempotency_key": body.idempotency_key,
            },
        )
        return manifest

    async def execute(self, loop: ResearchLoop, candidate_id: str) -> dict[str, Any]:
        if loop.status != "running":
            raise ResearchLoopWorkerError("research loop must be running")
        proposed = await self.memory.records.list(loop_id=loop.loop_id, candidate_id=candidate_id, record_type="candidate.proposed")
        if not proposed:
            raise ResearchLoopWorkerError("candidate not found in this loop")
        if await self.memory.records.list(loop_id=loop.loop_id, candidate_id=candidate_id, record_type="candidate.execution_started"):
            raise ResearchLoopWorkerError("candidate has already been executed")
        solution = proposed[-1].payload.get("solution", {})
        entrypoint = self._safe_relative(str(solution.get("entrypoint", "solve.sh")))
        candidate_dir = self.solutions_dir / candidate_id
        script = candidate_dir / entrypoint
        if not script.exists():
            raise ResearchLoopWorkerError("candidate entrypoint is missing")
        requirement = ComputeRequirement(timeout_seconds=min(loop.budget.max_wall_seconds, 86_400), network="none")
        command = ["bash", script.relative_to(self.workspace).as_posix()]
        job = await get_job_coordinator(str(self.workspace)).submit(command, requirement, "local")
        await self.memory.records.append(
            "candidate.execution_started",
            producer="research-loop-worker",
            loop_id=loop.loop_id,
            candidate_id=candidate_id,
            run_id=job.job_id,
            payload={"job_id": job.job_id, "command": command, "solution": solution},
        )
        asyncio.create_task(self._observe_job(loop.loop_id, candidate_id, job.job_id))
        return job.model_dump(mode="json")

    async def _observe_job(self, loop_id: str, candidate_id: str, job_id: str) -> None:
        coordinator = get_job_coordinator(str(self.workspace))
        while True:
            await asyncio.sleep(0.05)
            job = await coordinator.status(job_id)
            if job is None:
                return
            if job.status in {"succeeded", "failed", "cancelled", "timed_out"}:
                await self.memory.records.append(
                    "candidate.execution_finished",
                    producer="research-loop-worker",
                    loop_id=loop_id,
                    candidate_id=candidate_id,
                    run_id=job_id,
                    payload={
                        "job_id": job_id,
                        "status": job.status,
                        "return_code": job.return_code,
                        "started_at": job.started_at.isoformat() if job.started_at else None,
                        "finished_at": job.ended_at.isoformat() if job.ended_at else None,
                        "stdout_excerpt": job.stdout[-4000:],
                        "stderr_excerpt": job.stderr[-4000:],
                        "environment": job.environment,
                    },
                )
                return
