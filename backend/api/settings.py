"""Settings API — manage API keys, model selection, and config."""

import json
import hashlib
import os
import re
from urllib.parse import urlparse
from pathlib import Path
from typing import Literal, Optional

import yaml
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from config import BASE_DIR
from services.model_registry import (
    PROVIDER_ENV_MAP,
    PROVIDERS,
    available_models,
    clamp_thinking_level,
    custom_models_runtime,
    custom_provider_id,
    custom_providers,
    fetch_custom_models,
    public_custom_provider,
    validate_custom_base_url,
)
from services.runtime_extensions import runtime_extension_status
from services.settings_store import config_file, load_config, save_config
from services.workspace_security import validate_workspace_cwd

router = APIRouter(prefix="/api/settings", tags=["settings"])

CONFIG_FILE = BASE_DIR / "config.json"


# ── Request models ──

class ProviderKey(BaseModel):
    provider: str
    api_key: str

class ModelConfig(BaseModel):
    model: str = ""
    thinking: str = "high"  # off, minimal, low, medium, high, max


class CustomProviderRequest(BaseModel):
    """OpenAI-compatible (or Anthropic-compatible) custom endpoint."""
    name: str = "Custom API"
    base_url: str
    api_key: str = ""
    api: Literal["openai-completions", "openai-responses", "anthropic-messages"] = "openai-completions"
    models: list[str] = Field(default_factory=list)


WEB_SEARCH_KEY_ENV_MAP: dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "exa": "EXA_API_KEY",
    "brave": "BRAVE_API_KEY",
    "parallel": "PARALLEL_API_KEY",
    "tavily": "TAVILY_API_KEY",
    "perplexity": "PERPLEXITY_API_KEY",
    "gemini": "GEMINI_API_KEY",
}
WEB_SEARCH_PROVIDERS = ["auto", *WEB_SEARCH_KEY_ENV_MAP]
WEB_SEARCH_WORKFLOWS = ["none", "summary-review", "auto-summary"]


class WebAccessConfigRequest(BaseModel):
    provider: Literal["auto", "openai", "exa", "brave", "parallel", "tavily", "perplexity", "gemini"] = "auto"
    workflow: Literal["none", "summary-review", "auto-summary"] = "none"
    api_keys: dict[str, str] = Field(default_factory=dict)
    remove_keys: list[str] = Field(default_factory=list)


class SubagentConfigRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=300)
    prompt: str = Field(min_length=1, max_length=50_000)
    model: str = Field(default="", max_length=200)
    thinking: str = Field(default="", max_length=32)
    tools: str = Field(default="", max_length=1000)
    system_prompt_mode: Literal["replace", "append"] = "replace"
    inherit_project_context: bool = True
    inherit_skills: bool = False
    default_context: Literal["fresh", "fork"] = "fresh"


@router.get("/extensions")
async def list_runtime_extensions():
    """Report extension entrypoints that the next Pi process will actually load."""
    return {"extensions": runtime_extension_status()}


def _web_access_public(config: Optional[dict] = None) -> dict:
    full_config = config or _load_config()
    payload = full_config.get("web_access", {})
    stored = payload.get("api_keys", {}) if isinstance(payload, dict) else {}
    llm_keys = full_config.get("api_keys", {})
    provider = payload.get("provider", "auto") if isinstance(payload, dict) else "auto"
    workflow = payload.get("workflow", "none") if isinstance(payload, dict) else "none"
    return {
        "provider": provider if provider in WEB_SEARCH_PROVIDERS else "auto",
        "workflow": workflow if workflow in WEB_SEARCH_WORKFLOWS else "none",
        "providers": [
            {
                "id": provider_id,
                "has_key": bool(stored.get(provider_id)) or bool(os.environ.get(env_name)) or (
                    provider_id == "openai" and bool(llm_keys.get("openai"))
                ) or (provider_id == "gemini" and bool(llm_keys.get("google"))),
                "key_source": (
                    "web-access"
                    if stored.get(provider_id)
                    else "environment"
                    if os.environ.get(env_name)
                    else "llm-settings"
                    if (provider_id == "openai" and llm_keys.get("openai"))
                    or (provider_id == "gemini" and llm_keys.get("google"))
                    else None
                ),
                "env": env_name,
            }
            for provider_id, env_name in WEB_SEARCH_KEY_ENV_MAP.items()
        ],
    }


@router.get("/web-access")
async def get_web_access_config():
    """Return web-search preferences and key presence without exposing secrets."""
    return _web_access_public()


@router.put("/web-access")
async def set_web_access_config(body: WebAccessConfigRequest):
    """Persist web-search preferences and extension-specific API keys."""
    unknown = (set(body.api_keys) | set(body.remove_keys)) - set(WEB_SEARCH_KEY_ENV_MAP)
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown web search provider: {sorted(unknown)[0]}")
    config = _load_config()
    web_access = config.setdefault("web_access", {})
    web_access["provider"] = body.provider
    web_access["workflow"] = body.workflow
    stored = web_access.setdefault("api_keys", {})
    for provider_id, value in body.api_keys.items():
        if value.strip():
            stored[provider_id] = value.strip()
    for provider_id in body.remove_keys:
        stored.pop(provider_id, None)
    _save_config(config)
    return {"ok": True, **_web_access_public(config)}


_SUBAGENT_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def _subagent_dir(cwd: str) -> Path:
    try:
        workspace = validate_workspace_cwd(cwd)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return workspace / ".pi" / "agents"


def _parse_subagent(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    metadata: dict = {}
    prompt = text
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end >= 0:
            try:
                parsed = yaml.safe_load(text[4:end]) or {}
                metadata = parsed if isinstance(parsed, dict) else {}
            except yaml.YAMLError:
                metadata = {}
            prompt = text[end + 5:].lstrip("\n")
    return {
        "name": str(metadata.get("name") or path.stem),
        "description": str(metadata.get("description") or ""),
        "prompt": prompt,
        "model": str(metadata.get("model") or ""),
        "thinking": str(metadata.get("thinking") or ""),
        "tools": str(metadata.get("tools") or ""),
        "system_prompt_mode": str(metadata.get("systemPromptMode") or "replace"),
        "inherit_project_context": bool(metadata.get("inheritProjectContext", True)),
        "inherit_skills": bool(metadata.get("inheritSkills", False)),
        "default_context": str(metadata.get("defaultContext") or "fresh"),
        "path": str(path),
    }


@router.get("/subagents")
async def list_project_subagents(cwd: str = Query(...)):
    directory = _subagent_dir(cwd)
    agents = []
    if directory.is_dir():
        for path in sorted(directory.glob("*.md")):
            try:
                agents.append(_parse_subagent(path))
            except OSError:
                continue
    return {"agents": agents}


@router.put("/subagents/{agent_name}")
async def save_project_subagent(agent_name: str, body: SubagentConfigRequest, cwd: str = Query(...)):
    if not _SUBAGENT_NAME.fullmatch(agent_name) or body.name != agent_name:
        raise HTTPException(status_code=400, detail="Agent name must use lowercase letters, numbers, hyphens, or underscores")
    directory = _subagent_dir(cwd)
    directory.mkdir(parents=True, exist_ok=True)
    metadata = {
        "name": body.name,
        "description": body.description,
        **({"model": body.model} if body.model else {}),
        **({"thinking": body.thinking} if body.thinking else {}),
        **({"tools": body.tools} if body.tools else {}),
        "systemPromptMode": body.system_prompt_mode,
        "inheritProjectContext": body.inherit_project_context,
        "inheritSkills": body.inherit_skills,
        "defaultContext": body.default_context,
    }
    frontmatter = yaml.safe_dump(metadata, sort_keys=False, allow_unicode=True).strip()
    target = directory / f"{agent_name}.md"
    target.write_text(f"---\n{frontmatter}\n---\n\n{body.prompt.rstrip()}\n", encoding="utf-8")
    return {"ok": True, "agent": _parse_subagent(target), "restart_required": True}


@router.delete("/subagents/{agent_name}")
async def delete_project_subagent(agent_name: str, cwd: str = Query(...)):
    if not _SUBAGENT_NAME.fullmatch(agent_name):
        raise HTTPException(status_code=400, detail="Invalid agent name")
    target = _subagent_dir(cwd) / f"{agent_name}.md"
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Subagent not found")
    target.unlink()
    return {"ok": True, "restart_required": True}


# ── Helpers ──

def _config_file() -> Path:
    """Get config file path, reading PI_SCIENCE_HOME at call time (test-friendly)."""
    return config_file()


def _load_config() -> dict:
    return load_config()

def _save_config(data: dict):
    """Atomically save config to prevent corruption on concurrent writes."""
    save_config(data)


def _custom_provider_id(value: str) -> str:
    return custom_provider_id(value)


def _validate_custom_base_url(value: str) -> str:
    return validate_custom_base_url(value)


def _custom_providers(config: Optional[dict] = None) -> list[dict]:
    return custom_providers(config or _load_config())


def _public_custom_provider(provider: dict) -> dict:
    return public_custom_provider(provider)


def _fetch_custom_models(base_url: str, api_key: str = "") -> list[str]:
    return fetch_custom_models(base_url, api_key)


def _clamp_thinking_level(requested: str, supported: list[str]) -> str:
    return clamp_thinking_level(requested, supported)


def _available_models(config: Optional[dict] = None) -> list[dict]:
    return available_models(config or _load_config(), _get_active_api_keys())


def get_custom_models_runtime(cwd: Optional[str] = None) -> tuple[Optional[Path], dict[str, str]]:
    return custom_models_runtime(_load_config(), _config_file().parent, cwd)


def get_web_access_runtime(cwd: Optional[str], agent_dir: Optional[Path] = None) -> Optional[Path]:
    """Materialize non-secret pi-web-access preferences in Pi's active config dir."""
    config = _load_config()
    payload = config.get("web_access")
    if not isinstance(payload, dict):
        return agent_dir
    provider = payload.get("provider", "auto")
    workflow = payload.get("workflow", "none")
    if provider not in WEB_SEARCH_PROVIDERS:
        provider = "auto"
    if workflow not in WEB_SEARCH_WORKFLOWS:
        workflow = "none"
    if agent_dir is None:
        identity = str(Path(cwd).expanduser().resolve() if cwd else "default")
        key = hashlib.sha256(identity.encode()).hexdigest()[:12]
        agent_dir = _config_file().parent / "pi-agent" / key
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "web-search.json").write_text(
        json.dumps({"provider": provider, "workflow": workflow}, indent=2) + "\n",
        encoding="utf-8",
    )
    return agent_dir


def _current_env_has_key(provider: str) -> bool:
    """Check if API key is already in environment variables."""
    env_var = PROVIDER_ENV_MAP.get(provider)
    if env_var:
        return bool(os.environ.get(env_var))
    return False

def _get_active_api_keys() -> dict[str, bool]:
    """Returns which providers have active API keys (from env or config)."""
    config = _load_config()
    stored = config.get("api_keys", {})
    result = {}
    for pid in PROVIDER_ENV_MAP:
        result[pid] = (
            _current_env_has_key(pid) or
            bool(stored.get(pid))
        )
    return result


# ── Endpoints ──

@router.get("/providers")
async def list_providers():
    """List all supported LLM providers with model suggestions."""
    keys = _get_active_api_keys()
    return {
        "providers": [
            {**p, "has_key": keys.get(p["id"], False)}
            for p in PROVIDERS
        ],
    }


@router.get("/config")
async def get_config():
    """Get full configuration (API key status only, never actual keys)."""
    config = _load_config()
    keys = _get_active_api_keys()
    available_models = _available_models(config)
    available_ids = {item["id"] for item in available_models}
    configured_model = str(config.get("model") or "")
    effective_model = configured_model if configured_model in available_ids else ""
    selected = next((item for item in available_models if item["id"] == effective_model), None)
    configured_thinking = str(config.get("thinking") or "high")
    effective_thinking = _clamp_thinking_level(
        configured_thinking,
        selected["thinking_levels"] if selected else ["off"],
    )
    return {
        "api_keys": keys,  # bool only: has_key or not
        "model": effective_model,
        "thinking": effective_thinking,
        "providers": PROVIDERS,
        "custom_providers": [_public_custom_provider(provider) for provider in _custom_providers(config)],
        "available_models": available_models,
    }


@router.put("/api-key")
async def set_api_key(body: ProviderKey):
    """Store an API key for a provider."""
    if body.provider not in PROVIDER_ENV_MAP:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {body.provider}")

    config = _load_config()
    config.setdefault("api_keys", {})
    config["api_keys"][body.provider] = body.api_key
    _save_config(config)
    return {"ok": True, "provider": body.provider}


@router.delete("/api-key/{provider}")
async def delete_api_key(provider: str):
    """Remove a stored API key."""
    config = _load_config()
    config.get("api_keys", {}).pop(provider, None)
    if str(config.get("model") or "").startswith(f"{provider}/"):
        config["model"] = ""
    _save_config(config)
    return {"ok": True, "provider": provider}


@router.put("/model")
async def set_model(body: ModelConfig):
    """Set default model and thinking level."""
    config = _load_config()
    available_models = _available_models(config)
    selected = next((item for item in available_models if item["id"] == body.model), None)
    if body.model and selected is None:
        raise HTTPException(status_code=400, detail="Model requires a configured provider")
    thinking = _clamp_thinking_level(body.thinking, selected["thinking_levels"] if selected else ["off"])
    config["model"] = body.model
    config["thinking"] = thinking
    _save_config(config)
    return {"ok": True, "model": body.model, "thinking": thinking}


@router.get("/custom-providers")
async def list_custom_providers():
    """List custom endpoints without returning stored API keys."""
    return {"providers": [_public_custom_provider(provider) for provider in _custom_providers()]}


@router.post("/custom-providers/discover")
async def discover_custom_provider(body: CustomProviderRequest):
    """Discover model IDs from a custom provider's /models endpoint."""
    try:
        base_url = _validate_custom_base_url(body.base_url)
        import asyncio
        models = await asyncio.to_thread(_fetch_custom_models, base_url, body.api_key)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    provider_id = _custom_provider_id(body.name or urlparse(base_url).netloc)
    return {
        "ok": True,
        "provider": {
            "id": provider_id,
            "name": body.name.strip() or "Custom API",
            "base_url": base_url,
            "api": body.api,
            "models": models,
            "has_key": bool(body.api_key.strip()),
        },
    }


@router.put("/custom-providers/{provider_id}")
async def save_custom_provider(provider_id: str, body: CustomProviderRequest):
    """Save a custom provider and its discovered model list."""
    try:
        base_url = _validate_custom_base_url(body.base_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    provider_id = _custom_provider_id(provider_id)
    models = list(dict.fromkeys(model.strip() for model in body.models if model.strip()))
    if not models:
        raise HTTPException(status_code=400, detail="At least one model is required")

    config = _load_config()
    providers = _custom_providers(config)
    existing = next((provider for provider in providers if provider["id"] == provider_id), None)
    provider = {
        "id": provider_id,
        "name": body.name.strip() or provider_id,
        "base_url": base_url,
        "api_key": body.api_key.strip() or (existing.get("api_key", "") if existing else ""),
        "api": body.api,
        "models": models,
    }
    providers = [provider if item["id"] == provider_id else item for item in providers]
    if existing is None:
        providers.append(provider)
    config["custom_providers"] = providers
    _save_config(config)
    return {"ok": True, "provider": _public_custom_provider(provider)}


@router.delete("/custom-providers/{provider_id}")
async def delete_custom_provider(provider_id: str):
    """Remove a custom provider and its stored key."""
    config = _load_config()
    normalized = _custom_provider_id(provider_id)
    config["custom_providers"] = [
        provider for provider in _custom_providers(config) if provider["id"] != normalized
    ]
    if str(config.get("model") or "").startswith(f"custom-{normalized}/"):
        config["model"] = ""
    _save_config(config)
    return {"ok": True, "id": normalized}


def get_env_with_keys(extra_env: dict = None) -> dict:
    """Return a copy of os.environ with stored API keys injected.
    This is called by pi_manager before spawning a pi process.
    """
    env = os.environ.copy()
    config = _load_config()
    stored_keys = config.get("api_keys", {})

    for provider, api_key in stored_keys.items():
        env_var = PROVIDER_ENV_MAP.get(provider)
        if env_var and api_key:
            if env_var not in os.environ or not os.environ[env_var]:
                env[env_var] = api_key

    web_keys = config.get("web_access", {}).get("api_keys", {})
    if isinstance(web_keys, dict):
        for provider, api_key in web_keys.items():
            env_var = WEB_SEARCH_KEY_ENV_MAP.get(provider)
            if env_var and isinstance(api_key, str) and api_key:
                if env_var not in os.environ or not os.environ[env_var]:
                    env[env_var] = api_key

    if extra_env:
        env.update(extra_env)

    return env


# ── MCP Server Management ──

def _mcp_source_path(config: Optional[dict] = None, cwd: Optional[str] = None) -> Optional[Path]:
    """Locate the standard MCP config used by the pi-mcp-adapter."""
    config = config or _load_config()
    configured = config.get("mcp_config_path")
    if configured:
        candidate = Path(configured).expanduser()
        if not candidate.is_absolute():
            candidate = _config_file().parent / candidate
        if candidate.exists():
            return candidate.resolve()

    workspace = Path(cwd).expanduser().resolve() if cwd else None
    candidates = [
        *((workspace / name for name in (".mcp.json", ".pi/mcp.json")) if workspace else ()),
        _config_file().parent / "mcp.json",
        Path.cwd() / ".mcp.json",
        Path.home() / ".config" / "mcp" / "mcp.json",
        Path.home() / ".pi" / "agent" / "mcp.json",
    ]
    return next((p.resolve() for p in candidates if p.exists()), None)


def _load_mcp_definitions(path: Optional[Path]) -> dict:
    if path is None:
        return {}
    try:
        data = json.loads(path.read_text())
        servers = data.get("mcpServers", data.get("mcp-servers", {}))
        return servers if isinstance(servers, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def get_mcp_runtime_config(cwd: Optional[str] = None) -> Optional[Path]:
    """Write and return a filtered MCP config for the next pi process.

    The adapter supports ``--mcp-config``. We use it to turn the Settings
    allowlist into actual runtime behavior while leaving the user's source
    config untouched.
    """
    config = _load_config()
    source = _mcp_source_path(config, cwd)
    definitions = _load_mcp_definitions(source)
    if not definitions:
        return None

    configured_names = set(definitions)
    enabled = config.get("mcp_servers")
    enabled_names = configured_names if enabled is None else set(enabled) & configured_names
    filtered = {name: definitions[name] for name in sorted(enabled_names)}
    runtime_root = _config_file().parent
    runtime_root.mkdir(parents=True, exist_ok=True)
    if cwd:
        key = hashlib.sha256(str(Path(cwd).expanduser().resolve()).encode()).hexdigest()[:12]
        runtime_path = runtime_root / f"mcp-runtime-{key}.json"
    else:
        runtime_path = runtime_root / "mcp-runtime.json"
    runtime_path.write_text(json.dumps({"mcpServers": filtered}, indent=2) + "\n")
    return runtime_path

@router.get("/mcp")
async def get_mcp_servers():
    """Get the list of enabled MCP servers."""
    config = _load_config()
    source = _mcp_source_path(config)
    definitions = _load_mcp_definitions(source)
    configured_names = sorted(definitions)
    enabled = config.get("mcp_servers")
    enabled_names = configured_names if enabled is None else sorted(set(enabled) & set(configured_names))
    return {
        "servers": enabled_names,
        "configured": configured_names,
        "config_path": str(source) if source else None,
    }


@router.put("/mcp/{server_id}")
async def toggle_mcp_server(server_id: str, enabled: bool = Query(True)):
    """Enable or disable an MCP server."""
    config = _load_config()
    source = _mcp_source_path(config)
    definitions = _load_mcp_definitions(source)
    if not definitions:
        raise HTTPException(
            status_code=409,
            detail="No MCP server definitions found. Add a standard mcp.json first.",
        )
    if definitions and server_id not in definitions:
        raise HTTPException(status_code=404, detail=f"MCP server not found in {source}")

    # With no explicit allowlist, all configured servers are enabled by
    # default. Materialize that set before applying a toggle.
    servers = set(config.get("mcp_servers", definitions.keys()))
    if enabled:
        servers.add(server_id)
    else:
        servers.discard(server_id)
    config["mcp_servers"] = sorted(servers)
    _save_config(config)
    runtime_path = get_mcp_runtime_config()
    return {
        "ok": True,
        "server": server_id,
        "enabled": enabled,
        "runtime_config": str(runtime_path) if runtime_path else None,
    }


# ── Skill Management ──


class SkillToggleRequest(BaseModel):
    name: str
    enabled: bool = True


@router.get("/skills")
async def get_skills_state():
    """Return discovered skills and their effective enabled state."""
    from api.skills import _discover_all_skills
    from services.skill_catalog import catalog as skill_catalog

    config = _load_config()
    configured = bool(config.get("skills_configured", False))
    enabled_paths = set(config.get("skill_paths", []))
    metadata = {item.name: item for item in skill_catalog(".")}
    skills = []
    for name, path, source in _discover_all_skills():
        record = metadata.get(name)
        skills.append({
            "name": name,
            "path": path,
            "source": source,
            "enabled": path in enabled_paths if configured else True,
            "skill_id": record.skill_id if record else None,
            "digest": record.digest if record else None,
            "quality": record.quality if record else "draft",
            "validation": record.validation.model_dump() if record else None,
        })
    return {"skills": skills, "configured": configured}


@router.put("/skills/toggle")
async def toggle_skill(body: SkillToggleRequest):
    """Enable or disable one skill for subsequently spawned Pi processes."""
    from api.skills import _discover_all_skills

    config = _load_config()
    discovered = _discover_all_skills()
    name_to_path = {name: path for name, path, _source in discovered}
    if body.name not in name_to_path:
        raise HTTPException(status_code=404, detail=f"Skill '{body.name}' not found")

    if config.get("skills_configured"):
        enabled_paths = set(config.get("skill_paths", []))
    else:
        enabled_paths = {path for _name, path, _source in discovered}
    skill_path = name_to_path[body.name]
    if body.enabled:
        enabled_paths.add(skill_path)
    else:
        enabled_paths.discard(skill_path)
    config["skills_configured"] = True
    config["skill_paths"] = sorted(enabled_paths)
    _save_config(config)
    return {
        "ok": True,
        "name": body.name,
        "enabled": body.enabled,
        "enabled_count": len(enabled_paths),
        "total_count": len(discovered),
    }


@router.delete("/skills")
async def reset_skills():
    """Return skill loading to automatic discovery mode."""
    config = _load_config()
    config.pop("skills_configured", None)
    config.pop("skill_paths", None)
    _save_config(config)
    return {"ok": True, "message": "Skills reset to auto-discover mode"}
