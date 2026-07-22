"""Contracts for the unified project-memory and research-loop record stream."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


RecordType = Literal[
    "loop.created",
    "loop.updated",
    "loop.state_changed",
    "candidate.proposed",
    "candidate.execution_started",
    "candidate.execution_finished",
    "candidate.evaluated",
    "inspiration.issued",
    "evaluator.registered",
    "evaluator.activated",
    "knowledge.promotion_requested",
    "knowledge.promotion_decided",
]
LoopStatus = Literal[
    "draft",
    "ready",
    "running",
    "stopping",
    "paused",
    "completed",
    "failed",
    "cancelled",
]
MetricDirection = Literal["maximize", "minimize"]
CheckStatus = Literal["passed", "failed", "pending"]


class ResearchRecordEnvelope(BaseModel):
    schema_version: Literal[1] = 1
    record_id: str = Field(default_factory=lambda: f"record-{uuid4().hex[:16]}")
    record_type: RecordType
    workspace_id: str
    loop_id: str | None = None
    candidate_id: str | None = None
    session_id: str | None = None
    run_id: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    producer: str
    causation_id: str | None = None
    correlation_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class EvaluatorRef(BaseModel):
    evaluator_id: str
    version: int = Field(ge=1)
    digest: str = Field(min_length=8, max_length=128)


class MetricValue(BaseModel):
    value: float
    direction: MetricDirection
    standard_error: float | None = Field(default=None, ge=0)
    confidence_interval: tuple[float, float] | None = None
    repetitions: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_interval(self):
        if self.confidence_interval and self.confidence_interval[0] > self.confidence_interval[1]:
            raise ValueError("confidence interval lower bound exceeds upper bound")
        return self


class ResearchBudget(BaseModel):
    max_candidates: int = Field(default=20, ge=1, le=10_000)
    max_wall_seconds: int = Field(default=7200, ge=1, le=31_536_000)
    max_model_tokens: int | None = Field(default=None, ge=1)
    max_cost_usd: float | None = Field(default=None, ge=0)
    max_parallel: int = Field(default=1, ge=1, le=64)


class StopConditions(BaseModel):
    target_metrics: dict[str, float] = Field(default_factory=dict)
    patience: int = Field(default=5, ge=1, le=10_000)
    min_improvement: float = Field(default=0.0, ge=0)


class ResearchLoop(BaseModel):
    schema_version: Literal[1] = 1
    loop_id: str = Field(default_factory=lambda: f"loop-{uuid4().hex[:16]}")
    title: str = Field(min_length=1, max_length=200)
    objective: str = Field(min_length=1, max_length=4000)
    status: LoopStatus = "draft"
    mode: Literal["serial", "parallel"] = "serial"
    evaluator_ref: EvaluatorRef | None = None
    budget: ResearchBudget = Field(default_factory=ResearchBudget)
    stop_conditions: StopConditions = Field(default_factory=StopConditions)
    constraints: list[str] = Field(default_factory=list, max_length=100)
    created_by: str = "user"
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    stop_reason: str | None = None


class ExperienceRecord(BaseModel):
    schema_version: Literal[1] = 1
    experience_id: str
    loop_id: str | None = None
    candidate_id: str | None = None
    parent_candidate_ids: list[str] = Field(default_factory=list)
    inspiration_id: str | None = None
    status: str
    objective: str = ""
    approach_summary: str = ""
    solution: dict[str, Any] = Field(default_factory=dict)
    execution: dict[str, Any] = Field(default_factory=dict)
    artifacts: list[dict[str, Any]] = Field(default_factory=list)
    evaluation: dict[str, Any] = Field(default_factory=dict)
    diagnosis: dict[str, Any] = Field(default_factory=dict)
    knowledge_ids: list[str] = Field(default_factory=list)
    source_refs: list[dict[str, Any]] = Field(default_factory=list)
    provisional: bool = False
    created_at: datetime = Field(default_factory=utc_now)


class Inspiration(BaseModel):
    schema_version: Literal[1] = 1
    inspiration_id: str = Field(default_factory=lambda: f"inspiration-{uuid4().hex[:16]}")
    loop_id: str
    strategy: str = "best_failure_diverse"
    objective: str
    knowledge_refs: list[str] = Field(default_factory=list)
    experience_refs: dict[str, list[str]] = Field(default_factory=dict)
    included_evidence: list[dict[str, Any]] = Field(default_factory=list)
    excluded_reasons: list[dict[str, str]] = Field(default_factory=list)
    selection_reasons: list[str] = Field(default_factory=list)
    token_estimate: int = Field(default=0, ge=0)
    context_digest: str = ""
    created_at: datetime = Field(default_factory=utc_now)


class EvaluatorMetric(BaseModel):
    name: str
    direction: MetricDirection
    weight: float = 0.0


class EvaluatorSpec(BaseModel):
    schema_version: Literal[1] = 1
    evaluator_id: str
    version: int = Field(default=1, ge=1)
    digest: str = Field(min_length=8, max_length=128)
    status: Literal["draft", "approved", "deprecated"] = "draft"
    inputs: list[dict[str, Any]] = Field(default_factory=list)
    metrics: list[EvaluatorMetric] = Field(default_factory=list)
    hard_checks: list[str] = Field(default_factory=list)
    entrypoint: str = "evaluate.py"
    fixtures_digest: str = ""
    approved_by: str | None = None
    approved_at: datetime | None = None


class ResearchLoopCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    objective: str = Field(min_length=1, max_length=4000)
    evaluator_ref: EvaluatorRef | None = None
    budget: ResearchBudget = Field(default_factory=ResearchBudget)
    stop_conditions: StopConditions = Field(default_factory=StopConditions)
    constraints: list[str] = Field(default_factory=list, max_length=100)


class ResearchLoopUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    objective: str | None = Field(default=None, min_length=1, max_length=4000)
    evaluator_ref: EvaluatorRef | None = None
    budget: ResearchBudget | None = None
    stop_conditions: StopConditions | None = None
    constraints: list[str] | None = None


class CandidateEvaluationRequest(BaseModel):
    candidate_id: str
    run_id: str | None = None
    session_id: str | None = None
    approach_summary: str = ""
    metrics: dict[str, MetricValue] = Field(default_factory=dict)
    hard_checks: dict[str, CheckStatus] = Field(default_factory=dict)
    artifact_refs: list[dict[str, Any]] = Field(default_factory=list)
    findings: list[dict[str, Any]] = Field(default_factory=list)
    parent_candidate_ids: list[str] = Field(default_factory=list)
    model_tokens: int = Field(default=0, ge=0)
    cost_usd: float = Field(default=0, ge=0)


class CandidateProposalRequest(BaseModel):
    approach_summary: str = Field(min_length=1, max_length=4000)
    files: dict[str, str] = Field(min_length=1, max_length=100)
    entrypoint: str = "solve.sh"
    inspiration_id: str | None = None
    parent_candidate_ids: list[str] = Field(default_factory=list, max_length=100)
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=200)


class KnowledgePromotionRequest(BaseModel):
    candidate_id: str
    knowledge_type: Literal[
        "finding", "conclusion", "decision", "hypothesis", "question", "task", "project_change", "artifact"
    ] = "finding"
    title: str = Field(min_length=1, max_length=160)
    summary: str = Field(min_length=1, max_length=4000)
    reason: str = Field(default="Promoted from a reviewed research candidate", min_length=1, max_length=2000)
