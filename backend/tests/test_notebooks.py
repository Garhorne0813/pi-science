"""Notebook listing and managed Jupyter server tests."""

from pathlib import Path

import pytest

from api import notebooks


class FakeJupyterProcess:
    def __init__(self, args):
        self.args = args
        self.returncode = None
        self.terminated = False
        self.killed = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9


@pytest.fixture(autouse=True)
def reset_jupyter_state(monkeypatch):
    monkeypatch.setattr(notebooks, "_jupyter_process", None)
    monkeypatch.setattr(notebooks, "_jupyter_port", None)
    monkeypatch.setattr(notebooks, "_jupyter_cwd", None)


@pytest.mark.anyio
async def test_list_notebooks_skips_hidden_directories(client, temp_workspace):
    visible = temp_workspace / "analysis.ipynb"
    visible.write_text('{"cells": []}')
    hidden = temp_workspace / ".cache"
    hidden.mkdir()
    (hidden / "ignored.ipynb").write_text('{"cells": []}')

    response = await client.get("/api/notebooks", params={"cwd": str(temp_workspace)})

    assert response.status_code == 200
    assert [item["path"] for item in response.json()] == ["analysis.ipynb"]


@pytest.mark.anyio
async def test_jupyter_start_is_scoped_to_workspace(client, temp_workspace, monkeypatch):
    spawned = []

    def fake_popen(args, **_kwargs):
        process = FakeJupyterProcess(args)
        spawned.append(process)
        return process

    monkeypatch.setattr(notebooks, "_find_available_port", lambda: 43123)
    monkeypatch.setattr(notebooks.subprocess, "Popen", fake_popen)

    response = await client.post(
        "/api/notebooks/jupyter/start",
        params={"cwd": str(temp_workspace)},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["running"] is True
    assert data["port"] == 43123
    assert data["cwd"] == str(temp_workspace.resolve())
    assert f"--ServerApp.root_dir={temp_workspace.resolve()}" in spawned[0].args

    status = await client.get(
        "/api/notebooks/jupyter/status",
        params={"cwd": str(temp_workspace)},
    )
    assert status.json()["matches_workspace"] is True


@pytest.mark.anyio
async def test_jupyter_rejects_cross_workspace_start_and_stop(client, temp_workspace, monkeypatch):
    other = temp_workspace / "other"
    other.mkdir()
    # Mark as an initialized workspace so cwd validation accepts it and the
    # request reaches the Jupyter ownership check.
    (other / ".pi-science").mkdir()
    monkeypatch.setattr(notebooks, "_find_available_port", lambda: 43124)
    monkeypatch.setattr(
        notebooks.subprocess,
        "Popen",
        lambda args, **_kwargs: FakeJupyterProcess(args),
    )

    started = await client.post(
        "/api/notebooks/jupyter/start",
        params={"cwd": str(temp_workspace)},
    )
    assert started.status_code == 200

    conflict = await client.post(
        "/api/notebooks/jupyter/start",
        params={"cwd": str(other)},
    )
    assert conflict.status_code == 409

    status = await client.get(
        "/api/notebooks/jupyter/status",
        params={"cwd": str(other)},
    )
    assert status.json()["matches_workspace"] is False

    wrong_stop = await client.post(
        "/api/notebooks/jupyter/stop",
        params={"cwd": str(other)},
    )
    assert wrong_stop.status_code == 409
    assert notebooks._jupyter_running()

    stopped = await client.post(
        "/api/notebooks/jupyter/stop",
        params={"cwd": str(temp_workspace)},
    )
    assert stopped.status_code == 200
    assert not notebooks._jupyter_running()

@pytest.mark.anyio
async def test_jupyter_rejects_missing_workspace(client, temp_workspace):
    missing = Path(temp_workspace) / "missing"
    response = await client.post(
        "/api/notebooks/jupyter/start",
        params={"cwd": str(missing)},
    )
    # workspace_security rejects unknown/uninitialized paths before the
    # directory-existence check, so a missing workspace surfaces as 403.
    assert response.status_code == 403
