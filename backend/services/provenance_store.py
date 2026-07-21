"""Provenance storage — append-only JSONL tracking every agent file write/edit.

Each record captures the tool, session, model, content hash, and optional
environment snapshot, enabling full artifact lineage reconstruction.
"""

import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Optional

import aiofiles

from models import ProvenanceRecord
from services.workspace_journal import journal_lock

logger = logging.getLogger(__name__)

MAX_CONTENT_CHARS = 100_000


class ProvenanceStore:
    """Append-only JSONL store for artifact provenance records.

    Thread-safe for concurrent appends from async contexts.
    """

    def __init__(self, workspace_dir: str):
        self._dir = Path(workspace_dir) / ".pi-science"
        self._file = self._dir / "provenance.jsonl"
        self._env_dir = self._dir / "env"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._env_dir.mkdir(parents=True, exist_ok=True)
        self._version_index: dict[str, int] = {}
        self._build_version_index()

    def _build_version_index(self) -> None:
        """Build a path/version index once instead of scanning on every write."""
        if not self._file.exists():
            return
        try:
            with open(self._file) as stream:
                for line in stream:
                    try:
                        record = json.loads(line)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    path = record.get("path")
                    version = record.get("version", 0)
                    if path and isinstance(version, int):
                        self._version_index[path] = max(
                            self._version_index.get(path, 0), version
                        )
        except OSError:
            return

    async def record(
        self,
        path: str,
        session_id: str,
        tool: str,
        tool_call_id: Optional[str] = None,
        model: Optional[str] = None,
        content: Optional[str] = None,
        diff: Optional[str] = None,
        run_id: Optional[str] = None,
    ) -> ProvenanceRecord:
        """Append a provenance record. Returns the created record."""
        async with journal_lock(self._file):
            version = await self._next_version(path)
            content_hash = None
            stored_content = None
            if content is not None:
                content_hash = hashlib.sha256(content.encode()).hexdigest()[:16]
                stored_content = content
                if len(stored_content) > MAX_CONTENT_CHARS:
                    stored_content = stored_content[:MAX_CONTENT_CHARS] + "\n[truncated]"

            record = ProvenanceRecord(
                path=path,
                version=version,
                ts=time.time(),
                tool=tool,
                toolCallId=tool_call_id,
                sessionId=session_id,
                model=model,
                contentHash=content_hash,
                content=stored_content,
                diff=diff,
                runId=run_id,
            )

            line = record.model_dump_json() + "\n"
            async with aiofiles.open(self._file, "a") as f:
                await f.write(line)

            self._version_index[path] = version
        return record

    async def query(
        self,
        path: Optional[str] = None,
        session_id: Optional[str] = None,
        limit: int = 100,
    ) -> list[ProvenanceRecord]:
        """Query provenance records, optionally filtered by path or session."""
        results = []
        if not self._file.exists():
            return results

        async with aiofiles.open(self._file, "r") as f:
            async for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = ProvenanceRecord.model_validate_json(line)
                    if path and rec.path != path:
                        continue
                    if session_id and rec.sessionId != session_id:
                        continue
                    results.append(rec)
                except Exception:
                    logger.debug("Skipping malformed provenance record", exc_info=True)
                    continue

        # Return newest first
        results.reverse()
        return results[:limit]

    async def get_versions(self, path: str) -> list[ProvenanceRecord]:
        """Get all versions of a specific artifact."""
        return await self.query(path=path, limit=100)

    async def _next_version(self, path: str) -> int:
        """Get the next version number for an artifact path in O(1)."""
        return self._version_index.get(path, 0) + 1

    async def capture_environment(
        self,
        label: Optional[str] = None,
        include_hardware: bool = True,
    ) -> dict:
        """Capture current Python environment as a snapshot. Returns metadata."""
        import platform
        import subprocess

        env_data = {
            "ts": time.time(),
            "label": label,
            "platform": platform.platform(),
            "python": platform.python_version(),
        }

        # pip freeze
        try:
            result = subprocess.run(
                ["pip", "freeze"], capture_output=True, text=True, timeout=30
            )
            freeze_text = result.stdout
            freeze_hash = hashlib.sha256(freeze_text.encode()).hexdigest()[:16]
            env_data["packages_hash"] = freeze_hash
            env_data["package_count"] = len(
                [line for line in freeze_text.split("\n") if line.strip()]
            )

            # Store the freeze output for reproducibility
            env_file = self._env_dir / f"{freeze_hash}.txt"
            env_file.write_text(freeze_text)
        except Exception:
            logger.debug("pip freeze failed during environment capture", exc_info=True)
            env_data["packages_hash"] = None

        if include_hardware:
            try:
                import os
                cpu_count = os.cpu_count() or 0
                env_data["cpu_count"] = cpu_count
            except Exception:
                logger.debug("Failed to detect CPU count", exc_info=True)

        return env_data

    @property
    def record_count(self) -> int:
        if not self._file.exists():
            return 0
        with open(self._file) as f:
            return sum(1 for _ in f)


# Store singleton registry (keyed by workspace directory)
_stores: dict[str, ProvenanceStore] = {}


def get_store(workspace_dir: str) -> ProvenanceStore:
    """Get or create a provenance store for a workspace."""
    workspace_dir = str(Path(workspace_dir).resolve())
    if workspace_dir not in _stores:
        _stores[workspace_dir] = ProvenanceStore(workspace_dir)
    return _stores[workspace_dir]
