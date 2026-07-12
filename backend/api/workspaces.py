"""Workspace management API — list and create workspace directories."""

import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

import shutil

from config import WORKSPACES_DIR

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


def _seed_harness(workspace_path: Path):
    """Copy harness files into a new workspace (non-clobbering)."""
    if not HARNESS_DIR.exists():
        return
    for src in HARNESS_DIR.iterdir():
        if src.is_file():
            dst = workspace_path / src.name
            if not dst.exists():
                shutil.copy2(src, dst)
