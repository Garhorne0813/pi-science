"""Agent Profile catalog and permission-aware CRUD."""

from fastapi import APIRouter, HTTPException

from api.settings import _load_config, _save_config
from models.agent_profile import AgentProfile, AgentProfileRequest

router = APIRouter(prefix="/api/agent-profiles", tags=["agent-profiles"])


def _builtins() -> list[AgentProfile]:
    return [
        AgentProfile(name="SCIENCE", display_name="Science Agent", description="General scientific workbench agent", unrestricted=True, source="builtin"),
        AgentProfile(name="RESULT_REVIEWER", display_name="Result Reviewer", description="Read-only transcript and artifact consistency reviewer", skills=["literature-review"], read_scope=["workspace", "transcript", "artifacts"], write_scope=[], source="builtin"),
        AgentProfile(name="BOOKMARKER", display_name="Transcript Bookmarker", description="Selects durable navigation breadcrumbs", skills=[], read_scope=["transcript"], write_scope=["bookmarks"], source="builtin"),
    ]


def _custom() -> list[AgentProfile]:
    rows = _load_config().get("agent_profiles", [])
    return [AgentProfile.model_validate(row) for row in rows if isinstance(row, dict)]


@router.get("")
async def list_profiles():
    return {"profiles": [item.model_dump() for item in [*_builtins(), *_custom()]]}


@router.post("")
async def create_profile(body: AgentProfileRequest):
    if body.name in {item.name for item in _builtins()}:
        raise HTTPException(status_code=409, detail="Built-in profile cannot be replaced")
    profile = AgentProfile.model_validate({**body.model_dump(), "source": "user"})
    config = _load_config()
    rows = [row for row in config.get("agent_profiles", []) if row.get("name") != profile.name]
    rows.append(profile.model_dump())
    config["agent_profiles"] = rows
    _save_config(config)
    return profile.model_dump()


@router.put("/{name}")
async def update_profile(name: str, body: AgentProfileRequest):
    if name in {item.name for item in _builtins()}:
        raise HTTPException(status_code=403, detail="Built-in profile is read-only")
    config = _load_config()
    rows = config.get("agent_profiles", [])
    if not any(row.get("name") == name for row in rows):
        raise HTTPException(status_code=404, detail="Agent profile not found")
    profile = AgentProfile.model_validate({**body.model_dump(), "source": "user"})
    config["agent_profiles"] = [profile.model_dump() if row.get("name") == name else row for row in rows]
    _save_config(config)
    return profile.model_dump()


@router.delete("/{name}")
async def delete_profile(name: str):
    if name in {item.name for item in _builtins()}:
        raise HTTPException(status_code=403, detail="Built-in profile is read-only")
    config = _load_config()
    rows = config.get("agent_profiles", [])
    next_rows = [row for row in rows if row.get("name") != name]
    if len(next_rows) == len(rows):
        raise HTTPException(status_code=404, detail="Agent profile not found")
    config["agent_profiles"] = next_rows
    _save_config(config)
    return {"ok": True, "name": name}

