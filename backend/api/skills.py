"""Skills API — list and manage agent skills."""

import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/skills", tags=["skills"])


class SkillInfo(BaseModel):
    name: str
    description: str
    location: str = ""
    source: str = "project"  # builtin, project, user


class ToolInfo(BaseModel):
    name: str
    found: bool
    version: Optional[str] = None


@router.get("", response_model=list[SkillInfo])
async def list_skills(cwd: str = Query(".", description="Working directory")):
    """List all skills from project, user, and builtin locations."""
    from services.workspace_security import validate_workspace_cwd
    try:
        cwd_path = validate_workspace_cwd(cwd)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))

    return [
        SkillInfo(name=name, description="", location=path, source=source)
        for name, path, source in _discover_all_skills(str(cwd_path))
    ]


def _discover_all_skills(cwd: str = ".") -> list[tuple[str, str, str]]:
    """Discover project, user, bundled, and installed package skills."""
    results: list[tuple[str, str, str]] = []
    project_dir = Path(cwd).expanduser().resolve() / ".pi" / "skills"
    for info in _scan_skills(project_dir, "project"):
        results.append((info.name, info.location, info.source))

    for user_dir in (Path.home() / ".pi" / "agent" / "skills", Path.home() / ".agents" / "skills"):
        for info in _scan_skills(user_dir, "user"):
            results.append((info.name, info.location, info.source))

    # Support both a local Pi checkout and the npm runtime layout.
    from config import PI_CLI_PATH
    cli_path = Path(PI_CLI_PATH).resolve()
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
    seen_roots: set[Path] = set()
    for pi_root in candidates:
        if pi_root in seen_roots or not pi_root.exists():
            continue
        seen_roots.add(pi_root)
        for info in _scan_skills(pi_root / ".pi" / "skills", "builtin"):
            results.append((info.name, info.location, info.source))
        node_modules = pi_root / "node_modules"
        if node_modules.exists():
            for child in node_modules.iterdir():
                skills_dir = child / "skills"
                for info in _scan_skills(skills_dir, "builtin"):
                    results.append((info.name, info.location, info.source))
    return results


@router.get("/tools", response_model=list[ToolInfo])
async def detect_tools():
    """Detect installed scientific tools (concurrent, max 5s total)."""
    tool_specs = [
        ("python", ["python3", "--version"]),
        ("R", ["Rscript", "--version"]),
        ("Node.js", ["node", "--version"]),
        ("Git", ["git", "--version"]),
        ("uv", ["uv", "--version"]),
        ("jupyter", ["jupyter", "--version"]),
    ]

    async def _check(name: str, cmd: list[str]) -> ToolInfo:
        try:
            result = await asyncio.to_thread(
                subprocess.run, cmd, capture_output=True, text=True, timeout=5
            )
            version = (result.stdout or result.stderr).strip().split("\n")[0] if result.returncode == 0 else None
            return ToolInfo(name=name, found=result.returncode == 0, version=version)
        except Exception:
            logger.debug("Tool detection failed for %s", name, exc_info=True)
            return ToolInfo(name=name, found=False)

    return await asyncio.gather(*[_check(name, cmd) for name, cmd in tool_specs])


def _scan_skills(directory: Path, source: str) -> list[SkillInfo]:
    """Scan a directory for SKILL.md files."""
    if not directory.exists():
        return []
    skills = []
    for skill_file in sorted(directory.rglob("SKILL.md")):
        try:
            name, desc = _parse_skill_md(skill_file)
            skills.append(SkillInfo(
                name=name or skill_file.parent.name,
                description=desc or "",
                location=str(skill_file),
                source=source,
            ))
        except Exception:
            logger.debug("Failed to parse skill: %s", skill_file, exc_info=True)
    return skills


def _parse_skill_md(path: Path) -> tuple[Optional[str], Optional[str]]:
    """Parse name and description from SKILL.md frontmatter."""
    text = path.read_text()
    match = re.match(r'^---\s*\n(.*?)\n---', text, re.DOTALL)
    if not match:
        return None, None
    name = None
    desc = None
    for line in match.group(1).split("\n"):
        line = line.strip()
        if line.startswith("name:"):
            name = line.split(":", 1)[1].strip()
        elif line.startswith("description:"):
            desc = line.split(":", 1)[1].strip()
    return name, desc
