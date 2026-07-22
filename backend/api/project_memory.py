"""Unified Project Memory and serial Research Loop API."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from models import Proposal, SourceReference
from models.research_memory import (
    CandidateEvaluationRequest,
    CandidateProposalRequest,
    EvaluatorSpec,
    Inspiration,
    KnowledgePromotionRequest,
    ResearchLoop,
    ResearchLoopCreateRequest,
    ResearchLoopUpdateRequest,
)
from services.project_memory import ProjectMemoryService
from services.research_loop_policy import ResearchLoopPolicy
from services.research_loop_worker import ResearchLoopWorker, ResearchLoopWorkerError
from services.job_coordinator import get_job_coordinator
from services.workspace_security import validate_workspace_cwd


router = APIRouter(prefix="/api/project-memory", tags=["project-memory"])


def _service(cwd: str) -> ProjectMemoryService:
    try:
        workspace = validate_workspace_cwd(cwd)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return ProjectMemoryService(workspace)


@router.get("/overview")
async def overview(cwd: str = Query(".")):
    return await _service(cwd).overview()


@router.get("/timeline")
async def timeline(cwd: str = Query("."), limit: int = Query(200, ge=1, le=1000)):
    return {"timeline": await _service(cwd).timeline(limit)}


@router.post("/index/rebuild")
async def rebuild_index(cwd: str = Query(".")):
    return await _service(cwd).records.rebuild_index()


@router.get("/experiences")
async def experiences(
    cwd: str = Query("."),
    loop_id: str | None = Query(None),
    limit: int = Query(200, ge=1, le=1000),
):
    return {"experiences": [item.model_dump(mode="json") for item in await _service(cwd).experiences(loop_id, limit)]}


@router.get("/experiences/{experience_id}")
async def experience_detail(experience_id: str, cwd: str = Query(".")):
    item = next((row for row in await _service(cwd).experiences(limit=10_000) if row.experience_id == experience_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="Experience not found")
    return item.model_dump(mode="json")


@router.get("/inspirations/{inspiration_id}")
async def inspiration_detail(inspiration_id: str, cwd: str = Query(".")):
    records = await _service(cwd).records.list(record_type="inspiration.issued", limit=100_000)
    record = next((item for item in reversed(records) if item.payload.get("inspiration_id") == inspiration_id), None)
    if record is None:
        raise HTTPException(status_code=404, detail="Inspiration not found")
    return record.payload


@router.post("/research-loops")
async def create_loop(body: ResearchLoopCreateRequest, cwd: str = Query(".")):
    service = _service(cwd)
    loop = ResearchLoop(**body.model_dump())
    await service.records.append(
        "loop.created",
        producer="project-memory-api",
        loop_id=loop.loop_id,
        correlation_id=loop.loop_id,
        payload=loop.model_dump(mode="json"),
    )
    return loop.model_dump(mode="json")


@router.get("/research-loops")
async def list_loops(cwd: str = Query(".")):
    return {"loops": [item.model_dump(mode="json") for item in await _service(cwd).list_loops()]}


async def _loop_or_404(service: ProjectMemoryService, loop_id: str) -> ResearchLoop:
    loop = await service.get_loop(loop_id)
    if loop is None:
        raise HTTPException(status_code=404, detail="Research loop not found")
    return loop


@router.get("/research-loops/{loop_id}")
async def get_loop(loop_id: str, cwd: str = Query(".")):
    service = _service(cwd)
    loop = await _loop_or_404(service, loop_id)
    return {
        **loop.model_dump(mode="json"),
        "experiences": [item.model_dump(mode="json") for item in await service.experiences(loop_id)],
        "frontier": [item.model_dump(mode="json") for item in await service.frontier(loop_id)],
    }


@router.patch("/research-loops/{loop_id}")
async def update_loop(loop_id: str, body: ResearchLoopUpdateRequest, cwd: str = Query(".")):
    service = _service(cwd)
    loop = await _loop_or_404(service, loop_id)
    if loop.status not in {"draft", "paused"}:
        raise HTTPException(status_code=409, detail="Only draft or paused loops can be edited")
    changes = body.model_dump(exclude_none=True, mode="json")
    changes["updated_at"] = datetime.now(timezone.utc).isoformat()
    await service.records.append("loop.updated", producer="project-memory-api", loop_id=loop_id, payload=changes)
    return (await _loop_or_404(service, loop_id)).model_dump(mode="json")


@router.post("/research-loops/{loop_id}/preflight")
async def preflight_loop(loop_id: str, cwd: str = Query(".")):
    service = _service(cwd)
    loop = await _loop_or_404(service, loop_id)
    blockers: list[str] = []
    if loop.evaluator_ref is None:
        blockers.append("an approved evaluator is required")
    else:
        registered = await service.records.list(record_type="evaluator.registered", limit=10_000)
        matching = next((record for record in reversed(registered) if record.payload.get("evaluator_id") == loop.evaluator_ref.evaluator_id and record.payload.get("version") == loop.evaluator_ref.version), None)
        if matching is None:
            blockers.append("evaluator version is not registered")
        elif matching.payload.get("digest") != loop.evaluator_ref.digest:
            blockers.append("evaluator digest does not match the registered version")
        elif matching.payload.get("status") != "approved":
            blockers.append("evaluator version is not approved")
        elif not matching.payload.get("metrics"):
            blockers.append("evaluator must declare at least one metric")
    result = {"ok": not blockers, "blockers": blockers}
    if not blockers and loop.status == "draft":
        await service.records.append(
            "evaluator.activated",
            producer="project-memory-api",
            loop_id=loop.loop_id,
            payload=loop.evaluator_ref.model_dump(mode="json") if loop.evaluator_ref else {},
        )
        await _change_state(service, loop, "ready", reason="preflight_passed")
    return result


_TRANSITIONS: dict[str, set[str]] = {
    "draft": {"ready", "cancelled"},
    "ready": {"running", "cancelled"},
    "running": {"paused", "stopping", "completed", "failed", "cancelled"},
    "paused": {"running", "cancelled"},
    "stopping": {"completed", "failed", "cancelled"},
    "completed": set(),
    "failed": set(),
    "cancelled": set(),
}


async def _change_state(service: ProjectMemoryService, loop: ResearchLoop, status: str, *, reason: str | None = None) -> ResearchLoop:
    if status not in _TRANSITIONS.get(loop.status, set()):
        raise HTTPException(status_code=409, detail=f"Invalid loop transition: {loop.status} -> {status}")
    payload: dict[str, Any] = {"status": status, "updated_at": datetime.now(timezone.utc).isoformat()}
    if status in {"completed", "failed", "cancelled"}:
        payload["stop_reason"] = reason or status
    await service.records.append(
        "loop.state_changed",
        producer="project-memory-api",
        loop_id=loop.loop_id,
        payload=payload,
    )
    return await _loop_or_404(service, loop.loop_id)


@router.post("/research-loops/{loop_id}/evaluations")
async def record_evaluation(loop_id: str, body: CandidateEvaluationRequest, cwd: str = Query(".")):
    service = _service(cwd)
    loop = await _loop_or_404(service, loop_id)
    if loop.status not in {"running", "paused"}:
        raise HTTPException(status_code=409, detail="Loop must be running or paused to record a candidate")
    registered = await service.records.list(record_type="evaluator.registered", limit=10_000)
    evaluator = next(
        (
            record.payload for record in reversed(registered)
            if loop.evaluator_ref
            and record.payload.get("evaluator_id") == loop.evaluator_ref.evaluator_id
            and record.payload.get("version") == loop.evaluator_ref.version
        ),
        {},
    )
    declared_metrics = {row.get("name"): row.get("direction") for row in evaluator.get("metrics", [])}
    unknown_metrics = set(body.metrics) - set(declared_metrics)
    if unknown_metrics:
        raise HTTPException(status_code=422, detail="Undeclared evaluator metrics: " + ", ".join(sorted(unknown_metrics)))
    wrong_directions = [
        name for name, metric in body.metrics.items()
        if declared_metrics.get(name) and metric.direction != declared_metrics[name]
    ]
    if wrong_directions:
        raise HTTPException(status_code=422, detail="Metric direction mismatch: " + ", ".join(sorted(wrong_directions)))
    declared_checks = set(evaluator.get("hard_checks", []))
    unknown_checks = set(body.hard_checks) - declared_checks
    if unknown_checks:
        raise HTTPException(status_code=422, detail="Undeclared hard checks: " + ", ".join(sorted(unknown_checks)))
    hard_checks = {name: body.hard_checks.get(name, "pending") for name in declared_checks}
    evaluation_status = (
        "failed" if any(value == "failed" for value in hard_checks.values())
        else "incomplete" if any(value == "pending" for value in hard_checks.values())
        else "passed"
    )
    record = await service.records.append(
        "candidate.evaluated",
        producer="evaluator-service",
        loop_id=loop_id,
        candidate_id=body.candidate_id,
        run_id=body.run_id,
        session_id=body.session_id,
        payload={
            "status": "evaluated",
            "evaluator_ref": loop.evaluator_ref.model_dump(mode="json") if loop.evaluator_ref else None,
            "approach_summary": body.approach_summary,
            "metrics": {key: value.model_dump(mode="json") for key, value in body.metrics.items()},
            "hard_checks": hard_checks,
            "artifact_refs": body.artifact_refs,
            "findings": body.findings,
            "parent_candidate_ids": body.parent_candidate_ids,
            "evaluation_status": evaluation_status,
            "model_tokens": body.model_tokens,
            "cost_usd": body.cost_usd,
        },
    )
    if loop.status == "running":
        reason = await ResearchLoopPolicy(service).stop_after_evaluation(loop)
        if reason:
            await _change_state(service, loop, "completed", reason=reason)
    return record.model_dump(mode="json")


@router.get("/research-loops/{loop_id}/frontier")
async def frontier(loop_id: str, cwd: str = Query(".")):
    service = _service(cwd)
    await _loop_or_404(service, loop_id)
    return {"frontier": [item.model_dump(mode="json") for item in await service.frontier(loop_id)]}


@router.post("/research-loops/{loop_id}/inspirations")
async def create_inspiration(loop_id: str, cwd: str = Query(".")):
    service = _service(cwd)
    loop = await _loop_or_404(service, loop_id)
    experiences = await service.experiences(loop_id, limit=10_000)
    frontier_rows = await service.frontier(loop_id)
    best = frontier_rows[:2]
    failures = [item for item in experiences if item.evaluation.get("status") == "failed"][:1]
    selected_ids = {item.experience_id for item in [*best, *failures]}
    diverse = next((item for item in experiences if item.experience_id not in selected_ids), None)
    knowledge = service.knowledge.list_items(include_inactive=False)[:8]
    refs = {
        "best": [item.experience_id for item in best],
        "informative_failures": [item.experience_id for item in failures],
        "diverse": [diverse.experience_id] if diverse else [],
    }
    context_material = json.dumps({"objective": loop.objective, "knowledge": [item.id for item in knowledge], "experiences": refs}, sort_keys=True)
    inspiration = Inspiration(
        loop_id=loop_id,
        objective=loop.objective,
        knowledge_refs=[item.id for item in knowledge],
        experience_refs=refs,
        selection_reasons=["selected current Pareto frontier", "included an informative hard-check failure", "reserved a different historical direction"],
        token_estimate=max(1, len(context_material) // 4),
        context_digest=hashlib.sha256(context_material.encode()).hexdigest(),
    )
    await service.records.append(
        "inspiration.issued",
        producer="context-assembler",
        loop_id=loop_id,
        payload=inspiration.model_dump(mode="json"),
    )
    return inspiration.model_dump(mode="json")


@router.post("/research-loops/{loop_id}/promote")
async def promote_candidate(loop_id: str, body: KnowledgePromotionRequest, cwd: str = Query(".")):
    service = _service(cwd)
    loop = await _loop_or_404(service, loop_id)
    experience = next((item for item in await service.experiences(loop_id, limit=10_000) if item.candidate_id == body.candidate_id), None)
    if experience is None:
        raise HTTPException(status_code=404, detail="Candidate experience not found")
    if experience.evaluation.get("status") != "passed":
        raise HTTPException(status_code=409, detail="Only a fully passed evaluation can be promoted to project knowledge")
    artifact_refs = [
        {key: row.get(key) for key in ("artifact_id", "version", "sha256") if row.get(key) is not None}
        for row in experience.artifacts
    ]
    proposal = Proposal(
        proposal_type="knowledge",
        knowledge_type=body.knowledge_type,
        title=body.title,
        summary=body.summary,
        reason=body.reason,
        confidence="high",
        importance="important",
        source_message_ids=[],
        related_files=[row.get("path") for row in experience.artifacts if row.get("path")],
        source=SourceReference(
            session_id=experience.execution.get("session_id"),
            run_ids=[experience.execution.get("run_id")] if experience.execution.get("run_id") else [],
            files=[row.get("path") for row in experience.artifacts if row.get("path")],
        ),
        experience_ids=[experience.experience_id],
        loop_ids=[loop_id],
        candidate_ids=[body.candidate_id],
        evaluator_refs=[loop.evaluator_ref.model_dump(mode="json")] if loop.evaluator_ref else [],
        artifact_refs=artifact_refs,
    )
    created, _ = service.knowledge.add_proposals([proposal])
    if not created:
        raise HTTPException(status_code=409, detail="An equivalent knowledge proposal already exists")
    await service.records.append(
        "knowledge.promotion_requested",
        producer="project-memory-api",
        loop_id=loop_id,
        candidate_id=body.candidate_id,
        run_id=experience.execution.get("run_id"),
        payload={
            "proposal_id": proposal.id,
            "experience_ids": proposal.experience_ids,
            "loop_ids": proposal.loop_ids,
            "candidate_ids": proposal.candidate_ids,
            "evaluator_refs": proposal.evaluator_refs,
            "artifact_refs": proposal.artifact_refs,
        },
    )
    return {"ok": True, "proposal": proposal.model_dump(mode="json")}


@router.post("/research-loops/{loop_id}/candidates")
async def propose_candidate(loop_id: str, body: CandidateProposalRequest, cwd: str = Query(".")):
    service = _service(cwd)
    loop = await _loop_or_404(service, loop_id)
    try:
        return await ResearchLoopWorker(service.workspace).propose(loop, body)
    except ResearchLoopWorkerError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/research-loops/{loop_id}/candidates/{candidate_id}/execute")
async def execute_candidate(loop_id: str, candidate_id: str, cwd: str = Query(".")):
    service = _service(cwd)
    loop = await _loop_or_404(service, loop_id)
    try:
        return await ResearchLoopWorker(service.workspace).execute(loop, candidate_id)
    except ResearchLoopWorkerError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/research-loops/{loop_id}/{action}")
async def loop_action(loop_id: str, action: str, cwd: str = Query(".")):
    targets = {"start": "running", "pause": "paused", "resume": "running", "cancel": "cancelled", "complete": "completed"}
    if action not in targets:
        raise HTTPException(status_code=404, detail="Unknown research loop action")
    service = _service(cwd)
    loop = await _loop_or_404(service, loop_id)
    if action in {"start", "resume"}:
        if reason := await ResearchLoopPolicy(service).budget_exhaustion(loop):
            raise HTTPException(status_code=409, detail=reason)
    started = await service.records.list(loop_id=loop_id, record_type="candidate.execution_started", limit=100_000)
    finished = await service.records.list(loop_id=loop_id, record_type="candidate.execution_finished", limit=100_000)
    finished_ids = {record.candidate_id for record in finished}
    active = [record for record in started if record.candidate_id not in finished_ids]
    if action == "complete" and active:
        raise HTTPException(status_code=409, detail="Cannot complete a loop with an active candidate")
    if action == "cancel":
        coordinator = get_job_coordinator(str(service.workspace))
        for record in active:
            job_id = str(record.payload.get("job_id") or record.run_id or "")
            if job_id:
                await coordinator.cancel(job_id)
    return (await _change_state(service, loop, targets[action], reason=f"user_{action}")).model_dump(mode="json")


@router.post("/evaluators")
async def register_evaluator(body: EvaluatorSpec, cwd: str = Query(".")):
    service = _service(cwd)
    existing = await service.records.list(record_type="evaluator.registered", limit=10_000)
    if any(record.payload.get("evaluator_id") == body.evaluator_id and record.payload.get("version") == body.version for record in existing):
        raise HTTPException(status_code=409, detail="Evaluator version already exists")
    record = await service.records.append("evaluator.registered", producer="project-memory-api", payload=body.model_dump(mode="json"))
    return {"record_id": record.record_id, "evaluator": body.model_dump(mode="json")}


@router.get("/evaluators")
async def list_evaluators(cwd: str = Query(".")):
    records = await _service(cwd).records.list(record_type="evaluator.registered", limit=100_000)
    return {"evaluators": [record.payload for record in records]}


@router.get("/evaluators/{evaluator_id}/versions/{version}")
async def get_evaluator(evaluator_id: str, version: int, cwd: str = Query(".")):
    records = await _service(cwd).records.list(record_type="evaluator.registered", limit=100_000)
    record = next(
        (
            item for item in reversed(records)
            if item.payload.get("evaluator_id") == evaluator_id and item.payload.get("version") == version
        ),
        None,
    )
    if record is None:
        raise HTTPException(status_code=404, detail="Evaluator version not found")
    return record.payload
