"""Unified Project Memory and serial Research Loop tests."""

import asyncio
import json

import pytest

from services.project_knowledge_store import ProjectKnowledgeStore
from services.project_memory import ProjectMemoryService
from services.research_record_store import ResearchRecordStore
from api.workspaces import _seed_harness


@pytest.mark.anyio
async def test_research_record_store_is_single_append_only_stream(temp_workspace):
    store = ResearchRecordStore(temp_workspace)
    first = await store.append(
        "loop.created",
        producer="test",
        loop_id="loop-one",
        payload={"title": "One"},
    )
    await store.append(
        "candidate.evaluated",
        producer="test",
        loop_id="loop-one",
        candidate_id="candidate-one",
        payload={"metrics": {}},
    )
    with store.path.open("a", encoding="utf-8") as handle:
        handle.write("not-json\n")

    rows = await store.list(loop_id="loop-one")

    assert store.path == (temp_workspace / ".pi-science" / "research-records.jsonl").resolve()
    assert len(rows) == 2
    assert rows[0].record_id == first.record_id
    assert not (temp_workspace / ".pi-science" / "research-loops").exists()
    assert not (temp_workspace / ".pi-science" / "experiences.jsonl").exists()

    index = await store.rebuild_index()
    assert index["record_count"] == 2
    assert json.loads(store.index_path.read_text())["loops"]["loop-one"] == 2
    store.index_path.unlink()
    assert (await store.rebuild_index())["candidates"]["candidate-one"] == 1


@pytest.mark.anyio
async def test_research_record_store_serializes_concurrent_appends(temp_workspace):
    store = ResearchRecordStore(temp_workspace)
    await asyncio.gather(*(
        store.append(
            "candidate.proposed",
            producer="parallel-test",
            loop_id="loop-concurrent",
            candidate_id=f"candidate-{index}",
        )
        for index in range(40)
    ))

    rows = await store.list(loop_id="loop-concurrent", limit=100)
    assert len(rows) == 40
    assert len({row.record_id for row in rows}) == 40
    assert len(store.path.read_text().splitlines()) == 40


def test_workspace_harness_seeds_only_agent_contract(temp_workspace):
    _seed_harness(temp_workspace)

    assert (temp_workspace / "AGENTS.md").exists()
    assert not (temp_workspace / "KNOWLEDGE.md").exists()
    assert not (temp_workspace / "knowledge").exists()
    assert not (temp_workspace / "notes").exists()
    contract = (temp_workspace / "AGENTS.md").read_text()
    assert "Project Memory" in contract
    assert "Do not create, edit, summarize, or synchronize files under `.pi-science/`" in contract


@pytest.mark.anyio
async def test_project_memory_aggregates_existing_facts_without_copying_them(temp_workspace):
    meta = temp_workspace / ".pi-science"
    (meta / "runs.jsonl").write_text(json.dumps({
        "runId": "run-old",
        "command": "python analysis.py",
        "status": "ok",
        "startedAt": "2026-07-22T00:00:00+00:00",
    }) + "\n")
    (meta / "artifacts.jsonl").write_text(json.dumps({
        "artifact_id": "artifact-old",
        "version": 1,
        "path": "result.csv",
        "sha256": "a" * 64,
        "published_at": "2026-07-22T00:01:00+00:00",
        "producer": {"run_id": "run-old"},
    }) + "\n")
    (meta / "result-reviews.jsonl").write_text(json.dumps({
        "review_id": "review-old",
        "session_id": "session-old",
        "status": "pass",
        "findings": [],
        "created_at": 1784678520,
    }) + "\n")

    service = ProjectMemoryService(temp_workspace)
    overview = await service.overview()
    rows = await service.experiences()
    timeline = await service.timeline()

    assert overview["run_count"] == 1
    assert overview["artifact_count"] == 1
    assert overview["result_review_count"] == 1
    assert rows[0].experience_id == "exp-run-old"
    assert rows[0].provisional is True
    assert rows[0].artifacts[0]["artifact_id"] == "artifact-old"
    assert {row["event"] for row in timeline} >= {"run.recorded", "artifact.published", "result_review.pass"}
    assert not (meta / "experiences.jsonl").exists()


async def _create_ready_loop(client, temp_workspace):
    evaluator = {
        "evaluator_id": "eval-quality",
        "version": 1,
        "digest": "sha256:evaluator-v1",
        "status": "approved",
        "metrics": [
            {"name": "quality", "direction": "maximize", "weight": 1},
            {"name": "runtime", "direction": "minimize", "weight": 0},
        ],
        "hard_checks": ["verified"],
    }
    registered = await client.post(
        "/api/project-memory/evaluators",
        params={"cwd": str(temp_workspace)},
        json=evaluator,
    )
    assert registered.status_code == 200
    created = await client.post(
        "/api/project-memory/research-loops",
        params={"cwd": str(temp_workspace)},
        json={
            "title": "Improve quality",
            "objective": "Improve quality without increasing runtime",
            "evaluator_ref": {
                "evaluator_id": "eval-quality",
                "version": 1,
                "digest": "sha256:evaluator-v1",
            },
            "constraints": ["keep outputs reproducible"],
        },
    )
    assert created.status_code == 200
    loop_id = created.json()["loop_id"]
    preflight = await client.post(
        f"/api/project-memory/research-loops/{loop_id}/preflight",
        params={"cwd": str(temp_workspace)},
    )
    assert preflight.status_code == 200
    assert preflight.json()["ok"] is True
    started = await client.post(
        f"/api/project-memory/research-loops/{loop_id}/start",
        params={"cwd": str(temp_workspace)},
    )
    assert started.status_code == 200
    assert started.json()["status"] == "running"
    return loop_id


@pytest.mark.anyio
async def test_research_loop_frontier_and_state_machine(client, temp_workspace):
    loop_id = await _create_ready_loop(client, temp_workspace)
    candidates = [
        ("candidate-a", 0.80, 10.0, "passed"),
        ("candidate-b", 0.85, 12.0, "passed"),
        ("candidate-c", 0.70, 20.0, "passed"),
        ("candidate-unsafe", 0.99, 1.0, "failed"),
    ]
    for candidate_id, quality, runtime, check in candidates:
        response = await client.post(
            f"/api/project-memory/research-loops/{loop_id}/evaluations",
            params={"cwd": str(temp_workspace)},
            json={
                "candidate_id": candidate_id,
                "approach_summary": candidate_id,
                "metrics": {
                    "quality": {"value": quality, "direction": "maximize"},
                    "runtime": {"value": runtime, "direction": "minimize"},
                },
                "hard_checks": {"verified": check},
            },
        )
        assert response.status_code == 200

    frontier = await client.get(
        f"/api/project-memory/research-loops/{loop_id}/frontier",
        params={"cwd": str(temp_workspace)},
    )
    frontier_ids = {item["candidate_id"] for item in frontier.json()["frontier"]}

    assert frontier_ids == {"candidate-a", "candidate-b"}
    assert "candidate-unsafe" not in frontier_ids

    paused = await client.post(
        f"/api/project-memory/research-loops/{loop_id}/pause",
        params={"cwd": str(temp_workspace)},
    )
    assert paused.json()["status"] == "paused"
    invalid = await client.post(
        f"/api/project-memory/research-loops/{loop_id}/complete",
        params={"cwd": str(temp_workspace)},
    )
    assert invalid.status_code == 409


@pytest.mark.anyio
async def test_candidate_promotes_through_existing_knowledge_inbox(client, temp_workspace):
    loop_id = await _create_ready_loop(client, temp_workspace)
    evaluated = await client.post(
        f"/api/project-memory/research-loops/{loop_id}/evaluations",
        params={"cwd": str(temp_workspace)},
        json={
            "candidate_id": "candidate-good",
            "run_id": "run-good",
            "approach_summary": "Validated approach",
            "metrics": {"quality": {"value": 0.9, "direction": "maximize"}},
            "hard_checks": {"verified": "passed"},
        },
    )
    assert evaluated.status_code == 200
    promoted = await client.post(
        f"/api/project-memory/research-loops/{loop_id}/promote",
        params={"cwd": str(temp_workspace)},
        json={
            "candidate_id": "candidate-good",
            "knowledge_type": "finding",
            "title": "Validated approach improves quality",
            "summary": "The evaluated candidate reached quality 0.9.",
        },
    )
    assert promoted.status_code == 200
    proposal_id = promoted.json()["proposal"]["id"]

    store = ProjectKnowledgeStore(temp_workspace)
    proposal = store.get_proposal(proposal_id)
    assert proposal is not None
    assert proposal.loop_ids == [loop_id]
    assert proposal.candidate_ids == ["candidate-good"]
    assert proposal.evaluator_refs[0]["evaluator_id"] == "eval-quality"

    accepted = await client.post(
        f"/api/project-knowledge/proposals/{proposal_id}/accept",
        params={"cwd": str(temp_workspace)},
        json={},
    )
    assert accepted.status_code == 200
    item = store.list_items()[-1]
    assert item.loop_ids == [loop_id]
    assert item.candidate_ids == ["candidate-good"]
    assert item.experience_ids == ["exp-candidate-good"]
    assert item.evaluator_refs[0]["digest"] == "sha256:evaluator-v1"
    assert "Validated approach improves quality" in store.project_file.read_text()

    records = await ResearchRecordStore(temp_workspace).list(loop_id=loop_id)
    assert any(record.record_type == "knowledge.promotion_requested" for record in records)
    assert any(record.record_type == "knowledge.promotion_decided" for record in records)


@pytest.mark.anyio
async def test_serial_candidate_snapshot_and_execution(client, temp_workspace):
    loop_id = await _create_ready_loop(client, temp_workspace)
    proposed = await client.post(
        f"/api/project-memory/research-loops/{loop_id}/candidates",
        params={"cwd": str(temp_workspace)},
        json={
            "approach_summary": "Emit a deterministic result",
            "files": {"solve.sh": "#!/bin/sh\nprintf 'candidate-ok\\n'\n"},
        },
    )
    assert proposed.status_code == 200
    candidate = proposed.json()
    candidate_id = candidate["candidate_id"]
    candidate_dir = temp_workspace / ".pi-science" / "solutions" / candidate_id
    assert candidate["digest"].startswith("sha256:")
    assert (candidate_dir / "solve.sh").exists()
    assert (candidate_dir / "solution.json").exists()

    executed = await client.post(
        f"/api/project-memory/research-loops/{loop_id}/candidates/{candidate_id}/execute",
        params={"cwd": str(temp_workspace)},
    )
    assert executed.status_code == 200
    job_id = executed.json()["job_id"]

    store = ResearchRecordStore(temp_workspace)
    finished = []
    for _ in range(100):
        finished = await store.list(
            loop_id=loop_id,
            candidate_id=candidate_id,
            record_type="candidate.execution_finished",
        )
        if finished:
            break
        await asyncio.sleep(0.02)

    assert finished
    assert finished[-1].run_id == job_id
    assert finished[-1].payload["status"] == "succeeded"
    assert "candidate-ok" in finished[-1].payload["stdout_excerpt"]
    assert not (temp_workspace / ".pi-science" / "research-loops").exists()

    experience = next(
        item for item in await ProjectMemoryService(temp_workspace).experiences(loop_id)
        if item.candidate_id == candidate_id
    )
    assert experience.status == "succeeded"
    assert experience.solution["digest"] == candidate["digest"]
    assert experience.execution["run_id"] == job_id
    assert len(experience.source_refs) == 3

    duplicate = await client.post(
        f"/api/project-memory/research-loops/{loop_id}/candidates/{candidate_id}/execute",
        params={"cwd": str(temp_workspace)},
    )
    assert duplicate.status_code == 409


@pytest.mark.anyio
async def test_candidate_snapshot_rejects_workspace_escape(client, temp_workspace):
    loop_id = await _create_ready_loop(client, temp_workspace)
    response = await client.post(
        f"/api/project-memory/research-loops/{loop_id}/candidates",
        params={"cwd": str(temp_workspace)},
        json={
            "approach_summary": "Attempt to escape the candidate directory",
            "entrypoint": "../solve.sh",
            "files": {"../solve.sh": "#!/bin/sh\n"},
        },
    )

    assert response.status_code == 409
    assert not (temp_workspace / "solve.sh").exists()


@pytest.mark.anyio
async def test_candidate_budget_stops_loop_automatically(client, temp_workspace):
    evaluator = await client.post(
        "/api/project-memory/evaluators",
        params={"cwd": str(temp_workspace)},
        json={
            "evaluator_id": "eval-budget",
            "version": 1,
            "digest": "sha256:budget-evaluator",
            "status": "approved",
            "metrics": [{"name": "quality", "direction": "maximize", "weight": 1}],
        },
    )
    assert evaluator.status_code == 200
    created = await client.post(
        "/api/project-memory/research-loops",
        params={"cwd": str(temp_workspace)},
        json={
            "title": "Bounded loop",
            "objective": "Stop at the configured candidate budget",
            "evaluator_ref": {
                "evaluator_id": "eval-budget",
                "version": 1,
                "digest": "sha256:budget-evaluator",
            },
            "budget": {"max_candidates": 1, "max_wall_seconds": 3600},
        },
    )
    loop_id = created.json()["loop_id"]
    await client.post(f"/api/project-memory/research-loops/{loop_id}/preflight", params={"cwd": str(temp_workspace)})
    await client.post(f"/api/project-memory/research-loops/{loop_id}/start", params={"cwd": str(temp_workspace)})

    evaluated = await client.post(
        f"/api/project-memory/research-loops/{loop_id}/evaluations",
        params={"cwd": str(temp_workspace)},
        json={
            "candidate_id": "candidate-only",
            "metrics": {"quality": {"value": 0.5, "direction": "maximize"}},
        },
    )
    assert evaluated.status_code == 200
    loop = await client.get(
        f"/api/project-memory/research-loops/{loop_id}",
        params={"cwd": str(temp_workspace)},
    )
    assert loop.json()["status"] == "completed"
    assert loop.json()["stop_reason"] == "candidate_budget_exhausted"
