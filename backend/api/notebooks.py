"""Notebook management API — list .ipynb files, manage Jupyter Lab with uv."""

import os
import secrets
import shutil
import asyncio
import socket
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
    from services.workspace_security import validate_workspace_cwd

    try:
        return validate_workspace_cwd(cwd)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


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

_jupyter_process: subprocess.Popen | None = None
_jupyter_port: int | None = None
_jupyter_cwd: str | None = None
_jupyter_token: str | None = None
_jupyter_lock = asyncio.Lock()


def _jupyter_running() -> bool:
    return _jupyter_process is not None and _jupyter_process.poll() is None


def _find_available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _jupyter_payload(*, message: str | None = None) -> dict:
    running = _jupyter_running()
    payload = {
        "running": running,
        "port": _jupyter_port if running else None,
        "url": f"http://127.0.0.1:{_jupyter_port}/lab?token={_jupyter_token}" if running else None,
        "cwd": _jupyter_cwd if running else None,
    }
    if message is not None:
        payload["message"] = message
    return payload


def _stop_jupyter_process() -> None:
    global _jupyter_process, _jupyter_port, _jupyter_cwd, _jupyter_token
    process = _jupyter_process
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    _jupyter_process = None
    _jupyter_port = None
    _jupyter_cwd = None
    _jupyter_token = None


async def shutdown_jupyter_server() -> None:
    """Stop the managed Jupyter process during API or application shutdown."""
    async with _jupyter_lock:
        await asyncio.to_thread(_stop_jupyter_process)


@router.get("/jupyter/status")
async def jupyter_status(cwd: str | None = Query(None, description="Current working directory")):
    """Get Jupyter Lab server status."""
    payload = _jupyter_payload()
    payload["env_ready"] = _jupyter_bin().exists()
    payload["matches_workspace"] = (
        not payload["running"]
        or cwd is None
        or payload["cwd"] == str(_workspace_dir(cwd))
    )
    return payload


@router.post("/jupyter/start")
async def start_jupyter(cwd: str = Query(".", description="Working directory")):
    """Start Jupyter Lab server in the workspace."""
    global _jupyter_process, _jupyter_port, _jupyter_cwd, _jupyter_token
    ws = _workspace_dir(cwd)
    if not ws.is_dir():
        raise HTTPException(status_code=400, detail=f"Workspace directory does not exist: {ws}")

    async with _jupyter_lock:
        if _jupyter_running():
            if _jupyter_cwd == str(ws):
                return {"ok": True, **_jupyter_payload(message="Already running")}
            raise HTTPException(
                status_code=409,
                detail=f"Jupyter Lab is already running for another workspace: {_jupyter_cwd}",
            )
        _stop_jupyter_process()
        try:
            _jupyter_port = _find_available_port()
            _jupyter_cwd = str(ws)
            # Random token keeps Jupyter auth on: an unauthenticated server on
            # 127.0.0.1 is still reachable by any local process or a DNS-rebound
            # browser page, and Jupyter is an arbitrary-code-execution surface.
            _jupyter_token = secrets.token_hex(24)
            # Prefer the managed uv environment, then PATH; the bare name lets
            # Popen raise FileNotFoundError -> 400 when nothing is installed.
            jupyter_bin = _jupyter_bin()
            if not jupyter_bin.exists():
                jupyter_bin = Path(shutil.which("jupyter-lab") or "jupyter-lab")
            _jupyter_process = subprocess.Popen(
                [
                    str(jupyter_bin),
                    "--no-browser",
                    "--ip=127.0.0.1",
                    f"--port={_jupyter_port}",
                    "--port-retries=0",
                    f"--ServerApp.root_dir={ws}",
                    f"--ServerApp.token={_jupyter_token}",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            await asyncio.sleep(0)
            if _jupyter_process.poll() is not None:
                _stop_jupyter_process()
                raise HTTPException(status_code=500, detail="Jupyter Lab exited during startup")
            return {"ok": True, **_jupyter_payload()}
        except FileNotFoundError:
            _stop_jupyter_process()
            raise HTTPException(status_code=400, detail="Jupyter Lab not installed. Run: pip install jupyterlab")
        except HTTPException:
            raise
        except Exception as exc:
            _stop_jupyter_process()
            raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/jupyter/stop")
async def stop_jupyter(cwd: str | None = Query(None, description="Workspace that owns the server")):
    """Stop the Jupyter Lab server."""
    async with _jupyter_lock:
        if _jupyter_running() and cwd is not None and _jupyter_cwd != str(_workspace_dir(cwd)):
            raise HTTPException(status_code=409, detail="Cannot stop Jupyter Lab owned by another workspace")
        await asyncio.to_thread(_stop_jupyter_process)
    return {"ok": True}
