"""Workspace-local storage for reviewed project knowledge and proposal state."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Iterable, Optional
from uuid import uuid4

from models import KnowledgeItem, ProjectPolicy, Proposal, SourceReference
from models.project_knowledge import utc_now_iso


MANAGED_START = "<!-- pi-science:project-knowledge:start -->"
MANAGED_END = "<!-- pi-science:project-knowledge:end -->"

# Scientific-project skeleton created once per workspace. Directories live
# under one hidden folder so the workspace root and ordinary file list stay
# free of six scattered management categories.
PROJECT_KNOWLEDGE_BASE = ".project_knowledge"
LEGACY_PROJECT_KNOWLEDGE_BASES = (".project_knowledge_base",)

BASE_DIRECTORIES = (
    "sources",
    "research",
    "data",
    "work",
    "deliverables",
    "archive",
)

SECTION_TITLES = {
    "finding": "Findings / 研究发现",
    "conclusion": "Conclusions / 当前结论",
    "decision": "Decisions / 关键决策",
    "hypothesis": "Hypotheses / 待验证假设",
    "question": "Open Questions / 开放问题",
    "task": "Next Steps / 下一步",
    "project_change": "Project Changes / 项目变化",
    "artifact": "Important Artifacts / 重要产物",
}


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{os.urandom(4).hex()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _write_json(path: Path, value: Any) -> None:
    _atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def proposal_fingerprint(proposal: Proposal | dict[str, Any]) -> str:
    data = proposal.model_dump() if isinstance(proposal, Proposal) else proposal
    normalized = {
        "proposal_type": data.get("proposal_type"),
        "knowledge_type": data.get("knowledge_type"),
        "title": " ".join(str(data.get("title", "")).lower().split()),
        "summary": " ".join(str(data.get("summary", "")).lower().split()),
        "operations": data.get("operations", []),
    }
    raw = json.dumps(normalized, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]


class ProjectKnowledgeStore:
    """Small JSON/JSONL persistence layer rooted inside one workspace."""

    def __init__(self, workspace: str | Path):
        self.workspace = Path(workspace).expanduser().resolve()
        self.meta_dir = self.workspace / ".pi-science"
        self.knowledge_dir = self.meta_dir / "knowledge"
        self.inbox_dir = self.meta_dir / "inbox"
        self.history_dir = self.meta_dir / "history"
        self.transactions_dir = self.meta_dir / "transactions"
        self.project_versions_dir = self.history_dir / "project-documents"
        self.project_file = self.workspace / "PROJECT.md"
        self.items_file = self.knowledge_dir / "items.json"
        self.proposals_file = self.inbox_dir / "proposals.json"
        self.policy_file = self.meta_dir / "policy.yaml"
        self.cursors_file = self.meta_dir / "review-cursors.json"
        self.runs_file = self.history_dir / "reviewer-runs.jsonl"
        self.events_file = self.history_dir / "knowledge-events.jsonl"

    def initialize(self, create_base_directories: bool = True) -> dict[str, Any]:
        self.workspace.mkdir(parents=True, exist_ok=True)
        for directory in (
            self.meta_dir,
            self.knowledge_dir,
            self.inbox_dir,
            self.history_dir,
            self.transactions_dir,
            self.project_versions_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)
        if create_base_directories:
            base = self.workspace / PROJECT_KNOWLEDGE_BASE
            for legacy_name in LEGACY_PROJECT_KNOWLEDGE_BASES:
                legacy_base = self.workspace / legacy_name
                if legacy_base.is_dir() and not base.exists():
                    legacy_base.rename(base)
                    break
            base.mkdir(exist_ok=True)
            for name in BASE_DIRECTORIES:
                (base / name).mkdir(exist_ok=True)
            # Remove only empty legacy skeleton folders. Non-empty directories
            # may contain user data and must keep their existing paths.
            for name in BASE_DIRECTORIES:
                legacy_directory = self.workspace / name
                if legacy_directory.is_dir():
                    try:
                        legacy_directory.rmdir()
                    except OSError:
                        pass

        if not self.items_file.exists():
            _write_json(self.items_file, [])
        if not self.proposals_file.exists():
            _write_json(self.proposals_file, [])
        if not self.cursors_file.exists():
            _write_json(self.cursors_file, {})
        if not self.policy_file.exists():
            _write_json(self.policy_file, ProjectPolicy().model_dump())
        if not self.project_file.exists():
            _atomic_write_text(self.project_file, self._initial_project_document())
        elif MANAGED_START not in self.project_file.read_text(encoding="utf-8", errors="replace"):
            existing = self.project_file.read_text(encoding="utf-8", errors="replace").rstrip()
            _atomic_write_text(
                self.project_file,
                existing + "\n\n" + self._render_managed_block([]) + "\n",
            )
        if not any(self.project_versions_dir.glob("*.json")):
            self._save_project_version(self.project_file.read_text(encoding="utf-8", errors="replace"), self.list_items(), "initialized")
        return self.summary()

    def summary(self) -> dict[str, Any]:
        proposals = self.list_proposals()
        items = self.list_items()
        return {
            "workspace": str(self.workspace),
            "project_file": "PROJECT.md",
            "pending_count": sum(1 for p in proposals if p.status == "pending"),
            "knowledge_count": sum(1 for item in items if item.status == "active"),
            "auto_review": self.get_policy().auto_review,
        }

    def _initial_project_document(self) -> str:
        title = self.workspace.name.replace("-", " ").strip() or "Project"
        return (
            f"# {title}\n\n"
            "## Project Goal / 项目目标\n\n"
            "Describe the project goal, scope, and constraints here. / 在此描述项目目标、范围和约束。\n\n"
            f"{self._render_managed_block([])}\n"
        )

    def list_items(self, include_inactive: bool = True) -> list[KnowledgeItem]:
        rows = _read_json(self.items_file, [])
        items: list[KnowledgeItem] = []
        for row in rows if isinstance(rows, list) else []:
            try:
                item = KnowledgeItem.model_validate(row)
            except Exception:
                continue
            if include_inactive or item.status == "active":
                items.append(item)
        return items

    def save_items(self, items: Iterable[KnowledgeItem]) -> None:
        _write_json(self.items_file, [item.model_dump() for item in items])

    def get_item(self, item_id: str) -> Optional[KnowledgeItem]:
        return next((item for item in self.list_items() if item.id == item_id), None)

    def list_proposals(self, status: Optional[str] = None) -> list[Proposal]:
        rows = _read_json(self.proposals_file, [])
        proposals: list[Proposal] = []
        for row in rows if isinstance(rows, list) else []:
            try:
                proposal = Proposal.model_validate(row)
            except Exception:
                continue
            if status is None or proposal.status == status:
                proposals.append(proposal)
        return sorted(proposals, key=lambda item: item.created_at, reverse=True)

    def save_proposals(self, proposals: Iterable[Proposal]) -> None:
        ordered = sorted(proposals, key=lambda item: item.created_at)
        _write_json(self.proposals_file, [proposal.model_dump() for proposal in ordered])

    def get_proposal(self, proposal_id: str) -> Optional[Proposal]:
        return next((item for item in self.list_proposals() if item.id == proposal_id), None)

    def add_proposals(self, incoming: Iterable[Proposal]) -> tuple[list[Proposal], int]:
        existing = self.list_proposals()
        known = {
            proposal.fingerprint
            for proposal in existing
            if proposal.status in {"pending", "accepted"} and proposal.fingerprint
        }
        accepted: list[Proposal] = []
        skipped = 0
        for proposal in incoming:
            proposal.fingerprint = proposal.fingerprint or proposal_fingerprint(proposal)
            if proposal.fingerprint in known:
                skipped += 1
                continue
            known.add(proposal.fingerprint)
            existing.append(proposal)
            accepted.append(proposal)
        self.save_proposals(existing)
        return accepted, skipped

    def update_proposal(self, updated: Proposal) -> Proposal:
        proposals = self.list_proposals()
        found = False
        for index, proposal in enumerate(proposals):
            if proposal.id == updated.id:
                updated.updated_at = utc_now_iso()
                proposals[index] = updated
                found = True
                break
        if not found:
            raise KeyError(updated.id)
        self.save_proposals(proposals)
        return updated

    def accept_knowledge_proposal(
        self,
        proposal: Proposal,
        *,
        title: Optional[str] = None,
        summary: Optional[str] = None,
    ) -> KnowledgeItem:
        if proposal.proposal_type != "knowledge" or proposal.knowledge_type is None:
            raise ValueError("proposal is not a knowledge proposal")
        if proposal.status != "pending":
            raise ValueError("proposal is not pending")

        items = self.list_items()
        item = KnowledgeItem(
            type=proposal.knowledge_type,
            title=title or proposal.title,
            summary=summary or proposal.summary,
            confidence=proposal.confidence,
            importance=proposal.importance,
            source=proposal.source,
            related_files=proposal.related_files,
            conflicts_with=proposal.conflicts_with,
            supersedes=proposal.supersedes,
            proposal_id=proposal.id,
        )
        superseded = set(proposal.supersedes)
        if superseded:
            for old in items:
                if old.id in superseded and old.status == "active":
                    old.status = "superseded"
                    old.updated_at = utc_now_iso()
        items.append(item)
        self.save_items(items)
        self.render_project_document(items)

        proposal.status = "accepted"
        proposal.title = item.title
        proposal.summary = item.summary
        proposal.applied_history_id = item.id
        self.update_proposal(proposal)
        self.record_event("knowledge.accepted", {
            "proposal_id": proposal.id,
            "knowledge_id": item.id,
            "superseded": sorted(superseded),
        })
        self.bump_policy_count("accepted", proposal)
        return item

    def reject_proposal(self, proposal: Proposal, reason: Optional[str] = None) -> Proposal:
        if proposal.status != "pending":
            raise ValueError("proposal is not pending")
        proposal.status = "rejected"
        proposal.decision_reason = reason
        updated = self.update_proposal(proposal)
        self.record_event("proposal.rejected", {
            "proposal_id": proposal.id,
            "reason": reason,
        })
        self.bump_policy_count("rejected", proposal)
        return updated

    def render_project_document(self, items: Optional[list[KnowledgeItem]] = None) -> str:
        items = items if items is not None else self.list_items()
        current = self.project_file.read_text(encoding="utf-8", errors="replace") if self.project_file.exists() else ""
        block = self._render_managed_block(items)
        if MANAGED_START in current and MANAGED_END in current:
            prefix, remainder = current.split(MANAGED_START, 1)
            _, suffix = remainder.split(MANAGED_END, 1)
            updated = prefix.rstrip() + "\n\n" + block + suffix
        else:
            updated = current.rstrip() + "\n\n" + block + "\n"
        _atomic_write_text(self.project_file, updated)
        self._save_project_version(updated, items, "knowledge-render")
        return updated

    def _save_project_version(self, document: str, items: list[KnowledgeItem], reason: str) -> dict[str, Any]:
        version_id = f"project-version-{uuid4().hex[:12]}"
        record = {
            "id": version_id,
            "event": "project_document.version",
            "created_at": utc_now_iso(),
            "reason": reason,
            "document": document,
            "items": [item.model_dump() for item in items],
        }
        _write_json(self.project_versions_dir / f"{version_id}.json", record)
        self.record_event("project_document.version", {
            "version_id": version_id,
            "reason": reason,
            "knowledge_count": len(items),
        })
        return record

    def list_project_versions(self, limit: int = 100) -> list[dict[str, Any]]:
        versions: list[dict[str, Any]] = []
        for path in self.project_versions_dir.glob("*.json"):
            row = _read_json(path, None)
            if not isinstance(row, dict):
                continue
            versions.append({
                "id": row.get("id"),
                "created_at": row.get("created_at"),
                "reason": row.get("reason"),
                "knowledge_count": len(row.get("items", [])) if isinstance(row.get("items"), list) else 0,
            })
        versions.sort(key=lambda row: row.get("created_at") or "", reverse=True)
        return versions[:limit]

    def restore_project_version(self, version_id: str) -> dict[str, Any]:
        # Version IDs come from a URL path. Reject separators and any resolved
        # path outside the project-document snapshots before reading it.
        if not version_id or Path(version_id).name != version_id:
            raise KeyError(version_id)
        path = (self.project_versions_dir / f"{version_id}.json").resolve()
        if not path.is_relative_to(self.project_versions_dir.resolve()):
            raise KeyError(version_id)
        row = _read_json(path, None)
        if not isinstance(row, dict) or not isinstance(row.get("document"), str) or not isinstance(row.get("items"), list):
            raise KeyError(version_id)
        try:
            items = [KnowledgeItem.model_validate(item) for item in row["items"]]
        except Exception as exc:
            raise ValueError("Project version contains invalid knowledge data") from exc
        _atomic_write_text(self.project_file, row["document"])
        self.save_items(items)
        restored = self._save_project_version(row["document"], items, f"restored:{version_id}")
        self.record_event("project_document.restored", {
            "version_id": version_id,
            "restored_version_id": restored["id"],
        })
        return {
            "restored_from": version_id,
            "new_version_id": restored["id"],
            "knowledge_count": len(items),
        }

    def _render_managed_block(self, items: list[KnowledgeItem]) -> str:
        lines = [
            MANAGED_START,
            "## Reviewed Project Knowledge / 已确认项目知识",
            "",
            f"_Last updated / 最后更新: {utc_now_iso()}_",
        ]
        active = [item for item in items if item.status == "active"]
        for kind, heading in SECTION_TITLES.items():
            grouped = [item for item in active if item.type == kind]
            if not grouped:
                continue
            lines.extend(["", f"### {heading}", ""])
            for item in grouped:
                summary = " ".join(item.summary.strip().splitlines())
                lines.append(f"- **{item.title.strip()}** — {summary}")
                evidence = self._format_source(item.source)
                meta = f"confidence: {item.confidence}; id: `{item.id}`"
                if evidence:
                    meta += f"; source: {evidence}"
                if item.related_files:
                    meta += "; files: " + ", ".join(f"`{path}`" for path in item.related_files)
                lines.append(f"  - {meta}")
        if not active:
            lines.extend(["", "_No reviewed knowledge yet. / 暂无已确认知识。_"])
        lines.extend(["", MANAGED_END])
        return "\n".join(lines)

    @staticmethod
    def _format_source(source: SourceReference) -> str:
        parts: list[str] = []
        if source.session_id:
            message_suffix = ""
            if source.message_ids:
                message_suffix = "#" + ",".join(source.message_ids[:8])
            parts.append(f"session `{source.session_id}{message_suffix}`")
        if source.run_ids:
            parts.append("runs " + ", ".join(f"`{run}`" for run in source.run_ids[:8]))
        if source.citations:
            parts.append("citations " + ", ".join(source.citations[:5]))
        return "; ".join(parts)

    def get_policy(self) -> ProjectPolicy:
        self.meta_dir.mkdir(parents=True, exist_ok=True)
        raw = _read_json(self.policy_file, {})
        try:
            return ProjectPolicy.model_validate(raw)
        except Exception:
            policy = ProjectPolicy()
            self.save_policy(policy)
            return policy

    def save_policy(self, policy: ProjectPolicy) -> ProjectPolicy:
        policy.updated_at = utc_now_iso()
        _write_json(self.policy_file, policy.model_dump())
        return policy

    def bump_policy_count(self, outcome: str, proposal: Proposal) -> None:
        policy = self.get_policy()
        key = proposal.knowledge_type or proposal.proposal_type
        target = policy.accepted_counts if outcome == "accepted" else policy.rejected_counts
        target[key] = target.get(key, 0) + 1
        self.save_policy(policy)

    def get_cursor(self, session_id: str) -> dict[str, Any]:
        cursors = _read_json(self.cursors_file, {})
        value = cursors.get(session_id, {}) if isinstance(cursors, dict) else {}
        return value if isinstance(value, dict) else {}

    def set_cursor(self, session_id: str, *, message_count: int, last_message_id: Optional[str]) -> None:
        cursors = _read_json(self.cursors_file, {})
        if not isinstance(cursors, dict):
            cursors = {}
        cursors[session_id] = {
            "message_count": message_count,
            "last_message_id": last_message_id,
            "updated_at": utc_now_iso(),
        }
        _write_json(self.cursors_file, cursors)

    def record_reviewer_run(self, data: dict[str, Any]) -> None:
        self._append_jsonl(self.runs_file, data)

    def record_event(self, event: str, data: dict[str, Any]) -> str:
        event_id = f"history-{hashlib.sha256((event + utc_now_iso()).encode()).hexdigest()[:12]}"
        self._append_jsonl(self.events_file, {
            "id": event_id,
            "event": event,
            "created_at": utc_now_iso(),
            **data,
        })
        return event_id

    def list_history(self, limit: int = 100) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for path in (self.events_file, self.runs_file, self.history_dir / "file-operations.jsonl"):
            if not path.exists():
                continue
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(row, dict):
                    rows.append(row)
        rows.sort(key=lambda row: row.get("created_at") or row.get("started_at") or "", reverse=True)
        return rows[:limit]

    @staticmethod
    def _append_jsonl(path: Path, data: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(data, ensure_ascii=False) + "\n")


def initialize_project_workspace(workspace: str | Path, create_base_directories: bool = True) -> dict[str, Any]:
    return ProjectKnowledgeStore(workspace).initialize(create_base_directories=create_base_directories)
