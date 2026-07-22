"""Unified read model over project knowledge, runs, artifacts, reviews, and research records."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from models.research_memory import ExperienceRecord, ResearchLoop
from services.project_knowledge_store import ProjectKnowledgeStore
from services.research_record_store import ResearchRecordStore


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            row = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def _iso(value: Any) -> str:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
    return str(value or "")


class ProjectMemoryService:
    def __init__(self, workspace: str | Path):
        self.workspace = Path(workspace).expanduser().resolve()
        self.meta = self.workspace / ".pi-science"
        self.knowledge = ProjectKnowledgeStore(self.workspace)
        self.records = ResearchRecordStore(self.workspace)

    def _runs(self) -> list[dict[str, Any]]:
        return _read_jsonl(self.meta / "runs.jsonl")

    def _jobs(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        directory = self.meta / "jobs"
        if not directory.exists():
            return rows
        for path in directory.glob("*.json"):
            try:
                row = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(row, dict):
                rows.append(row)
        return rows

    def _artifacts(self) -> list[dict[str, Any]]:
        return _read_jsonl(self.meta / "artifacts.jsonl")

    def _provenance(self) -> list[dict[str, Any]]:
        return _read_jsonl(self.meta / "provenance.jsonl")

    def _reviews(self) -> list[dict[str, Any]]:
        return _read_jsonl(self.meta / "result-reviews.jsonl")

    async def overview(self) -> dict[str, Any]:
        research = await self.records.list(limit=1_000_000)
        loops = await self.list_loops()
        artifacts = self._artifacts()
        latest_artifacts = {(row.get("artifact_id"), row.get("version")): row for row in artifacts}
        return {
            **self.knowledge.summary(),
            "run_count": len(self._runs()) + len(self._jobs()),
            "artifact_count": len(latest_artifacts),
            "result_review_count": len(self._reviews()),
            "research_record_count": len(research),
            "research_loop_count": len(loops),
            "active_research_loop_count": sum(1 for loop in loops if loop.status in {"ready", "running", "paused", "stopping"}),
        }

    async def timeline(self, limit: int = 200) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for row in self.knowledge.list_history(limit=limit):
            rows.append({"source": "knowledge", **row})
        for row in self._runs():
            rows.append({
                "id": row.get("runId"),
                "event": "run.recorded",
                "created_at": row.get("startedAt"),
                "source": "run",
                "run_id": row.get("runId"),
                "status": row.get("status"),
                "command": row.get("command"),
            })
        for row in self._jobs():
            rows.append({
                "id": row.get("job_id"),
                "event": "job." + str(row.get("status", "unknown")),
                "created_at": row.get("ended_at") or row.get("started_at") or row.get("created_at"),
                "source": "job",
                "run_id": row.get("job_id"),
                "status": row.get("status"),
                "command": row.get("command"),
            })
        for row in self._artifacts():
            rows.append({
                "id": f"{row.get('artifact_id')}:{row.get('version')}",
                "event": "artifact.published",
                "created_at": row.get("published_at"),
                "source": "artifact",
                "artifact_id": row.get("artifact_id"),
                "path": row.get("path"),
                "run_id": row.get("producer", {}).get("run_id"),
            })
        for row in self._reviews():
            rows.append({
                "id": row.get("review_id"),
                "event": "result_review." + str(row.get("status", "unknown")),
                "created_at": _iso(row.get("created_at")),
                "source": "result_review",
                "session_id": row.get("session_id"),
                "status": row.get("status"),
                "finding_count": len(row.get("findings", [])),
            })
        for record in await self.records.list(limit=limit):
            rows.append({"source": "research", "event": record.record_type, **record.model_dump(mode="json")})
        rows.sort(key=lambda item: _iso(item.get("created_at") or item.get("started_at")), reverse=True)
        return rows[:limit]

    async def list_loops(self) -> list[ResearchLoop]:
        records = await self.records.list(limit=1_000_000)
        loops: dict[str, ResearchLoop] = {}
        for record in records:
            if not record.loop_id:
                continue
            if record.record_type == "loop.created":
                try:
                    loops[record.loop_id] = ResearchLoop.model_validate(record.payload)
                except Exception:
                    continue
            elif record.loop_id in loops and record.record_type in {"loop.updated", "loop.state_changed"}:
                payload = loops[record.loop_id].model_dump()
                payload.update(record.payload)
                try:
                    loops[record.loop_id] = ResearchLoop.model_validate(payload)
                except Exception:
                    continue
        return sorted(loops.values(), key=lambda item: item.updated_at, reverse=True)

    async def get_loop(self, loop_id: str) -> ResearchLoop | None:
        return next((item for item in await self.list_loops() if item.loop_id == loop_id), None)

    async def experiences(self, loop_id: str | None = None, limit: int = 200) -> list[ExperienceRecord]:
        research = await self.records.list(loop_id=loop_id, limit=1_000_000)
        artifacts = self._artifacts()
        provenance = self._provenance()
        reviews = self._reviews()
        loops = {item.loop_id: item for item in await self.list_loops()}
        experiences: list[ExperienceRecord] = []

        candidate_records: dict[str, dict[str, Any]] = {}
        for record in research:
            if not record.candidate_id or not record.record_type.startswith("candidate."):
                continue
            candidate_records.setdefault(record.candidate_id, {})[record.record_type] = record

        for candidate_id, lifecycle in candidate_records.items():
            proposed = lifecycle.get("candidate.proposed")
            started = lifecycle.get("candidate.execution_started")
            finished = lifecycle.get("candidate.execution_finished")
            evaluated = lifecycle.get("candidate.evaluated")
            anchor = evaluated or finished or started or proposed
            if anchor is None:
                continue
            run_id = anchor.run_id or (started.run_id if started else None)
            evaluation_payload = evaluated.payload if evaluated else {}
            proposal_payload = proposed.payload if proposed else {}
            execution_payload: dict[str, Any] = {}
            if started:
                execution_payload.update(started.payload)
            if finished:
                execution_payload.update(finished.payload)
            related_artifacts = [
                row for row in artifacts
                if row.get("producer", {}).get("run_id") == run_id
                or row.get("artifact_id") in set(evaluation_payload.get("artifact_ids", []))
            ]
            session_id = anchor.session_id
            related_reviews = [row for row in reviews if session_id and row.get("session_id") == session_id]
            knowledge_ids = [
                item.id for item in self.knowledge.list_items()
                if candidate_id in item.candidate_ids or (anchor.loop_id and anchor.loop_id in item.loop_ids)
            ]
            loop = loops.get(anchor.loop_id or "")
            experiences.append(ExperienceRecord(
                experience_id=f"exp-{candidate_id}",
                loop_id=anchor.loop_id,
                candidate_id=candidate_id,
                parent_candidate_ids=evaluation_payload.get("parent_candidate_ids") or proposal_payload.get("parent_candidate_ids", []),
                inspiration_id=evaluation_payload.get("inspiration_id") or proposal_payload.get("inspiration_id"),
                status=(
                    evaluation_payload.get("status", "evaluated") if evaluated
                    else execution_payload.get("status", "running") if started
                    else "proposed"
                ),
                objective=loop.objective if loop else "",
                approach_summary=evaluation_payload.get("approach_summary") or proposal_payload.get("approach_summary", ""),
                solution=proposal_payload.get("solution", {}),
                execution={"run_id": run_id, **execution_payload},
                artifacts=related_artifacts or evaluation_payload.get("artifact_refs", []),
                evaluation={
                    "metrics": evaluation_payload.get("metrics", {}),
                    "hard_checks": evaluation_payload.get("hard_checks", {}),
                    "findings": evaluation_payload.get("findings", []),
                    "status": evaluation_payload.get("evaluation_status", "passed"),
                } if evaluated else {},
                diagnosis={"reviews": related_reviews, **evaluation_payload.get("diagnosis", {})},
                knowledge_ids=knowledge_ids,
                source_refs=[
                    {"kind": "research_record", "id": item.record_id}
                    for item in (proposed, started, finished, evaluated)
                    if item is not None
                ],
                created_at=(proposed or anchor).created_at,
            ))

        if loop_id is None:
            known_runs = {item.execution.get("run_id") for item in experiences}
            for row in [*self._runs(), *self._jobs()]:
                run_id = row.get("runId") or row.get("job_id")
                if not run_id or run_id in known_runs:
                    continue
                related_artifacts = [item for item in artifacts if item.get("producer", {}).get("run_id") == run_id]
                related_provenance = [item for item in provenance if item.get("runId") == run_id]
                experiences.append(ExperienceRecord(
                    experience_id=f"exp-{run_id}",
                    status=row.get("status", "unknown"),
                    approach_summary=str(row.get("command", "")),
                    execution={"run_id": run_id, **row},
                    artifacts=related_artifacts,
                    source_refs=[{"kind": "provenance", "path": item.get("path"), "version": item.get("version")} for item in related_provenance],
                    provisional=True,
                    created_at=row.get("startedAt") or row.get("created_at") or datetime.now(timezone.utc),
                ))
        experiences.sort(key=lambda item: item.created_at, reverse=True)
        return experiences[:limit]

    async def frontier(self, loop_id: str) -> list[ExperienceRecord]:
        candidates = [item for item in await self.experiences(loop_id, limit=10_000) if item.evaluation]
        eligible = [
            item for item in candidates
            if all(value == "passed" for value in item.evaluation.get("hard_checks", {}).values())
            and item.evaluation.get("status") == "passed"
            and item.evaluation.get("metrics")
        ]

        def dominates(left: ExperienceRecord, right: ExperienceRecord) -> bool:
            left_metrics = left.evaluation.get("metrics", {})
            right_metrics = right.evaluation.get("metrics", {})
            common = set(left_metrics) & set(right_metrics)
            if not common or set(left_metrics) != set(right_metrics):
                return False
            never_worse = True
            strictly_better = False
            for name in common:
                lval = left_metrics[name]
                rval = right_metrics[name]
                lv = float(lval["value"] if isinstance(lval, dict) else lval)
                rv = float(rval["value"] if isinstance(rval, dict) else rval)
                direction = lval.get("direction", "maximize") if isinstance(lval, dict) else "maximize"
                better_or_equal = lv >= rv if direction == "maximize" else lv <= rv
                better = lv > rv if direction == "maximize" else lv < rv
                never_worse = never_worse and better_or_equal
                strictly_better = strictly_better or better
            return never_worse and strictly_better

        return [candidate for candidate in eligible if not any(dominates(other, candidate) for other in eligible if other is not candidate)]
