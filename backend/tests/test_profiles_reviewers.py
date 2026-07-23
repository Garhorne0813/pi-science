"""Agent profile, result reviewer, and bookmark contract tests."""

import json

import pytest

from services.bookmarker import create_bookmarks
from services.result_reviewer import review_session


class _FakeReviewerPi:
    def __init__(self, events):
        self.events = events
        self.shutdown_called = False

    async def send_command(self, command, **params):
        assert command == "prompt"
        assert params["message"]
        return {"success": True}

    async def read_events(self):
        for event in self.events:
            yield event

    async def shutdown(self):
        self.shutdown_called = True


def _session(workspace, session_id="session-1"):
    path = workspace / ".pi-science" / "sessions" / "session.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"type": "session", "id": session_id}) + "\n" +
        json.dumps({"type": "message", "id": "m1", "message": {"role": "assistant", "content": [{"type": "text", "text": "Conclusion: result saved to result.csv. DOI 10.1000/example."}]}}) + "\n",
        encoding="utf-8",
    )


@pytest.mark.anyio
async def test_result_reviewer_flags_unverified_reference(client, temp_workspace):
    _session(temp_workspace)
    result = await client.post("/api/result-reviews", params={"cwd": str(temp_workspace), "session_id": "session-1"})
    assert result.status_code == 200
    assert result.json()["status"] == "warn"
    assert result.json()["findings"][0]["kind"] == "citation_unverified"


@pytest.mark.anyio
async def test_result_reviewer_flags_execution_claim_without_tool_record(client, temp_workspace):
    path = temp_workspace / ".pi-science" / "sessions" / "session.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"type": "session", "id": "session-2"}) + "\n" + json.dumps({"type": "message", "id": "m1", "message": {"role": "assistant", "content": [{"type": "text", "text": "I verified the result."}]}}) + "\n")
    result = await client.post("/api/result-reviews", params={"cwd": str(temp_workspace), "session_id": "session-2"})
    assert result.status_code == 200
    assert result.json()["status"] == "fail"
    assert any(item["kind"] == "unsupported_execution_claim" for item in result.json()["findings"])


@pytest.mark.anyio
async def test_bookmarker_selects_exact_transcript_line(client, temp_workspace):
    _session(temp_workspace)
    result = await client.post("/api/bookmarks", params={"cwd": str(temp_workspace), "session_id": "session-1"})
    assert result.status_code == 200
    assert result.json()["bookmarks"][0]["quote"].startswith("Conclusion:")


@pytest.mark.anyio
async def test_agent_profile_crud_and_builtin_is_read_only(client, temp_config_dir):
    listed = await client.get("/api/agent-profiles")
    assert listed.status_code == 200
    assert any(item["name"] == "RESULT_REVIEWER" for item in listed.json()["profiles"])
    created = await client.post("/api/agent-profiles", json={"name": "CHEMISTRY_HELPER", "display_name": "Chemistry Helper", "skills": ["figure-style"], "write_scope": []})
    assert created.status_code == 200
    updated = await client.put("/api/agent-profiles/CHEMISTRY_HELPER", json={"name": "CHEMISTRY_HELPER", "display_name": "Chemistry Helper v2", "read_scope": ["workspace"], "write_scope": []})
    assert updated.status_code == 200
    forbidden = await client.put("/api/agent-profiles/RESULT_REVIEWER", json={"name": "RESULT_REVIEWER", "display_name": "Nope"})
    assert forbidden.status_code == 403


@pytest.mark.anyio
async def test_reviewer_accepts_provider_that_only_emits_text_end(tmp_path, temp_config_dir, monkeypatch):
    from services.pi_manager import PiProcess
    from services.reviewer_service import ReviewerService

    fake = _FakeReviewerPi([
        {
            "type": "message_update",
            "message": {"id": "review-message"},
            "assistantMessageEvent": {"type": "text_end", "contentIndex": 0, "content": '{"proposals": []}'},
        },
        {"type": "agent_settled"},
    ])

    async def fake_spawn(*_args, **_kwargs):
        return fake

    monkeypatch.setattr(PiProcess, "spawn", fake_spawn)

    result = await ReviewerService._run_pi_model("review", tmp_path)

    assert result == '{"proposals": []}'
    assert fake.shutdown_called is True


@pytest.mark.anyio
async def test_reviewer_deduplicates_delta_and_final_text_per_content_block(tmp_path, temp_config_dir, monkeypatch):
    from services.pi_manager import PiProcess
    from services.reviewer_service import ReviewerService

    fake = _FakeReviewerPi([
        {
            "type": "message_update",
            "message": {"id": "review-message"},
            "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "first"},
        },
        {
            "type": "message_update",
            "message": {"id": "review-message"},
            "assistantMessageEvent": {"type": "text_end", "contentIndex": 0, "content": "first"},
        },
        {
            "type": "message_update",
            "message": {"id": "review-message"},
            "assistantMessageEvent": {"type": "text_end", "contentIndex": 1, "content": " second"},
        },
        {"type": "agent_settled"},
    ])

    async def fake_spawn(*_args, **_kwargs):
        return fake

    monkeypatch.setattr(PiProcess, "spawn", fake_spawn)

    assert await ReviewerService._run_pi_model("review", tmp_path) == "first second"


@pytest.mark.anyio
async def test_reviewer_preserves_message_end_provider_error(tmp_path, temp_config_dir, monkeypatch):
    from services.pi_manager import PiProcess
    from services.reviewer_service import ReviewerError, ReviewerService

    fake = _FakeReviewerPi([
        {
            "type": "message_end",
            "message": {
                "stopReason": "error",
                "errorMessage": "OpenAI API error (401): Invalid API key",
            },
        },
        {"type": "agent_settled"},
    ])

    async def fake_spawn(*_args, **_kwargs):
        return fake

    monkeypatch.setattr(PiProcess, "spawn", fake_spawn)

    with pytest.raises(ReviewerError, match="Invalid API key"):
        await ReviewerService._run_pi_model("review", tmp_path)
    assert fake.shutdown_called is True
