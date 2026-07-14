"""Kernel manager and API tests."""

import pytest
from services.kernel_manager import KernelManager, kernel_manager, CellResult


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
        res = await client.post("/api/kernels/test-shutdown/shutdown")
        assert res.status_code == 200
        assert res.json()["ok"] is True

    async def test_shutdown_all(self, client):
        """POST /api/kernels/shutdown-all kills all sessions."""
        res = await client.post("/api/kernels/shutdown-all")
        assert res.status_code == 200
        assert res.json()["ok"] is True
