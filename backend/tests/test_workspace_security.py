"""Workspace cwd validation tests."""

import pytest

from services import workspace_security


def test_marker_workspace_is_allowed(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace_security, "_REGISTRY_FILE", tmp_path / "registry.json")
    monkeypatch.setattr(workspace_security, "WORKSPACES_DIR", tmp_path / "managed")
    workspace = tmp_path / "project"
    (workspace / ".pi-science").mkdir(parents=True)

    assert workspace_security.validate_workspace_cwd(str(workspace)) == workspace.resolve()


def test_unregistered_directory_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace_security, "_REGISTRY_FILE", tmp_path / "registry.json")
    monkeypatch.setattr(workspace_security, "WORKSPACES_DIR", tmp_path / "managed")
    workspace = tmp_path / "outside"
    workspace.mkdir()

    with pytest.raises(ValueError, match="not a registered workspace"):
        workspace_security.validate_workspace_cwd(str(workspace))


def test_registered_workspace_survives_registry_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace_security, "_REGISTRY_FILE", tmp_path / "registry.json")
    monkeypatch.setattr(workspace_security, "WORKSPACES_DIR", tmp_path / "managed")
    workspace = tmp_path / "opened"
    workspace.mkdir()

    workspace_security.register_workspace(workspace)
    assert workspace_security.validate_workspace_cwd(str(workspace)) == workspace.resolve()
