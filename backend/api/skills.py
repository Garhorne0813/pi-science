"""Skills API — list and manage agent skills."""

import glob
import os
import re
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

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
    skills = []
    cwd_path = Path(cwd).resolve()

    # 1. Project skills: .pi/skills/
    project_dir = cwd_path / ".pi" / "skills"
    skills.extend(_scan_skills(project_dir, "project"))

    # 2. User skills: ~/.pi/agent/skills/
    user_dir = Path.home() / ".pi" / "agent" / "skills"
    skills.extend(_scan_skills(user_dir, "user"))

    # 3. Builtin: bundled with pi
    pi_repo = Path(__file__).parent.parent.parent.parent / "pi"
    if pi_repo.exists():
        builtin_dir = pi_repo / ".pi" / "skills"
        skills.extend(_scan_skills(builtin_dir, "builtin"))

    return skills


@router.get("/tools", response_model=list[ToolInfo])
async def detect_tools():
    """Detect installed scientific tools."""
    tools = []
    for name, cmd in [("python", ["python3", "--version"]), ("R", ["Rscript", "--version"]),
                       ("Node.js", ["node", "--version"]), ("Git", ["git", "--version"]),
                       ("uv", ["uv", "--version"]), ("jupyter", ["jupyter", "--version"])]:
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            version = (result.stdout or result.stderr).strip().split("\n")[0] if result.returncode == 0 else None
            tools.append(ToolInfo(name=name, found=result.returncode == 0, version=version))
        except Exception:
            tools.append(ToolInfo(name=name, found=False))
    return tools


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
            pass
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
