"""Stable file indexing and transactional workspace organization operations."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Any, Iterable
from uuid import uuid4

from models import FileOperation, ProjectPolicy
from models.project_knowledge import utc_now_iso
from services.file_service import detect_preview_kind, resolve_workspace_path
from services.project_knowledge_store import ProjectKnowledgeStore, _atomic_write_text, _read_json, _write_json


EXCLUDED_DIRECTORIES = {
    ".git",
    ".pi-science",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    "dist",
    "build",
}


class FilePlanError(ValueError):
    pass


class WorkspaceFileOrganizer:
    def __init__(self, workspace: str | Path):
        self.workspace = Path(workspace).expanduser().resolve()
        self.store = ProjectKnowledgeStore(self.workspace)
        self.index_file = self.store.meta_dir / "index.json"
        self.history_file = self.store.history_dir / "file-operations.jsonl"

    def build_index(self) -> dict[str, Any]:
        self.store.initialize(create_base_directories=False)
        previous = _read_json(self.index_file, {"files": []})
        previous_rows = previous.get("files", []) if isinstance(previous, dict) else []
        by_path = {row.get("path"): row for row in previous_rows if isinstance(row, dict)}
        by_fingerprint: dict[str, list[dict[str, Any]]] = {}
        for row in previous_rows:
            if isinstance(row, dict) and row.get("fingerprint"):
                by_fingerprint.setdefault(row["fingerprint"], []).append(row)

        rows: list[dict[str, Any]] = []
        used_ids: set[str] = set()
        for path in self._iter_files():
            relative = path.relative_to(self.workspace).as_posix()
            stat = path.stat()
            fingerprint = self._fingerprint(path, stat.st_size)
            old = by_path.get(relative)
            file_id = old.get("id") if old else None
            if not file_id:
                moved_candidates = by_fingerprint.get(fingerprint, [])
                candidate = next((item for item in moved_candidates if item.get("id") not in used_ids), None)
                file_id = candidate.get("id") if candidate else None
            file_id = file_id or f"file-{uuid4().hex[:12]}"
            used_ids.add(file_id)
            rows.append({
                "id": file_id,
                "path": relative,
                "name": path.name,
                "directory": path.parent.relative_to(self.workspace).as_posix(),
                "extension": path.suffix.lower(),
                "kind": detect_preview_kind(path.name),
                "size": stat.st_size,
                "modified": stat.st_mtime,
                "fingerprint": fingerprint,
                "tags": old.get("tags", []) if old else [],
            })
        payload = {"updated_at": utc_now_iso(), "files": rows}
        _write_json(self.index_file, payload)
        return payload

    def logical_views(self) -> dict[str, Any]:
        index = self.build_index()
        rows = index["files"]
        by_type: dict[str, list[dict[str, Any]]] = {}
        by_topic: dict[str, list[dict[str, Any]]] = {}
        by_month: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            by_type.setdefault(row["kind"], []).append(row)
            path_parts = Path(row["path"]).parts
            # Skip the project-knowledge root so topics map to the
            # human-facing categories (research / data / work / deliverables).
            if path_parts and path_parts[0] in {".project_knowledge", ".project_knowledge_base"}:
                path_parts = path_parts[1:]
            topic = path_parts[1] if len(path_parts) > 2 and path_parts[0] in {"research", "data", "work", "deliverables"} else path_parts[0]
            by_topic.setdefault(topic or "workspace", []).append(row)
            from datetime import datetime, timezone
            month = datetime.fromtimestamp(row["modified"], tz=timezone.utc).strftime("%Y-%m")
            by_month.setdefault(month, []).append(row)
        return {
            "updated_at": index["updated_at"],
            "files": rows,
            "by_type": by_type,
            "by_topic": by_topic,
            "by_month": by_month,
        }

    def preview_plan(self, operations: Iterable[FileOperation], policy: ProjectPolicy | None = None) -> dict[str, Any]:
        policy = policy or self.store.get_policy()
        normalized = [self._normalize_operation(operation, policy) for operation in operations]
        targets: set[str] = set()
        sources: set[str] = set()
        collisions: list[str] = []
        warnings: list[str] = []
        reference_updates: list[dict[str, Any]] = []

        for operation in normalized:
            target = operation.target
            if target in targets:
                collisions.append(f"duplicate target: {target}")
            targets.add(target)
            if operation.source:
                if operation.source in sources:
                    collisions.append(f"duplicate source: {operation.source}")
                sources.add(operation.source)

            target_path = resolve_workspace_path(self.workspace, target)
            source_moves_away = target in sources
            if target_path.exists() and not source_moves_away:
                if operation.type != "mkdir" or not target_path.is_dir():
                    collisions.append(f"target exists: {target}")
            if operation.source:
                source_path = resolve_workspace_path(self.workspace, operation.source)
                if not source_path.exists():
                    collisions.append(f"source missing: {operation.source}")
                elif not source_path.is_file():
                    collisions.append(f"only files can be moved: {operation.source}")
                reference_updates.extend(self._find_references(operation.source, operation.target))
                git_state = self._git_state(operation.source)
                if git_state:
                    warnings.append(f"Git state for {operation.source}: {git_state}")

        return {
            "ok": not collisions,
            "operations": [item.model_dump() for item in normalized],
            "collisions": sorted(set(collisions)),
            "warnings": sorted(set(warnings)),
            "reference_updates": reference_updates,
            "reference_count": len(reference_updates),
        }

    def apply_plan(self, operations: Iterable[FileOperation], proposal_id: str | None = None) -> dict[str, Any]:
        policy = self.store.get_policy()
        preview = self.preview_plan(operations, policy)
        if not preview["ok"]:
            raise FilePlanError("; ".join(preview["collisions"]))
        normalized = [FileOperation.model_validate(row) for row in preview["operations"]]
        history_id = f"fileop-{uuid4().hex[:12]}"
        completed_moves: list[tuple[Path, Path]] = []
        created_dirs: list[Path] = []
        reference_backups = self._reference_backups()

        try:
            for operation in normalized:
                target = resolve_workspace_path(self.workspace, operation.target)
                if operation.type == "mkdir":
                    if not target.exists():
                        target.mkdir(parents=True, exist_ok=False)
                        created_dirs.append(target)
                    continue

                source = resolve_workspace_path(self.workspace, operation.source or "")
                missing_parents = self._missing_parents(target.parent)
                target.parent.mkdir(parents=True, exist_ok=True)
                created_dirs.extend(missing_parents)
                source.rename(target)
                completed_moves.append((source, target))

            path_map = {source.relative_to(self.workspace).as_posix(): target.relative_to(self.workspace).as_posix() for source, target in completed_moves}
            self._replace_references(path_map)
            self.build_index()
        except Exception as exc:
            self._rollback_moves(completed_moves)
            self._restore_reference_backups(reference_backups)
            self._remove_created_directories(created_dirs)
            raise FilePlanError(f"file transaction rolled back: {exc}") from exc

        inverse: list[dict[str, Any]] = []
        for source, target in reversed(completed_moves):
            inverse.append({
                "type": "move",
                "source": target.relative_to(self.workspace).as_posix(),
                "target": source.relative_to(self.workspace).as_posix(),
            })
        for directory in reversed(created_dirs):
            if directory.exists() and directory.is_relative_to(self.workspace):
                inverse.append({"type": "rmdir", "target": directory.relative_to(self.workspace).as_posix()})

        record = {
            "id": history_id,
            "event": "file_operation.applied",
            "proposal_id": proposal_id,
            "created_at": utc_now_iso(),
            "operations": [item.model_dump() for item in normalized],
            "inverse": inverse,
            "reference_updates": preview["reference_updates"],
            "undone": False,
        }
        self._append_history(record)
        return record

    def undo(self, history_id: str) -> dict[str, Any]:
        record = self._find_history(history_id)
        if not record or record.get("event") != "file_operation.applied":
            raise FilePlanError("file operation history not found")
        if self._was_undone(history_id):
            raise FilePlanError("file operation already undone")

        inverse = record.get("inverse", [])
        moves = [item for item in inverse if item.get("type") == "move"]
        rmdirs = [item for item in inverse if item.get("type") == "rmdir"]
        reverse_ops = [FileOperation(type="move", source=item["source"], target=item["target"]) for item in moves]
        preview = self.preview_plan(reverse_ops)
        if not preview["ok"]:
            raise FilePlanError("cannot undo: " + "; ".join(preview["collisions"]))

        completed: list[tuple[Path, Path]] = []
        reference_backups = self._reference_backups()
        try:
            for operation in reverse_ops:
                source = resolve_workspace_path(self.workspace, operation.source or "")
                target = resolve_workspace_path(self.workspace, operation.target)
                target.parent.mkdir(parents=True, exist_ok=True)
                source.rename(target)
                completed.append((source, target))
            path_map = {source.relative_to(self.workspace).as_posix(): target.relative_to(self.workspace).as_posix() for source, target in completed}
            self._replace_references(path_map)
            for operation in rmdirs:
                directory = resolve_workspace_path(self.workspace, operation["target"])
                if directory.exists() and directory.is_dir():
                    try:
                        directory.rmdir()
                    except OSError:
                        pass
            self.build_index()
        except Exception as exc:
            self._rollback_moves(completed)
            self._restore_reference_backups(reference_backups)
            raise FilePlanError(f"undo rolled back: {exc}") from exc

        undo_record = {
            "id": f"undo-{uuid4().hex[:12]}",
            "event": "file_operation.undone",
            "history_id": history_id,
            "created_at": utc_now_iso(),
        }
        self._append_history(undo_record)
        return undo_record

    def _normalize_operation(self, operation: FileOperation, policy: ProjectPolicy) -> FileOperation:
        source = self._normalize_relative(operation.source) if operation.source else None
        target = self._normalize_relative(operation.target)
        if target == ".":
            raise FilePlanError("workspace root cannot be an operation target")
        for candidate in [value for value in (source, target) if value]:
            if self._is_locked(candidate, policy.locked_paths):
                raise FilePlanError(f"path is locked by project policy: {candidate}")
            depth = len(Path(candidate).parts)
            if depth > policy.max_directory_depth + 1:
                raise FilePlanError(f"path exceeds maximum directory depth: {candidate}")
        if source == target:
            raise FilePlanError("source and target are identical")
        return FileOperation(type=operation.type, source=source, target=target, reason=operation.reason)

    def _normalize_relative(self, value: str) -> str:
        raw = value.strip().replace("\\", "/")
        if not raw or Path(raw).is_absolute():
            raise FilePlanError("operation paths must be relative to the workspace")
        try:
            resolved = resolve_workspace_path(self.workspace, raw)
        except ValueError as exc:
            raise FilePlanError("operation paths must be relative and remain inside the workspace") from exc
        relative = resolved.relative_to(self.workspace).as_posix()
        if relative.startswith(".pi-science/") or relative == ".pi-science":
            raise FilePlanError("internal .pi-science files cannot be reorganized")
        return relative

    @staticmethod
    def _is_locked(path: str, locked_paths: list[str]) -> bool:
        candidate = Path(path)
        for locked in locked_paths:
            locked_path = Path(locked.strip().strip("/"))
            if candidate == locked_path or candidate.is_relative_to(locked_path):
                return True
        return False

    def _iter_files(self):
        for root, dirs, files in os.walk(self.workspace):
            dirs[:] = [name for name in dirs if name not in EXCLUDED_DIRECTORIES and not name.startswith(".cache")]
            root_path = Path(root)
            for name in files:
                path = root_path / name
                try:
                    if path.is_file() and not path.is_symlink():
                        yield path
                except OSError:
                    continue

    @staticmethod
    def _fingerprint(path: Path, size: int) -> str:
        digest = hashlib.sha256()
        digest.update(str(size).encode())
        try:
            with path.open("rb") as handle:
                if size <= 8 * 1024 * 1024:
                    while chunk := handle.read(1024 * 1024):
                        digest.update(chunk)
                else:
                    digest.update(handle.read(1024 * 1024))
                    handle.seek(max(size - 1024 * 1024, 0))
                    digest.update(handle.read(1024 * 1024))
        except OSError:
            digest.update(path.name.encode("utf-8", errors="replace"))
        return digest.hexdigest()[:24]

    def _find_references(self, source: str, target: str) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        if self.store.project_file.exists():
            count = self.store.project_file.read_text(encoding="utf-8", errors="replace").count(source)
            if count:
                results.append({
                    "path": self.store.project_file.relative_to(self.workspace).as_posix(),
                    "from": source,
                    "to": target,
                    "count": count,
                })
        for path in (self.store.items_file, self.store.proposals_file):
            rows = _read_json(path, [])
            count = 0
            for row in rows if isinstance(rows, list) else []:
                if not isinstance(row, dict):
                    continue
                related = row.get("related_files", [])
                count += sum(1 for value in related if value == source) if isinstance(related, list) else 0
                source_ref = row.get("source", {})
                source_files = source_ref.get("files", []) if isinstance(source_ref, dict) else []
                count += sum(1 for value in source_files if value == source) if isinstance(source_files, list) else 0
            if count:
                results.append({
                    "path": path.relative_to(self.workspace).as_posix(),
                    "from": source,
                    "to": target,
                    "count": count,
                })
        return results

    def _reference_backups(self) -> dict[Path, str]:
        backups: dict[Path, str] = {}
        for path in (self.store.project_file, self.store.items_file, self.store.proposals_file):
            if path.exists():
                backups[path] = path.read_text(encoding="utf-8", errors="replace")
        return backups

    @staticmethod
    def _restore_reference_backups(backups: dict[Path, str]) -> None:
        for path, text in backups.items():
            _atomic_write_text(path, text)

    def _replace_references(self, path_map: dict[str, str]) -> None:
        if self.store.project_file.exists():
            text = self.store.project_file.read_text(encoding="utf-8", errors="replace")
            updated = text
            for source, target in path_map.items():
                updated = updated.replace(source, target)
            if updated != text:
                _atomic_write_text(self.store.project_file, updated)

        for path in (self.store.items_file, self.store.proposals_file):
            rows = _read_json(path, [])
            if not isinstance(rows, list):
                continue
            changed = False
            for row in rows:
                if not isinstance(row, dict):
                    continue
                related = row.get("related_files")
                if isinstance(related, list):
                    mapped = [path_map.get(value, value) if isinstance(value, str) else value for value in related]
                    if mapped != related:
                        row["related_files"] = mapped
                        changed = True
                source = row.get("source")
                if isinstance(source, dict) and isinstance(source.get("files"), list):
                    source_files = source["files"]
                    mapped = [path_map.get(value, value) if isinstance(value, str) else value for value in source_files]
                    if mapped != source_files:
                        source["files"] = mapped
                        changed = True
            if changed:
                _write_json(path, rows)

    def _git_state(self, source: str) -> str:
        try:
            result = subprocess.run(
                ["git", "status", "--short", "--", source],
                cwd=self.workspace,
                capture_output=True,
                text=True,
                timeout=3,
            )
            return result.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return ""

    def _missing_parents(self, parent: Path) -> list[Path]:
        missing: list[Path] = []
        current = parent
        while current != self.workspace and not current.exists():
            missing.append(current)
            current = current.parent
        return list(reversed(missing))

    @staticmethod
    def _rollback_moves(completed: list[tuple[Path, Path]]) -> None:
        for source, target in reversed(completed):
            if target.exists() and not source.exists():
                source.parent.mkdir(parents=True, exist_ok=True)
                target.rename(source)

    @staticmethod
    def _remove_created_directories(directories: list[Path]) -> None:
        for directory in reversed(directories):
            if directory.exists():
                try:
                    directory.rmdir()
                except OSError:
                    pass

    def _append_history(self, record: dict[str, Any]) -> None:
        self.history_file.parent.mkdir(parents=True, exist_ok=True)
        with self.history_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def _history_rows(self) -> list[dict[str, Any]]:
        if not self.history_file.exists():
            return []
        rows: list[dict[str, Any]] = []
        for line in self.history_file.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict):
                rows.append(row)
        return rows

    def _find_history(self, history_id: str) -> dict[str, Any] | None:
        return next((row for row in self._history_rows() if row.get("id") == history_id), None)

    def _was_undone(self, history_id: str) -> bool:
        return any(row.get("event") == "file_operation.undone" and row.get("history_id") == history_id for row in self._history_rows())
