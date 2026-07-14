"""Pi RPC subprocess manager — the core service bridging pi's JSONL RPC to HTTP+SSE."""

import asyncio
import json
import os
import signal
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator, Optional

from config import (
    PI_CLI_PATH,
    PI_NODE_PATH,
    PI_DEFAULT_MODEL,
    PI_DEFAULT_THINKING,
    PI_MODE,
    PI_TSX_PATH,
    PI_TSCONFIG_PATH,
)
from models import PiConfig


class PiProcess:
    """Manages a single pi RPC subprocess instance.

    Each PiProcess corresponds to one working directory (cwd).
    Communication is via JSONL over stdin/stdout.
    """

    def __init__(
        self,
        process: subprocess.Popen,
        cwd: str,
        session_id: str,
        config: PiConfig,
        session_dir: str = "",
    ):
        self.process = process
        self.cwd = cwd
        self.session_id = session_id
        self.config = config
        self.session_dir = session_dir
        self._pgid = process.pid  # process group leader (start_new_session=True)
        self.pending_requests: dict[str, asyncio.Future] = {}
        self._event_queue: asyncio.Queue = asyncio.Queue()
        self._reader_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._started_at = datetime.now(timezone.utc)
        self._last_activity = datetime.now(timezone.utc)

    @classmethod
    async def spawn(cls, cwd: str, session_dir: str, config: PiConfig) -> "PiProcess":
        """Spawn a new pi RPC subprocess.

        Args:
            cwd: Working directory for the pi process (project directory).
            session_dir: Directory for pi to store session JSONL files.
            config: Model, provider, API key, skills, extensions config.
        """
        # Override model from config.json if not explicitly set in request
        effective_model = config.model
        if config.model == PI_DEFAULT_MODEL:
            try:
                from api.settings import _load_config
                cfg = _load_config()
                if cfg.get("model"):
                    effective_model = cfg["model"]
            except Exception:
                pass

        # Dev mode: tsx + TypeScript source (no build needed)
        # Prod mode: node + built JS
        if PI_MODE == "dev" and PI_TSX_PATH:
            args = [
                PI_NODE_PATH,
                PI_TSX_PATH,
                "--tsconfig", PI_TSCONFIG_PATH,
                PI_CLI_PATH,
                "--mode", "rpc",
            ]
        else:
            args = [
                PI_NODE_PATH,
                PI_CLI_PATH,
                "--mode", "rpc",
            ]

        thinking = config.thinking or PI_DEFAULT_THINKING

        # Load MCP adapter, subagent, and context-mode extensions
        if PI_MODE == "dev":
            ext_base = Path(PI_CLI_PATH).parent.parent.parent.parent  # pi repo root
        else:
            ext_base = Path(PI_CLI_PATH).parent  # runtime dir
        mcp_ext = ext_base / "node_modules" / "pi-mcp-adapter" / "index.ts"
        sub_ext = ext_base / "node_modules" / "pi-subagents" / "src" / "extension" / "index.ts"
        # context-mode: sandboxed execution + FTS5 knowledge index for long sessions
        ctx_ext = ext_base / "node_modules" / "context-mode" / "build" / "adapters" / "pi" / "extension.js"
        ctx_skills = ext_base / "node_modules" / "context-mode" / "skills"

        args.extend([
            "--model", effective_model,
            "--thinking", thinking,
            "--session-dir", session_dir,
            "--no-extensions",
            "--no-skills",
        ])

        if mcp_ext.exists():
            args.extend(["-e", str(mcp_ext)])
        if sub_ext.exists():
            args.extend(["-e", str(sub_ext)])
        # context-mode: sandbox code execution + session continuity via FTS5
        if ctx_ext.exists():
            args.extend(["-e", str(ctx_ext)])
        if ctx_skills.exists():
            args.extend(["--skill", str(ctx_skills)])

        # Add explicitly configured skills
        for skill_path in config.skills:
            args.extend(["--skill", skill_path])

        # Add explicitly configured extensions
        for ext_path in config.extensions:
            args.extend(["-e", ext_path])

        # Set up environment with API keys from config + env vars
        from api.settings import get_env_with_keys
        env = get_env_with_keys()

        # context-mode: store its SQLite/FTS5 database inside pi-science data dir
        from config import BASE_DIR
        env["CONTEXT_MODE_DIR"] = str(BASE_DIR / "context-mode")

        if config.provider:
            env["PI_DEFAULT_PROVIDER"] = config.provider

        # Pi also supports --api-key flag for runtime override
        if config.api_key:
            args.extend(["--api-key", config.api_key])

        process = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            env=env,
            text=True,
            bufsize=1,  # Line buffered
            start_new_session=True,  # Isolate in own process group — killpg on shutdown
        )

        instance = cls(process, cwd, session_id="", config=config, session_dir=session_dir)
        # Update model to the effective one used
        instance.config.model = effective_model

        # Start stdout + stderr readers (stderr MUST be drained to avoid deadlock)
        instance._reader_task = asyncio.create_task(instance._read_stdout())
        instance._stderr_task = asyncio.create_task(instance._read_stderr())

        # Get initial state to retrieve session ID
        state = await instance.send_command("get_state")
        if state.get("success") and state.get("data"):
            instance.session_id = state["data"].get("sessionId", "")

        # Write PID file so stale process detection works across restarts
        pid_file = Path(session_dir) / ".pi-pid"
        pid_file.write_text(str(process.pid))

        return instance

    async def _read_stdout(self):
        """Background task: read JSONL lines from stdout and dispatch."""
        loop = asyncio.get_event_loop()

        def read_lines():
            """Synchronous line reader running in executor."""
            for line in self.process.stdout:
                line = line.rstrip("\n").rstrip("\r")
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    # Put on queue for async dispatch
                    asyncio.run_coroutine_threadsafe(
                        self._dispatch(data), loop
                    )
                except json.JSONDecodeError:
                    # Log and skip malformed lines
                    print(f"[pi-manager] malformed JSONL line: {line[:200]}")

        # Run blocking reader in default executor
        await loop.run_in_executor(None, read_lines)

    async def _read_stderr(self):
        """Background task: drain stderr to prevent pipe buffer deadlock.
        If stderr fills up (>64KB OS pipe buffer), the pi process blocks on
        stderr write and never produces more stdout. We drain it continuously."""
        loop = asyncio.get_event_loop()

        def drain():
            for line in self.process.stderr:
                print(f"[pi-manager:stderr] {line.rstrip()}")

        try:
            await loop.run_in_executor(None, drain)
        except Exception:
            pass  # Process already exited, pipe closed

    async def _dispatch(self, data: dict):
        """Route stdout data to either pending request future or event queue."""
        self._last_activity = datetime.now(timezone.utc)
        msg_type = data.get("type")

        if msg_type == "response":
            req_id = data.get("id")
            if req_id and req_id in self.pending_requests:
                future = self.pending_requests.pop(req_id)
                if not future.done():
                    future.set_result(data)
                return
            # Response without matching request -> treat as event
            await self._event_queue.put(data)

        elif msg_type == "extension_ui_request":
            # Extension requests user interaction - forward as event
            # The frontend will respond via extension_ui_response
            await self._event_queue.put(data)

        elif msg_type == "extension_error":
            print(f"[pi-manager] extension error: {data}")
            await self._event_queue.put(data)

        else:
            # Agent lifecycle event (message_start, tool_execution_start, etc.)
            await self._event_queue.put(data)

    async def send_command(self, cmd_type: str, **params) -> dict:
        """Send an RPC command and await the response.

        Special handling for new_session: updates the session map."""
        result = await self._send_command_internal(cmd_type, **params)
        if cmd_type == "new_session" and result.get("success"):
            # pi created a new session — update our tracking
            old_id = self.session_id
            new_state = await self._send_command_internal("get_state")
            if new_state.get("success") and new_state.get("data"):
                self.session_id = new_state["data"].get("sessionId", self.session_id)
                # Update the session map
                from .pi_manager import pi_manager
                pi_manager._session_map.pop(old_id, None)
                pi_manager._session_map[self.session_id] = self.cwd
        return result

    async def _send_command_internal(self, cmd_type: str, **params) -> dict:
        """Internal: send an RPC command and await the response."""
        req_id = str(uuid.uuid4())[:8]
        cmd = {"id": req_id, "type": cmd_type, **params}
        line = json.dumps(cmd, ensure_ascii=False) + "\n"

        future = asyncio.Future()
        self.pending_requests[req_id] = future

        # Write to stdin (run in executor to avoid blocking)
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._write_stdin, line)

        try:
            result = await asyncio.wait_for(future, timeout=30.0)
            return result
        except asyncio.TimeoutError:
            self.pending_requests.pop(req_id, None)
            return {"success": False, "error": "request timeout after 30s"}
        except Exception as e:
            self.pending_requests.pop(req_id, None)
            return {"success": False, "error": str(e)}

    def _write_stdin(self, line: str):
        """Write a line to stdin. Called from executor thread."""
        try:
            self.process.stdin.write(line)
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            print(f"[pi-manager] stdin write failed: {e}")

    async def read_events(self) -> AsyncIterator[dict]:
        """Async generator yielding AgentSessionEvent dicts from the event queue."""
        while True:
            try:
                # Check if process is still alive
                if self.process.poll() is not None:
                    # Process exited
                    exit_code = self.process.returncode
                    stderr_output = ""
                    try:
                        stderr_output = self.process.stderr.read()
                    except Exception:
                        pass
                    yield {
                        "type": "error",
                        "sessionId": self.session_id,
                        "message": f"pi process exited with code {exit_code}. stderr: {stderr_output[:500]}",
                    }
                    return

                # Wait for next event with timeout to check process liveness
                event = await asyncio.wait_for(self._event_queue.get(), timeout=1.0)
                yield event
            except asyncio.TimeoutError:
                # No event yet, continue checking
                continue
            except asyncio.CancelledError:
                return

    async def shutdown(self):
        """Gracefully shut down the pi process and its entire process group.

        Uses killpg to ensure all descendants (tsx, Node.js workers, MCP bridge,
        context-mode server) are terminated — like open-science's Tauri sidecar
        with parent_process_death_signal."""
        if self._reader_task:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass

        if self.process.poll() is None:
            try:
                # SIGTERM the entire process group first (graceful)
                os.killpg(self._pgid, signal.SIGTERM)
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    # Force kill if graceful shutdown fails
                    os.killpg(self._pgid, signal.SIGKILL)
                    self.process.wait()
            except (ProcessLookupError, OSError):
                # Process group already gone — just clean up the main process
                try:
                    self.process.kill()
                    self.process.wait()
                except OSError:
                    pass

        # Remove PID file
        try:
            pid_file = Path(self.session_dir) / ".pi-pid" if self.session_dir else None
            if pid_file and pid_file.exists():
                pid_file.unlink()
        except Exception:
            pass

        # Fail all pending requests
        for req_id, future in self.pending_requests.items():
            if not future.done():
                future.set_exception(ConnectionError("pi process shut down"))

    @property
    def is_alive(self) -> bool:
        return self.process.poll() is None


class PiManager:
    """Global manager for pi process instances.

    One PiProcess per working directory (cwd). Sessions within the same
    cwd share the same pi process, switching via switch_session RPC command.

    Idle processes (no activity for IDLE_TTL seconds) are automatically
    shut down to free memory and LLM connection slots.
    """

    IDLE_TTL = 30 * 60  # 30 minutes

    def __init__(self):
        self._processes: dict[str, PiProcess] = {}  # cwd -> PiProcess
        self._session_map: dict[str, str] = {}  # session_id -> cwd
        self._idle_task: Optional[asyncio.Task] = None
        self._spawn_locks: dict[str, asyncio.Lock] = {}  # per-cwd spawn mutex

    def _start_idle_check(self):
        """Start the idle cleanup background task (idempotent)."""
        if self._idle_task is None or self._idle_task.done():
            self._idle_task = asyncio.create_task(self._idle_cleanup_loop())

    async def _idle_cleanup_loop(self):
        """Periodically check for and shut down idle pi processes."""
        while True:
            try:
                await asyncio.sleep(5 * 60)  # Check every 5 minutes
                now = datetime.now(timezone.utc)
                for cwd in list(self._processes.keys()):
                    pi = self._processes.get(cwd)
                    if pi and pi.is_alive:
                        idle_seconds = (now - pi._last_activity).total_seconds()
                        if idle_seconds > self.IDLE_TTL:
                            print(f"[pi-manager] Shutting down idle pi process for {cwd} ({idle_seconds:.0f}s idle)")
                            await self._remove(cwd)
            except asyncio.CancelledError:
                return
            except Exception:
                pass  # Don't crash the cleanup loop

    async def get_or_spawn(
        self,
        cwd: str,
        session_dir: str,
        config: PiConfig,
    ) -> PiProcess:
        """Get existing PiProcess for cwd or spawn a new one.

        Uses a PID file in the session directory to detect and recover from
        stale pi processes left behind after a backend restart (e.g. uvicorn
        --reload clears the in-memory process dict but leaves OS processes).
        """
        cwd = str(Path(cwd).resolve())

        # Prevent concurrent spawns for the same cwd (race between connect() and sendPrompt())
        if cwd not in self._spawn_locks:
            self._spawn_locks[cwd] = asyncio.Lock()
        async with self._spawn_locks[cwd]:
            # Re-check after acquiring lock — another caller may have spawned already
            if cwd in self._processes:
                pi = self._processes[cwd]
                if pi.is_alive:
                    return pi
                else:
                    await self._remove(cwd)

            # Create session directory for this cwd
            encoded_cwd = cwd.lstrip("/").replace("/", "-")
            cwd_session_dir = str(Path(session_dir) / encoded_cwd)
            os.makedirs(cwd_session_dir, exist_ok=True)

            # ── Detect & recover from stale pi processes ──
            pid_file = Path(cwd_session_dir) / ".pi-pid"
            if pid_file.exists():
                try:
                    old_pid = int(pid_file.read_text().strip())
                    try:
                        os.kill(old_pid, 0)
                        print(f"[pi-manager] Killing stale pi process (pid={old_pid}) for {cwd}")
                        os.kill(old_pid, 9)
                    except OSError:
                        pass
                except (ValueError, FileNotFoundError):
                    pass
                try:
                    pid_file.unlink()
                except OSError:
                    pass

            pi = await PiProcess.spawn(cwd, cwd_session_dir, config)
            self._processes[cwd] = pi
            self._session_map[pi.session_id] = cwd
            self._start_idle_check()
            return pi

    def get_by_session(self, session_id: str) -> Optional[PiProcess]:
        """Get PiProcess by session ID."""
        cwd = self._session_map.get(session_id)
        if cwd:
            return self._processes.get(cwd)
        return None

    def get_by_cwd(self, cwd: str) -> Optional[PiProcess]:
        """Get PiProcess by working directory."""
        cwd = str(Path(cwd).resolve())
        return self._processes.get(cwd)

    async def _remove(self, cwd: str):
        """Remove and shut down a pi process."""
        pi = self._processes.pop(cwd, None)
        if pi:
            self._session_map.pop(pi.session_id, None)
            await pi.shutdown()

    async def shutdown_all(self):
        """Shut down all managed pi processes."""
        for cwd in list(self._processes.keys()):
            await self._remove(cwd)

    @property
    def active_count(self) -> int:
        return sum(1 for p in self._processes.values() if p.is_alive)


# Singleton
pi_manager = PiManager()
