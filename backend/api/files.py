"""File operations API — read, raw download, and preview."""

from pathlib import Path

import shutil

from fastapi import APIRouter, HTTPException, Query, UploadFile, File
from fastapi.responses import FileResponse

from models import FileContent, PreviewData
from services.file_service import (
    read_file_content,
    get_preview_data,
    detect_preview_kind,
    resolve_workspace_path,
)

from datetime import datetime, timezone

router = APIRouter(prefix="/api/files", tags=["files"])


@router.get("")
async def list_files(
    cwd: str = Query(".", description="Working directory"),
    subdir: str = Query("", description="Subdirectory path relative to workspace"),
):
    """List files in the workspace, optionally in a subdirectory."""
    import os as _os
    ws = _workspace_dir(cwd)
    try:
        target = resolve_workspace_path(ws, subdir or ".")
    except ValueError:
        raise HTTPException(status_code=403, detail="Path outside workspace")
    if not target.exists() or not target.is_dir():
        return []
    entries = []
    for p in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
        if p.name.startswith("."):
            continue
        try:
            st = p.stat()
            entries.append({
                "path": str(p.relative_to(ws)),
                "name": p.name,
                "isDir": p.is_dir(),
                "size": st.st_size,
                "modified": st.st_mtime,
            })
        except OSError:
            pass
    return entries


@router.get("/breadcrumbs")
async def get_breadcrumbs(
    cwd: str = Query(".", description="Working directory"),
    subdir: str = Query("", description="Current subdirectory"),
):
    """Return breadcrumb path components from workspace root to subdir."""
    ws = _workspace_dir(cwd)
    try:
        target = resolve_workspace_path(ws, subdir or ".")
    except ValueError:
        raise HTTPException(status_code=403, detail="Path outside workspace")
    parts = []
    current = ws.resolve()
    for part in str(target.relative_to(ws)).split("/"):
        if not part or part == ".":
            continue
        current = current / part
        parts.append({"name": part, "path": str(current.relative_to(ws))})
    return parts


@router.delete("/{path:path}")
async def delete_file(
    path: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Delete a file or empty directory from the workspace."""
    ws = _workspace_dir(cwd)
    try:
        target = resolve_workspace_path(ws, path)
    except ValueError:
        raise HTTPException(status_code=403, detail="Path outside workspace")
    if not target.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if target.is_dir():
        try:
            target.rmdir()
        except OSError:
            raise HTTPException(status_code=400, detail="Directory not empty")
    else:
        target.unlink()
    return {"ok": True}


@router.get("/probe/{path:path}")
async def probe_file(
    path: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Probe a file to get its structure summary without loading the whole thing."""
    from services.large_file import probe_file as probe
    ws = _workspace_dir(cwd)
    try:
        target = resolve_workspace_path(ws, path)
    except ValueError:
        raise HTTPException(status_code=403, detail="Path outside workspace")
    return probe(target)


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    cwd: str = Query(".", description="Working directory"),
):
    """Upload a file to the workspace."""
    ws = _workspace_dir(cwd)
    filename = Path(file.filename or "").name
    if not filename or filename in {".", ".."}:
        raise HTTPException(status_code=400, detail="Invalid filename")
    try:
        dest = resolve_workspace_path(ws, filename)
    except ValueError:
        raise HTTPException(status_code=403, detail="Path outside workspace")
    # Don't overwrite existing files
    if dest.exists():
        raise HTTPException(status_code=409, detail=f"File already exists: {file.filename}")
    try:
        with dest.open("wb") as f:
            shutil.copyfileobj(file.file, f)
    finally:
        file.file.close()
    return {"ok": True, "path": str(dest.relative_to(ws)), "filename": file.filename}


def _workspace_dir(cwd: str = ".") -> Path:
    """Resolve workspace directory. Defaults to cwd but can be overridden."""
    return Path(cwd).resolve()


# ── Specific routes MUST come before the catch-all /{path:path} ──

@router.get("/{path:path}/raw")
async def raw_file(
    path: str,
    cwd: str = Query(".", description="Working directory"),
):
    """Serve raw file for browser-native viewing (PDFs, images, HTML, video)."""
    ws_root = _workspace_dir(cwd)
    try:
        full_path = resolve_workspace_path(ws_root, path)
    except ValueError:
        raise HTTPException(status_code=403, detail="Path outside workspace")

    if not full_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")

    if not full_path.is_file():
        raise HTTPException(status_code=400, detail=f"Not a file: {path}")

    ext = full_path.suffix.lower()
    mime_map = {
        ".pdf": "application/pdf",
        ".html": "text/html", ".htm": "text/html",
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".svg": "image/svg+xml",
        ".mp4": "video/mp4", ".webm": "video/webm",
        ".json": "application/json", ".txt": "text/plain", ".csv": "text/csv",
    }
    media_type = mime_map.get(ext, "application/octet-stream")
    return FileResponse(full_path, media_type=media_type)


@router.get("/{path:path}/preview")
async def preview_file(
    path: str,
    cwd: str = Query(".", description="Working directory"),
) -> PreviewData:
    """Get preview data for scientific file formats."""
    try:
        return get_preview_data(_workspace_dir(cwd), path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{path:path}")
async def read_file(
    path: str,
    cwd: str = Query(".", description="Working directory"),
    format: str = Query("text", description="text or base64"),
) -> FileContent:
    """Read a file from the workspace. text returns UTF-8, base64 returns encoded."""
    try:
        content = read_file_content(_workspace_dir(cwd), path)
        if format == "base64" and content.encoding == "utf8":
            import base64
            content.data = base64.b64encode(content.data.encode("utf-8")).decode("ascii")
            content.encoding = "base64"
        return content
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
