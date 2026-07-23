"""Pi subprocess launch policy tests."""

from services import pi_runtime_config
from models import PiConfig


def test_runtime_uses_workspace_scoped_agent_dir_and_skips_context_mode_by_default(
    tmp_path, monkeypatch
):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("PI_SCIENCE_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("PI_SCIENCE_ENABLE_CONTEXT_MODE", "0")
    monkeypatch.setattr(pi_runtime_config, "BASE_DIR", tmp_path / "data")

    launch = pi_runtime_config.build_runtime_launch(
        str(workspace), str(workspace / ".pi-science" / "sessions"), PiConfig()
    )

    agent_dir = launch.env["PI_CODING_AGENT_DIR"]
    assert agent_dir.startswith(str(tmp_path / "data" / "pi-agent"))
    assert launch.env["PI_CONFIG_DIR"] == agent_dir
    assert launch.env["PI_WORKSPACE_DIR"] == str(workspace.resolve())
    assert "context-mode/build/adapters/pi/extension" not in " ".join(launch.args)


def test_runtime_can_explicitly_enable_context_mode(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("PI_SCIENCE_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("PI_SCIENCE_ENABLE_CONTEXT_MODE", "1")
    monkeypatch.setattr(pi_runtime_config, "BASE_DIR", tmp_path / "data")

    launch = pi_runtime_config.build_runtime_launch(
        str(workspace), str(workspace / ".pi-science" / "sessions"), PiConfig()
    )

    assert "context-mode/build/adapters/pi/extension" in " ".join(launch.args)
