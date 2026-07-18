"""Python/R kernel manager — spawns persistent subprocesses per notebook.

Protocol: JSONL over stdin/stdout (see kernel_bridge.py). Each notebook_id
gets its own isolated kernel process with independent namespace.
"""

import asyncio
import json
import os
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

KERNEL_BRIDGE_DIR = Path(__file__).parent


@dataclass
class CellResult:
    ok: bool
    stdout: str = ""
    result: Optional[str] = None
    error: Optional[str] = None


@dataclass
class KernelSession:
    """A persistent Python or R kernel process."""
    process: subprocess.Popen
    language: str  # "python" or "r"
    notebook_id: str
    cwd: str
    pending: dict = field(default_factory=dict)
    _execution_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    async def execute(self, code: str) -> CellResult:
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
                    line = self.process.stdout.readline()
                    if not line:
                        return {
                            "id": req_id,
                            "ok": False,
                            "stdout": "",
                            "result": None,
                            "error": "Kernel process died",
                        }
                    return json.loads(line)
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


class KernelManager:
    """Manages isolated kernel sessions per workspace/notebook/language."""

    def __init__(self):
        self._sessions: dict[tuple[str, str, str], KernelSession] = {}
        self._session_locks: dict[tuple[str, str, str], asyncio.Lock] = {}
        self._python_path: Optional[str] = None
        self._r_path: Optional[str] = None

    @staticmethod
    def _key(notebook_id: str, language: str, cwd: str) -> tuple[str, str, str]:
        return (str(Path(cwd).resolve()), notebook_id, language)

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
        import sys
        if name in ("python3", "python"):
            # Use the same Python that runs this backend (respects conda envs)
            return sys.executable
        return shutil.which(name)

    async def get_or_create(self, notebook_id: str, language: str, cwd: str = ".") -> KernelSession:
        """Get existing kernel session or create a new one."""
        cwd = str(Path(cwd).resolve())
        key = self._key(notebook_id, language, cwd)
        lock = self._session_locks.setdefault(key, asyncio.Lock())
        async with lock:
            session = self._sessions.get(key)
            if session is not None and session.is_alive:
                return session
            if session is not None:
                session.shutdown()
                self._sessions.pop(key, None)

            session = await self._spawn(notebook_id, language, cwd=cwd)
            self._sessions[key] = session
            return session

    async def _spawn(self, notebook_id: str, language: str, cwd: str = ".") -> KernelSession:
        """Spawn a new kernel subprocess."""
        if language == "python":
            script = KERNEL_BRIDGE_DIR / "kernel_bridge.py"
            exe = self._python_path or "python3"
        elif language == "r":
            script = KERNEL_BRIDGE_DIR / "kernel_bridge.R"
            exe = self._r_path or "Rscript"
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
        )

        session = KernelSession(
            process=process,
            language=language,
            notebook_id=notebook_id,
            cwd=str(Path(cwd).resolve()),
        )

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
        timeout_seconds: float = 120,
    ) -> CellResult:
        """Execute code in a kernel session."""
        resolved_cwd = str(Path(cwd).resolve())
        key = self._key(notebook_id, language, resolved_cwd)
        session = await self.get_or_create(notebook_id, language, cwd=resolved_cwd)
        try:
            return await asyncio.wait_for(session.execute(code), timeout=timeout_seconds)
        except TimeoutError:
            await asyncio.to_thread(session.shutdown)
            if self._sessions.get(key) is session:
                self._sessions.pop(key, None)
                self._session_locks.pop(key, None)
            return CellResult(
                ok=False,
                error=f"Cell execution timed out after {timeout_seconds:g} seconds; kernel will restart on next run",
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
        keys = [
            key
            for key in self._sessions
            if key[1] == notebook_id
            and (resolved_cwd is None or key[0] == resolved_cwd)
            and (language is None or key[2] == language)
        ]
        for key in keys:
            session = self._sessions.pop(key, None)
            if session:
                session.shutdown()
            self._session_locks.pop(key, None)

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
                "alive": s.is_alive,
            }
            for s in self._sessions.values()
        ]


# Singleton
kernel_manager = KernelManager()
