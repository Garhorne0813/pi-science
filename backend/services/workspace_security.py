"""Workspace path validation for APIs that accept a ``cwd`` parameter.

The frontend intentionally sends absolute workspace paths.  Every API that
uses one must validate it before reading or writing files; otherwise a caller
could point ``cwd`` at an arbitrary directory on the host.

This mirrors ``apps/server/src/workspace-security.ts``: the Node control plane
is the authority for workspace security, and Python must reach the same verdict
for every path.  A path is accepted when it resolves to a directory that either
contains the ``.pi-science`` marker directory or lives strictly below the
managed workspaces root named by ``PI_SCIENCE_WORKSPACES``.

Two mirrored details are deliberate rather than accidental:

* Both the candidate and an existing managed root are resolved through
  symlinks before containment is checked.
* Without ``PI_SCIENCE_WORKSPACES`` there is no managed root at all, so
  ``config.WORKSPACES_DIR``'s ``~/pi-science-workspaces`` default grants nothing
  on its own -- such workspaces are accepted via their marker directory.
"""

import os
from pathlib import Path


def _managed_root() -> Path | None:
    raw = os.environ.get("PI_SCIENCE_WORKSPACES")
    if not raw:
        return None
    configured = Path(os.path.abspath(raw))
    try:
        return configured.resolve(strict=True)
    except OSError:
        return configured


def validate_workspace_cwd(cwd: str) -> Path:
    """Resolve and validate a workspace path."""
    if not cwd:
        raise ValueError("Workspace path is required")
    try:
        root = Path(cwd).resolve(strict=True)
    except OSError as exc:
        raise ValueError(f"Workspace does not exist: {cwd}") from exc
    if not root.is_dir():
        raise ValueError(f"Not a directory: {cwd}")
    if (root / ".pi-science").is_dir():
        return root
    managed = _managed_root()
    if managed is not None and root != managed and root.is_relative_to(managed):
        return root
    raise ValueError(f"Path is not a registered workspace: {cwd}")


def resolve_workspace_file(workspace: str | Path, relative_path: str, *, allow_metadata: bool = False) -> Path:
    """Resolve a workspace-relative file while preventing traversal/symlink escape."""
    root = Path(workspace).expanduser().resolve()
    if not relative_path or Path(relative_path).is_absolute():
        raise ValueError("Artifact path must be relative to the workspace")
    candidate = (root / relative_path).resolve()
    if not candidate.is_relative_to(root):
        raise ValueError("Artifact path escapes the workspace")
    try:
        relative = candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("Artifact path escapes the workspace") from exc
    if not allow_metadata and ".pi-science" in relative.parts:
        raise ValueError("Artifact metadata paths are not publishable")
    return candidate
