"""Notebook files and the app-managed, project-independent Jupyter runtime."""

import asyncio
import json
import os
import secrets
import shutil
import socket
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/api/notebooks", tags=["notebooks"])

_IS_WINDOWS = os.name == "nt"
_BIN_DIR = "Scripts" if _IS_WINDOWS else "bin"
_PYTHON_NAME = "python.exe" if _IS_WINDOWS else "python"
_JUPYTER_NAME = "jupyter-lab.exe" if _IS_WINDOWS else "jupyter-lab"
JUPYTER_PACKAGES = ["jupyterlab"]


def _runtime_root() -> Path:
    return Path(os.environ.get("PI_SCIENCE_HOME", Path.home() / ".pi-science"))


def _workspace_venv(_workspace: Path) -> Path:
    """Compatibility name: Jupyter now lives in one app-level environment."""
    return _runtime_root() / "micromamba" / "envs" / "pi-science-jupyter-runtime"


def _jupyter_bin(workspace: Path) -> Path:
    return _workspace_venv(workspace) / _BIN_DIR / _JUPYTER_NAME


def _env_python(workspace: Path) -> Path:
    return _workspace_venv(workspace) / _BIN_DIR / _PYTHON_NAME


def _find_uv() -> str | None:
    return shutil.which("uv")


def _find_micromamba() -> str | None:
    configured = os.environ.get("PI_SCIENCE_MICROMAMBA_EXECUTABLE")
    managed = _runtime_root() / "micromamba" / "bin" / ("micromamba.exe" if _IS_WINDOWS else "micromamba")
    return configured or (str(managed) if managed.exists() else None) or shutil.which("micromamba")


def _install_project_kernelspec(workspace: Path) -> None:
    """Expose the bound project environment without installing Jupyter into it."""
    binding_path = workspace / ".pi-science" / "environment.json"
    prefix: Path | None = None
    revision_id = "legacy"
    display_name = "Pi-Science Project"
    language = "python"
    try:
        binding = json.loads(binding_path.read_text("utf8"))
        revision_id = str(binding["revision_id"])
        registry = json.loads((_runtime_root() / "environments" / "registry.json").read_text("utf8"))
        revision = next(item for item in registry.get("revisions", []) if item.get("revision_id") == revision_id and item.get("status") == "ready")
        prefix = Path(revision["prefix"])
        display_name = str(revision.get("display_name") or display_name)
        language = str(revision.get("language") or language)
    except (OSError, ValueError, KeyError, StopIteration, TypeError):
        legacy = workspace / ".venv"
        if legacy.exists():
            prefix = legacy
    if prefix is None:
        return
    bin_dir = prefix / _BIN_DIR
    if language == "r":
        executable = bin_dir / ("R.exe" if _IS_WINDOWS else "R")
        argv = [str(executable), "--slave", "-e", "IRkernel::main()", "--args", "{connection_file}"]
    else:
        executable = bin_dir / _PYTHON_NAME
        argv = [str(executable), "-m", "ipykernel_launcher", "-f", "{connection_file}"]
    if not executable.exists():
        return
    kernel_dir = _workspace_venv(workspace) / "share" / "jupyter" / "kernels" / f"pi-science-{revision_id.lower()}"
    kernel_dir.mkdir(parents=True, exist_ok=True)
    (kernel_dir / "kernel.json").write_text(json.dumps({
        "argv": argv,
        "display_name": f"{display_name} ({revision_id[:12]})",
        "language": language,
        "metadata": {"pi_science_environment_revision_id": revision_id},
    }, indent=2) + "\n", "utf8")


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
async def jupyter_env_status(cwd: str = Query(".", description="Working directory")):
    """Check the application-level Jupyter runtime."""
    ws = _workspace_dir(cwd)
    return {
        "ready": _jupyter_bin(ws).exists(),
        "path": str(_workspace_venv(ws)),
        "uv_available": _find_uv() is not None,
        "manager": "micromamba" if _find_micromamba() else "uv-fallback",
    }


@router.get("/jupyter/setup")
async def setup_jupyter_env(cwd: str = Query(".", description="Working directory")):
    """Install Jupyter once into the application runtime. Returns SSE progress."""
    ws = _workspace_dir(cwd)
    if _setup_lock.locked():
        raise HTTPException(status_code=409, detail="Setup already in progress")

    micromamba = _find_micromamba()
    uv = _find_uv()
    if not micromamba and not uv:
        raise HTTPException(status_code=400, detail="Micromamba runtime is unavailable")

    # Acquire before returning the streaming response so two requests cannot both
    # pass the locked() check while waiting for their generators to be consumed.
    await _setup_lock.acquire()

    async def event_stream():
        try:
            venv = _workspace_venv(ws)
            yield f"data: {_sse_msg(text='Creating application Jupyter runtime...')}\n\n"
            if micromamba:
                result = await asyncio.to_thread(
                    subprocess.run,
                    [micromamba, "create", "--yes", "--prefix", str(venv), "--channel", "conda-forge", "--strict-channel-priority", "python=3.12", *JUPYTER_PACKAGES],
                    capture_output=True,
                    text=True,
                    timeout=900,
                )
                if result.returncode != 0:
                    yield f"data: {_sse_msg('error', result.stderr[-200:])}\n\n"
                    return
            else:
                if not _env_python(ws).exists():
                    result = await asyncio.to_thread(subprocess.run, [uv, "venv", str(venv), "--python", "3.12"], capture_output=True, text=True, timeout=120)
                    if result.returncode != 0:
                        yield f"data: {_sse_msg('error', result.stderr[-200:])}\n\n"
                        return
                for pkg in JUPYTER_PACKAGES:
                    yield f"data: {_sse_msg(text=f'Installing {pkg}...')}\n\n"
                    result = await asyncio.to_thread(subprocess.run, [uv, "pip", "install", pkg, "--python", str(_env_python(ws))], capture_output=True, text=True, timeout=300)
                    if result.returncode != 0:
                        yield f"data: {_sse_msg('error', result.stderr[-200:])}\n\n"
                        return

            yield f"data: {_sse_msg('done', 'Jupyter environment ready')}\n\n"
        finally:
            _setup_lock.release()

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
    ws = _workspace_dir(cwd) if cwd is not None else None
    payload["env_ready"] = _jupyter_bin(ws).exists() if ws is not None else False
    payload["matches_workspace"] = (
        not payload["running"]
        or ws is None
        or payload["cwd"] == str(ws)
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
            jupyter_bin = _jupyter_bin(ws)
            if not jupyter_bin.exists():
                raise HTTPException(
                    status_code=400,
                    detail="The application Jupyter runtime is not installed",
                )
            _install_project_kernelspec(ws)
            _jupyter_port = _find_available_port()
            _jupyter_cwd = str(ws)
            # Random token keeps Jupyter auth on: an unauthenticated server on
            # 127.0.0.1 is still reachable by any local process or a DNS-rebound
            # browser page, and Jupyter is an arbitrary-code-execution surface.
            _jupyter_token = secrets.token_hex(24)
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
