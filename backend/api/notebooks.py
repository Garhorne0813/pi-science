"""Notebook management API — list, scan, and manage .ipynb files."""

import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

router = APIRouter(prefix="/api/notebooks", tags=["notebooks"])


def _workspace_dir(cwd: str = ".") -> Path:
    return Path(cwd).resolve()


@router.get("")
async def list_notebooks(cwd: str = Query(".", description="Working directory")):
    """List all .ipynb files in the workspace."""
    ws = _workspace_dir(cwd)
    if not ws.exists():
        return []
    notebooks = []
    for nb_path in sorted(ws.rglob("*.ipynb")):
        if any(p.startswith(".") for p in nb_path.relative_to(ws).parts):
            continue
        st = nb_path.stat()
        notebooks.append({
            "path": str(nb_path.relative_to(ws)),
            "name": nb_path.name,
            "size": st.st_size,
            "modified": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
        })
    return notebooks


# ── Jupyter Server Management ──

_jupyter_process: subprocess.Popen | None = None
_jupyter_port = 8888


@router.get("/jupyter/status")
async def jupyter_status():
    """Get Jupyter Lab server status."""
    global _jupyter_process
    running = _jupyter_process is not None and _jupyter_process.poll() is None
    return {
        "running": running,
        "port": _jupyter_port,
        "url": f"http://127.0.0.1:{_jupyter_port}/lab" if running else None,
    }


@router.post("/jupyter/start")
async def start_jupyter(cwd: str = Query(".", description="Working directory")):
    """Start Jupyter Lab server in the workspace."""
    global _jupyter_process, _jupyter_port
    if _jupyter_process and _jupyter_process.poll() is None:
        return {"ok": True, "message": "Already running", "url": f"http://127.0.0.1:{_jupyter_port}/lab"}
    try:
        ws = _workspace_dir(cwd)
        _jupyter_process = subprocess.Popen(
            ["jupyter-lab", "--no-browser", f"--port={_jupyter_port}", f"--notebook-dir={ws}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        return {"ok": True, "url": f"http://127.0.0.1:{_jupyter_port}/lab"}
    except FileNotFoundError:
        raise HTTPException(status_code=400, detail="Jupyter Lab not installed. Run: pip install jupyterlab")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/jupyter/stop")
async def stop_jupyter():
    """Stop the Jupyter Lab server."""
    global _jupyter_process
    if _jupyter_process:
        _jupyter_process.terminate()
        try:
            _jupyter_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _jupyter_process.kill()
        _jupyter_process = None
    return {"ok": True}
