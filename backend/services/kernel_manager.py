"""Python/R kernel manager — spawns persistent subprocesses per notebook.

Protocol: JSONL over stdin/stdout (see kernel_bridge.py). Each notebook_id
gets its own isolated kernel process with independent namespace.
"""

import asyncio
import json
import os
import subprocess
import sys
import hashlib
import shutil
import signal
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from models import CellResult

KERNEL_BRIDGE_DIR = Path(__file__).parent


def workspace_npm_bin(npm_prefix: Path, platform_name: str = os.name) -> Path:
    """Return npm's global executable directory for the current platform."""
    return npm_prefix if platform_name == "nt" else npm_prefix / "bin"


@dataclass
class KernelSession:
    """A persistent Python or R kernel process."""
    process: subprocess.Popen
    language: str  # "python" or "r"
    notebook_id: str
    cwd: str
    session_id: Optional[str] = None
    environment_revision_id: Optional[str] = None
    kernel_instance_id: Optional[str] = None
    overlay_dir: Optional[str] = None
    stderr_tail: list[str] = field(default_factory=list)
    pending: dict = field(default_factory=dict)
    _execution_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    async def execute(self, code: str, on_event=None) -> CellResult:
        """Execute code in the kernel and return the result."""
        async with self._execution_lock:
            if not self.is_alive:
                return CellResult(ok=False, error="Kernel process died")

            # Keep the full UUID; short IDs make concurrent kernel requests
            # unnecessarily vulnerable to collisions over long-lived sessions.
            req_id = uuid.uuid4().hex
            req = json.dumps({"id": req_id, "code": code}) + "\n"
            loop = asyncio.get_running_loop()

            def _write_and_read():
                try:
                    self.process.stdin.write(req)
                    self.process.stdin.flush()
                    while True:
                        line = self.process.stdout.readline()
                        if not line:
                            return {
                                "id": req_id,
                                "ok": False,
                                "stdout": "",
                                "result": None,
                                "error": "Kernel process died",
                            }
                        message = json.loads(line)
                        if message.get("id") != req_id:
                            continue
                        if message.get("type") == "stream":
                            if on_event is not None:
                                on_event({"type": "stream", "stream": message.get("stream", "stdout"), "text": message.get("text", "")})
                            continue
                        return message
                except (BrokenPipeError, OSError, json.JSONDecodeError) as exc:
                    return {
                        "id": req_id,
                        "ok": False,
                        "stdout": "",
                        "result": None,
                        "error": f"Kernel communication failed: {exc}",
                    }

            resp = await loop.run_in_executor(None, _write_and_read)
            return CellResult(
                ok=resp.get("ok", False),
                stdout=resp.get("stdout", ""),
                result=resp.get("result"),
                error=resp.get("error"),
                interrupted=resp.get("interrupted", False),
                mime=resp.get("mime") or {},
            )

    @property
    def is_alive(self) -> bool:
        return self.process.poll() is None

    def shutdown(self):
        if self.is_alive:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()

    def interrupt(self) -> bool:
        if not self.is_alive:
            return False
        try:
            if os.name == "nt":
                self.process.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                self.process.send_signal(signal.SIGINT)
            return True
        except (OSError, ValueError):
            return False


class KernelManager:
    """Manages isolated kernel sessions per workspace/notebook/language."""

    def __init__(self):
        self._sessions: dict[tuple[str, str, str, str], KernelSession] = {}
        self._session_locks: dict[tuple[str, str, str, str], asyncio.Lock] = {}
        self._python_path: Optional[str] = None
        self._r_path: Optional[str] = None

    @staticmethod
    def _key(identity: str, revision_or_language: str, language_or_cwd: str, cwd: Optional[str] = None) -> tuple[str, str, str, str]:
        if cwd is None:
            environment_revision_id, language, target_cwd = "legacy", revision_or_language, language_or_cwd
        else:
            environment_revision_id, language, target_cwd = revision_or_language, language_or_cwd, cwd
        return (str(Path(target_cwd).resolve()), identity, environment_revision_id, language)

    async def discover_interpreters(self) -> dict[str, Optional[str]]:
        """Find available Python and R interpreters."""
        if not self._python_path:
            self._python_path = self._find("python3") or self._find("python")
        if not self._r_path:
            self._r_path = self._find("Rscript")
        return {"python": self._python_path, "r": self._r_path}

    @staticmethod
    def _find(name: str) -> Optional[str]:
        """Find an executable. Uses the current Python interpreter for python3
        so that conda/virtual environments are picked up correctly."""
        import shutil
        if name in ("python3", "python"):
            # Use the same Python that runs this backend (respects conda envs)
            return sys.executable
        return shutil.which(name)

    async def get_or_create(
        self, notebook_id: str, language: str, cwd: str = ".", *,
        session_id: Optional[str] = None, environment_revision_id: Optional[str] = None,
        environment_prefix: Optional[str] = None, kernel_instance_id: Optional[str] = None,
    ) -> KernelSession:
        """Get existing kernel session or create a new one."""
        cwd = str(Path(cwd).resolve())
        identity = kernel_instance_id or session_id or notebook_id
        revision = environment_revision_id or "legacy"
        key = self._key(identity, revision, language, cwd)
        lock = self._session_locks.setdefault(key, asyncio.Lock())
        async with lock:
            session = self._sessions.get(key)
            if session is not None and session.is_alive:
                return session
            if session is not None:
                session.shutdown()
                self._sessions.pop(key, None)

            if session_id is None and environment_revision_id is None and environment_prefix is None and kernel_instance_id is None:
                # Preserve the legacy call shape for adapters and tests that
                # override _spawn while the environment-aware API rolls out.
                session = await self._spawn(notebook_id, language, cwd=cwd)
            else:
                session = await self._spawn(
                    notebook_id, language, cwd=cwd, session_id=session_id,
                    environment_revision_id=environment_revision_id,
                    environment_prefix=environment_prefix, kernel_instance_id=identity,
                )
            self._sessions[key] = session
            return session

    async def _spawn(
        self, notebook_id: str, language: str, cwd: str = ".", *,
        session_id: Optional[str] = None, environment_revision_id: Optional[str] = None,
        environment_prefix: Optional[str] = None, kernel_instance_id: Optional[str] = None,
    ) -> KernelSession:
        """Spawn a new kernel subprocess."""
        process_env = os.environ.copy()
        overlay_dir: Optional[Path] = None
        if language == "python":
            script = KERNEL_BRIDGE_DIR / "kernel_bridge.py"
            selected_prefix = Path(environment_prefix).resolve() if environment_prefix else Path(cwd) / ".venv"
            base_bin = selected_prefix / ("Scripts" if os.name == "nt" else "bin")
            base_python = base_bin / ("python.exe" if os.name == "nt" else "python")
            if base_python.is_file() and environment_revision_id:
                digest = hashlib.sha256(f"{cwd}\0{kernel_instance_id}\0{environment_revision_id}".encode()).hexdigest()[:20]
                overlay_dir = Path(cwd) / ".pi-science" / "runtime" / "kernels" / digest / ".venv"
                await asyncio.to_thread(shutil.rmtree, overlay_dir, True)
                overlay_dir.parent.mkdir(parents=True, exist_ok=True)
                result = await asyncio.to_thread(
                    subprocess.run,
                    [str(base_python), "-m", "venv", "--system-site-packages", str(overlay_dir)],
                    capture_output=True, text=True, timeout=120,
                )
                if result.returncode != 0:
                    raise RuntimeError(f"Kernel overlay creation failed: {result.stderr or result.stdout}")
                venv_dir = overlay_dir
            else:
                venv_dir = selected_prefix
            venv_bin = venv_dir / ("Scripts" if os.name == "nt" else "bin")
            workspace_python = venv_bin / ("python.exe" if os.name == "nt" else "python")
            if workspace_python.is_file():
                exe = str(workspace_python)
                npm_prefix = Path(cwd) / ".pi-science" / "npm-global"
                npm_cache = Path(cwd) / ".pi-science" / "cache" / "npm"
                pnpm_home = Path(cwd) / ".pi-science" / "pnpm-global"
                npm_bin = workspace_npm_bin(npm_prefix)
                process_env.update({
                    "VIRTUAL_ENV": str(venv_dir),
                    "PATH": os.pathsep.join([str(venv_bin), str(npm_bin), str(pnpm_home), process_env.get("PATH", "")]),
                    "PYTHONNOUSERSITE": "1",
                    "PIP_REQUIRE_VIRTUALENV": "1",
                    "PIP_USER": "0",
                    "UV_PROJECT_ENVIRONMENT": str(venv_dir),
                    "npm_config_prefix": str(npm_prefix),
                    "NPM_CONFIG_PREFIX": str(npm_prefix),
                    "npm_config_cache": str(npm_cache),
                    "NPM_CONFIG_CACHE": str(npm_cache),
                    "PNPM_HOME": str(pnpm_home),
                })
                process_env.pop("PYTHONHOME", None)
                process_env.pop("PIP_PREFIX", None)
            else:
                exe = self._python_path or sys.executable
        elif language == "r":
            script = KERNEL_BRIDGE_DIR / "kernel_bridge.R"
            environment_r = Path(environment_prefix or "") / ("Scripts" if os.name == "nt" else "bin") / ("Rscript.exe" if os.name == "nt" else "Rscript")
            exe = str(environment_r) if environment_prefix and environment_r.is_file() else self._r_path or "Rscript"
        else:
            raise ValueError(f"Unsupported language: {language}")

        if not os.path.exists(script):
            raise FileNotFoundError(f"Kernel bridge script not found: {script}")

        process = subprocess.Popen(
            [exe, str(script)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=cwd,  # Set CWD to workspace so relative paths work
            env=process_env,
        )

        session = KernelSession(
            process=process,
            language=language,
            notebook_id=notebook_id,
            cwd=str(Path(cwd).resolve()),
            session_id=session_id,
            environment_revision_id=environment_revision_id,
            kernel_instance_id=kernel_instance_id,
            overlay_dir=str(overlay_dir) if overlay_dir else None,
        )

        def _drain_stderr():
            if process.stderr is None:
                return
            for line in process.stderr:
                session.stderr_tail.append(line.rstrip())
                del session.stderr_tail[:-50]

        threading.Thread(target=_drain_stderr, daemon=True).start()

        # Quick health check
        result = await session.execute("1+1")
        if not result.ok:
            session.shutdown()
            raise RuntimeError(f"Kernel health check failed: {result.error}")

        return session

    async def execute(
        self,
        notebook_id: str,
        language: str,
        code: str,
        cwd: str = ".",
        session_id: Optional[str] = None,
        environment_revision_id: Optional[str] = None,
        environment_prefix: Optional[str] = None,
        kernel_instance_id: Optional[str] = None,
        timeout_seconds: float = 120,
        on_event=None,
    ) -> CellResult:
        """Execute code in a kernel session."""
        resolved_cwd = str(Path(cwd).resolve())
        identity = kernel_instance_id or session_id or notebook_id
        key = self._key(identity, environment_revision_id or "legacy", language, resolved_cwd)
        session = await self.get_or_create(
            notebook_id, language, cwd=resolved_cwd, session_id=session_id,
            environment_revision_id=environment_revision_id,
            environment_prefix=environment_prefix, kernel_instance_id=kernel_instance_id,
        )
        execution = asyncio.create_task(session.execute(code) if on_event is None else session.execute(code, on_event=on_event))
        try:
            return await asyncio.wait_for(asyncio.shield(execution), timeout=timeout_seconds)
        except TimeoutError:
            interrupt = getattr(session, "interrupt", None)
            interrupted = bool(interrupt()) if callable(interrupt) else False
            if interrupted:
                try:
                    # Let the bridge consume SIGINT and finish its JSONL reply;
                    # this preserves the namespace and prevents a stale reader
                    # from racing the next request.
                    await asyncio.wait_for(asyncio.shield(execution), timeout=3)
                except (TimeoutError, asyncio.CancelledError):
                    interrupted = False
            if not interrupted:
                execution.cancel()
                await asyncio.to_thread(session.shutdown)
                if self._sessions.get(key) is session:
                    self._sessions.pop(key, None)
                    self._session_locks.pop(key, None)
            return CellResult(
                ok=False,
                error=(f"Cell execution timed out after {timeout_seconds:g} seconds; kernel was interrupted"
                       if interrupted else f"Cell execution timed out after {timeout_seconds:g} seconds; kernel will restart on next run"),
            )

    async def shutdown_notebook(
        self,
        notebook_id: str,
        *,
        cwd: Optional[str] = None,
        language: Optional[str] = None,
    ):
        """Shut down matching kernels without affecting another workspace."""
        resolved_cwd = str(Path(cwd).resolve()) if cwd is not None else None
        keys = [key for key, session in self._sessions.items()
                if (session.notebook_id == notebook_id or session.kernel_instance_id == notebook_id)
                and (resolved_cwd is None or session.cwd == resolved_cwd)
                and (language is None or session.language == language)]
        for key in keys:
            session = self._sessions.pop(key, None)
            if session:
                session.shutdown()
            self._session_locks.pop(key, None)

    async def interrupt_notebook(self, notebook_id: str, *, cwd: str, language: Optional[str] = None) -> bool:
        resolved_cwd = str(Path(cwd).resolve())
        return any(session.interrupt() for session in self._sessions.values()
                   if (session.notebook_id == notebook_id or session.kernel_instance_id == notebook_id)
                   and session.cwd == resolved_cwd and (language is None or session.language == language))

    async def shutdown_all(self):
        """Shut down all kernel sessions."""
        for session in list(self._sessions.values()):
            session.shutdown()
        self._sessions.clear()
        self._session_locks.clear()

    @property
    def active_count(self) -> int:
        return sum(1 for s in self._sessions.values() if s.is_alive)

    def list_sessions(self) -> list[dict]:
        """List active kernel sessions."""
        return [
            {
                "notebook_id": s.notebook_id,
                "language": s.language,
                "cwd": s.cwd,
                "session_id": s.session_id,
                "environment_revision_id": s.environment_revision_id,
                "kernel_instance_id": s.kernel_instance_id,
                "alive": s.is_alive,
            }
            for s in self._sessions.values()
        ]


# Singleton
kernel_manager = KernelManager()
