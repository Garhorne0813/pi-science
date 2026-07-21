"""Workspace cwd validation tests."""

import pytest

from api import workspaces as workspaces_api
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


@pytest.mark.anyio
async def test_api_listing_filters_unmarked_children_and_root(tmp_path, monkeypatch):
    managed = tmp_path / "managed"
    marked = managed / "marked"
    unmarked = managed / "unmarked"
    (marked / ".pi-science").mkdir(parents=True)
    unmarked.mkdir(parents=True)
    managed.mkdir(exist_ok=True)
    registered = tmp_path / "opened"
    registered.mkdir()

    monkeypatch.setattr(workspaces_api, "WORKSPACES_DIR", managed)
    monkeypatch.setattr(workspaces_api, "_load_registry", lambda: {
        str(managed.resolve()), str(registered.resolve())
    })

    result = await workspaces_api.list_workspaces()

    assert {item.path for item in result} == {str(marked.resolve()), str(registered.resolve())}


@pytest.mark.anyio
async def test_api_open_rejects_managed_root(tmp_path, monkeypatch):
    managed = tmp_path / "managed"
    managed.mkdir()
    monkeypatch.setattr(workspace_security, "_REGISTRY_FILE", tmp_path / "registry.json")
    monkeypatch.setattr(workspaces_api, "WORKSPACES_DIR", managed)
    monkeypatch.setattr(workspaces_api, "register_workspace", workspace_security.register_workspace)
    monkeypatch.setattr(workspace_security, "WORKSPACES_DIR", managed)

    with pytest.raises(workspaces_api.HTTPException) as exc_info:
        await workspaces_api.open_folder(workspaces_api.OpenFolderRequest(path=str(managed)))

    assert exc_info.value.status_code == 400
    assert workspace_security._load_registry() == set()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("method", "url", "kwargs"),
    [
        ("post", "/api/sessions", {"json": {}}),
        ("get", "/api/project-knowledge/summary", {}),
        ("post", "/api/kernels/execute", {"json": {"language": "python", "code": "1"}}),
    ],
)
async def test_workspace_scoped_apis_reject_unregistered_directory(client, tmp_path, method, url, kwargs):
    outside = tmp_path / "outside"
    outside.mkdir()
    if method == "post" and url == "/api/sessions":
        kwargs["json"]["cwd"] = str(outside)
    else:
        kwargs["params"] = {"cwd": str(outside)}

    response = await getattr(client, method)(url, **kwargs)

    assert response.status_code == 403
