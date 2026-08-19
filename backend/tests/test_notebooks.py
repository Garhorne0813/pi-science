"""Notebook listing and managed Jupyter server tests."""

from pathlib import Path
from types import SimpleNamespace

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
def reset_jupyter_state(monkeypatch, tmp_path):
    monkeypatch.setenv("PI_SCIENCE_HOME", str(tmp_path / "app-data"))
    monkeypatch.setattr(notebooks, "_jupyter_process", None)
    monkeypatch.setattr(notebooks, "_jupyter_port", None)
    monkeypatch.setattr(notebooks, "_jupyter_cwd", None)
    monkeypatch.setattr(notebooks, "_jupyter_token", None)


def install_fake_jupyter(workspace: Path) -> Path:
    executable = notebooks._jupyter_bin(workspace)
    executable.parent.mkdir(parents=True, exist_ok=True)
    executable.touch()
    return executable


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
    install_fake_jupyter(temp_workspace)
    resolved_workspace = temp_workspace.resolve()
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
    assert spawned[0].args[0] == str(notebooks._jupyter_bin(resolved_workspace))
    assert f"--ServerApp.root_dir={resolved_workspace}" in spawned[0].args

    status = await client.get(
        "/api/notebooks/jupyter/status",
        params={"cwd": str(temp_workspace)},
    )
    assert status.json()["matches_workspace"] is True


@pytest.mark.anyio
async def test_jupyter_rejects_cross_workspace_start_and_stop(client, temp_workspace, monkeypatch):
    install_fake_jupyter(temp_workspace)
    other = temp_workspace / "other"
    other.mkdir()
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
    assert response.status_code == 403


@pytest.mark.anyio
async def test_jupyter_environment_status_uses_application_runtime(client, temp_workspace):
    before = await client.get(
        "/api/notebooks/jupyter/env-status",
        params={"cwd": str(temp_workspace)},
    )
    assert before.status_code == 200
    assert before.json()["ready"] is False
    assert before.json()["path"] == str(notebooks._workspace_venv(temp_workspace.resolve()))

    install_fake_jupyter(temp_workspace)
    after = await client.get(
        "/api/notebooks/jupyter/env-status",
        params={"cwd": str(temp_workspace)},
    )
    assert after.json()["ready"] is True


@pytest.mark.anyio
async def test_jupyter_setup_is_get_sse_and_installs_into_application_runtime(
    client, temp_workspace, monkeypatch
):
    commands = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(notebooks, "_find_micromamba", lambda: "/usr/bin/micromamba")
    monkeypatch.setattr(notebooks.subprocess, "run", fake_run)

    response = await client.get(
        "/api/notebooks/jupyter/setup",
        params={"cwd": str(temp_workspace)},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert '"status": "progress"' in response.text
    assert commands[0] == [
        "/usr/bin/micromamba",
        "create",
        "--yes",
        "--prefix",
        str(notebooks._workspace_venv(temp_workspace.resolve())),
        "--channel",
        "conda-forge",
        "--strict-channel-priority",
        "python=3.12",
        "jupyterlab",
    ]

    post_response = await client.post(
        "/api/notebooks/jupyter/setup",
        params={"cwd": str(temp_workspace)},
    )
    assert post_response.status_code == 405


def test_windows_workspace_environment_paths(temp_workspace, monkeypatch):
    monkeypatch.setattr(notebooks, "_BIN_DIR", "Scripts")
    monkeypatch.setattr(notebooks, "_PYTHON_NAME", "python.exe")
    monkeypatch.setattr(notebooks, "_JUPYTER_NAME", "jupyter-lab.exe")

    assert notebooks._env_python(temp_workspace) == notebooks._workspace_venv(temp_workspace) / "Scripts" / "python.exe"
    assert notebooks._jupyter_bin(temp_workspace) == notebooks._workspace_venv(temp_workspace) / "Scripts" / "jupyter-lab.exe"
