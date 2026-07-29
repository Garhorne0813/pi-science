"""Workspace cwd validation tests.

Shared parity fixture: apps/server/src/workspace-security.test.ts mirrors this
scenario list case-for-case.  The Node control plane is the authority; any
change here must be replicated on the Node side in the same commit.
"""

import pytest

from services import workspace_security
from services.workspace_context import WorkspaceContext


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    """A symlink-free sandbox with no managed workspaces root configured."""
    monkeypatch.delenv("PI_SCIENCE_WORKSPACES", raising=False)
    return tmp_path.resolve()


def test_empty_path_is_rejected(sandbox):
    with pytest.raises(ValueError, match="Workspace path is required"):
        workspace_security.validate_workspace_cwd("")


def test_missing_path_is_rejected(sandbox):
    with pytest.raises(ValueError):
        workspace_security.validate_workspace_cwd(str(sandbox / "missing"))


def test_file_is_rejected(sandbox):
    file = sandbox / "notes.md"
    file.write_text("x")

    with pytest.raises(ValueError, match="Not a directory"):
        workspace_security.validate_workspace_cwd(str(file))


def test_marker_directory_is_accepted(sandbox):
    workspace = sandbox / "marked"
    (workspace / ".pi-science").mkdir(parents=True)

    assert workspace_security.validate_workspace_cwd(str(workspace)) == workspace


def test_marker_file_is_rejected(sandbox):
    workspace = sandbox / "fake-marker"
    workspace.mkdir()
    (workspace / ".pi-science").write_text("")

    with pytest.raises(ValueError, match="not a registered workspace"):
        workspace_security.validate_workspace_cwd(str(workspace))


def test_unmarked_directory_is_rejected_without_managed_root(sandbox):
    workspace = sandbox / "outside"
    workspace.mkdir()

    with pytest.raises(ValueError, match="not a registered workspace"):
        workspace_security.validate_workspace_cwd(str(workspace))


def test_unmarked_child_of_managed_root_is_accepted(sandbox, monkeypatch):
    managed = sandbox / "managed"
    workspace = managed / "child"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("PI_SCIENCE_WORKSPACES", str(managed))

    assert workspace_security.validate_workspace_cwd(str(workspace)) == workspace


def test_nested_unmarked_directory_below_managed_root_is_accepted(sandbox, monkeypatch):
    managed = sandbox / "managed"
    workspace = managed / "child" / "deeper"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("PI_SCIENCE_WORKSPACES", str(managed))

    assert workspace_security.validate_workspace_cwd(str(workspace)) == workspace


def test_dot_dot_prefixed_child_of_managed_root_is_accepted(sandbox, monkeypatch):
    managed = sandbox / "managed"
    workspace = managed / "..results"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("PI_SCIENCE_WORKSPACES", str(managed))

    assert workspace_security.validate_workspace_cwd(str(workspace)) == workspace


def test_managed_root_itself_is_rejected(sandbox, monkeypatch):
    managed = sandbox / "managed"
    managed.mkdir()
    monkeypatch.setenv("PI_SCIENCE_WORKSPACES", str(managed))

    with pytest.raises(ValueError, match="not a registered workspace"):
        workspace_security.validate_workspace_cwd(str(managed))


def test_sibling_sharing_managed_root_name_prefix_is_rejected(sandbox, monkeypatch):
    managed = sandbox / "managed"
    workspace = sandbox / "managed-evil"
    managed.mkdir()
    workspace.mkdir()
    monkeypatch.setenv("PI_SCIENCE_WORKSPACES", str(managed))

    with pytest.raises(ValueError, match="not a registered workspace"):
        workspace_security.validate_workspace_cwd(str(workspace))


def test_symlink_to_marked_workspace_resolves_to_the_target(sandbox):
    workspace = sandbox / "target"
    link = sandbox / "link"
    (workspace / ".pi-science").mkdir(parents=True)
    link.symlink_to(workspace, target_is_directory=True)

    assert workspace_security.validate_workspace_cwd(str(link)) == workspace


def test_symlink_escaping_the_managed_root_is_rejected(sandbox, monkeypatch):
    managed = sandbox / "managed"
    outside = sandbox / "outside"
    link = managed / "escape"
    managed.mkdir()
    outside.mkdir()
    link.symlink_to(outside, target_is_directory=True)
    monkeypatch.setenv("PI_SCIENCE_WORKSPACES", str(managed))

    with pytest.raises(ValueError, match="not a registered workspace"):
        workspace_security.validate_workspace_cwd(str(link))


def test_unmarked_workspace_under_symlinked_managed_root_is_accepted(sandbox, monkeypatch):
    managed = sandbox / "managed"
    workspace = managed / "child"
    link = sandbox / "managed-link"
    workspace.mkdir(parents=True)
    link.symlink_to(managed, target_is_directory=True)
    monkeypatch.setenv("PI_SCIENCE_WORKSPACES", str(link))

    assert workspace_security.validate_workspace_cwd(str(workspace)) == workspace


def test_missing_dot_dot_prefixed_file_inside_workspace_is_accepted(sandbox):
    workspace = sandbox / "marked"
    (workspace / ".pi-science").mkdir(parents=True)

    assert workspace_security.resolve_workspace_file(workspace, "..results.json") == workspace / "..results.json"


def test_windows_metadata_directory_case_variant_is_rejected(sandbox):
    workspace = sandbox / "marked"
    (workspace / ".pi-science").mkdir(parents=True)

    with pytest.raises(ValueError, match="metadata paths"):
        workspace_security.resolve_workspace_file(
            workspace, ".PI-SCIENCE/secret.txt", platform="win32"
        )


def test_missing_target_below_escaping_symlink_is_rejected(sandbox):
    workspace = sandbox / "marked"
    outside = sandbox / "outside"
    (workspace / ".pi-science").mkdir(parents=True)
    outside.mkdir()
    (workspace / "escape").symlink_to(outside, target_is_directory=True)

    with pytest.raises(ValueError, match="escapes the workspace"):
        workspace_security.resolve_workspace_file(workspace, "escape/future.txt")


def test_workspace_context_exposes_canonical_paths(sandbox):
    workspace = sandbox / "project"
    (workspace / ".pi-science").mkdir(parents=True)

    context = WorkspaceContext.from_cwd(workspace)

    assert context.root == workspace
    assert context.metadata_root == workspace / ".pi-science"
    assert context.sessions_root == workspace / ".pi-science" / "sessions"
