"""Budget and stopping policy derived from the unified research record stream."""

from __future__ import annotations

from datetime import datetime, timezone

from models.research_memory import ResearchLoop
from services.project_memory import ProjectMemoryService


class ResearchLoopPolicy:
    def __init__(self, memory: ProjectMemoryService):
        self.memory = memory

    async def budget_exhaustion(self, loop: ResearchLoop) -> str | None:
        records = await self.memory.records.list(loop_id=loop.loop_id, limit=100_000)
        candidates = {
            record.candidate_id
            for record in records
            if record.candidate_id and record.record_type in {"candidate.proposed", "candidate.evaluated"}
        }
        if len(candidates) >= loop.budget.max_candidates:
            return "candidate_budget_exhausted"
        elapsed = (datetime.now(timezone.utc) - loop.created_at).total_seconds()
        if elapsed >= loop.budget.max_wall_seconds:
            return "wall_time_budget_exhausted"
        evaluations = [record for record in records if record.record_type == "candidate.evaluated"]
        tokens = sum(int(record.payload.get("model_tokens", 0) or 0) for record in evaluations)
        cost = sum(float(record.payload.get("cost_usd", 0) or 0) for record in evaluations)
        if loop.budget.max_model_tokens is not None and tokens >= loop.budget.max_model_tokens:
            return "model_token_budget_exhausted"
        if loop.budget.max_cost_usd is not None and cost >= loop.budget.max_cost_usd:
            return "cost_budget_exhausted"
        return None

    async def stop_after_evaluation(self, loop: ResearchLoop) -> str | None:
        if reason := await self.budget_exhaustion(loop):
            return reason
        records = await self.memory.records.list(
            loop_id=loop.loop_id,
            record_type="candidate.evaluated",
            limit=100_000,
        )
        passed = [record for record in records if record.payload.get("evaluation_status") == "passed"]
        if not passed:
            return None

        targets = loop.stop_conditions.target_metrics
        if targets:
            latest = passed[-1].payload.get("metrics", {})
            reached = True
            for name, target in targets.items():
                metric = latest.get(name)
                if not isinstance(metric, dict) or "value" not in metric:
                    reached = False
                    break
                value = float(metric["value"])
                reached = reached and (
                    value <= target if metric.get("direction") == "minimize" else value >= target
                )
            if reached:
                return "target_metrics_reached"

        primary = await self._primary_metric(loop)
        if primary and len(passed) > loop.stop_conditions.patience:
            values = [record.payload.get("metrics", {}).get(primary) for record in passed]
            values = [value for value in values if isinstance(value, dict) and "value" in value]
            if len(values) > loop.stop_conditions.patience:
                direction = values[-1].get("direction", "maximize")
                best = float(values[0]["value"])
                stale = 0
                for metric in values[1:]:
                    value = float(metric["value"])
                    improvement = best - value if direction == "minimize" else value - best
                    if improvement >= loop.stop_conditions.min_improvement:
                        best = value
                        stale = 0
                    else:
                        stale += 1
                if stale >= loop.stop_conditions.patience:
                    return "patience_exhausted"
        return None

    async def _primary_metric(self, loop: ResearchLoop) -> str | None:
        if loop.evaluator_ref is None:
            return None
        records = await self.memory.records.list(record_type="evaluator.registered", limit=100_000)
        registered = next(
            (
                record for record in reversed(records)
                if record.payload.get("evaluator_id") == loop.evaluator_ref.evaluator_id
                and record.payload.get("version") == loop.evaluator_ref.version
            ),
            None,
        )
        metrics = registered.payload.get("metrics", []) if registered else []
        if not metrics:
            return None
        return max(metrics, key=lambda metric: float(metric.get("weight", 0))).get("name")
