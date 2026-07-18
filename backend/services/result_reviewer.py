"""Read-only consistency checks for session transcripts and artifacts."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

import aiofiles

from services.citation_service import normalize_identifier
from services.session_reader import message_text, read_session_messages
from services.content_guard import inspect_untrusted_text


_REFERENCE = re.compile(r"\b(?:10\.\d{4,9}/\S+|(?:PMID|pmid)[:\s]+\d+|(?:arXiv|arxiv)[:\s]+\d{4}\.\d{4,5})\b")
_EXECUTION_CLAIM = re.compile(r"\b(?:ran|executed|tested|verified|measured|computed)\b", re.I)


async def _artifact_records(workspace: str, session_id: str) -> list[dict[str, Any]]:
    path = Path(workspace) / ".pi-science" / "artifacts.jsonl"
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    async with aiofiles.open(path, "r", encoding="utf-8") as handle:
        async for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("producer", {}).get("session_id") == session_id:
                rows.append(row)
    return rows


async def review_session(workspace: str, session_id: str) -> dict[str, Any]:
    messages = read_session_messages(session_id, workspace)
    findings: list[dict[str, Any]] = []
    text = "\n".join(message_text(item) for item in messages)
    has_tool_evidence = any(
        any(isinstance(part, dict) and part.get("type") in {"toolCall", "toolResult"} for part in item.get("content", []))
        for item in messages
    )
    if _EXECUTION_CLAIM.search(text) and not has_tool_evidence:
        findings.append({
            "severity": "fail",
            "kind": "unsupported_execution_claim",
            "message": "Transcript claims an execution or verification action but contains no corresponding tool record.",
            "evidence": {"claim": _EXECUTION_CLAIM.search(text).group(0)},
        })
    guard = inspect_untrusted_text(text)
    if guard["requires_review"]:
        findings.append({
            "severity": "warn",
            "kind": "untrusted_instruction",
            "message": "Transcript content contains instruction-like text that must be treated as evidence, not runtime instructions.",
            "evidence": {"signals": guard["injection_signals"]},
        })
    for raw in _REFERENCE.findall(text):
        try:
            citation = normalize_identifier(raw.replace("PMID:", "").replace("pmid:", "").replace("arXiv:", "").replace("arxiv:", ""))
            findings.append({
                "severity": "warn",
                "kind": "citation_unverified",
                "message": f"Citation {citation.identifier} was mentioned; verify it against a provider before treating it as established evidence.",
                "evidence": {"identifier": citation.identifier, "source": "transcript"},
            })
        except ValueError:
            findings.append({"severity": "warn", "kind": "citation_unparseable", "message": f"Could not normalize citation {raw}", "evidence": {"text": raw}})
    for artifact in await _artifact_records(workspace, session_id):
        verification = artifact.get("verification", {})
        if verification.get("status") == "failed":
            findings.append({
                "severity": "fail",
                "kind": "artifact_verification_failed",
                "message": f"Artifact {artifact.get('path')} failed content verification.",
                "evidence": {"artifact_id": artifact.get("artifact_id"), "errors": verification.get("errors", [])},
            })
    result = {
        "review_id": f"review_{int(time.time() * 1000)}",
        "session_id": session_id,
        "status": "fail" if any(item["severity"] == "fail" for item in findings) else "warn" if findings else "pass",
        "findings": findings,
        "checked_messages": len(messages),
        "created_at": time.time(),
    }
    output = Path(workspace) / ".pi-science" / "result-reviews.jsonl"
    output.parent.mkdir(parents=True, exist_ok=True)
    async with aiofiles.open(output, "a", encoding="utf-8") as handle:
        await handle.write(json.dumps(result, ensure_ascii=False) + "\n")
    return result
