"""Skills API — discover, validate, and inspect agent skills."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from config import PI_CLI_PATH
from models.skill import SkillInfo
from services.skill_catalog import catalog, discover_raw, get_skill, validate_directory
from services.workspace_security import validate_workspace_cwd

router = APIRouter(prefix="/api/skills", tags=["skills"])


class ToolInfo(BaseModel):
    name: str
    found: bool
    version: Optional[str] = None


def _safe_cwd(cwd: str) -> str:
    if cwd == ".":
        return cwd
    try:
        return str(validate_workspace_cwd(cwd))
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


def _runtime_roots() -> list[Path]:
    """Return candidate Pi runtime roots for compatibility and diagnostics."""
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
    result: list[Path] = []
    for root in candidates:
        if root.exists() and root not in result:
            result.append(root)
    return result


@router.get("", response_model=list[SkillInfo])
async def list_skills(cwd: str = Query(".", description="Working directory")):
    """List effective skills using project > user > builtin precedence."""
    # ``.`` is useful for the local development workspace even before it is
    # registered. Explicit absolute paths are validated by the catalog's
    # callers before project files are accessed.
    return catalog(_safe_cwd(cwd))


@router.get("/tools", response_model=list[ToolInfo])
async def detect_tools():
    """Detect installed scientific tools."""
    tools = []
    for name, cmd in [("python", ["python3", "--version"]), ("R", ["Rscript", "--version"]),
                       ("Node.js", ["node", "--version"]), ("Git", ["git", "--version"]),
                       ("uv", ["uv", "--version"]), ("jupyter", ["jupyter", "--version"])] :
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            version = (result.stdout or result.stderr).strip().split("\n")[0] if result.returncode == 0 else None
            tools.append(ToolInfo(name=name, found=result.returncode == 0, version=version))
        except Exception:
            tools.append(ToolInfo(name=name, found=False))
    return tools


@router.get("/{skill_id}", response_model=SkillInfo)
async def skill_detail(skill_id: str, cwd: str = Query(".", description="Working directory")):
    record = get_skill(skill_id, _safe_cwd(cwd))
    if record is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    return record.public()


@router.post("/validate")
async def validate_skills(
    cwd: str = Query(".", description="Working directory"),
    path: Optional[str] = Query(None, description="Skill directory or SKILL.md path"),
):
    safe_cwd = _safe_cwd(cwd)
    target = Path(path or safe_cwd).expanduser().resolve()
    if path and safe_cwd != ".":
        workspace = Path(safe_cwd).resolve()
        if not target.is_relative_to(workspace) or ".pi-science" in target.relative_to(workspace).parts:
            raise HTTPException(status_code=403, detail="Skill path must remain inside the workspace")
    if target.is_file():
        target = target.parent
    validations = validate_directory(target)
    return {
        "valid": all(item.valid for item in validations),
        "validations": [item.model_dump() for item in validations],
    }


def _discover_all_skills(cwd: str = ".") -> list[tuple[str, str, str]]:
    """Legacy tuple API consumed by Settings and existing integrations."""
    return [
        (record.metadata.name, str(record.source_path), record.source)
        for record in discover_raw(cwd)
    ]


def _scan_skills(directory: Path, source: str):
    """Compatibility scanner retained for older tests/extensions."""
    return [record.public() for record in discover_raw(str(directory.parent)) if record.source == source]


def _parse_skill_md(path: Path):
    """Compatibility parser returning the old name/description pair."""
    for record in discover_raw(str(path.parent.parent)):
        if record.source_path == path:
            return record.metadata.name, record.metadata.description
    return None, None
