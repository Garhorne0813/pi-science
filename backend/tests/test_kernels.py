"""Kernel manager and API tests."""

import asyncio
import json
import time

import pytest
from services.kernel_manager import KernelManager, KernelSession, CellResult


class _AliveProcess:
    def poll(self):
        return None


class _SerializedIoProcess(_AliveProcess):
    def __init__(self):
        self.requests: list[dict] = []
        self.reading = 0
        self.overlapped = False
        self.stdin = self
        self.stdout = self

    def write(self, value: str):
        if self.reading:
            self.overlapped = True
        self.requests.append(json.loads(value))

    def flush(self):
        return None

    def readline(self):
        self.reading += 1
        try:
            time.sleep(0.03)
            request = self.requests.pop(0)
            return json.dumps({
                "id": request["id"],
                "ok": True,
                "stdout": "",
                "result": request["code"],
            }) + "\n"
        finally:
            self.reading -= 1


class _FakeKernel(_AliveProcess):
    def __init__(self, notebook_id: str, language: str, cwd: str):
        self.notebook_id = notebook_id
        self.language = language
        self.cwd = cwd
        self.shutdown_called = False

    @property
    def is_alive(self):
        return True

    def shutdown(self):
        self.shutdown_called = True


class TestKernelManager:
    """Unit tests for KernelManager."""

    def test_discover_interpreters(self):
        mgr = KernelManager()
        # Should not raise, and should return dict with python and r keys
        # (actual values depend on the system)
        interpreters = mgr._find("python3") or mgr._find("python") or "python3"
        assert interpreters is not None

    def test_find_returns_none_for_unknown(self):
        mgr = KernelManager()
        result = mgr._find("nonexistent_binary_xyz")
        assert result is None

    def test_cell_result_ok(self):
        result = CellResult(ok=True, stdout="output", result="42")
        assert result.ok
        assert result.stdout == "output"
        assert result.result == "42"
        assert result.error is None

    def test_cell_result_error(self):
        result = CellResult(ok=False, error="NameError: name 'x' is not defined")
        assert not result.ok
        assert result.error is not None

    @pytest.mark.anyio
    async def test_same_kernel_serializes_concurrent_execute_calls(self, tmp_path):
        process = _SerializedIoProcess()
        session = KernelSession(
            process=process,
            language="python",
            notebook_id="shared",
            cwd=str(tmp_path),
        )

        first, second = await asyncio.gather(
            session.execute("first"),
            session.execute("second"),
        )

        assert [first.result, second.result] == ["first", "second"]
        assert process.overlapped is False

    @pytest.mark.anyio
    async def test_same_notebook_id_is_isolated_by_workspace_and_language(self, tmp_path, monkeypatch):
        mgr = KernelManager()
        first_cwd = tmp_path / "first"
        second_cwd = tmp_path / "second"
        first_cwd.mkdir()
        second_cwd.mkdir()
        spawned = []

        async def fake_spawn(notebook_id, language, cwd="."):
            session = _FakeKernel(notebook_id, language, str(cwd))
            spawned.append(session)
            return session

        monkeypatch.setattr(mgr, "_spawn", fake_spawn)

        first = await mgr.get_or_create("same", "python", str(first_cwd))
        second = await mgr.get_or_create("same", "python", str(second_cwd))
        third = await mgr.get_or_create("same", "r", str(first_cwd))

        assert len(spawned) == 3
        assert first is not second and first is not third and second is not third
        assert not any(session.shutdown_called for session in spawned)

        await mgr.shutdown_notebook("same", cwd=str(first_cwd))
        assert first.shutdown_called is True
        assert third.shutdown_called is True
        assert second.shutdown_called is False
        assert mgr.active_count == 1

    @pytest.mark.anyio
    async def test_execution_timeout_recycles_only_the_stuck_kernel(self, tmp_path, monkeypatch):
        mgr = KernelManager()
        first_cwd = tmp_path / "first"
        second_cwd = tmp_path / "second"
        first_cwd.mkdir()
        second_cwd.mkdir()
        spawned = []

        class SlowKernel(_FakeKernel):
            @property
            def is_alive(self):
                return not self.shutdown_called

            async def execute(self, code):
                if code == "hang":
                    await asyncio.sleep(10)
                return CellResult(ok=True, result=code)

        async def fake_spawn(notebook_id, language, cwd="."):
            session = SlowKernel(notebook_id, language, str(cwd))
            spawned.append(session)
            return session

        monkeypatch.setattr(mgr, "_spawn", fake_spawn)
        healthy = await mgr.get_or_create("same", "python", cwd=str(second_cwd))

        result = await mgr.execute(
            "same",
            "python",
            "hang",
            cwd=str(first_cwd),
            timeout_seconds=0.01,
        )

        assert result.ok is False
        assert "timed out" in (result.error or "")
        assert spawned[-1].shutdown_called is True
        assert mgr._sessions[mgr._key("same", "python", str(second_cwd))] is healthy


@pytest.mark.anyio
class TestKernelAPI:
    async def test_kernel_status(self, client):
        """GET /api/kernels/status returns interpreter info."""
        res = await client.get("/api/kernels/status")
        assert res.status_code == 200
        data = res.json()
        assert "interpreters" in data
        assert "python" in data["interpreters"]
        assert "sessions" in data
        assert "active_count" in data

    async def test_execute_python(self, client):
        """POST /api/kernels/execute runs Python code."""
        res = await client.post(
            "/api/kernels/execute",
            json={
                "language": "python",
                "code": "x = 42\nx * 2",
                "notebook_id": "test-nb",
            },
        )
        assert res.status_code == 200
        data = res.json()
        assert data["ok"] is True
        assert data["result"] == "84"

    async def test_execute_python_namespace_persists(self, client):
        """Cells in the same notebook share namespace."""
        # Execute first cell
        await client.post(
            "/api/kernels/execute",
            json={"language": "python", "code": "y = 100", "notebook_id": "test-ns"},
        )
        # Second cell can access y
        res = await client.post(
            "/api/kernels/execute",
            json={"language": "python", "code": "y + 1", "notebook_id": "test-ns"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["ok"] is True
        assert data["result"] == "101"

    async def test_execute_python_syntax_error(self, client):
        """Syntax errors are caught and returned as error."""
        res = await client.post(
            "/api/kernels/execute",
            json={"language": "python", "code": "def broken(", "notebook_id": "test-err"},
        )
        data = res.json()
        assert data["ok"] is False
        assert data["error"] is not None

    async def test_execute_python_runtime_error(self, client):
        """Runtime errors are caught."""
        res = await client.post(
            "/api/kernels/execute",
            json={"language": "python", "code": "1/0", "notebook_id": "test-err2"},
        )
        data = res.json()
        assert data["ok"] is False
        assert "ZeroDivisionError" in (data["error"] or "")

    async def test_execute_python_uses_requested_workspace(self, client, temp_workspace):
        marker = temp_workspace / "marker.txt"
        marker.write_text("workspace-ok")
        res = await client.post(
            f"/api/kernels/execute?cwd={temp_workspace}",
            json={
                "language": "python",
                "code": "from pathlib import Path\nPath('marker.txt').read_text()",
                "notebook_id": "test-cwd",
            },
        )
        assert res.status_code == 200
        assert res.json()["result"] == "'workspace-ok'"

    async def test_shutdown_notebook(self, client):
        """POST /api/kernels/{id}/shutdown kills a notebook session."""
        # Create a session first
        await client.post(
            "/api/kernels/execute",
            json={"language": "python", "code": "a=1", "notebook_id": "test-shutdown"},
        )
        # Shut it down
        res = await client.post("/api/kernels/test-shutdown/shutdown", params={"cwd": "."})
        assert res.status_code == 200
        assert res.json()["ok"] is True

    async def test_shutdown_all(self, client):
        """POST /api/kernels/shutdown-all kills all sessions."""
        res = await client.post("/api/kernels/shutdown-all")
        assert res.status_code == 200
        assert res.json()["ok"] is True
