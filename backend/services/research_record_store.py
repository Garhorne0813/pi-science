"""Single append-only stream for new project-memory and research-loop events."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

import aiofiles

from models.research_memory import ResearchRecordEnvelope
from services.workspace_journal import journal_lock


class ResearchRecordStore:
    def __init__(self, workspace: str | Path):
        self.workspace = Path(workspace).expanduser().resolve()
        self.path = self.workspace / ".pi-science" / "research-records.jsonl"
        self.index_path = self.workspace / ".pi-science" / "indexes" / "project-memory.json"
        self.workspace_id = "workspace-" + hashlib.sha256(str(self.workspace).encode()).hexdigest()[:16]

    async def append(
        self,
        record_type: str,
        *,
        producer: str,
        payload: dict[str, Any] | None = None,
        loop_id: str | None = None,
        candidate_id: str | None = None,
        session_id: str | None = None,
        run_id: str | None = None,
        causation_id: str | None = None,
        correlation_id: str | None = None,
    ) -> ResearchRecordEnvelope:
        record = ResearchRecordEnvelope(
            record_type=record_type,
            workspace_id=self.workspace_id,
            loop_id=loop_id,
            candidate_id=candidate_id,
            session_id=session_id,
            run_id=run_id,
            producer=producer,
            causation_id=causation_id,
            correlation_id=correlation_id or loop_id,
            payload=payload or {},
        )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        async with journal_lock(self.path):
            async with aiofiles.open(self.path, "a", encoding="utf-8") as handle:
                await handle.write(record.model_dump_json() + "\n")
        return record

    async def list(
        self,
        *,
        loop_id: str | None = None,
        candidate_id: str | None = None,
        record_type: str | None = None,
        limit: int = 1000,
    ) -> list[ResearchRecordEnvelope]:
        if not self.path.exists():
            return []
        records: list[ResearchRecordEnvelope] = []
        async with aiofiles.open(self.path, "r", encoding="utf-8") as handle:
            async for line in handle:
                try:
                    record = ResearchRecordEnvelope.model_validate_json(line)
                except Exception:
                    continue
                if loop_id and record.loop_id != loop_id:
                    continue
                if candidate_id and record.candidate_id != candidate_id:
                    continue
                if record_type and record.record_type != record_type:
                    continue
                records.append(record)
        return records[-limit:]

    async def raw_rows(self, limit: int = 1000) -> list[dict[str, Any]]:
        return [record.model_dump(mode="json") for record in await self.list(limit=limit)]

    async def rebuild_index(self) -> dict[str, Any]:
        records = await self.list(limit=1_000_000)
        loops: dict[str, int] = {}
        candidates: dict[str, int] = {}
        types: dict[str, int] = {}
        for record in records:
            if record.loop_id:
                loops[record.loop_id] = loops.get(record.loop_id, 0) + 1
            if record.candidate_id:
                candidates[record.candidate_id] = candidates.get(record.candidate_id, 0) + 1
            types[record.record_type] = types.get(record.record_type, 0) + 1
        index = {"record_count": len(records), "loops": loops, "candidates": candidates, "record_types": types}
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.index_path.with_suffix(".tmp")
        async with journal_lock(self.index_path):
            async with aiofiles.open(temporary, "w", encoding="utf-8") as handle:
                await handle.write(json.dumps(index, ensure_ascii=False, indent=2) + "\n")
            os.replace(temporary, self.index_path)
        return index
