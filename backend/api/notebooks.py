"""Notebook management API — list .ipynb files, manage Jupyter Lab with uv."""

import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from config import BASE_DIR

router = APIRouter(prefix="/api/notebooks", tags=["notebooks"])

JUPYTER_ENV = BASE_DIR / "jupyter-env"
JUPYTER_PACKAGES = ["jupyterlab", "ipykernel", "numpy", "pandas", "matplotlib"]

_jupyter_process: subprocess.Popen | None = None
_jupyter_port = 8888
import asyncio
_setup_lock = asyncio.Lock()  # Prevent concurrent setup


def _workspace_dir(cwd: str = ".") -> Path:
    return Path(cwd).resolve()


def _find_uv() -> str | None:
    uv = shutil.which("uv")
    if not uv:
        # Check common install locations
        for p in [Path.home() / ".local" / "bin" / "uv", Path.home() / ".cargo" / "bin" / "uv"]:
            if p.exists():
                return str(p)
    return uv


def _jupyter_bin() -> Path:
    """Path to jupyter-lab in the managed env."""
    if os.name == "nt":
        return JUPYTER_ENV / "Scripts" / "jupyter-lab.exe"
    return JUPYTER_ENV / "bin" / "jupyter-lab"


def _env_python() -> str:
    if os.name == "nt":
        return str(JUPYTER_ENV / "Scripts" / "python.exe")
    return str(JUPYTER_ENV / "bin" / "python")


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


# ── Jupyter Environment Setup ──

@router.get("/jupyter/env-status")
async def jupyter_env_status():
    """Check if the managed Jupyter environment is ready."""
    return {
        "ready": _jupyter_bin().exists(),
        "path": str(JUPYTER_ENV),
        "uv_available": _find_uv() is not None,
    }


@router.post("/jupyter/setup")
async def setup_jupyter_env():
    """Provision the isolated Jupyter environment using uv. Returns SSE progress."""
    if _setup_lock.locked():
        raise HTTPException(status_code=409, detail="Setup already in progress")

    uv = _find_uv()
    if not uv:
        raise HTTPException(status_code=400, detail="uv not found. Install from https://docs.astral.sh/uv/")

    async with _setup_lock:
        async def event_stream():
            try:
                # Create venv
                yield f"data: {_sse_msg('Creating venv...')}\n\n"
                if not JUPYTER_ENV.exists():
                    result = subprocess.run(
                        [uv, "venv", str(JUPYTER_ENV), "--python", "3.12"],
                        capture_output=True, text=True, timeout=120,
                    )
                    if result.returncode != 0:
                        yield f"data: {_sse_msg('error', result.stderr[-200:])}\n\n"
                        return

                # Install packages
                for pkg in JUPYTER_PACKAGES:
                    yield f"data: {_sse_msg(f'Installing {pkg}...')}\n\n"
                    result = subprocess.run(
                        [uv, "pip", "install", pkg, "--python", _env_python()],
                        capture_output=True, text=True, timeout=300,
                    )
                    if result.returncode != 0:
                        yield f"data: {_sse_msg('error', result.stderr[-200:])}\n\n"
                        return

                yield f"data: {_sse_msg('done', 'Jupyter environment ready')}\n\n"
            finally:
                pass  # Lock released by async with

        return StreamingResponse(event_stream(), media_type="text/event-stream")


def _sse_msg(status: str = "progress", text: str = "") -> str:
    import json
    return json.dumps({"status": status, "text": text})


# ── Jupyter Server Management ──

@router.get("/jupyter/status")
async def jupyter_status():
    """Get Jupyter Lab server status."""
    global _jupyter_process
    running = _jupyter_process is not None and _jupyter_process.poll() is None
    return {
        "running": running,
        "port": _jupyter_port,
        "url": f"http://127.0.0.1:{_jupyter_port}/lab" if running else None,
        "env_ready": _jupyter_bin().exists(),
    }


@router.post("/jupyter/start")
async def start_jupyter(cwd: str = Query(".", description="Working directory")):
    """Start Jupyter Lab in the workspace using the managed uv environment."""
    global _jupyter_process, _jupyter_port
    if _jupyter_process and _jupyter_process.poll() is None:
        return {"ok": True, "message": "Already running", "url": f"http://127.0.0.1:{_jupyter_port}/lab"}

    jupyter_bin = _jupyter_bin()
    if not jupyter_bin.exists():
        # Fallback: try system jupyter-lab
        system_jupyter = shutil.which("jupyter-lab")
        if system_jupyter:
            jupyter_bin = Path(system_jupyter)
        else:
            raise HTTPException(
                status_code=400,
                detail="Jupyter environment not set up. Click 'Setup Jupyter' first or run: uv venv ~/.pi-science/jupyter-env && uv pip install -p ~/.pi-science/jupyter-env jupyter-lab ipykernel numpy pandas matplotlib",
            )

    ws = _workspace_dir(cwd)
    _jupyter_process = subprocess.Popen(
        [str(jupyter_bin), "--no-browser", f"--port={_jupyter_port}", f"--notebook-dir={ws}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return {"ok": True, "url": f"http://127.0.0.1:{_jupyter_port}/lab"}


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
