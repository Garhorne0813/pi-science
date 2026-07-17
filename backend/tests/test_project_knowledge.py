"""Project knowledge, Reviewer, and file organization tests."""

import asyncio
import json
from pathlib import Path

import pytest

from config import get_sessions_dir
from models import FileOperation, Proposal, SourceReference
from services.file_organizer import FilePlanError, WorkspaceFileOrganizer
from services.project_knowledge_store import MANAGED_START, ProjectKnowledgeStore
from services.reviewer_service import ReviewerService, parse_reviewer_json


def knowledge_proposal(**overrides):
    data = {
        "proposal_type": "knowledge",
        "knowledge_type": "conclusion",
        "title": "The selected model works",
        "summary": "Custom API models can be selected and used in chat.",
        "reason": "The issue was fixed and verified.",
        "confidence": "high",
        "importance": "important",
        "source_message_ids": ["message-1"],
        "related_files": [],
        "source": SourceReference(session_id="session-1", message_ids=["message-1"]),
    }
    data.update(overrides)
    return Proposal(**data)


def file_proposal(**overrides):
    data = {
        "proposal_type": "file_operation",
        "knowledge_type": None,
        "title": "Organize result file",
        "summary": "Move the result into the processed data directory.",
        "reason": "The file is a processed result.",
        "confidence": "high",
        "importance": "normal",
        "source_message_ids": [],
        "related_files": ["result.csv"],
        "operations": [FileOperation(type="move", source="result.csv", target="data/processed/result.csv")],
        "source": SourceReference(files=["result.csv"]),
    }
    data.update(overrides)
    return Proposal(**data)


def write_session(workspace: Path, session_id: str, messages: list[dict]) -> None:
    directory = get_sessions_dir(str(workspace)) / "encoded"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{session_id}.jsonl"
    rows = [{"type": "session", "id": session_id, "cwd": str(workspace)}]
    rows.extend(
        {
            "type": "message",
            "id": message["id"],
            "message": {
                "role": message.get("role", "user"),
                "content": [{"type": "text", "text": message["text"]}],
            },
        }
        for message in messages
    )
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n")


def test_initialize_creates_project_skeleton(temp_workspace):
    store = ProjectKnowledgeStore(temp_workspace)
    summary = store.initialize()

    assert (temp_workspace / "PROJECT.md").exists()
    assert MANAGED_START in (temp_workspace / "PROJECT.md").read_text()
    for directory in ("sources", "research", "data", "work", "deliverables", "archive"):
        assert (temp_workspace / directory).is_dir()
    assert summary["pending_count"] == 0
    assert summary["auto_review"] is True


def test_accept_knowledge_updates_document_and_policy(temp_workspace):
    store = ProjectKnowledgeStore(temp_workspace)
    store.initialize()
    proposal = knowledge_proposal()
    store.add_proposals([proposal])

    item = store.accept_knowledge_proposal(proposal)

    assert item.status == "active"
    assert store.get_proposal(proposal.id).status == "accepted"
    document = store.project_file.read_text()
    assert "The selected model works" in document
    assert item.id in document
    assert store.get_policy().accepted_counts["conclusion"] == 1


def test_accept_supersedes_prior_item(temp_workspace):
    store = ProjectKnowledgeStore(temp_workspace)
    store.initialize()
    first = knowledge_proposal(title="Old conclusion")
    store.add_proposals([first])
    old_item = store.accept_knowledge_proposal(first)

    second = knowledge_proposal(
        title="New conclusion",
        summary="New evidence replaces the old conclusion.",
        supersedes=[old_item.id],
    )
    store.add_proposals([second])
    store.accept_knowledge_proposal(second)

    assert store.get_item(old_item.id).status == "superseded"
    document = store.project_file.read_text()
    assert "New conclusion" in document
    assert "Old conclusion" not in document


def test_reject_updates_learning_policy(temp_workspace):
    store = ProjectKnowledgeStore(temp_workspace)
    store.initialize()
    proposal = knowledge_proposal(knowledge_type="hypothesis")
    store.add_proposals([proposal])

    store.reject_proposal(proposal, "Too speculative")

    assert store.get_proposal(proposal.id).decision_reason == "Too speculative"
    assert store.get_policy().rejected_counts["hypothesis"] == 1


def test_project_document_versions_restore_knowledge_and_markdown(temp_workspace):
    store = ProjectKnowledgeStore(temp_workspace)
    store.initialize()
    initial_version = store.list_project_versions()[0]["id"]
    proposal = knowledge_proposal()
    store.add_proposals([proposal])
    store.accept_knowledge_proposal(proposal)
    assert store.list_items()
    assert "The selected model works" in store.project_file.read_text()

    restored = store.restore_project_version(initial_version)

    assert restored["knowledge_count"] == 0
    assert store.list_items() == []
    assert "The selected model works" not in store.project_file.read_text()


def test_project_document_version_restore_rejects_path_traversal(temp_workspace):
    store = ProjectKnowledgeStore(temp_workspace)
    store.initialize()

    with pytest.raises(KeyError):
        store.restore_project_version("../../outside")


def test_file_index_preserves_id_after_move(temp_workspace):
    source = temp_workspace / "result.csv"
    source.write_text("a,b\n1,2\n")
    organizer = WorkspaceFileOrganizer(temp_workspace)
    first = organizer.build_index()
    file_id = next(row["id"] for row in first["files"] if row["path"] == "result.csv")

    (temp_workspace / "data").mkdir()
    source.rename(temp_workspace / "data" / "result.csv")
    second = organizer.build_index()

    moved = next(row for row in second["files"] if row["path"] == "data/result.csv")
    assert moved["id"] == file_id


def test_file_plan_blocks_traversal_collision_and_locked_paths(temp_workspace):
    (temp_workspace / "result.csv").write_text("x\n1\n")
    (temp_workspace / "occupied.csv").write_text("x\n2\n")
    organizer = WorkspaceFileOrganizer(temp_workspace)
    organizer.store.initialize()

    with pytest.raises(FilePlanError, match="relative"):
        organizer.preview_plan([FileOperation(type="move", source="result.csv", target="../escape.csv")])

    preview = organizer.preview_plan([FileOperation(type="move", source="result.csv", target="occupied.csv")])
    assert preview["ok"] is False
    assert "target exists: occupied.csv" in preview["collisions"]

    policy = organizer.store.get_policy()
    policy.locked_paths = ["data"]
    organizer.store.save_policy(policy)
    with pytest.raises(FilePlanError, match="locked"):
        organizer.preview_plan([FileOperation(type="move", source="result.csv", target="data/result.csv")])


def test_file_plan_apply_updates_references_and_undoes(temp_workspace):
    store = ProjectKnowledgeStore(temp_workspace)
    store.initialize()
    (temp_workspace / "result.csv").write_text("x\n1\n")
    store.project_file.write_text(store.project_file.read_text() + "\nSee `result.csv`.\n")
    organizer = WorkspaceFileOrganizer(temp_workspace)
    operations = [FileOperation(type="move", source="result.csv", target="data/result.csv")]

    record = organizer.apply_plan(operations, proposal_id="proposal-1")

    assert not (temp_workspace / "result.csv").exists()
    assert (temp_workspace / "data" / "result.csv").exists()
    assert "data/result.csv" in store.project_file.read_text()
    assert record["id"].startswith("fileop-")

    organizer.undo(record["id"])
    assert (temp_workspace / "result.csv").exists()
    assert not (temp_workspace / "data" / "result.csv").exists()
    assert "`result.csv`" in store.project_file.read_text()


def test_parse_reviewer_json_accepts_fenced_payload():
    assert parse_reviewer_json('```json\n{"proposals": []}\n```') == {"proposals": []}


@pytest.mark.anyio
async def test_reviewer_creates_valid_proposal_and_advances_cursor(temp_workspace):
    write_session(temp_workspace, "session-1", [
        {"id": "message-1", "role": "user", "text": "We decided to use the hybrid file tree."},
        {"id": "message-2", "role": "assistant", "text": "I will record that decision."},
    ])

    async def fake_runner(prompt, workspace):
        assert "message-1" in prompt
        return json.dumps({
            "proposals": [{
                "proposal_type": "knowledge",
                "knowledge_type": "decision",
                "title": "Use a hybrid file tree",
                "summary": "Keep a shallow physical tree and flexible logical views.",
                "reason": "The user explicitly selected this structure.",
                "confidence": "high",
                "importance": "important",
                "source_message_ids": ["message-1"],
                "related_files": [],
                "conflicts_with": [],
                "supersedes": [],
                "operations": [],
            }]
        })

    service = ReviewerService(temp_workspace, model_runner=fake_runner)
    first = await service.review_session("session-1")
    second = await service.review_session("session-1")

    assert first["created"] == 1
    assert second["created"] == 0
    assert "No new" in second["message"]
    proposal = service.store.list_proposals("pending")[0]
    assert proposal.source.message_ids == ["message-1"]
    assert service.store.get_cursor("session-1")["message_count"] == 2


@pytest.mark.anyio
async def test_reviewer_rejects_unsupported_evidence(temp_workspace):
    write_session(temp_workspace, "session-2", [
        {"id": "real-message", "role": "user", "text": "Casual conversation."},
    ])

    async def fake_runner(prompt, workspace):
        return json.dumps({
            "proposals": [{
                "proposal_type": "knowledge",
                "knowledge_type": "finding",
                "title": "Invented finding",
                "summary": "This is unsupported.",
                "reason": "Invented source.",
                "confidence": "high",
                "importance": "critical",
                "source_message_ids": ["invented-message"],
                "related_files": ["missing.csv"],
                "conflicts_with": [],
                "supersedes": [],
                "operations": [],
            }]
        })

    service = ReviewerService(temp_workspace, model_runner=fake_runner)
    result = await service.review_session("session-2")

    assert result["created"] == 0
    assert result["skipped"] == 1
    assert service.store.list_proposals() == []


@pytest.mark.anyio
async def test_reviewer_caps_batches_without_skipping_the_next_message(temp_workspace, monkeypatch):
    import services.reviewer_service as reviewer_module

    write_session(temp_workspace, "session-capped", [
        {"id": "message-1", "role": "user", "text": "A" * 40},
        {"id": "message-2", "role": "assistant", "text": "B" * 40},
    ])
    prompts = []

    async def fake_runner(prompt, workspace):
        prompts.append(prompt)
        return json.dumps({"proposals": []})

    monkeypatch.setattr(reviewer_module, "MAX_REVIEW_INPUT_CHARS", 50)
    service = ReviewerService(temp_workspace, model_runner=fake_runner)

    await service.review_session("session-capped")
    assert service.store.get_cursor("session-capped")["message_count"] == 1
    await service.review_session("session-capped")

    assert len(prompts) == 2
    assert "message-1" in prompts[0] and "message-2" not in prompts[0]
    assert "message-2" in prompts[1]
    assert service.store.get_cursor("session-capped")["message_count"] == 2


@pytest.mark.anyio
async def test_auto_reviewer_schedule_debounces_and_can_be_cancelled(temp_workspace, monkeypatch):
    import services.reviewer_service as reviewer_module

    calls = []

    async def fake_auto_review(cwd, session_id):
        calls.append((cwd, session_id))

    monkeypatch.setattr(reviewer_module, "_auto_review", fake_auto_review)
    session_id = "session-debounce"
    reviewer_module.schedule_auto_review(str(temp_workspace), session_id)
    reviewer_module.schedule_auto_review(str(temp_workspace), session_id)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert calls == [(str(temp_workspace), session_id)]

    calls.clear()
    reviewer_module.schedule_auto_review(str(temp_workspace), session_id)
    reviewer_module.cancel_auto_review(str(temp_workspace), session_id)
    await asyncio.sleep(0)
    assert calls == []


@pytest.mark.anyio
async def test_project_knowledge_api_accept_flow(client, temp_workspace):
    store = ProjectKnowledgeStore(temp_workspace)
    store.initialize()
    proposal = knowledge_proposal()
    store.add_proposals([proposal])

    response = await client.post(
        f"/api/project-knowledge/proposals/{proposal.id}/accept",
        params={"cwd": str(temp_workspace)},
        json={"title": "Edited accepted title"},
    )

    assert response.status_code == 200
    assert response.json()["knowledge_item"]["title"] == "Edited accepted title"
    summary = await client.get("/api/project-knowledge/summary", params={"cwd": str(temp_workspace)})
    assert summary.json()["knowledge_count"] == 1


@pytest.mark.anyio
async def test_project_knowledge_api_file_accept_preview_and_undo(client, temp_workspace):
    store = ProjectKnowledgeStore(temp_workspace)
    store.initialize()
    (temp_workspace / "result.csv").write_text("x\n1\n")
    proposal = file_proposal()
    store.add_proposals([proposal])

    preview = await client.get(
        f"/api/project-knowledge/proposals/{proposal.id}/preview",
        params={"cwd": str(temp_workspace)},
    )
    assert preview.status_code == 200
    assert preview.json()["ok"] is True

    accepted = await client.post(
        f"/api/project-knowledge/proposals/{proposal.id}/accept",
        params={"cwd": str(temp_workspace)},
        json={},
    )
    assert accepted.status_code == 200
    history_id = accepted.json()["file_operation"]["id"]
    assert (temp_workspace / "data" / "processed" / "result.csv").exists()
    stored_proposal = store.get_proposal(proposal.id)
    assert stored_proposal.related_files == ["data/processed/result.csv"]
    assert stored_proposal.operations[0].source == "result.csv"
    assert stored_proposal.operations[0].target == "data/processed/result.csv"

    undone = await client.post(
        f"/api/project-knowledge/file-operations/{history_id}/undo",
        params={"cwd": str(temp_workspace)},
    )
    assert undone.status_code == 200
    assert (temp_workspace / "result.csv").exists()


@pytest.mark.anyio
async def test_project_knowledge_api_rejects_unsafe_file_edit(client, temp_workspace):
    store = ProjectKnowledgeStore(temp_workspace)
    store.initialize()
    (temp_workspace / "result.csv").write_text("x\n1\n")
    proposal = file_proposal()
    store.add_proposals([proposal])

    response = await client.patch(
        f"/api/project-knowledge/proposals/{proposal.id}",
        params={"cwd": str(temp_workspace)},
        json={"operations": [{"type": "move", "source": "result.csv", "target": "../escape.csv"}]},
    )

    assert response.status_code == 400
    assert "inside the workspace" in response.json()["detail"]
