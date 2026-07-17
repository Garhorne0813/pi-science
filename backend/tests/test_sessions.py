"""Session resume/fork plumbing tests that do not require the pi runtime."""

import asyncio
import json
import signal
from io import StringIO
from unittest.mock import MagicMock, patch

import pytest

from config import get_sessions_dir
from api.sessions import _error_stream, _event_replay_cursor, _read_session_from_disk
from models import PiConfig
from services.pi_manager import PiManager, PiProcess, _should_use_global_model


class FakePi:
    def __init__(self, cwd: str):
        self.cwd = cwd
        self.session_id = "active-session"
        self.is_alive = True
        self.config = PiConfig()
        self.busy = False
        self.calls: list[tuple[str, dict]] = []
        self.shutdown_called = False

    async def send_command(self, command: str, **params):
        self.calls.append((command, params))
        if command == "switch_session":
            with open(params["sessionPath"], encoding="utf-8") as stream:
                self.session_id = json.loads(stream.readline())["id"]
        return {"success": True}

    async def shutdown(self):
        self.shutdown_called = True


def _write_session(cwd, session_id: str):
    session_dir = get_sessions_dir(str(cwd)) / "encoded"
    session_dir.mkdir(parents=True, exist_ok=True)
    path = session_dir / f"{session_id}.jsonl"
    path.write_text(json.dumps({"type": "session", "id": session_id}) + "\n")
    return path


def test_find_session_file_uses_exact_session_id(tmp_path):
    mgr = PiManager()
    path = _write_session(tmp_path, "session-123")
    assert mgr._find_session_file("session-123", str(tmp_path)) == path.resolve()
    assert mgr._find_session_file("session-12", str(tmp_path)) is None


def test_unauthenticated_persisted_model_can_fall_back_to_configured_model(temp_config_dir):
    from api.settings import _save_config

    _save_config({
        "model": "custom-custom-api/gpt-5.6-luna",
        "custom_providers": [{
            "id": "custom-api",
            "base_url": "https://llm.example.test/v1",
            "api": "openai-completions",
            "api_key": "sk-custom",
            "models": ["gpt-5.6-luna"],
        }],
    })

    assert _should_use_global_model(
        "anthropic/claude-sonnet-5-20250929",
        "custom-custom-api/gpt-5.6-luna",
    ) is True


@pytest.mark.anyio
async def test_resuming_session_aligns_unauthed_model_with_global_config(tmp_path, temp_config_dir, monkeypatch):
    from api.settings import _save_config

    _save_config({
        "model": "custom-custom-api/gpt-5.6-luna",
        "thinking": "max",
        "custom_providers": [{
            "id": "custom-api",
            "base_url": "https://llm.example.test/v1",
            "api": "openai-completions",
            "api_key": "sk-custom",
            "models": ["gpt-5.6-luna"],
        }],
    })
    _write_session(tmp_path, "session-123")

    class ConfigurablePi(FakePi):
        def __init__(self, cwd: str):
            super().__init__(cwd)
            self.config = PiConfig(model="anthropic/claude-sonnet-5-20250929", thinking="high")
            self.applied = False

        async def apply_config(self, _config):
            self.applied = True
            self.config.model = "custom-custom-api/gpt-5.6-luna"
            self.config.thinking = "max"
            return {"success": True}

    spawned = ConfigurablePi(str(tmp_path.resolve()))
    spawned.session_id = "session-123"

    async def fake_spawn(_cwd, _session_dir, _config, *, session_path=None):
        assert session_path is not None
        return spawned

    monkeypatch.setattr(PiProcess, "spawn", fake_spawn)
    mgr = PiManager()

    resumed = await mgr.get_or_resume_session("session-123", str(tmp_path), PiConfig())

    assert resumed is spawned
    assert spawned.applied is True
    assert spawned.config.model == "custom-custom-api/gpt-5.6-luna"


def test_read_session_history_uses_workspace_cwd(tmp_path):
    session_dir = get_sessions_dir(str(tmp_path)) / "encoded"
    session_dir.mkdir(parents=True)
    path = session_dir / "session-456.jsonl"
    path.write_text(
        json.dumps({"type": "session", "id": "session-456"})
        + "\n"
        + json.dumps({
            "type": "message",
            "id": "message-1",
            "message": {"role": "user", "content": [{"type": "text", "text": "hello"}]},
        })
        + "\n"
    )
    messages = _read_session_from_disk("session-456", str(tmp_path))
    assert messages[0]["content"][0]["text"] == "hello"


def test_read_session_history_preserves_tool_identity(tmp_path):
    session_dir = get_sessions_dir(str(tmp_path)) / "encoded"
    session_dir.mkdir(parents=True)
    path = session_dir / "session-tools.jsonl"
    path.write_text(
        json.dumps({"type": "session", "id": "session-tools"})
        + "\n"
        + json.dumps({
            "type": "message",
            "id": "result-1",
            "message": {
                "role": "toolResult",
                "toolCallId": "call-1",
                "toolName": "read",
                "isError": False,
                "content": [{"type": "text", "text": "content"}],
            },
        })
        + "\n"
    )

    message = _read_session_from_disk("session-tools", str(tmp_path))[0]

    assert message["toolCallId"] == "call-1"
    assert message["toolName"] == "read"
    assert message["isError"] is False


@pytest.mark.anyio
async def test_missing_session_error_stream_is_terminal():
    events = [event async for event in _error_stream("session not found in this workspace", "missing")]

    payload = json.loads(events[0]["data"])
    assert events[0]["event"] == "error"
    assert payload["terminal"] is True
    assert events[1]["event"] == "session.idle"


@pytest.mark.anyio
async def test_resume_session_switches_existing_process(tmp_path):
    mgr = PiManager()
    path = _write_session(tmp_path, "session-123")
    cwd = str(tmp_path.resolve())
    fake = FakePi(cwd)
    mgr._processes[cwd] = fake
    mgr._session_map[fake.session_id] = cwd

    resumed = await mgr.resume_session("session-123", cwd, PiConfig())

    assert resumed is fake
    assert fake.calls == [("switch_session", {"sessionPath": str(path.resolve())})]


@pytest.mark.anyio
async def test_get_or_resume_rebinds_missing_alias_without_switching(tmp_path):
    mgr = PiManager()
    cwd = str(tmp_path.resolve())
    fake = FakePi(cwd)
    fake.session_id = "session-123"
    fake._busy = True
    mgr._processes[cwd] = fake

    resumed = await mgr.get_or_resume_session("session-123", cwd, PiConfig())

    assert resumed is fake
    assert mgr.get_by_session("session-123") is fake
    assert fake.calls == []


@pytest.mark.anyio
async def test_resume_session_spawns_directly_on_persisted_file(tmp_path, monkeypatch):
    mgr = PiManager()
    path = _write_session(tmp_path, "session-123")
    spawned = FakePi(str(tmp_path.resolve()))
    spawned.session_id = "session-123"
    calls = []

    async def fake_spawn(cwd, session_dir, config, *, session_path=None):
        calls.append((cwd, session_dir, session_path))
        return spawned

    monkeypatch.setattr(PiProcess, "spawn", fake_spawn)

    resumed = await mgr.resume_session("session-123", str(tmp_path), PiConfig())

    assert resumed is spawned
    assert calls[0][2] == str(path.resolve())
    assert spawned.calls == []
    assert mgr.get_by_session("session-123") is spawned


@pytest.mark.anyio
async def test_restart_session_preserves_id_and_replaces_process(tmp_path, monkeypatch):
    mgr = PiManager()
    path = _write_session(tmp_path, "session-123")
    cwd = str(tmp_path.resolve())
    old = FakePi(cwd)
    mgr._processes[cwd] = old
    mgr._session_map[old.session_id] = cwd
    replacement = FakePi(cwd)
    replacement.session_id = "session-123"

    async def fake_spawn(spawn_cwd, session_dir, config, *, session_path=None):
        assert session_path == str(path.resolve())
        assert config.model == "custom-test/luna"
        return replacement

    monkeypatch.setattr(PiProcess, "spawn", fake_spawn)

    restarted = await mgr.restart_session(
        "session-123",
        cwd,
        PiConfig(model="custom-test/luna"),
    )

    assert old.shutdown_called is True
    assert restarted is replacement
    assert mgr.get_by_session("session-123") is replacement
    assert mgr.get_by_session("active-session") is None


class FakeProcess:
    returncode = None
    stderr = StringIO("")

    @staticmethod
    def poll():
        return None


@pytest.mark.anyio
async def test_event_readers_receive_broadcast_instead_of_stealing_events(tmp_path):
    process = PiProcess(FakeProcess(), str(tmp_path), "session-1", PiConfig())
    first = process.read_events()
    second = process.read_events()
    first_task = asyncio.create_task(anext(first))
    second_task = asyncio.create_task(anext(second))
    await asyncio.sleep(0)

    event = {"type": "agent_start", "sessionId": "session-1"}
    await process._dispatch(event)

    first_event = await asyncio.wait_for(first_task, timeout=1)
    second_event = await asyncio.wait_for(second_task, timeout=1)
    assert first_event["type"] == event["type"]
    assert first_event["sessionId"] == event["sessionId"]
    assert first_event["_piSessionId"] == "session-1"
    assert first_event["_piSequence"] == 1
    assert first_event["_piEventId"].endswith(":1")
    assert second_event == first_event
    await first.aclose()
    await second.aclose()


@pytest.mark.anyio
async def test_prompt_is_rejected_while_agent_turn_is_busy(tmp_path):
    process = PiProcess(FakeProcess(), str(tmp_path), "session-1", PiConfig())

    async def fake_send(command: str, **params):
        assert command == "prompt"
        return {"success": True}

    process._send_command_internal = fake_send

    first = await process.send_command("prompt", message="first")
    second = await process.send_command("prompt", message="second")

    assert first == {"success": True}
    assert second["success"] is False
    assert second["code"] == "busy"

    await process._dispatch({"type": "agent_settled"})
    assert process.busy is False


@pytest.mark.anyio
async def test_failed_prompt_releases_busy_guard(tmp_path):
    process = PiProcess(FakeProcess(), str(tmp_path), "session-1", PiConfig())

    async def fake_send(command: str, **params):
        return {"success": False, "error": "transport failed"}

    process._send_command_internal = fake_send

    result = await process.send_command("prompt", message="first")

    assert result["success"] is False
    assert process.busy is False


@pytest.mark.anyio
async def test_prompt_timeout_keeps_busy_guard_until_abort(tmp_path):
    process = PiProcess(FakeProcess(), str(tmp_path), "session-1", PiConfig())

    async def fake_send(command: str, **params):
        if command == "prompt":
            return {"success": False, "code": "timeout", "error": "request timeout after 30s"}
        if command == "abort":
            return {"success": True}
        assert command == "get_state"
        return {
            "success": True,
            "data": {"sessionId": "session-1", "isStreaming": False},
        }

    process._send_command_internal = fake_send

    result = await process.send_command("prompt", message="first")
    await process.refresh_state()

    assert result["code"] == "timeout"
    assert process.busy is True

    await process.send_command("abort")
    assert process.busy is False


@pytest.mark.anyio
async def test_extension_handled_prompt_releases_busy_without_empty_response_error(tmp_path, monkeypatch):
    import importlib

    manager_module = importlib.import_module("services.pi_manager")

    monkeypatch.setattr(manager_module, "PROMPT_START_RECONCILE_DELAY", 0)
    process = PiProcess(FakeProcess(), str(tmp_path), "session-1", PiConfig())

    async def fake_send(command: str, **params):
        if command == "prompt":
            return {"success": True}
        assert command == "get_state"
        return {
            "success": True,
            "data": {"sessionId": "session-1", "isStreaming": False},
        }

    process._send_command_internal = fake_send

    await process.send_command("prompt", message="/handled-command")
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert process.busy is False
    settled = process._event_history["session-1"][-1][1]
    assert settled["type"] == "agent_settled"
    assert settled["handledWithoutTurn"] is True


@pytest.mark.anyio
async def test_abort_releases_busy_guard_even_without_terminal_event(tmp_path):
    process = PiProcess(FakeProcess(), str(tmp_path), "session-1", PiConfig())
    process._busy = True

    async def fake_send(command: str, **params):
        if command == "abort":
            return {"success": True}
        assert command == "get_state"
        return {
            "success": True,
            "data": {"sessionId": "session-1", "isStreaming": False},
        }

    process._send_command_internal = fake_send

    result = await process.send_command("abort")

    assert result["success"] is True
    assert process.busy is False


def test_pending_runtime_messages_keep_workspace_session_busy(tmp_path):
    process = PiProcess(FakeProcess(), str(tmp_path), "session-1", PiConfig())

    process._apply_state({
        "sessionId": "session-1",
        "isStreaming": False,
        "isCompacting": False,
        "pendingMessageCount": 1,
    })

    assert process.busy is True


@pytest.mark.anyio
async def test_create_session_returns_busy_error_instead_of_old_id(client, temp_workspace, monkeypatch):
    import api.sessions as sessions_api

    async def busy_create_session(**_kwargs):
        return None, {
            "success": False,
            "code": "busy",
            "error": "agent is busy",
        }

    monkeypatch.setattr(sessions_api.pi_manager, "create_session", busy_create_session)

    response = await client.post("/api/sessions", json={"cwd": str(temp_workspace)})

    assert response.status_code == 409
    assert response.json()["code"] == "busy"


@pytest.mark.anyio
async def test_state_exposes_backend_prompt_guard_before_runtime_streaming(client, temp_workspace, monkeypatch):
    import api.sessions as sessions_api

    guarded = FakePi(str(temp_workspace))
    guarded.session_id = "session-guarded"
    guarded.busy = True

    async def guarded_state(session_id, cwd, config):
        return guarded, {
            "success": True,
            "data": {
                "sessionId": session_id,
                "isStreaming": False,
                "isCompacting": False,
                "pendingMessageCount": 0,
            },
        }

    monkeypatch.setattr(sessions_api.pi_manager, "get_session_state", guarded_state)

    response = await client.get(
        "/api/sessions/session-guarded/state",
        params={"cwd": str(temp_workspace)},
    )

    assert response.status_code == 200
    assert response.json()["is_streaming"] is True


@pytest.mark.anyio
async def test_concurrent_initial_spawn_creates_only_one_runtime(tmp_path, monkeypatch):
    mgr = PiManager()
    cwd = str(tmp_path.resolve())
    spawned = FakePi(cwd)
    spawn_calls = 0

    async def fake_spawn(*_args, **_kwargs):
        nonlocal spawn_calls
        spawn_calls += 1
        await asyncio.sleep(0.01)
        return spawned

    monkeypatch.setattr(PiProcess, "spawn", fake_spawn)

    first, second = await asyncio.gather(
        mgr.get_or_spawn(cwd, str(get_sessions_dir(cwd)), PiConfig()),
        mgr.get_or_spawn(cwd, str(get_sessions_dir(cwd)), PiConfig()),
    )

    assert first is spawned
    assert second is spawned
    assert spawn_calls == 1


@pytest.mark.anyio
async def test_concurrent_new_sessions_receive_distinct_ids(tmp_path):
    class CreatingPi(FakePi):
        counter = 0

        async def send_command(self, command: str, **params):
            assert command == "new_session"
            await asyncio.sleep(0.005)
            self.counter += 1
            self.session_id = f"session-{self.counter}"
            return {"success": True}

        async def apply_config(self, _config):
            return {"success": True}

    mgr = PiManager()
    cwd = str(tmp_path.resolve())
    fake = CreatingPi(cwd)
    mgr._processes[cwd] = fake

    results = await asyncio.gather(*(
        mgr.create_session(cwd, str(get_sessions_dir(cwd)), PiConfig())
        for _ in range(4)
    ))

    assert [result["session_id"] for _pi, result in results] == [
        "session-1", "session-2", "session-3", "session-4",
    ]


@pytest.mark.anyio
async def test_new_session_replaces_stale_runtime_when_custom_config_cannot_apply(tmp_path, monkeypatch):
    class StalePi(FakePi):
        async def send_command(self, command: str, **params):
            assert command == "new_session"
            self.session_id = "stale-blank-session"
            return {"success": True}

        async def apply_config(self, _config):
            return {"success": False, "error": "Model not found"}

    mgr = PiManager()
    cwd = str(tmp_path.resolve())
    stale = StalePi(cwd)
    mgr._processes[cwd] = stale
    replacement = FakePi(cwd)
    replacement.session_id = "configured-blank-session"
    replacement.config = PiConfig(model="custom-luna/luna", thinking="max")

    async def fake_spawn(_cwd, _session_dir, config, *, session_path=None):
        assert session_path is None
        assert config.model == "custom-luna/luna"
        assert config.thinking == "max"
        return replacement

    monkeypatch.setattr(PiProcess, "spawn", fake_spawn)

    pi, result = await mgr.create_session(
        cwd,
        str(get_sessions_dir(cwd)),
        PiConfig(model="custom-luna/luna", thinking="max"),
    )

    assert stale.shutdown_called is True
    assert pi is replacement
    assert result["success"] is True
    assert result["session_id"] == "configured-blank-session"
    assert mgr.get_by_cwd(cwd) is replacement


@pytest.mark.anyio
async def test_custom_model_switch_replaces_active_blank_session(tmp_path, monkeypatch):
    class StalePi(FakePi):
        async def send_command(self, command: str, **params):
            assert command == "set_model"
            return {"success": False, "error": "Model not found"}

    mgr = PiManager()
    cwd = str(tmp_path.resolve())
    stale = StalePi(cwd)
    stale.session_id = "old-blank-session"
    mgr._processes[cwd] = stale
    replacement = FakePi(cwd)
    replacement.session_id = "new-blank-session"
    replacement.config = PiConfig(model="custom-luna/luna", thinking="max")

    async def fake_spawn(_cwd, _session_dir, config, *, session_path=None):
        assert session_path is None
        assert config.model == "custom-luna/luna"
        assert config.thinking == "max"
        return replacement

    monkeypatch.setattr(PiProcess, "spawn", fake_spawn)

    pi, result = await mgr.configure_session(
        "old-blank-session",
        cwd,
        "custom-luna/luna",
        "max",
    )

    assert stale.shutdown_called is True
    assert pi is replacement
    assert result == {
        "success": True,
        "model": "custom-luna/luna",
        "thinking": "max",
        "restarted": True,
        "replaced_blank": True,
        "session_id": "new-blank-session",
    }


@pytest.mark.anyio
async def test_event_stream_attachment_does_not_switch_active_session(tmp_path):
    mgr = PiManager()
    cwd = str(tmp_path.resolve())
    _write_session(tmp_path, "session-a")
    _write_session(tmp_path, "session-b")
    fake = FakePi(cwd)
    fake.session_id = "session-a"
    mgr._processes[cwd] = fake

    attached, result = await mgr.get_event_process("session-b", cwd, PiConfig())

    assert result["success"] is True
    assert attached is fake
    assert fake.session_id == "session-a"
    assert fake.calls == []


@pytest.mark.anyio
async def test_event_stream_accepts_active_session_before_first_file_flush(tmp_path):
    mgr = PiManager()
    cwd = str(tmp_path.resolve())
    fake = FakePi(cwd)
    fake.session_id = "blank-session"
    mgr._processes[cwd] = fake

    attached, result = await mgr.get_event_process("blank-session", cwd, PiConfig())

    assert result["success"] is True
    assert attached is fake
    assert not get_sessions_dir(cwd).exists()


@pytest.mark.anyio
async def test_activation_and_prompt_are_atomic_across_sessions(tmp_path):
    class PromptPi(FakePi):
        async def send_command(self, command: str, **params):
            if command == "switch_session":
                return await super().send_command(command, **params)
            assert command == "prompt"
            self.busy = True
            return {"success": True}

    mgr = PiManager()
    cwd = str(tmp_path.resolve())
    _write_session(tmp_path, "session-a")
    _write_session(tmp_path, "session-b")
    fake = PromptPi(cwd)
    fake.session_id = "session-a"
    mgr._processes[cwd] = fake

    first_pi, first = await mgr.run_session_command(
        "session-a", cwd, PiConfig(), "prompt", message="first",
    )
    second_pi, second = await mgr.run_session_command(
        "session-b", cwd, PiConfig(), "prompt", message="second",
    )

    assert first_pi is fake and first["success"] is True
    assert second_pi is None
    assert second["code"] == "busy"
    assert fake.session_id == "session-a"


@pytest.mark.anyio
async def test_stdout_event_keeps_captured_session_after_switch(tmp_path):
    process = PiProcess(FakeProcess(), str(tmp_path), "session-b", PiConfig())

    await process._dispatch(
        {
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_delta", "text": "from A"},
        },
        "session-a",
    )

    assert process._event_history["session-a"][0][1]["_piSessionId"] == "session-a"
    assert "session-b" not in process._event_history


@pytest.mark.anyio
async def test_settled_event_records_turn_text_for_reconnecting_stream(tmp_path):
    process = PiProcess(FakeProcess(), str(tmp_path), "session-a", PiConfig())
    await process._begin_turn("session-a")
    await process._dispatch({
        "type": "message_update",
        "assistantMessageEvent": {"type": "text_delta", "text": "answer"},
    })
    await process._dispatch({"type": "agent_settled"})

    settled = process._event_history["session-a"][-1][1]
    assert settled["_piTurnHadText"] is True


@pytest.mark.anyio
async def test_turn_end_does_not_release_busy_guard_before_agent_settles(tmp_path, monkeypatch):
    process = PiProcess(FakeProcess(), str(tmp_path), "session-a", PiConfig())
    monkeypatch.setattr(process, "_observe_event", lambda *_args: asyncio.sleep(0))
    await process._begin_turn("session-a")
    process._busy = True

    await process._dispatch({"type": "turn_end"})
    await process._dispatch({"type": "agent_end"})

    assert process.busy is True

    await process._dispatch({"type": "agent_settled"})
    assert process.busy is False


def test_replay_cursor_is_rejected_after_runtime_epoch_changes(tmp_path):
    first = PiProcess(FakeProcess(), str(tmp_path), "session-a", PiConfig())
    second = PiProcess(FakeProcess(), str(tmp_path), "session-a", PiConfig())
    old_cursor = f"{first._event_epoch}:42"

    assert first.sequence_after_event_id(old_cursor) == 42
    assert second.sequence_after_event_id(old_cursor) is None
    assert second.sequence_after_event_id("17") == 17
    assert second.sequence_after_event_id("invalid") is None


def test_fresh_idle_stream_skips_completed_turn_replay(tmp_path):
    process = PiProcess(FakeProcess(), str(tmp_path), "session-a", PiConfig())
    process._event_sequence["session-a"] = 12
    process._busy = False

    assert _event_replay_cursor(process, "session-a", None) == 12
    assert _event_replay_cursor(process, "session-a", f"{process._event_epoch}:9") == 9


def test_fresh_stream_replays_active_turn(tmp_path):
    process = PiProcess(FakeProcess(), str(tmp_path), "session-a", PiConfig())
    process._event_sequence["session-a"] = 4
    process._busy = True

    assert _event_replay_cursor(process, "session-a", None) is None


@pytest.mark.anyio
async def test_replay_reports_gap_when_cursor_predates_retained_history(tmp_path):
    process = PiProcess(FakeProcess(), str(tmp_path), "session-a", PiConfig())
    for index in range(3):
        await process._publish_event({"type": "event", "index": index}, "session-a")
    process._event_history["session-a"].popleft()

    events = process.read_events("session-a", after_sequence=0)
    gap = await anext(events)
    first_replay = await anext(events)

    assert gap["_piStreamGap"] is True
    assert first_replay["_piSequence"] == 2
    await events.aclose()


@pytest.mark.anyio
async def test_process_exit_error_uses_requested_stream_session(tmp_path):
    class DeadProcess(FakeProcess):
        returncode = 1

        @staticmethod
        def poll():
            return 1

    process = PiProcess(DeadProcess(), str(tmp_path), "session-a", PiConfig())
    events = process.read_events("session-b")

    error = await anext(events)

    assert error["type"] == "error"
    assert error["sessionId"] == "session-b"
    await events.aclose()


@pytest.mark.anyio
async def test_shutdown_terminates_the_runtime_process_group(tmp_path):
    process = MagicMock()
    process.pid = 12345
    process.poll.return_value = None
    pi = PiProcess(process, str(tmp_path), "session-a", PiConfig())

    with patch("services.pi_manager.os.killpg") as killpg:
        await pi.shutdown()

    killpg.assert_called_once_with(12345, signal.SIGTERM)


@pytest.mark.anyio
async def test_delete_session_is_workspace_scoped(tmp_path):
    first_workspace = tmp_path / "first"
    second_workspace = tmp_path / "second"
    first_workspace.mkdir()
    second_workspace.mkdir()
    first = _write_session(first_workspace, "shared-id")
    second = _write_session(second_workspace, "shared-id")
    mgr = PiManager()

    result = await mgr.delete_session("shared-id", str(first_workspace))

    assert result["success"] is True
    assert not first.exists()
    assert second.exists()


@pytest.mark.anyio
async def test_delete_rejects_active_busy_session(tmp_path):
    path = _write_session(tmp_path, "session-a")
    cwd = str(tmp_path.resolve())
    fake = FakePi(cwd)
    fake.session_id = "session-a"
    fake.busy = True
    mgr = PiManager()
    mgr._processes[cwd] = fake

    result = await mgr.delete_session("session-a", cwd)

    assert result["code"] == "busy"
    assert path.exists()


@pytest.mark.anyio
async def test_delete_active_blank_session_without_file(tmp_path):
    cwd = str(tmp_path.resolve())
    fake = FakePi(cwd)
    fake.session_id = "blank-session"
    mgr = PiManager()
    mgr._processes[cwd] = fake
    mgr._session_map[fake.session_id] = cwd

    result = await mgr.delete_session("blank-session", cwd)

    assert result["success"] is True
    assert fake.shutdown_called is True
    assert mgr.get_by_session("blank-session") is None


@pytest.mark.anyio
async def test_custom_model_switch_restarts_stale_runtime(client, temp_workspace, monkeypatch):
    import api.sessions as sessions_api

    replacement = FakePi(str(temp_workspace))
    replacement.session_id = "session-123"
    replacement.config = PiConfig(model="custom-luna/luna-max", thinking="max")

    async def configure_session(session_id, cwd, model, thinking):
        assert session_id == "session-123"
        assert model == "custom-luna/luna-max"
        assert thinking is None
        return replacement, {
            "success": True,
            "model": model,
            "thinking": "max",
            "restarted": True,
        }

    monkeypatch.setattr(sessions_api.pi_manager, "configure_session", configure_session)

    response = await client.post(
        "/api/sessions/session-123/model",
        params={"cwd": str(temp_workspace)},
        json={"model": "custom-luna/luna-max"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "id": "session-123",
        "model": "custom-luna/luna-max",
        "thinking": "max",
        "restarted": True,
        "replaced_blank": False,
    }


@pytest.mark.anyio
async def test_session_commands_and_export_endpoints(client, temp_workspace, monkeypatch):
    import api.sessions as sessions_api

    path = _write_session(temp_workspace, "session-export")
    path.write_text(
        json.dumps({"type": "session", "id": "session-export"}) + "\n"
        + json.dumps({
            "type": "message",
            "id": "message-1",
            "message": {"role": "user", "content": [{"type": "text", "text": "hello"}]},
        }) + "\n",
    )

    fake = FakePi(str(temp_workspace))

    async def run_command(_session_id, _cwd, _config, command, **_params):
        if command == "get_commands":
            return fake, {"success": True, "data": {"commands": [{"name": "review", "source": "skill"}]}}
        if command == "compact":
            return fake, {"success": True}
        return fake, {"success": False, "error": "unsupported"}

    monkeypatch.setattr(sessions_api.pi_manager, "run_session_command", run_command)

    commands = await client.get("/api/sessions/session-export/commands", params={"cwd": str(temp_workspace)})
    assert commands.status_code == 200
    assert commands.json()["commands"][0]["name"] == "review"

    compact = await client.post("/api/sessions/session-export/compact", params={"cwd": str(temp_workspace)})
    assert compact.status_code == 200
    assert compact.json()["ok"] is True

    exported = await client.get(
        "/api/sessions/session-export/export",
        params={"cwd": str(temp_workspace), "format": "jsonl"},
    )
    assert exported.status_code == 200
    assert "hello" in exported.text
