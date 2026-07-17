"""Workspace security — validates cwd parameters to prevent path traversal.

File APIs accept a ``cwd`` query parameter. Without validation an attacker (or
a prompt-injected agent) could set ``cwd=/etc`` and read arbitrary files.

This module maintains a registry of workspace paths that were explicitly
created/opened via the workspaces API. A cwd is accepted if it is:
  1. In the registry, OR
  2. A subdirectory of WORKSPACES_DIR, OR
  3. A directory containing a ``.pi-science/`` marker (previously initialized)
"""

import json
import os
from pathlib import Path

from config import BASE_DIR, WORKSPACES_DIR

_REGISTRY_FILE = BASE_DIR / "workspaces.json"


def _load_registry() -> set[str]:
    """Load the set of registered workspace paths (resolved absolute strings)."""
    if _REGISTRY_FILE.exists():
        try:
            data = json.loads(_REGISTRY_FILE.read_text())
            return {
                str(Path(p).expanduser().resolve())
                for p in data.get("paths", [])
                if p
            }
        except (json.JSONDecodeError, OSError):
            pass
    return set()


def _save_registry(paths: set[str]) -> None:
    """Atomically save workspace paths to the registry."""
    _REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _REGISTRY_FILE.with_name(
        f".{_REGISTRY_FILE.name}.{os.getpid()}.{os.urandom(4).hex}.tmp"
    )
    tmp.write_text(json.dumps({"paths": sorted(paths)}, indent=2))
    os.replace(tmp, _REGISTRY_FILE)


def register_workspace(path: str | Path) -> None:
    """Register a workspace path so file APIs accept it as cwd."""
    try:
        resolved = str(Path(path).expanduser().resolve())
    except (OSError, RuntimeError):
        return
    paths = _load_registry()
    if resolved not in paths:
        paths.add(resolved)
        _save_registry(paths)


def validate_workspace_cwd(cwd: str) -> Path:
    """Resolve and validate a workspace cwd.

    Returns the resolved Path if valid.
    Raises ValueError if the path is not an allowed workspace.
    """
    if not cwd:
        raise ValueError("Workspace path is required")

    root = Path(cwd).expanduser().resolve()

    if not root.exists():
        raise ValueError(f"Workspace does not exist: {cwd}")
    if not root.is_dir():
        raise ValueError(f"Not a directory: {cwd}")

    # Check 1: explicitly registered workspace
    if str(root) in _load_registry():
        return root

    # Check 2: under the managed WORKSPACES_DIR
    try:
        if root.is_relative_to(WORKSPACES_DIR.resolve()):
            return root
    except (ValueError, OSError):
        pass

    # Check 3: has .pi-science marker (previously initialized workspace)
    if (root / ".pi-science").is_dir():
        return root

    raise ValueError(f"Path is not a registered workspace: {cwd}")


def scan_and_register_workspaces() -> None:
    """Auto-register existing workspace directories under WORKSPACES_DIR.

    Called at startup so previously-created workspaces work without re-opening.
    """
    if not WORKSPACES_DIR.exists():
        return
    paths = _load_registry()
    changed = False
    for entry in WORKSPACES_DIR.iterdir():
        if entry.is_dir() and not entry.name.startswith("."):
            resolved = str(entry.resolve())
            if resolved not in paths:
                paths.add(resolved)
                changed = True
    if changed:
        _save_registry(paths)
