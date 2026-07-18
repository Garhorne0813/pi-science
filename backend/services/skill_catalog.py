"""Discovery, validation, and metadata for Pi-Science skills.

This service intentionally has no runtime side effects.  It reads skill
directories, validates their front matter, and returns stable identifiers so
session creation can record exactly which skill content was available.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import yaml
from pydantic import ValidationError

from config import SKILLS_DIR
from models.skill import SkillFile, SkillInfo, SkillMetadata, SkillValidation


_FRONT_MATTER = re.compile(r"^---\s*\n(?P<body>.*?)\n---\s*(?:\n|$)", re.DOTALL)
_SOURCE_RANK = {"project": 0, "user": 1, "builtin": 2}
_MAX_SKILL_BYTES = 2 * 1024 * 1024
_MAX_REFERENCE_BYTES = 512 * 1024


@dataclass(frozen=True)
class DiscoveredSkill:
    source_path: Path
    source_root: Path
    source: str
    metadata: SkillMetadata
    validation: SkillValidation
    digest: str
    skill_id: str
    files: tuple[SkillFile, ...]

    @property
    def location(self) -> str:
        try:
            return self.source_path.relative_to(self.source_root).as_posix()
        except ValueError:
            return self.source_path.name

    def public(self, *, enabled: bool = True, shadowed: Iterable[str] = ()) -> SkillInfo:
        quality = "validated" if self.validation.valid else "draft"
        declared_quality = self.metadata.model_extra.get("quality") if self.metadata.model_extra else None
        if declared_quality in {"verified", "deprecated"}:
            quality = declared_quality
        return SkillInfo(
            skill_id=self.skill_id,
            digest=self.digest,
            name=self.metadata.name,
            description=self.metadata.description,
            version=self.metadata.version,
            category=self.metadata.category,
            license=self.metadata.license,
            risk=self.metadata.risk,
            quality=quality,
            location=self.location,
            source=self.source,  # type: ignore[arg-type]
            enabled=enabled,
            requirements=self.metadata.requirements,
            third_party=self.metadata.third_party,
            entrypoints=self.metadata.entrypoints,
            required_tools=self.metadata.required_tools,
            required_mcp_tools=self.metadata.required_mcp_tools,
            files=list(self.files),
            validation=self.validation,
            shadowed=list(shadowed),
        )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    for child in sorted(path.parent.rglob("*")):
        if not child.is_file() or child.stat().st_size > _MAX_REFERENCE_BYTES:
            continue
        digest.update(child.relative_to(path.parent).as_posix().encode())
        digest.update(b"\0")
        digest.update(child.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:32]


def _skill_id(name: str, source: str) -> str:
    # Source is included so a user/project override can be observed as a
    # distinct install even when its content is byte-for-byte identical.
    return hashlib.sha256(f"{source}:{name}".encode()).hexdigest()[:20]


def _read_front_matter(path: Path) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    try:
        if path.stat().st_size > _MAX_SKILL_BYTES:
            return {}, [f"SKILL.md exceeds {_MAX_SKILL_BYTES} bytes"]
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return {}, [f"unable to read SKILL.md: {exc}"]
    match = _FRONT_MATTER.match(text)
    if not match:
        return {}, ["SKILL.md must start with YAML front matter"]
    try:
        payload = yaml.safe_load(match.group("body"))
    except yaml.YAMLError as exc:
        return {}, [f"invalid YAML front matter: {exc}"]
    if payload is None:
        return {}, ["front matter is empty"]
    if not isinstance(payload, dict):
        return {}, ["front matter must be a YAML mapping"]
    return payload, errors


def _normalise_requirements(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        return [{"name": str(value), "kind": "other"}]
    result: list[dict[str, Any]] = []
    for item in value:
        if isinstance(item, str):
            result.append({"name": item, "kind": "other"})
        elif isinstance(item, dict):
            result.append(item)
        else:
            result.append({"name": str(item), "kind": "other"})
    return result


def _normalise_third_party(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, dict):
        value = [value]
    if not isinstance(value, list):
        return [{"name": str(value), "kind": "other"}]
    result: list[dict[str, Any]] = []
    for item in value:
        if isinstance(item, str):
            result.append({"name": item, "kind": "other"})
        elif isinstance(item, dict):
            result.append(item)
        else:
            result.append({"name": str(item), "kind": "other"})
    return result


def parse_skill(path: Path, source: str, source_root: Path) -> DiscoveredSkill:
    raw, errors = _read_front_matter(path)
    payload = dict(raw)
    # Legacy skills often use a bare requirements list and omit all optional
    # metadata.  Normalisation keeps those skills loadable while making the
    # public contract strict.
    payload["requirements"] = _normalise_requirements(payload.get("requirements"))
    payload["third_party"] = _normalise_third_party(payload.get("third_party"))
    validation_errors = list(errors)
    try:
        metadata = SkillMetadata.model_validate(payload)
    except ValidationError as exc:
        fallback_name = str(payload.get("name") or path.parent.name).lower()
        fallback_name = re.sub(r"[^a-z0-9._-]+", "-", fallback_name).strip("-") or "invalid-skill"
        metadata = SkillMetadata(
            name=fallback_name[:80],
            description=str(payload.get("description") or "Invalid skill metadata"),
        )
        validation_errors.extend(
            f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors()
        )
    files = _skill_files(path.parent, source_root)
    checked = SkillValidation(
        valid=not validation_errors,
        errors=validation_errors,
        warnings=_metadata_warnings(metadata),
        checked_at=_now(),
    )
    return DiscoveredSkill(
        source_path=path,
        source_root=source_root,
        source=source,
        metadata=metadata,
        validation=checked,
        digest=_digest(path),
        skill_id=_skill_id(metadata.name, source),
        files=tuple(files),
    )


def _metadata_warnings(metadata: SkillMetadata) -> list[str]:
    warnings: list[str] = []
    if metadata.third_party and not any(item.license for item in metadata.third_party):
        warnings.append("third_party entries do not declare a license")
    if metadata.risk == "high" and not metadata.required_tools and not metadata.required_mcp_tools:
        warnings.append("high-risk skills should declare required tools or MCP tools")
    return warnings


def _skill_files(directory: Path, source_root: Path) -> list[SkillFile]:
    result: list[SkillFile] = []
    for path in sorted(directory.rglob("*")):
        if not path.is_file():
            continue
        try:
            relative = path.relative_to(source_root).as_posix()
            size = path.stat().st_size
        except OSError:
            continue
        if path.name == "SKILL.md":
            kind = "skill"
        elif "reference" in path.parts:
            kind = "reference"
        elif path.suffix in {".py", ".js", ".ts", ".sh"}:
            kind = "helper"
        elif path.name in {"requirements.lock", "requirements.txt", "pyproject.toml", "package.json"}:
            kind = "requirement"
        else:
            kind = "other"
        result.append(SkillFile(path=relative, kind=kind, size=size))
    return result


def _scan(directory: Path, source: str, source_root: Path | None = None) -> list[DiscoveredSkill]:
    if not directory.exists() or not directory.is_dir():
        return []
    root = source_root or directory
    result: list[DiscoveredSkill] = []
    for path in sorted(directory.rglob("SKILL.md")):
        try:
            result.append(parse_skill(path, source, root))
        except (OSError, RuntimeError):
            continue
    return result


def _runtime_skill_roots() -> list[Path]:
    from config import PI_CLI_PATH

    cli_path = Path(PI_CLI_PATH).expanduser().resolve()
    if "packages" in cli_path.parts:
        package_index = cli_path.parts.index("packages")
        dev_root = Path(*cli_path.parts[:package_index])
    else:
        dev_root = cli_path.parent
    candidates = [
        dev_root,
        cli_path.parent.parent.parent.parent if "node_modules" in cli_path.parts else cli_path.parent,
        Path(__file__).resolve().parents[2] / "runtime" / "pi",
    ]
    seen: list[Path] = []
    for root in candidates:
        if root.exists() and root not in seen:
            seen.append(root)
    return seen


def discover_raw(cwd: str = ".") -> list[DiscoveredSkill]:
    """Discover all candidates, preserving duplicates for settings toggles."""
    workspace = Path(cwd).expanduser().resolve()
    candidates: list[DiscoveredSkill] = []
    project = workspace / ".pi" / "skills"
    candidates.extend(_scan(project, "project", workspace))
    for user_dir in (Path.home() / ".pi" / "agent" / "skills", Path.home() / ".agents" / "skills"):
        candidates.extend(_scan(user_dir, "user", user_dir))
    candidates.extend(_scan(SKILLS_DIR, "builtin", SKILLS_DIR))
    for root in _runtime_skill_roots():
        candidates.extend(_scan(root / ".pi" / "skills", "builtin", root / ".pi" / "skills"))
        node_modules = root / "node_modules"
        if node_modules.is_dir():
            for child in sorted(node_modules.iterdir()):
                candidates.extend(_scan(child / "skills", "builtin", child / "skills"))
    return candidates


def discover(cwd: str = ".") -> list[DiscoveredSkill]:
    """Return one effective record per skill name using source precedence."""
    all_records = discover_raw(cwd)
    grouped: dict[str, list[DiscoveredSkill]] = {}
    for record in all_records:
        grouped.setdefault(record.metadata.name, []).append(record)
    effective: list[DiscoveredSkill] = []
    for records in grouped.values():
        records.sort(key=lambda item: (_SOURCE_RANK.get(item.source, 99), item.location))
        effective.append(records[0])
    return sorted(effective, key=lambda item: item.metadata.name)


def catalog(cwd: str = ".", enabled_paths: set[str] | None = None) -> list[SkillInfo]:
    enabled_paths = enabled_paths or set()
    all_records = discover_raw(cwd)
    records = discover(cwd)
    by_name: dict[str, list[str]] = {}
    for record in all_records:
        by_name.setdefault(record.metadata.name, []).append(record.source)
    return [
        record.public(
            enabled=(not enabled_paths or str(record.source_path) in enabled_paths),
            shadowed=by_name.get(record.metadata.name, [])[1:],
        )
        for record in records
    ]


def get_skill(skill_id: str, cwd: str = ".") -> DiscoveredSkill | None:
    for record in discover(cwd):
        if record.skill_id == skill_id or record.metadata.name == skill_id:
            return record
    return None


def validate_directory(directory: str | Path) -> list[SkillValidation]:
    path = Path(directory).expanduser().resolve()
    records = _scan(path, "project", path)
    if not records:
        return [SkillValidation(valid=False, errors=[f"no SKILL.md found under {path}"], checked_at=_now())]
    return [record.validation for record in records]
