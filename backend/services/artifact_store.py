"""Workspace-local Artifact Manifest publication and verification."""

from __future__ import annotations

import asyncio
import hashlib
import mimetypes
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiofiles

from models import ArtifactManifest, ArtifactVerification
from services.provenance_store import get_store
from services.workspace_security import resolve_workspace_file
from services.workspace_journal import journal_lock


_MAX_PUBLISH_BYTES = 2 * 1024 * 1024 * 1024


def _kind(path: Path, mime: str) -> str:
    ext = path.suffix.lower()
    if mime.startswith("image/"):
        return "image"
    if mime.startswith("text/") or ext in {".md", ".json", ".yaml", ".yml", ".py", ".r", ".sh"}:
        return "text"
    if ext in {".csv", ".tsv", ".parquet", ".xlsx"}:
        return "table"
    if ext in {".pdf", ".docx", ".pptx"}:
        return "document"
    if ext in {".pdb", ".cif", ".mol", ".sdf", ".xyz"}:
        return "structure"
    return "file"


class ArtifactStore:
    def __init__(self, workspace_dir: str):
        self.workspace = Path(workspace_dir).expanduser().resolve()
        self.meta_dir = self.workspace / ".pi-science"
        self.manifest_file = self.meta_dir / "artifacts.jsonl"
        self.meta_dir.mkdir(parents=True, exist_ok=True)

    async def _read_all(self) -> list[ArtifactManifest]:
        if not self.manifest_file.exists():
            return []
        records: list[ArtifactManifest] = []
        async with aiofiles.open(self.manifest_file, "r", encoding="utf-8") as handle:
            async for line in handle:
                try:
                    records.append(ArtifactManifest.model_validate_json(line))
                except Exception:
                    continue
        return records

    @staticmethod
    def _hash_file(path: Path) -> tuple[str, int]:
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
                if size > _MAX_PUBLISH_BYTES:
                    raise ValueError("artifact is too large to publish")
        return digest.hexdigest(), size

    async def publish(
        self,
        path: str,
        *,
        session_id: str = "",
        tool: str = "publish_artifact",
        model: str | None = None,
        run_id: str | None = None,
        inputs: list[dict[str, Any]] | None = None,
        environment: dict[str, Any] | None = None,
    ) -> ArtifactManifest:
        file_path = resolve_workspace_file(self.workspace, path, allow_metadata=False)
        if not file_path.exists() or not file_path.is_file():
            raise FileNotFoundError(path)
        sha256, size = await asyncio.to_thread(self._hash_file, file_path)
        relative = file_path.relative_to(self.workspace).as_posix()
        mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        artifact_id = hashlib.sha256(f"{self.workspace}:{relative}".encode()).hexdigest()[:24]

        producer = {
            "tool": tool,
            "session_id": session_id,
            "model": model,
            "run_id": run_id,
        }
        producer = {key: value for key, value in producer.items() if value not in (None, "")}
        verification = ArtifactVerification(
            status="passed",
            checks={"exists": True, "readable": True, "size": size, "sha256": sha256},
            checked_at=datetime.now(timezone.utc),
        )
        async with journal_lock(self.manifest_file):
            records = await self._read_all()
            latest = next((item for item in reversed(records) if item.artifact_id == artifact_id), None)
            if latest is not None and latest.sha256 == sha256:
                return latest
            version = (latest.version + 1) if latest else 1
            manifest = ArtifactManifest(
                artifact_id=artifact_id,
                version=version,
                path=relative,
                kind=_kind(file_path, mime),
                mime=mime,
                size=size,
                sha256=sha256,
                published_at=datetime.now(timezone.utc),
                producer=producer,
                inputs=inputs or [],
                environment=environment or {},
                verification=verification,
            )
            async with aiofiles.open(self.manifest_file, "a", encoding="utf-8") as handle:
                await handle.write(manifest.model_dump_json() + "\n")
        from services.telemetry import record_metric
        await record_metric(str(self.workspace), "artifact_publish", "passed", metadata={"artifact_id": artifact_id, "path": relative, "size": size})
        # Keep existing provenance consumers aware of the publication without
        # storing the whole binary in JSONL.
        await get_store(str(self.workspace)).record(
            path=relative,
            session_id=session_id or "artifact-publisher",
            tool=tool,
            model=model,
            run_id=run_id,
            content=f"artifact:{artifact_id}:{version}:{sha256}",
        )
        return manifest

    async def list(self, artifact_id: str | None = None, limit: int = 100) -> list[ArtifactManifest]:
        records = await self._read_all()
        if artifact_id:
            records = [item for item in records if item.artifact_id == artifact_id]
        latest: dict[tuple[str, int], ArtifactManifest] = {}
        for item in records:
            latest[(item.artifact_id, item.version)] = item
        return list(reversed(list(latest.values())[-limit:]))

    async def get(self, artifact_id: str, version: int | None = None) -> ArtifactManifest | None:
        records = await self.list(artifact_id)
        if version is not None:
            return next((item for item in records if item.version == version), None)
        return records[0] if records else None

    async def record_verification(self, manifest: ArtifactManifest, report: dict[str, Any]) -> ArtifactManifest:
        updated = manifest.model_copy(
            update={
                "verification": ArtifactVerification(
                    status=report.get("status", "failed"),
                    checks=report.get("checks", {}),
                    errors=report.get("errors", []),
                    checked_at=datetime.now(timezone.utc),
                )
            }
        )
        async with journal_lock(self.manifest_file):
            async with aiofiles.open(self.manifest_file, "a", encoding="utf-8") as handle:
                await handle.write(updated.model_dump_json() + "\n")
        return updated


_stores: dict[str, ArtifactStore] = {}


def get_artifact_store(workspace_dir: str) -> ArtifactStore:
    key = str(Path(workspace_dir).expanduser().resolve())
    if key not in _stores:
        _stores[key] = ArtifactStore(key)
    return _stores[key]
