"""Pi RPC subprocess manager — the core service bridging pi's JSONL RPC to HTTP+SSE."""

import asyncio
import json
import os
import signal
import subprocess
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator, Callable, Optional

from config import (
    PI_DEFAULT_MODEL,
    PI_DEFAULT_THINKING,
)
from models import PiConfig
from services.pi_event_observer import observe_event, record_skill_snapshot
from services.pi_runtime_config import build_runtime_launch, ensure_pi_subagent_wrapper
from services.event_normalizer import assistant_text_from_event


MAX_EVENT_STRING_CHARS = 20000
MAX_EVENT_COLLECTION_ITEMS = 100
PROMPT_START_RECONCILE_DELAY = 0.25


def _is_pi_process(pid: int) -> bool:
    """Avoid killing an unrelated process when recovering a stale PID file."""
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            command = result.stdout.strip().lower()
            return any(token in command for token in ("node", "pi", "tsx"))
    except (OSError, subprocess.SubprocessError):
        pass
    # If process inspection is unavailable, preserve the historical recovery
    # behavior rather than leaving a stale runtime orphaned.
    return True


def _model_has_credentials(model: Optional[str]) -> bool:
    """Return whether the configured environment can authenticate a model."""
    if not model or "/" not in model:
        return False
    provider = model.split("/", 1)[0]
    try:
        from services.model_registry import PROVIDER_ENV_MAP, custom_providers
        from services.settings_store import load_config

        env_name = PROVIDER_ENV_MAP.get(provider)
        if env_name and os.environ.get(env_name):
            return True
        config = load_config()
        stored_keys = config.get("api_keys", {})
        if env_name and stored_keys.get(provider):
            return True
        if provider.startswith("custom-"):
            custom_id = provider.removeprefix("custom-")
            return any(
                item.get("id") == custom_id and bool(item.get("api_key"))
                for item in custom_providers(config)
            )
    except Exception:
        # Credential detection is only a fallback guard. If settings cannot
        # be read, preserve the session's own model rather than changing it.
        return True
    return False


def _should_use_global_model(active_model: Optional[str], global_model: Optional[str]) -> bool:
    """Use the current global model only when the persisted one is unusable."""
    if not global_model or active_model == global_model:
        return False
    return not _model_has_credentials(active_model) and _model_has_credentials(global_model)


def _bounded_event_value(value, depth: int = 0):
    """Bound RPC event payloads before replay storage and SSE serialization."""
    if depth >= 6:
        return "[truncated]"
    if isinstance(value, str):
        if len(value) <= MAX_EVENT_STRING_CHARS:
            return value
        return value[:MAX_EVENT_STRING_CHARS] + "\n… [truncated]"
    if isinstance(value, dict):
        items = list(value.items())[:MAX_EVENT_COLLECTION_ITEMS]
        result = {str(key): _bounded_event_value(item, depth + 1) for key, item in items}
        if len(value) > len(items):
            result["_truncated"] = True
        return result
    if isinstance(value, (list, tuple)):
        items = list(value)[:MAX_EVENT_COLLECTION_ITEMS]
        result = [_bounded_event_value(item, depth + 1) for item in items]
        if len(value) > len(items):
            result.append("[truncated]")
        return result
    return value


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
        session_dir: Optional[str] = None,
    ):
        self.process = process
        self.cwd = cwd
        self.session_id = session_id
        self.config = config
        self.session_dir = session_dir
        self._pgid = getattr(process, "pid", None)
        self.pending_requests: dict[str, asyncio.Future] = {}
        # Events are partitioned by the session that was active when they were
        # emitted. A workspace process can switch sessions, so a single shared
        # broadcast queue would leak one conversation into another.
        self._event_history: dict[str, deque[tuple[int, dict]]] = {}
        self._event_subscribers: dict[str, set[asyncio.Queue]] = {}
        self._event_sequence: dict[str, int] = {}
        self._event_epoch = uuid.uuid4().hex[:12]
        self._event_lock = asyncio.Lock()
        self._reader_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._stderr_tail: deque[str] = deque(maxlen=200)
        self._stderr_buffer = ""
        self._last_activity = datetime.now(timezone.utc)
        self._started_at = datetime.now(timezone.utc)
        self._session_started_at = self._started_at
        self._shutting_down = False
        self.session_path: Optional[str] = None
        # A prompt RPC returns before the agent turn is complete. Keep a
        # separate turn-level flag so a second prompt cannot be appended while
        # tools/model synthesis are still running.
        self._busy = False
        self._awaiting_prompt_ack = False
        self._prompt_started = False
        self._prompt_reconcile_task: Optional[asyncio.Task] = None
        self._turn_had_text: dict[str, bool] = {}
        self._command_lock = asyncio.Lock()
        self._on_session_changed: Optional[Callable[[str, str, str], None]] = None

    @classmethod
    async def spawn(
        cls,
        cwd: str,
        session_dir: str,
        config: PiConfig,
        *,
        session_path: Optional[str] = None,
    ) -> "PiProcess":
        """Spawn a new pi RPC subprocess.

        Args:
            cwd: Working directory for the pi process (project directory).
            session_dir: Directory for pi to store session JSONL files.
            config: Model, provider, API key, skills, extensions config.
        """
        launch = build_runtime_launch(
            cwd,
            session_dir,
            config,
            session_path=session_path,
        )

        process = subprocess.Popen(
            launch.args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            env=launch.env,
            text=True,
            bufsize=1,  # Line buffered
            start_new_session=True,
        )

        # Record the PID so a restarted backend can reap an orphaned runtime.
        try:
            (Path(session_dir) / ".pi-pid").write_text(str(process.pid))
        except OSError:
            pass

        instance = cls(process, cwd, session_id="", config=config, session_dir=session_dir)
        # Store the effective runtime configuration, not the request defaults.
        instance.config.model = launch.model
        instance.config.thinking = launch.thinking

        # Start the stdout reader
        instance._reader_task = asyncio.create_task(instance._read_stdout())
        instance._stderr_task = asyncio.create_task(instance._read_stderr())

        try:
            # A failed startup handshake must not register a blank session or
            # leave an untracked subprocess behind.
            state = await instance.send_command("get_state")
            if not state.get("success") or not state.get("data"):
                raise RuntimeError(state.get("error", "pi runtime did not return its initial state"))
            instance._apply_state(state["data"])
            if not instance.session_id:
                raise RuntimeError("pi runtime returned an empty session ID")
            await instance._record_skill_snapshot()
            return instance
        except BaseException:
            await instance.shutdown()
            raise

    async def _read_stdout(self):
        """Background task: read JSONL lines from stdout and dispatch."""
        loop = asyncio.get_running_loop()

        def read_lines():
            """Synchronous line reader running in executor."""
            for line in self.process.stdout:
                line = line.rstrip("\n").rstrip("\r")
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    # Bind the line to the session active when stdout emitted
                    # it. Dispatch may run after a later session switch.
                    event_session_id = self.session_id
                    asyncio.run_coroutine_threadsafe(
                        self._dispatch(data, event_session_id), loop
                    )
                except json.JSONDecodeError:
                    # Log and skip malformed lines
                    print(f"[pi-manager] malformed JSONL line: {line[:200]}")

        # Run blocking reader in default executor
        await loop.run_in_executor(None, read_lines)
        if not self._shutting_down:
            self._busy = False
            self.process.poll()
            message = f"pi process exited with code {self.process.returncode}"
            if self._stderr_tail:
                message += f". stderr: {' '.join(self._stderr_tail)[:500]}"
            for req_id, future in list(self.pending_requests.items()):
                self.pending_requests.pop(req_id, None)
                if not future.done():
                    future.set_result({"success": False, "error": message})
            await self._publish_event(
                {"type": "error", "sessionId": self.session_id, "message": message},
                self.session_id,
            )

    async def _read_stderr(self):
        """Continuously drain stderr so the child process cannot deadlock."""
        loop = asyncio.get_running_loop()

        def read_lines():
            for line in self.process.stderr:
                value = line.rstrip("\n").rstrip("\r")
                if value:
                    self._stderr_tail.append(value)
                    self._stderr_buffer = (self._stderr_buffer + value + "\n")[-5000:]

        await loop.run_in_executor(None, read_lines)

    async def _dispatch(self, data: dict, event_session_id: Optional[str] = None):
        """Route stdout data to either pending request future or event queue."""
        self._last_activity = datetime.now(timezone.utc)
        msg_type = data.get("type")
        event_session_id = event_session_id or self.session_id

        if msg_type == "message_update" and event_session_id:
            if assistant_text_from_event(data).strip():
                self._turn_had_text[event_session_id] = True

        if msg_type == "agent_start":
            self._awaiting_prompt_ack = False
            self._prompt_started = True
            if self._prompt_reconcile_task and not self._prompt_reconcile_task.done():
                self._prompt_reconcile_task.cancel()

        # turn_end is emitted for each tool/assistant turn and agent_end may be
        # followed by retries or queued continuations. Only agent_settled means
        # the whole conversation request is truly finished.
        if msg_type in {"agent_settled", "error"}:
            self._awaiting_prompt_ack = False
            self._prompt_started = False
            self._busy = False
            if self._prompt_reconcile_task and not self._prompt_reconcile_task.done():
                self._prompt_reconcile_task.cancel()

        if msg_type == "response":
            req_id = data.get("id")
            if req_id and req_id in self.pending_requests:
                future = self.pending_requests.pop(req_id)
                if not future.done():
                    future.set_result(data)
                return
            # Response without matching request -> treat as event
            await self._publish_event(data, event_session_id)

        elif msg_type == "extension_ui_request":
            # Extension requests user interaction - forward as event
            # The frontend will respond via extension_ui_response
            await self._publish_event(data, event_session_id)

        elif msg_type == "extension_error":
            print(f"[pi-manager] extension error: {data}")
            await self._publish_event(data, event_session_id)

        else:
            # Agent lifecycle event (message_start, tool_execution_start, etc.)
            await self._publish_event(data, event_session_id)

        await self._observe_event(data, event_session_id)

    async def _publish_event(self, data: dict, session_id: Optional[str] = None):
        session_id = session_id or self.session_id
        if not session_id:
            return
        async with self._event_lock:
            sequence = self._event_sequence.get(session_id, 0) + 1
            self._event_sequence[session_id] = sequence
            payload = _bounded_event_value(data)
            payload["_piSessionId"] = session_id
            payload["_piSequence"] = sequence
            payload["_piEventId"] = f"{self._event_epoch}:{sequence}"
            if data.get("type") == "agent_settled":
                payload["_piTurnHadText"] = self._turn_had_text.get(session_id, False)
            history = self._event_history.setdefault(session_id, deque(maxlen=2000))
            history.append((sequence, payload))
            for queue in tuple(self._event_subscribers.get(session_id, set())):
                stream_gap = False
                if queue.full():
                    try:
                        queue.get_nowait()
                        stream_gap = True
                    except asyncio.QueueEmpty:
                        pass
                queued_payload = dict(payload)
                if stream_gap:
                    queued_payload["_piStreamGap"] = True
                queue.put_nowait((sequence, queued_payload))

    async def _begin_turn(self, session_id: str) -> None:
        """Discard the previous turn's replay window before accepting a prompt."""
        async with self._event_lock:
            self._event_history[session_id] = deque(maxlen=2000)
            self._turn_had_text[session_id] = False

    async def _observe_event(self, data: dict, session_id: str) -> None:
        await observe_event(
            cwd=self.cwd,
            session_path=self.session_path,
            model=self.config.model,
            event=data,
            session_id=session_id,
            publish_event=self._publish_event,
        )

    async def _publish_artifact_for_event(self, event: dict, session_id: str) -> None:
        from services.pi_event_observer import publish_artifact_for_event

        await publish_artifact_for_event(
            cwd=self.cwd,
            model=self.config.model,
            event=event,
            session_id=session_id,
            publish_event=self._publish_event,
        )

    async def _record_skill_snapshot(self) -> None:
        await record_skill_snapshot(self.cwd, self.session_id)

    def _record_provenance(self, event: dict, session_id: str) -> None:
        from services.pi_event_observer import record_provenance

        record_provenance(self.cwd, event, session_id)

    async def send_command(self, cmd_type: str, **params) -> dict:
        """Send an RPC command and await the response.

        Session-switching commands update the manager's session map after the
        runtime confirms the new state."""
        if cmd_type == "prompt":
            async with self._command_lock:
                if self._busy:
                    return {
                        "success": False,
                        "error": "agent is busy; wait for the current task to finish or stop it",
                        "code": "busy",
                    }
                try:
                    from services.reviewer_service import cancel_auto_review

                    cancel_auto_review(self.cwd, self.session_id)
                except Exception:
                    pass
                await self._begin_turn(self.session_id)
                self._awaiting_prompt_ack = True
                self._prompt_started = False
                self._busy = True
                result = await self._send_command_internal(cmd_type, **params)
                if result.get("success"):
                    self._awaiting_prompt_ack = False
                    self._schedule_prompt_start_reconciliation(self.session_id)
                elif result.get("code") != "timeout":
                    self._awaiting_prompt_ack = False
                    self._busy = False
                return result

        disruptive = {
            "new_session",
            "switch_session",
            "fork",
            "clone",
            "set_model",
            "set_thinking_level",
        }
        if cmd_type in disruptive:
            async with self._command_lock:
                if self._busy:
                    return {
                        "success": False,
                        "error": "agent is busy; wait for the current task to finish or stop it",
                        "code": "busy",
                    }
                old_id = self.session_id
                result = await self._send_command_internal(cmd_type, **params)
                if not result.get("success"):
                    return result
                if isinstance(result.get("data"), dict) and result["data"].get("cancelled"):
                    return {
                        "success": False,
                        "error": f"{cmd_type} was cancelled by the runtime",
                        "code": "cancelled",
                    }
                state = await self._send_command_internal("get_state")
                if not state.get("success") or not state.get("data"):
                    return {
                        "success": False,
                        "error": state.get("error", f"unable to confirm state after {cmd_type}"),
                    }
                self._apply_state(state["data"])
                if cmd_type in {"new_session", "fork", "clone"} and self.session_id == old_id:
                    return {
                        "success": False,
                        "error": f"{cmd_type} did not create a distinct session",
                    }
                if self._on_session_changed and self.session_id != old_id:
                    self._on_session_changed(old_id, self.session_id, self.cwd)
                return result

        if cmd_type == "abort":
            result = await self._send_command_internal(cmd_type, **params)
            if result.get("success"):
                self._awaiting_prompt_ack = False
                self._prompt_started = False
                await self.refresh_state()
            return result

        return await self._send_command_internal(cmd_type, **params)

    async def refresh_state(self) -> dict:
        result = await self._send_command_internal("get_state")
        if result.get("success") and result.get("data"):
            self._apply_state(result["data"])
        return result

    def _schedule_prompt_start_reconciliation(self, session_id: str) -> None:
        if self._prompt_reconcile_task and not self._prompt_reconcile_task.done():
            self._prompt_reconcile_task.cancel()
        self._prompt_reconcile_task = asyncio.create_task(
            self._reconcile_prompt_start(session_id)
        )

    async def _reconcile_prompt_start(self, session_id: str) -> None:
        """Release commands handled by extensions without starting an agent run."""
        try:
            await asyncio.sleep(PROMPT_START_RECONCILE_DELAY)
            async with self._command_lock:
                if (
                    not self._busy
                    or self._prompt_started
                    or self._awaiting_prompt_ack
                    or self.session_id != session_id
                ):
                    return
                state = await self._send_command_internal("get_state")
                if not state.get("success") or not state.get("data"):
                    return
                data = state["data"]
                runtime_busy = bool(
                    data.get("isStreaming")
                    or data.get("isCompacting")
                    or int(data.get("pendingMessageCount", 0) or 0) > 0
                )
                if runtime_busy or self._prompt_started:
                    self._apply_state(data)
                    return
                self._busy = False
                await self._publish_event(
                    {"type": "agent_settled", "handledWithoutTurn": True},
                    session_id,
                )
        except asyncio.CancelledError:
            return

    @staticmethod
    def resolve_config(config: PiConfig) -> tuple[str, str]:
        settings: dict = {}
        try:
            from services.settings_store import load_config

            settings = load_config()
        except Exception:
            pass
        model = config.model or settings.get("model") or PI_DEFAULT_MODEL
        thinking = config.thinking or settings.get("thinking") or PI_DEFAULT_THINKING
        return model, thinking

    async def apply_config(self, config: PiConfig) -> dict:
        """Apply the requested/global model and thinking to the active session."""
        model, thinking = self.resolve_config(config)
        if "/" not in model:
            return {"success": False, "error": "model must use provider/model notation"}
        if self.config.model != model:
            provider, model_id = model.split("/", 1)
            result = await self.send_command("set_model", provider=provider, modelId=model_id)
            if not result.get("success"):
                return result
        if self.config.thinking != thinking:
            result = await self.send_command("set_thinking_level", level=thinking)
            if not result.get("success"):
                return result
        return {"success": True, "model": model, "thinking": thinking}

    def _apply_state(self, state: dict) -> None:
        next_session_id = state.get("sessionId", self.session_id)
        if next_session_id and next_session_id != self.session_id:
            self._session_started_at = datetime.now(timezone.utc)
        self.session_id = next_session_id
        self.session_path = state.get("sessionFile", self.session_path)
        model = state.get("model") or {}
        provider = model.get("provider")
        model_id = model.get("id")
        if provider and model_id:
            self.config.model = f"{provider}/{model_id}"
        if state.get("thinkingLevel"):
            self.config.thinking = state["thinkingLevel"]
        self._busy = self._awaiting_prompt_ack or bool(
            state.get("isStreaming")
            or state.get("isCompacting")
            or int(state.get("pendingMessageCount", 0) or 0) > 0
        )

    async def send_notification(self, notification_type: str, **params) -> None:
        """Send a notification-style RPC message that has no response."""
        line = json.dumps({"type": notification_type, **params}, ensure_ascii=False) + "\n"
        await asyncio.get_running_loop().run_in_executor(None, self._write_stdin, line)

    async def _send_command_internal(self, cmd_type: str, **params) -> dict:
        """Internal: send an RPC command and await the response."""
        self._last_activity = datetime.now(timezone.utc)
        req_id = uuid.uuid4().hex
        cmd = {"id": req_id, "type": cmd_type, **params}
        line = json.dumps(cmd, ensure_ascii=False) + "\n"

        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self.pending_requests[req_id] = future

        # Write to stdin (run in executor to avoid blocking)
        try:
            await loop.run_in_executor(None, self._write_stdin, line)
        except Exception as exc:
            self.pending_requests.pop(req_id, None)
            return {"success": False, "error": str(exc)}

        try:
            result = await asyncio.wait_for(future, timeout=30.0)
            return result
        except asyncio.TimeoutError:
            self.pending_requests.pop(req_id, None)
            return {
                "success": False,
                "code": "timeout",
                "error": "request timeout after 30s",
            }
        except Exception as e:
            self.pending_requests.pop(req_id, None)
            return {"success": False, "error": str(e)}

    def _write_stdin(self, line: str):
        """Write a line to stdin. Called from executor thread."""
        try:
            self.process.stdin.write(line)
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            raise ConnectionError(f"pi runtime stdin is unavailable: {e}") from e

    async def read_events(
        self,
        session_id: Optional[str] = None,
        after_sequence: Optional[int] = None,
    ) -> AsyncIterator[dict]:
        """Yield replayable events for exactly one session."""
        session_id = session_id or self.session_id
        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        async with self._event_lock:
            history = list(self._event_history.get(session_id, ()))
            replay = [item for item in history if after_sequence is None or item[0] > after_sequence]
            current_sequence = self._event_sequence.get(session_id, 0)
            replay_gap = (
                after_sequence is not None
                and current_sequence > after_sequence
                and (not history or history[0][0] > after_sequence + 1)
            )
            self._event_subscribers.setdefault(session_id, set()).add(queue)
        try:
            if replay_gap:
                marker_sequence = history[0][0] - 1 if history else current_sequence
                yield {
                    "type": "stream_gap",
                    "_piSessionId": session_id,
                    "_piSequence": marker_sequence,
                    "_piEventId": f"{self._event_epoch}:{marker_sequence}",
                    "_piStreamGap": True,
                }
            for _sequence, event in replay:
                yield event
            while True:
                try:
                    # Check if process is still alive
                    if self.process.poll() is not None:
                        if self._shutting_down:
                            return
                        # Process exited
                        exit_code = self.process.returncode
                        stderr_output = "\n".join(self._stderr_tail)
                        yield {
                            "type": "error",
                            "sessionId": session_id,
                            "message": f"pi process exited with code {exit_code}. stderr: {stderr_output[:500]}",
                        }
                        return

                    # Wait for next event with timeout to check process liveness
                    _sequence, event = await asyncio.wait_for(queue.get(), timeout=1.0)
                    yield event
                except asyncio.TimeoutError:
                    # No event yet, continue checking
                    continue
                except asyncio.CancelledError:
                    return
        finally:
            async with self._event_lock:
                subscribers = self._event_subscribers.get(session_id)
                if subscribers is not None:
                    subscribers.discard(queue)
                    if not subscribers:
                        self._event_subscribers.pop(session_id, None)

    def sequence_after_event_id(self, event_id: Optional[str]) -> Optional[int]:
        """Decode a replay cursor only when it belongs to this process epoch."""
        if not event_id:
            return None
        if ":" in event_id:
            epoch, raw_sequence = event_id.rsplit(":", 1)
            if epoch != self._event_epoch:
                return None
        else:
            # Accept numeric cursors emitted by older backend versions while
            # the same process remains alive.
            raw_sequence = event_id
        try:
            return max(0, int(raw_sequence))
        except ValueError:
            return None

    def latest_event_sequence(self, session_id: str) -> int:
        """Return the latest sequence stored for one session."""
        return self._event_sequence.get(session_id, 0)

    async def shutdown(self):
        """Gracefully shut down the pi process."""
        self._shutting_down = True
        self._awaiting_prompt_ack = False
        self._prompt_started = False
        self._busy = False
        if self._prompt_reconcile_task:
            self._prompt_reconcile_task.cancel()
            try:
                await self._prompt_reconcile_task
            except asyncio.CancelledError:
                pass
            self._prompt_reconcile_task = None
        if self._reader_task:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass

        if self._stderr_task:
            self._stderr_task.cancel()
            try:
                await self._stderr_task
            except asyncio.CancelledError:
                pass

        if self.process.poll() is None:
            try:
                if self._pgid:
                    os.killpg(self._pgid, signal.SIGTERM)
                else:
                    self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    if self._pgid:
                        os.killpg(self._pgid, signal.SIGKILL)
                    else:
                        self.process.kill()
                    self.process.wait()
            except (ProcessLookupError, OSError):
                # The process group may already have exited; clean up the
                # direct child as a best-effort fallback.
                try:
                    self.process.kill()
                    self.process.wait()
                except OSError:
                    pass

        if self.session_dir:
            try:
                pid_file = Path(self.session_dir) / ".pi-pid"
                if pid_file.exists():
                    pid_file.unlink()
            except OSError:
                pass

        # Fail all pending requests
        for req_id, future in self.pending_requests.items():
            if not future.done():
                future.set_exception(ConnectionError("pi process shut down"))

    @property
    def is_alive(self) -> bool:
        return self.process.poll() is None

    @property
    def busy(self) -> bool:
        """Whether an agent turn is currently running."""
        return self._busy

class PiManager:
    """Global manager for pi process instances.

    One PiProcess per working directory (cwd). Sessions within the same
    cwd share the same pi process, switching via switch_session RPC command.
    """

    def __init__(self):
        self._processes: dict[str, PiProcess] = {}  # cwd -> PiProcess
        self._session_map: dict[str, str] = {}  # session_id -> cwd
        self._cwd_locks: dict[str, asyncio.Lock] = {}
        self._idle_task: Optional[asyncio.Task] = None
        self.IDLE_TTL = 30 * 60

    def _start_idle_check(self) -> None:
        """Start the idle cleanup loop once the first process is spawned."""
        if self._idle_task is None or self._idle_task.done():
            self._idle_task = asyncio.create_task(self._idle_cleanup_loop())

    async def _idle_cleanup_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(5 * 60)
                now = datetime.now(timezone.utc)
                for cwd, pi in list(self._processes.items()):
                    if pi.is_alive and not pi.busy:
                        idle_seconds = (now - pi._last_activity).total_seconds()
                        if idle_seconds > self.IDLE_TTL:
                            await self._remove(cwd)
            except asyncio.CancelledError:
                return
            except Exception:
                # Cleanup must never take down the API process.
                continue

    def _lock_for_cwd(self, cwd: str) -> asyncio.Lock:
        cwd = str(Path(cwd).resolve())
        return self._cwd_locks.setdefault(cwd, asyncio.Lock())

    async def get_or_spawn(
        self,
        cwd: str,
        session_dir: str,
        config: PiConfig,
    ) -> PiProcess:
        """Get existing PiProcess for cwd or spawn a new one."""
        cwd = str(Path(cwd).resolve())
        async with self._lock_for_cwd(cwd):
            return await self._get_or_spawn_unlocked(cwd, session_dir, config)

    async def _get_or_spawn_unlocked(
        self,
        cwd: str,
        session_dir: str,
        config: PiConfig,
    ) -> PiProcess:
        """Lock-owning implementation for get_or_spawn."""

        if cwd in self._processes:
            pi = self._processes[cwd]
            if pi.is_alive:
                return pi
            else:
                # Dead process, clean up
                await self._remove(cwd)

        return await self._spawn_process(cwd, session_dir, config)

    async def _spawn_process(
        self,
        cwd: str,
        session_dir: str,
        config: PiConfig,
        *,
        session_path: Optional[str] = None,
    ) -> PiProcess:
        encoded_cwd = cwd.lstrip("/").replace("/", "-")
        cwd_session_dir = str(Path(session_dir) / encoded_cwd)
        os.makedirs(cwd_session_dir, exist_ok=True)

        # A backend reload can lose the in-memory manager while leaving the
        # child runtime alive. Recover the stale process before spawning a new
        # one, avoiding duplicate Pi runtimes for the same workspace.
        pid_file = Path(cwd_session_dir) / ".pi-pid"
        if pid_file.exists():
            try:
                old_pid = int(pid_file.read_text().strip())
                try:
                    os.kill(old_pid, 0)
                    if _is_pi_process(old_pid):
                        os.kill(old_pid, signal.SIGKILL)
                except OSError:
                    pass
            except (ValueError, OSError):
                pass
            try:
                pid_file.unlink()
            except OSError:
                pass

        pi = await PiProcess.spawn(
            cwd,
            cwd_session_dir,
            config,
            session_path=session_path,
        )
        pi._on_session_changed = self._on_session_changed
        self._processes[cwd] = pi
        self._session_map[pi.session_id] = cwd
        self._start_idle_check()
        return pi

    def _on_session_changed(self, old_id: str, new_id: str, cwd: str) -> None:
        """Keep durable aliases while the workspace process changes sessions."""
        if old_id:
            self._session_map[old_id] = cwd
        if new_id:
            self._session_map[new_id] = cwd

    async def create_session(
        self,
        cwd: str,
        session_dir: str,
        config: PiConfig,
    ) -> tuple[Optional[PiProcess], dict]:
        """Create a distinct session under a workspace-wide operation lock."""
        cwd = str(Path(cwd).resolve())
        async with self._lock_for_cwd(cwd):
            pi = self._processes.get(cwd)
            if pi is not None and not pi.is_alive:
                await self._remove(cwd)
                pi = None
            if pi is None:
                try:
                    pi = await self._spawn_process(cwd, session_dir, config)
                except Exception as exc:
                    return None, {"success": False, "code": "spawn_failed", "error": str(exc)}
                return pi, {"success": True, "session_id": pi.session_id}
            result = await pi.send_command("new_session")
            if not result.get("success"):
                return None, result
            configured = await pi.apply_config(config)
            if not configured.get("success"):
                model, thinking = PiProcess.resolve_config(config)
                if model.startswith("custom-"):
                    restarted = await self._restart_session_unlocked(
                        pi.session_id,
                        cwd,
                        PiConfig(model=model, thinking=thinking),
                    )
                    if restarted is not None:
                        return restarted, {
                            "success": True,
                            "restarted": True,
                            "session_id": restarted.session_id,
                        }
                    replacement, replacement_result = await self._replace_with_blank_session_unlocked(
                        cwd,
                        PiConfig(model=model, thinking=thinking),
                    )
                    if replacement is not None:
                        return replacement, {
                            "success": True,
                            "restarted": True,
                            "replaced_blank": True,
                            "session_id": replacement.session_id,
                        }
                    return None, replacement_result
                # The runtime already created a distinct session. Returning a
                # hard failure here strands the frontend on the previous ID
                # while the backend is active on the new one. Keep the new
                # conversation usable with its inherited runtime config and
                # surface the configuration warning as metadata.
                return pi, {
                    "success": True,
                    "session_id": pi.session_id,
                    "config_warning": configured.get("error", "unable to apply requested model config"),
                }
            return pi, {**result, "session_id": pi.session_id}

    @staticmethod
    def _find_session_file(session_id: str, cwd: str) -> Optional[Path]:
        """Find a persisted session by its exact header ID."""
        from services.session_repository import SessionRepository

        return SessionRepository(cwd).find(session_id)

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        config: PiConfig,
    ) -> Optional[PiProcess]:
        """Load a persisted session into the workspace's pi process."""
        cwd = str(Path(cwd).resolve())
        async with self._lock_for_cwd(cwd):
            pi, _result = await self._activate_session_unlocked(session_id, cwd, config)
            return pi

    async def _align_model_if_needed(self, pi: PiProcess, config: PiConfig) -> dict:
        """Repair an idle runtime whose persisted provider has no credentials."""
        if getattr(pi, "busy", False):
            return {"success": True}
        global_model, _global_thinking = PiProcess.resolve_config(config)
        if not _should_use_global_model(pi.config.model, global_model):
            return {"success": True}
        apply_config = getattr(pi, "apply_config", None)
        if not callable(apply_config):
            return {"success": True}
        configured = await apply_config(config)
        if configured.get("success"):
            return {"success": True}
        return {
            "success": True,
            "config_warning": configured.get("error", "unable to apply the configured model"),
        }

    async def _activate_session_unlocked(
        self,
        session_id: str,
        cwd: str,
        config: PiConfig,
    ) -> tuple[Optional[PiProcess], dict]:
        """Make one persisted session active while the caller owns cwd lock."""
        pi = self.get_by_cwd(cwd)
        if pi is not None and not pi.is_alive:
            await self._remove(cwd)
            pi = None
        if pi is not None and pi.session_id == session_id:
            self._session_map[session_id] = cwd
            return pi, await self._align_model_if_needed(pi, config)

        session_path = self._find_session_file(session_id, cwd)
        if session_path is None:
            return None, {
                "success": False,
                "code": "not_found",
                "error": "session not found in this workspace",
            }

        if pi is None:
            from config import get_sessions_dir

            # Start directly on the persisted session. This avoids creating an
            # extra empty conversation every time the backend is restarted.
            try:
                spawned = await self._spawn_process(
                    cwd=cwd,
                    session_dir=str(get_sessions_dir(cwd)),
                    config=config,
                    session_path=str(session_path),
                )
            except Exception as exc:
                return None, {"success": False, "code": "spawn_failed", "error": str(exc)}
            if spawned.session_id != session_id:
                await self._remove(cwd)
                return None, {
                    "success": False,
                    "code": "session_mismatch",
                    "error": "runtime resumed a different session",
                }
            # Persisted sessions keep the model from their original turn. If
            # that provider is no longer authenticated but the workspace has
            # a usable global model (for example a configured custom API),
            # align the resumed runtime before the first prompt. This avoids a
            # confusing provider-key error on an otherwise valid conversation.
            return spawned, await self._align_model_if_needed(spawned, config)

        # A workspace has one runtime process. Never switch away from an
        # active turn for a different session; doing so would detach its tool
        # events and recreate the "stuck after tools" failure this recovery
        # path is meant to avoid.
        if getattr(pi, "busy", False) and pi.session_id != session_id:
            return None, {
                "success": False,
                "code": "busy",
                "error": "another conversation in this workspace is still running",
            }

        result = await pi.send_command("switch_session", sessionPath=str(session_path))
        if not result.get("success"):
            return None, result
        if pi.session_id != session_id:
            return None, {
                "success": False,
                "code": "session_mismatch",
                "error": "runtime switched to a different session",
            }
        return pi, await self._align_model_if_needed(pi, config)

    async def get_or_resume_session(
        self,
        session_id: str,
        cwd: str,
        config: PiConfig,
    ) -> Optional[PiProcess]:
        """Return a live process for a session, lazily restoring it if needed."""
        cwd = str(Path(cwd).resolve())
        async with self._lock_for_cwd(cwd):
            pi, _result = await self._activate_session_unlocked(session_id, cwd, config)
            return pi

    async def run_session_command(
        self,
        session_id: str,
        cwd: str,
        config: PiConfig,
        command: str,
        **params,
    ) -> tuple[Optional[PiProcess], dict]:
        """Atomically activate a session and submit a command to it."""
        cwd = str(Path(cwd).resolve())
        async with self._lock_for_cwd(cwd):
            pi, activation = await self._activate_session_unlocked(session_id, cwd, config)
            if pi is None:
                return None, activation
            result = await pi.send_command(command, **params)
            return pi, result

    async def get_session_state(
        self,
        session_id: str,
        cwd: str,
        config: PiConfig,
    ) -> tuple[Optional[PiProcess], dict]:
        """Atomically activate a session and read its authoritative state."""
        cwd = str(Path(cwd).resolve())
        async with self._lock_for_cwd(cwd):
            pi, activation = await self._activate_session_unlocked(session_id, cwd, config)
            if pi is None:
                return None, activation
            return pi, await pi.refresh_state()

    async def notify_session(
        self,
        session_id: str,
        cwd: str,
        config: PiConfig,
        notification_type: str,
        **params,
    ) -> tuple[Optional[PiProcess], dict]:
        """Deliver an extension notification only to its owning session."""
        cwd = str(Path(cwd).resolve())
        async with self._lock_for_cwd(cwd):
            pi, activation = await self._activate_session_unlocked(session_id, cwd, config)
            if pi is None:
                return None, activation
            try:
                await pi.send_notification(notification_type, **params)
            except Exception as exc:
                return pi, {"success": False, "error": str(exc)}
            return pi, {"success": True}

    async def get_event_process(
        self,
        session_id: str,
        cwd: str,
        config: PiConfig,
    ) -> tuple[Optional[PiProcess], dict]:
        """Attach SSE without switching an already-live workspace runtime."""
        cwd = str(Path(cwd).resolve())
        async with self._lock_for_cwd(cwd):
            pi = self.get_by_cwd(cwd)
            if pi is not None and not pi.is_alive:
                await self._remove(cwd)
                pi = None
            # Pi intentionally delays creating a JSONL file until the first
            # assistant message. The active blank session is still a valid SSE
            # target and must not be rejected merely because its file is not on
            # disk yet. Pre-creating that file breaks Pi's exclusive first flush.
            if pi is not None and pi.session_id == session_id:
                self._session_map[session_id] = cwd
                return pi, {"success": True}

            session_path = self._find_session_file(session_id, cwd)
            if session_path is None:
                return None, {
                    "success": False,
                    "code": "not_found",
                    "error": "session not found in this workspace",
                }
            if pi is not None:
                self._session_map[session_id] = cwd
                return pi, {"success": True}
            from config import get_sessions_dir

            try:
                pi = await self._spawn_process(
                    cwd=cwd,
                    session_dir=str(get_sessions_dir(cwd)),
                    config=config,
                    session_path=str(session_path),
                )
            except Exception as exc:
                return None, {"success": False, "code": "spawn_failed", "error": str(exc)}
            if pi.session_id != session_id:
                await self._remove(cwd)
                return None, {
                    "success": False,
                    "code": "session_mismatch",
                    "error": "runtime resumed a different session",
                }
            return pi, {"success": True}

    async def restart_session(
        self,
        session_id: str,
        cwd: str,
        config: PiConfig,
    ) -> Optional[PiProcess]:
        """Restart the runtime while preserving the selected conversation."""
        cwd = str(Path(cwd).resolve())
        async with self._lock_for_cwd(cwd):
            return await self._restart_session_unlocked(session_id, cwd, config)

    async def _restart_session_unlocked(
        self,
        session_id: str,
        cwd: str,
        config: PiConfig,
    ) -> Optional[PiProcess]:
        session_path = self._find_session_file(session_id, cwd)
        if session_path is None:
            return None
        await self._remove(cwd)
        from config import get_sessions_dir

        return await self._spawn_process(
            cwd=cwd,
            session_dir=str(get_sessions_dir(cwd)),
            config=config,
            session_path=str(session_path),
        )

    async def _replace_with_blank_session_unlocked(
        self,
        cwd: str,
        config: PiConfig,
    ) -> tuple[Optional[PiProcess], dict]:
        """Replace an idle, unpersisted runtime with a freshly configured one.

        Pi does not write a session file until the first prompt. A stale
        runtime therefore cannot be restarted by path when a newly-added custom
        provider is selected. Replacing that empty process is lossless, and the
        caller must return the replacement session ID to the frontend.
        """
        await self._remove(cwd)
        from config import get_sessions_dir

        try:
            replacement = await self._spawn_process(
                cwd=cwd,
                session_dir=str(get_sessions_dir(cwd)),
                config=config,
            )
        except Exception as exc:
            return None, {
                "success": False,
                "code": "spawn_failed",
                "error": str(exc),
            }
        return replacement, {
            "success": True,
            "session_id": replacement.session_id,
        }

    async def configure_session(
        self,
        session_id: str,
        cwd: str,
        model: str,
        thinking: Optional[str] = None,
    ) -> tuple[Optional[PiProcess], dict]:
        """Apply model/thinking atomically, restarting for new custom providers."""
        cwd = str(Path(cwd).resolve())
        if "/" not in model:
            return None, {"success": False, "error": "model must use provider/model notation"}
        provider, model_id = model.split("/", 1)
        async with self._lock_for_cwd(cwd):
            pi, activation = await self._activate_session_unlocked(session_id, cwd, PiConfig())
            if pi is None:
                return None, activation
            previous_model = pi.config.model
            result = await pi.send_command("set_model", provider=provider, modelId=model_id)
            if not result.get("success"):
                if result.get("code") == "busy":
                    return pi, result
                if provider.startswith("custom-"):
                    restarted = await self._restart_session_unlocked(
                        session_id,
                        cwd,
                        PiConfig(model=model, thinking=thinking or pi.config.thinking),
                    )
                    if restarted is not None:
                        return restarted, {
                            "success": True,
                            "model": model,
                            "thinking": restarted.config.thinking,
                            "restarted": True,
                            "session_id": restarted.session_id,
                        }
                    if pi.session_id == session_id and self._find_session_file(session_id, cwd) is None:
                        replacement, replacement_result = await self._replace_with_blank_session_unlocked(
                            cwd,
                            PiConfig(model=model, thinking=thinking or pi.config.thinking),
                        )
                        if replacement is not None:
                            return replacement, {
                                "success": True,
                                "model": model,
                                "thinking": replacement.config.thinking,
                                "restarted": True,
                                "replaced_blank": True,
                                "session_id": replacement.session_id,
                            }
                        return None, replacement_result
                return pi, result
            if thinking and thinking != pi.config.thinking:
                thinking_result = await pi.send_command("set_thinking_level", level=thinking)
                if not thinking_result.get("success"):
                    # Avoid reporting the old model in the UI while leaving a
                    # partially applied runtime configuration behind.
                    if previous_model and previous_model != model and "/" in previous_model:
                        old_provider, old_model_id = previous_model.split("/", 1)
                        await pi.send_command(
                            "set_model",
                            provider=old_provider,
                            modelId=old_model_id,
                        )
                    return pi, thinking_result
            return pi, {
                "success": True,
                "model": pi.config.model or model,
                "thinking": pi.config.thinking,
                "restarted": False,
                "session_id": pi.session_id,
            }

    async def delete_session(self, session_id: str, cwd: str) -> dict:
        """Delete one workspace-scoped session without racing the live runtime."""
        cwd = str(Path(cwd).resolve())
        async with self._lock_for_cwd(cwd):
            pi = self.get_by_cwd(cwd)
            if pi is not None and pi.is_alive and pi.session_id == session_id:
                if pi.busy:
                    return {
                        "success": False,
                        "code": "busy",
                        "error": "cannot delete a conversation while it is running",
                    }
                # The runtime keeps the active JSONL file open. Stop it before
                # unlinking so the deleted conversation cannot reappear.
                await self._remove(cwd)
            path = self._find_session_file(session_id, cwd)
            if path is None:
                # Active blank sessions are intentionally not persisted until
                # the first assistant reply. Stopping the process fully deletes
                # such a session even though there is no JSONL to unlink.
                if pi is not None and pi.session_id == session_id:
                    self.unbind_session(session_id)
                    return {"success": True}
                return {"success": False, "code": "not_found", "error": "session not found"}
            try:
                path.unlink()
            except OSError as exc:
                return {"success": False, "code": "delete_failed", "error": str(exc)}
            self.unbind_session(session_id)
            return {"success": True}

    def unbind_session(self, session_id: str):
        """Remove a session alias from the in-memory process map."""
        self._session_map.pop(session_id, None)

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
            for session_id, mapped_cwd in list(self._session_map.items()):
                if mapped_cwd == cwd:
                    self._session_map.pop(session_id, None)
            await pi.shutdown()

    async def shutdown_all(self):
        """Shut down all managed pi processes."""
        if self._idle_task and not self._idle_task.done():
            self._idle_task.cancel()
            try:
                await self._idle_task
            except asyncio.CancelledError:
                pass
            self._idle_task = None
        for cwd in list(self._processes.keys()):
            await self._remove(cwd)

    @property
    def active_count(self) -> int:
        return sum(1 for p in self._processes.values() if p.is_alive)


def _ensure_pi_subagent_wrapper(base_dir: Path, parent_args: list[str]) -> Optional[str]:
    return ensure_pi_subagent_wrapper(base_dir, parent_args)


# Singleton
pi_manager = PiManager()
