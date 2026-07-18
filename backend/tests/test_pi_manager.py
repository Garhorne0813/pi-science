"""Unit tests for PiProcess and PiManager — mock subprocess.Popen."""
import asyncio
import json
import os
import signal
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from models import PiConfig
from services.pi_manager import PiProcess, PiManager, pi_manager


# ── Fixtures ──

@pytest.fixture
def pi_config():
    return PiConfig(
        model="anthropic/claude-sonnet-5-20250929",
        thinking="high",
        provider=None,
        api_key=None,
        skills=[],
        extensions=[],
    )


@pytest.fixture
def mock_popen():
    """Mock subprocess.Popen with fake stdin/stdout/stderr pipes."""
    with patch("services.pi_manager.subprocess.Popen") as mock:
        process = MagicMock()
        process.stdin = MagicMock()
        process.stdout = MagicMock()
        process.stderr = MagicMock()
        process.pid = 12345
        process.poll.return_value = None  # Still alive
        mock.return_value = process
        yield mock, process


# ── Mock JSONL I/O ──

def make_jsonl_line(data: dict) -> str:
    return json.dumps(data) + "\n"


@pytest.fixture
def mock_pi_stdio(mock_popen):
    """Mock popen with a controlled stdout iterator for RPC simulation."""
    mock_fn, process = mock_popen
    stdout_lines = []

    # Make stdout iterable
    def stdout_iter(self=None):
        for line in stdout_lines:
            yield line
    process.stdout.__iter__ = stdout_iter

    # Mock stdin write
    def write_stdin(line: str):
        nonlocal stdout_lines
        cmd = json.loads(line)
        if cmd.get("type") == "get_state":
            stdout_lines.append(make_jsonl_line({
                "type": "response",
                "id": cmd["id"],
                "success": True,
                "data": {"sessionId": "test-session-123"},
            }))
        elif cmd.get("type") == "new_session":
            stdout_lines.append(make_jsonl_line({
                "type": "response",
                "id": cmd["id"],
                "success": True,
                "data": {"sessionId": "test-session-456"},
            }))
        else:
            stdout_lines.append(make_jsonl_line({
                "type": "response",
                "id": cmd["id"],
                "success": True,
            }))

    process.stdin.write = MagicMock(side_effect=write_stdin)
    process.stdin.flush = MagicMock()

    return mock_fn, process


# ── Tests: PiManager ──

class TestPiManager:
    def test_singleton_exists(self):
        assert pi_manager is not None
        assert isinstance(pi_manager, PiManager)

    def test_initial_state(self):
        mgr = PiManager()
        assert mgr.active_count == 0
        assert len(mgr._processes) == 0
        assert len(mgr._session_map) == 0

    def test_spawn_locks_initialized(self):
        mgr = PiManager()
        assert isinstance(mgr._cwd_locks, dict)
        assert len(mgr._cwd_locks) == 0

    def test_get_by_cwd_returns_none_for_unknown(self):
        mgr = PiManager()
        assert mgr.get_by_cwd("/nonexistent") is None

    def test_get_by_session_returns_none_for_unknown(self):
        mgr = PiManager()
        assert mgr.get_by_session("unknown-id") is None

    def test_idle_ttl_is_set(self):
        mgr = PiManager()
        assert mgr.IDLE_TTL == 30 * 60  # 30 minutes


# ── Tests: PiProcess shutdown (without real process) ──

class TestPiProcessShutdown:
    @pytest.mark.asyncio
    async def test_shutdown_handles_missing_process(self, pi_config):
        """shutdown should not crash if process is already dead."""
        process = MagicMock()
        process.poll.return_value = 1  # Already exited
        process.pid = 12345
        pi = PiProcess(process, cwd="/tmp/test", session_id="s1", config=pi_config)

        # Should not raise
        await pi.shutdown()

    @pytest.mark.asyncio
    async def test_shutdown_fails_pending_requests(self, pi_config):
        """shutdown should fail all pending futures."""
        process = MagicMock()
        process.poll.return_value = 1
        process.pid = 12345
        pi = PiProcess(process, cwd="/tmp/test", session_id="s1", config=pi_config)

        # Add a pending request
        future: asyncio.Future = asyncio.Future()
        pi.pending_requests["req-1"] = future

        await pi.shutdown()

        assert future.done()
        with pytest.raises(ConnectionError):
            future.result()

    @pytest.mark.asyncio
    async def test_shutdown_uses_killpg_when_alive(self, pi_config):
        """shutdown should call os.killpg when process is alive."""
        process = MagicMock()
        process.poll.return_value = None  # Still alive
        process.pid = 12345
        pi = PiProcess(process, cwd="/tmp/test", session_id="s1", config=pi_config)
        pi._pgid = 12345

        with patch("os.killpg") as mock_killpg:
            mock_killpg.side_effect = ProcessLookupError  # Process group gone
            await pi.shutdown()

            mock_killpg.assert_called_once_with(12345, signal.SIGTERM)


# ── Tests: PiManager._remove ──

class TestPiManagerRemove:
    @pytest.mark.asyncio
    async def test_remove_cleans_up_session_map(self, pi_config):
        """_remove should clean both process dict and session map."""
        mgr = PiManager()
        process = MagicMock()
        process.poll.return_value = 1
        process.pid = 12345
        pi = PiProcess(process, cwd="/tmp/test", session_id="s1", config=pi_config)
        mgr._processes["/tmp/test"] = pi
        mgr._session_map["s1"] = "/tmp/test"

        await mgr._remove("/tmp/test")

        assert "/tmp/test" not in mgr._processes
        assert "s1" not in mgr._session_map


# ── Tests: send_command timeout ──

class TestPiProcessSendCommand:
    @pytest.mark.asyncio
    async def test_send_command_times_out_after_30s(self, pi_config):
        """send_command should return error dict after 30s timeout."""
        process = MagicMock()
        process.poll.return_value = None  # Alive
        process.pid = 12345
        pi = PiProcess(process, cwd="/tmp/test", session_id="s1", config=pi_config)

        # No pending future will ever resolve
        result = await pi.send_command("unknown_cmd")
        # Should timeout and return error
        assert not result.get("success")
        assert "timeout" in result.get("error", "").lower()


# ── Tests: _dispatch ──

class TestPiProcessDispatch:
    @pytest.mark.asyncio
    async def test_dispatch_updates_last_activity(self, pi_config):
        """_dispatch should touch _last_activity timestamp."""
        process = MagicMock()
        process.poll.return_value = None
        pi = PiProcess(process, cwd="/tmp/test", session_id="s1", config=pi_config)

        old_ts = pi._last_activity
        await asyncio.sleep(0.01)

        await pi._dispatch({"type": "message_start", "data": "test"})

        assert pi._last_activity > old_ts

    @pytest.mark.asyncio
    async def test_dispatch_response_routes_to_future(self, pi_config):
        """Response-type events should resolve pending futures."""
        process = MagicMock()
        process.poll.return_value = None
        pi = PiProcess(process, cwd="/tmp/test", session_id="s1", config=pi_config)

        future: asyncio.Future = asyncio.Future()
        pi.pending_requests["req-1"] = future

        await pi._dispatch({"type": "response", "id": "req-1", "data": "ok"})

        assert future.done()
        assert future.result() == {"type": "response", "id": "req-1", "data": "ok"}

    @pytest.mark.asyncio
    async def test_dispatch_agent_event_goes_to_queue(self, pi_config):
        """Non-response events should go to the event queue."""
        process = MagicMock()
        process.poll.return_value = None
        pi = PiProcess(process, cwd="/tmp/test", session_id="s1", config=pi_config)

        stream = pi.read_events("s1")
        task = asyncio.create_task(anext(stream))
        await asyncio.sleep(0)

        await pi._dispatch({"type": "message_start", "text": "hello"})

        # Event should reach the session's subscriber stream
        event = await asyncio.wait_for(task, timeout=1.0)
        assert event["type"] == "message_start"
        assert event["text"] == "hello"
        await stream.aclose()


# ── Tests: spawn lock ──

class TestSpawnLock:
    def test_spawn_lock_per_cwd(self):
        """Each cwd should get its own spawn lock."""
        mgr = PiManager()
        assert "/test/a" not in mgr._cwd_locks
        assert "/test/b" not in mgr._cwd_locks
        assert mgr._lock_for_cwd("/test/a") is mgr._lock_for_cwd("/test/a")
        assert mgr._lock_for_cwd("/test/a") is not mgr._lock_for_cwd("/test/b")


# ── Tests: PID file mechanism ──

class TestPidFile:
    @pytest.mark.asyncio
    async def test_pid_file_written_on_spawn(self, mock_pi_stdio, pi_config, tmp_path):
        """spawn should write a .pi-pid file in the session directory."""
        mock_fn, process = mock_pi_stdio
        session_dir = str(tmp_path)

        with patch("api.settings.get_env_with_keys", return_value={}):
            pi = await PiProcess.spawn(
                cwd=str(tmp_path),
                session_dir=session_dir,
                config=pi_config,
            )

        pid_file = tmp_path / ".pi-pid"
        assert pid_file.exists()
        assert pid_file.read_text().strip() == str(process.pid)

    @pytest.mark.asyncio
    async def test_shutdown_cleans_up_pid_file(self, mock_pi_stdio, pi_config, tmp_path):
        """shutdown should remove the .pi-pid file."""
        mock_fn, process = mock_pi_stdio
        process.poll.return_value = 1  # Already exited
        session_dir = str(tmp_path)

        with patch("api.settings.get_env_with_keys", return_value={}):
            pi = await PiProcess.spawn(
                cwd=str(tmp_path),
                session_dir=session_dir,
                config=pi_config,
            )

        pid_file = tmp_path / ".pi-pid"
        assert pid_file.exists()

        await pi.shutdown()

        assert not pid_file.exists()

    def test_get_or_spawn_kills_stale_process(self, tmp_path, pi_config):
        """get_or_spawn should kill a stale process detected via PID file."""
        mgr = PiManager()
        # get_or_spawn computes cwd_session_dir as session_dir / encoded_cwd
        # where encoded_cwd = cwd.lstrip("/").replace("/", "-")
        cwd = str(tmp_path)
        encoded = cwd.lstrip("/").replace("/", "-")
        session_base = str(tmp_path / "sessions")
        cwd_session_dir = Path(session_base) / encoded
        cwd_session_dir.mkdir(parents=True)

        # Write a PID file at the exact path get_or_spawn will check
        pid_file = cwd_session_dir / ".pi-pid"
        pid_file.write_text("99999")  # Fake PID

        with patch("os.kill") as mock_kill, \
             patch("services.pi_manager.PiProcess.spawn") as mock_spawn:
            mock_pi = MagicMock()
            mock_pi.session_id = "new-session"
            mock_spawn.return_value = mock_pi
            mock_kill.return_value = None

            async def run():
                await mgr.get_or_spawn(
                    cwd=cwd,
                    session_dir=session_base,
                    config=pi_config,
                )
            import asyncio
            asyncio.run(run())

            # Should have been called twice: existence check (signal 0) + SIGKILL (signal 9)
            assert mock_kill.call_count >= 2
            mock_kill.assert_any_call(99999, 0)
            mock_kill.assert_any_call(99999, 9)

    def test_get_or_spawn_ignores_dead_pid(self, tmp_path, pi_config):
        """get_or_spawn should ignore PID file when process is already dead."""
        mgr = PiManager()
        cwd = str(tmp_path)
        encoded = cwd.lstrip("/").replace("/", "-")
        session_base = str(tmp_path / "sessions")
        cwd_session_dir = Path(session_base) / encoded
        cwd_session_dir.mkdir(parents=True)

        pid_file = cwd_session_dir / ".pi-pid"
        pid_file.write_text("99999")

        with patch("os.kill") as mock_kill, \
             patch("services.pi_manager.PiProcess.spawn") as mock_spawn:
            mock_pi = MagicMock()
            mock_pi.session_id = "new-session"
            mock_spawn.return_value = mock_pi
            # os.kill(pid, 0) throws — process doesn't exist
            mock_kill.side_effect = OSError("No such process")

            async def run():
                await mgr.get_or_spawn(
                    cwd=cwd,
                    session_dir=session_base,
                    config=pi_config,
                )
            import asyncio
            asyncio.run(run())

            # Should only be called once (existence check), no SIGKILL needed
            mock_kill.assert_called_once_with(99999, 0)

    def test_session_dir_stored_on_instance(self, mock_pi_stdio, pi_config, tmp_path):
        """PiProcess should store session_dir after spawn."""
        mock_fn, process = mock_pi_stdio
        session_dir = str(tmp_path)

        with patch("api.settings.get_env_with_keys", return_value={}):
            import asyncio
            async def run():
                return await PiProcess.spawn(
                    cwd=str(tmp_path),
                    session_dir=session_dir,
                    config=pi_config,
                )
            pi = asyncio.run(run())

        assert pi.session_dir == session_dir
