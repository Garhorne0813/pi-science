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

    async def execute(self, code: str) -> CellResult:
        """Execute code in the kernel and return the result."""
        req_id = uuid.uuid4().hex[:8]
        req = json.dumps({"id": req_id, "code": code}) + "\n"

        loop = asyncio.get_event_loop()

        def _write_and_read():
            self.process.stdin.write(req)
            self.process.stdin.flush()
            line = self.process.stdout.readline()
            if not line:
                return {"id": req_id, "ok": False, "stdout": "", "result": None, "error": "Kernel process died"}
            return json.loads(line)

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
    """Manages multiple kernel sessions, one per notebook_id."""

    def __init__(self):
        self._sessions: dict[str, KernelSession] = {}
        self._python_path: Optional[str] = None
        self._r_path: Optional[str] = None

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
        if notebook_id in self._sessions:
            session = self._sessions[notebook_id]
            if session.is_alive and session.cwd == cwd and session.language == language:
                return session
            # Do not reuse a notebook ID across workspaces or languages.
            session.shutdown()
            del self._sessions[notebook_id]

        session = await self._spawn(notebook_id, language, cwd=cwd)
        self._sessions[notebook_id] = session
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

    async def execute(self, notebook_id: str, language: str, code: str, cwd: str = ".") -> CellResult:
        """Execute code in a kernel session."""
        session = await self.get_or_create(notebook_id, language, cwd=cwd)
        return await session.execute(code)

    async def shutdown_notebook(self, notebook_id: str):
        """Shut down a specific notebook's kernel."""
        session = self._sessions.pop(notebook_id, None)
        if session:
            session.shutdown()

    async def shutdown_all(self):
        """Shut down all kernel sessions."""
        for session in list(self._sessions.values()):
            session.shutdown()
        self._sessions.clear()

    @property
    def active_count(self) -> int:
        return sum(1 for s in self._sessions.values() if s.is_alive)

    def list_sessions(self) -> list[dict]:
        """List active kernel sessions."""
        return [
            {"notebook_id": nid, "language": s.language, "cwd": s.cwd, "alive": s.is_alive}
            for nid, s in self._sessions.items()
        ]


# Singleton
kernel_manager = KernelManager()
