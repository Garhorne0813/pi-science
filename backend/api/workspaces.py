"""Workspace management API — list and create workspace directories."""

from datetime import datetime, timezone
from pathlib import Path
import logging

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

import shutil

from config import WORKSPACES_DIR
from services.project_knowledge_store import initialize_project_workspace

logger = logging.getLogger(__name__)

HARNESS_DIR = Path(__file__).parent.parent.parent / "harness"

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])


class WorkspaceInfo(BaseModel):
    name: str
    path: str
    session_count: int = 0
    last_modified: str = ""


class CreateWorkspaceRequest(BaseModel):
    name: str


class OpenFolderRequest(BaseModel):
    path: str


class RenameWorkspaceRequest(BaseModel):
    path: str
    name: str


@router.get("", response_model=list[WorkspaceInfo])
async def list_workspaces():
    """List all workspace directories."""
    WORKSPACES_DIR.mkdir(parents=True, exist_ok=True)
    workspaces = []

    for entry in sorted(WORKSPACES_DIR.iterdir(), key=lambda e: e.stat().st_mtime, reverse=True):
        if entry.is_dir() and not entry.name.startswith("."):
            # Count sessions
            sessions_dir = entry / ".pi-science" / "sessions"
            session_count = 0
            if sessions_dir.exists():
                session_count = sum(1 for _ in sessions_dir.rglob("*.jsonl"))

            workspaces.append(WorkspaceInfo(
                name=entry.name,
                path=str(entry),
                session_count=session_count,
                last_modified=datetime.fromtimestamp(entry.stat().st_mtime, tz=timezone.utc).isoformat(),
            ))

    return workspaces


@router.post("", response_model=WorkspaceInfo)
async def create_workspace(body: CreateWorkspaceRequest):
    """Create a new workspace directory."""
    # Sanitize name
    name = body.name.strip().replace("/", "-").replace("\\", "-")[:100]
    if not name:
        raise HTTPException(status_code=400, detail="Invalid workspace name")

    path = WORKSPACES_DIR / name
    if path.exists():
        raise HTTPException(status_code=409, detail="Workspace already exists")

    path.mkdir(parents=True)
    # Seed harness files (AGENTS.md, KNOWLEDGE.md) into new workspace
    _seed_harness(path)
    initialize_project_workspace(path, create_base_directories=True)
    _register(path)
    return WorkspaceInfo(
        name=name,
        path=str(path),
        session_count=0,
        last_modified=datetime.now(timezone.utc).isoformat(),
    )


@router.post("/open", response_model=WorkspaceInfo)
async def open_folder(body: OpenFolderRequest):
    """Open an existing folder as a workspace."""
    import os as _os
    folder = Path(body.path).expanduser().resolve()
    if not folder.exists():
        raise HTTPException(status_code=404, detail=f"Folder not found: {folder}")
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {folder}")

    # Count existing sessions
    sessions_dir = folder / ".pi-science" / "sessions"
    session_count = 0
    if sessions_dir.exists():
        session_count = sum(1 for _ in sessions_dir.rglob("*.jsonl"))

    _register(folder)
    return WorkspaceInfo(
        name=folder.name,
        path=str(folder),
        session_count=session_count,
        last_modified=datetime.fromtimestamp(folder.stat().st_mtime, tz=timezone.utc).isoformat(),
    )


@router.post("/rename", response_model=WorkspaceInfo)
async def rename_workspace(body: RenameWorkspaceRequest):
    """Rename a workspace directory."""
    old = Path(body.path).expanduser().resolve()
    new = old.parent / body.name.strip().replace("/", "-").replace("\\", "-")[:100]
    if not old.exists():
        raise HTTPException(status_code=404, detail="Workspace not found")
    if new.exists():
        raise HTTPException(status_code=409, detail="Name already taken")
    old.rename(new)
    sessions_dir = new / ".pi-science" / "sessions"
    session_count = sum(1 for _ in sessions_dir.rglob("*.jsonl")) if sessions_dir.exists() else 0
    return WorkspaceInfo(
        name=new.name,
        path=str(new),
        session_count=session_count,
        last_modified=datetime.now(timezone.utc).isoformat(),
    )


class DeleteWorkspaceRequest(BaseModel):
    path: str


@router.delete("/delete")
async def delete_workspace(body: DeleteWorkspaceRequest):
    """Delete a workspace directory and all its contents."""
    import shutil as _shutil

    target = Path(body.path).expanduser().resolve()
    if not target.exists():
        raise HTTPException(status_code=404, detail="Workspace not found")
    try:
        if not target.is_relative_to(WORKSPACES_DIR.resolve()):
            raise HTTPException(status_code=403, detail="Cannot delete outside workspaces directory")
    except (ValueError, OSError):
        raise HTTPException(status_code=403, detail="Cannot delete outside workspaces directory")

    # Shut down any running pi process for this cwd
    try:
        from services.pi_manager import pi_manager
        await pi_manager._remove(str(target))
    except Exception:
        logger.warning("Failed to shut down pi process for workspace: %s", target, exc_info=True)

    _shutil.rmtree(target)
    return {"ok": True}


@router.post("/demo")
async def install_demo(name: str = Query("molecules", description="Demo name: molecules or climate")):
    """Install a demo workspace (molecules or climate)."""
    import shutil as _shutil

    demos = {
        "molecules": {"dir": "demo-molecules", "label": "Molecular Playground"},
        "climate": {"dir": "demo", "label": "Climate Trends"},
    }
    info = demos.get(name, demos["molecules"])
    demo_name = f"{name}-{datetime.now().strftime('%Y%m%d')}"
    demo_path = WORKSPACES_DIR / demo_name
    if demo_path.exists():
        return {"ok": True, "name": demo_name, "path": str(demo_path), "label": info["label"]}

    demo_src = Path(__file__).parent.parent.parent / info["dir"]
    if not demo_src.exists():
        raise HTTPException(status_code=404, detail=f"Demo '{name}' not found")

    demo_path.mkdir(parents=True, exist_ok=True)
    for item in demo_src.iterdir():
        dest = demo_path / item.name
        if item.is_dir():
            _shutil.copytree(item, dest, dirs_exist_ok=True)
        else:
            _shutil.copy2(item, dest)
    _seed_harness(demo_path)
    _register(demo_path)

    return {"ok": True, "name": demo_name, "path": str(demo_path), "label": info["label"]}


# ── Pinned Workspaces (stored server-side, shared across browsers) ──

import json as _json

def _pinned_file() -> Path:
    from config import BASE_DIR
    return BASE_DIR / "pinned.json"

def _load_pinned() -> list[str]:
    pf = _pinned_file()
    if pf.exists():
        try:
            return _json.loads(pf.read_text())
        except _json.JSONDecodeError:
            pass
    return []

def _save_pinned(paths: list[str]):
    pf = _pinned_file()
    pf.parent.mkdir(parents=True, exist_ok=True)
    pf.write_text(_json.dumps(paths, indent=2))

@router.get("/pinned")
async def get_pinned():
    """Get list of pinned workspace paths."""
    return {"paths": _load_pinned()}

class PinRequest(BaseModel):
    path: str

@router.post("/pin")
async def pin_workspace(body: PinRequest):
    """Pin a workspace to the top of the list."""
    paths = _load_pinned()
    if body.path not in paths:
        paths.append(body.path)
        _save_pinned(paths)
    return {"ok": True, "pinned": True}

@router.post("/unpin")
async def unpin_workspace(body: PinRequest):
    """Unpin a workspace."""
    paths = _load_pinned()
    if body.path in paths:
        paths.remove(body.path)
        _save_pinned(paths)
    return {"ok": True, "pinned": False}


def _register(workspace_path: Path):
    """Register a workspace so file APIs accept it as cwd."""
    from services.workspace_security import register_workspace
    register_workspace(workspace_path)


def _seed_harness(workspace_path: Path):
    """Copy harness files into a new workspace (non-clobbering)."""
    if not HARNESS_DIR.exists():
        return
    for src in HARNESS_DIR.iterdir():
        if src.is_file():
            dst = workspace_path / src.name
            if not dst.exists():
                shutil.copy2(src, dst)
