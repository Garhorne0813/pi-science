"""Workspace cwd validation tests."""

import pytest

from services import workspace_security
from services.workspace_context import WorkspaceContext


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


def test_workspace_context_exposes_canonical_paths(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace_security, "_REGISTRY_FILE", tmp_path / "registry.json")
    monkeypatch.setattr(workspace_security, "WORKSPACES_DIR", tmp_path / "managed")
    workspace = tmp_path / "project"
    (workspace / ".pi-science").mkdir(parents=True)

    context = WorkspaceContext.from_cwd(workspace)

    assert context.root == workspace.resolve()
    assert context.metadata_root == workspace.resolve() / ".pi-science"
    assert context.sessions_root == workspace.resolve() / ".pi-science" / "sessions"


def test_registered_workspace_survives_registry_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace_security, "_REGISTRY_FILE", tmp_path / "registry.json")
    monkeypatch.setattr(workspace_security, "WORKSPACES_DIR", tmp_path / "managed")
    workspace = tmp_path / "opened"
    workspace.mkdir()

    workspace_security.register_workspace(workspace)
    assert workspace_security.validate_workspace_cwd(str(workspace)) == workspace.resolve()


def test_managed_root_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace_security, "_REGISTRY_FILE", tmp_path / "registry.json")
    managed = tmp_path / "managed"
    managed.mkdir()
    monkeypatch.setattr(workspace_security, "WORKSPACES_DIR", managed)

    with pytest.raises(ValueError, match="not a registered workspace"):
        workspace_security.validate_workspace_cwd(str(managed))


def test_managed_root_cannot_be_registered(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace_security, "_REGISTRY_FILE", tmp_path / "registry.json")
    managed = tmp_path / "managed"
    managed.mkdir()
    monkeypatch.setattr(workspace_security, "WORKSPACES_DIR", managed)

    with pytest.raises(ValueError, match="not a registered workspace"):
        workspace_security.register_workspace(managed)
    assert workspace_security._load_registry() == set()


def test_scan_registers_only_marked_direct_children(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace_security, "_REGISTRY_FILE", tmp_path / "registry.json")
    managed = tmp_path / "managed"
    marked = managed / "marked"
    unmarked = managed / "unmarked"
    nested = managed / "nested"
    (marked / ".pi-science").mkdir(parents=True)
    unmarked.mkdir(parents=True)
    (nested / "child" / ".pi-science").mkdir(parents=True)
    monkeypatch.setattr(workspace_security, "WORKSPACES_DIR", managed)

    workspace_security.scan_and_register_workspaces()

    assert workspace_security._load_registry() == {str(marked.resolve())}
