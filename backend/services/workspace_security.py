"""Workspace path validation for APIs that accept a ``cwd`` parameter.

The frontend intentionally sends absolute workspace paths.  Every API that
uses one must validate it before reading or writing files; otherwise a caller
could point ``cwd`` at an arbitrary directory on the host.
"""

import json
import os
from pathlib import Path

from config import BASE_DIR, WORKSPACES_DIR


_REGISTRY_FILE = BASE_DIR / "workspaces.json"


def _load_registry() -> set[str]:
    if not _REGISTRY_FILE.exists():
        return set()
    try:
        payload = json.loads(_REGISTRY_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return set()
    paths = payload.get("paths", []) if isinstance(payload, dict) else []
    return {
        str(Path(path).expanduser().resolve())
        for path in paths
        if isinstance(path, str) and path.strip()
    }


def _save_registry(paths: set[str]) -> None:
    _REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _REGISTRY_FILE.with_name(
        f".{_REGISTRY_FILE.name}.{os.getpid()}.{os.urandom(4).hex()}.tmp"
    )
    tmp.write_text(json.dumps({"paths": sorted(paths)}, indent=2) + "\n")
    os.replace(tmp, _REGISTRY_FILE)


def register_workspace(path: str | Path) -> None:
    """Register an explicitly opened or created workspace."""
    try:
        resolved = str(Path(path).expanduser().resolve())
    except (OSError, RuntimeError):
        return
    if resolved == str(WORKSPACES_DIR.expanduser().resolve()):
        raise ValueError(f"Path is not a registered workspace: {path}")
    paths = _load_registry()
    if resolved not in paths:
        paths.add(resolved)
        _save_registry(paths)


def validate_workspace_cwd(cwd: str) -> Path:
    """Resolve and validate a workspace path.

    A path is accepted when it is registered, lives below the managed
    workspaces directory, or contains the workspace marker created by
    Pi-Science.  The final directory check also prevents a file from being
    used as a working directory.
    """
    if not cwd:
        raise ValueError("Workspace path is required")
    root = Path(cwd).expanduser().resolve()
    if not root.exists():
        raise ValueError(f"Workspace does not exist: {cwd}")
    if not root.is_dir():
        raise ValueError(f"Not a directory: {cwd}")
    if root == WORKSPACES_DIR.expanduser().resolve():
        raise ValueError(f"Path is not a registered workspace: {cwd}")

    if str(root) in _load_registry():
        return root
    try:
        if root.is_relative_to(WORKSPACES_DIR.expanduser().resolve()):
            return root
    except (OSError, RuntimeError, ValueError):
        pass
    if (root / ".pi-science").is_dir():
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


def scan_and_register_workspaces() -> None:
    """Register existing managed workspaces during backend startup."""
    root = WORKSPACES_DIR.expanduser()
    if not root.exists():
        return
    paths = _load_registry()
    changed = False
    for entry in root.iterdir():
        if entry.is_dir() and not entry.name.startswith(".") and (entry / ".pi-science").is_dir():
            resolved = str(entry.resolve())
            if resolved not in paths:
                paths.add(resolved)
                changed = True
    if changed:
        _save_registry(paths)
