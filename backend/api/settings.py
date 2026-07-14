"""Settings API — manage API keys, model selection, and config."""

import json
import hashlib
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from config import BASE_DIR

router = APIRouter(prefix="/api/settings", tags=["settings"])

CONFIG_FILE = BASE_DIR / "config.json"

# ── Known providers and their env var keys ──
PROVIDER_ENV_MAP: dict[str, str] = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "google": "GEMINI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "groq": "GROQ_API_KEY",
    "cerebras": "CEREBRAS_API_KEY",
    "xai": "XAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "zai": "ZAI_API_KEY",
    "fireworks": "FIREWORKS_API_KEY",
    "together": "TOGETHER_API_KEY",
    "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
    "nvidia": "NVIDIA_API_KEY",
    "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
    "kimi-coding": "KIMI_API_KEY",
    "moonshotai": "MOONSHOT_API_KEY",
    "minimax": "MINIMAX_API_KEY",
    "xiaomi": "XIAOMI_API_KEY",
}

PROVIDERS = [
    {"id": "anthropic", "name": "Anthropic (Claude)", "models": ["claude-sonnet-5-20250929", "claude-opus-4-5", "claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"]},
    {"id": "openai", "name": "OpenAI", "models": ["gpt-5.1", "gpt-4o", "gpt-4.1-mini"]},
    {"id": "google", "name": "Google (Gemini)", "models": ["gemini-2.5-pro", "gemini-2.5-flash"]},
    {"id": "deepseek", "name": "DeepSeek", "models": ["deepseek-v4-pro", "deepseek-chat"]},
    {"id": "groq", "name": "Groq", "models": ["llama-4-maverick", "mixtral-8x7b"]},
    {"id": "openrouter", "name": "OpenRouter", "models": ["openai/gpt-5.1", "anthropic/claude-sonnet-5"]},
]


# ── Request models ──

class ProviderKey(BaseModel):
    provider: str
    api_key: str

class ModelConfig(BaseModel):
    model: str = "anthropic/claude-sonnet-5-20250929"
    thinking: str = "high"  # off, minimal, low, medium, high, max


class CustomProviderRequest(BaseModel):
    """OpenAI-compatible (or Anthropic-compatible) custom endpoint."""
    name: str = "Custom API"
    base_url: str
    api_key: str = ""
    api: Literal["openai-completions", "openai-responses", "anthropic-messages"] = "openai-completions"
    models: list[str] = Field(default_factory=list)


# ── Helpers ──

def _config_file() -> Path:
    """Get config file path, reading PI_SCIENCE_HOME at call time (test-friendly)."""
    import os as _os
    base = Path(_os.environ.get("PI_SCIENCE_HOME", Path.home() / ".pi-science"))
    return base / "config.json"


def _load_config() -> dict:
    cf = _config_file()
    if cf.exists():
        try:
            return json.loads(cf.read_text())
        except json.JSONDecodeError:
            pass
    return {}

def _save_config(data: dict):
    cf = _config_file()
    cf.parent.mkdir(parents=True, exist_ok=True)
    cf.write_text(json.dumps(data, indent=2))


def _custom_provider_id(value: str) -> str:
    """Create a stable, shell/env-safe provider identifier."""
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return (slug or "custom-api")[:48]


def _validate_custom_base_url(value: str) -> str:
    base_url = value.strip().rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("base_url must be an absolute http(s) URL")
    if base_url.lower().endswith("/models"):
        base_url = base_url[:-7].rstrip("/")
    for suffix in ("/chat/completions", "/responses"):
        if base_url.lower().endswith(suffix):
            base_url = base_url[: -len(suffix)].rstrip("/")
    return base_url


def _custom_providers(config: Optional[dict] = None) -> list[dict]:
    raw = (config or _load_config()).get("custom_providers", [])
    if isinstance(raw, dict):
        raw = [dict(value, id=key) for key, value in raw.items() if isinstance(value, dict)]
    if not isinstance(raw, list):
        return []
    result = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            base_url = _validate_custom_base_url(str(item.get("base_url", "")))
        except ValueError:
            continue
        models = [str(model).strip() for model in item.get("models", []) if str(model).strip()]
        result.append({
            "id": _custom_provider_id(str(item.get("id") or item.get("name") or base_url)),
            "name": str(item.get("name") or "Custom API").strip()[:100],
            "base_url": base_url,
            "api_key": str(item.get("api_key") or ""),
            "api": item.get("api") if item.get("api") in {"openai-completions", "openai-responses", "anthropic-messages"} else "openai-completions",
            "models": list(dict.fromkeys(models)),
        })
    return result


def _public_custom_provider(provider: dict) -> dict:
    return {
        "id": provider["id"],
        "name": provider["name"],
        "base_url": provider["base_url"],
        "api": provider["api"],
        "models": provider["models"],
        "has_key": bool(provider.get("api_key")),
    }


def _fetch_custom_models(base_url: str, api_key: str = "") -> list[str]:
    """Discover model IDs from an OpenAI-style GET /models endpoint."""
    normalized = _validate_custom_base_url(base_url)
    headers = {"Accept": "application/json", "User-Agent": "pi-science/0.1"}
    if api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"
    urls = [f"{normalized}/models"]
    if not normalized.lower().endswith("/v1"):
        urls.append(f"{normalized}/v1/models")
    payload = None
    last_error: Exception | None = None
    for models_url in urls:
        request = Request(models_url, headers=headers, method="GET")
        try:
            with urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
            break
        except HTTPError as exc:
            last_error = exc
            if exc.code == 404:
                continue
            raise RuntimeError(f"Model discovery failed ({exc.code})") from exc
        except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            last_error = exc
            continue
    if payload is None:
        raise RuntimeError(f"Model discovery failed: {last_error}")

    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = payload.get("data", payload.get("models", []))
        if isinstance(rows, dict):
            rows = list(rows.values())
    else:
        rows = []

    models: list[str] = []
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, str):
            model_id = row
        elif isinstance(row, dict):
            model_id = row.get("id") or row.get("model") or row.get("name")
        else:
            model_id = None
        if isinstance(model_id, str) and model_id.strip():
            models.append(model_id.strip())
    return list(dict.fromkeys(models))


def _available_models(config: Optional[dict] = None) -> list[dict]:
    config = config or _load_config()
    models = []
    for provider in PROVIDERS:
        for model in provider["models"]:
            models.append({
                "id": f"{provider['id']}/{model}",
                "provider": provider["id"],
                "model": model,
                "label": f"{provider['name']} · {model}",
                "custom": False,
            })
    for provider in _custom_providers(config):
        for model in provider["models"]:
            models.append({
                "id": f"custom-{provider['id']}/{model}",
                "provider": f"custom-{provider['id']}",
                "model": model,
                "label": f"{provider['name']} · {model}",
                "custom": True,
            })
    return models


def get_custom_models_runtime(cwd: Optional[str] = None) -> tuple[Optional[Path], dict[str, str]]:
    """Materialize custom providers as a pi models.json plus env-backed keys."""
    providers = _custom_providers()
    if not providers:
        return None, {}

    key = hashlib.sha256(str(Path(cwd).expanduser().resolve() if cwd else "default").encode()).hexdigest()[:12]
    agent_dir = _config_file().parent / "pi-agent" / key
    agent_dir.mkdir(parents=True, exist_ok=True)
    definitions = {"providers": {}}
    env: dict[str, str] = {}
    for provider in providers:
        provider_id = f"custom-{provider['id']}"
        env_name = f"PI_SCIENCE_CUSTOM_{_custom_provider_id(provider['id']).upper().replace('-', '_')}_API_KEY"
        definition = {
            "name": provider["name"],
            "baseUrl": provider["base_url"],
            "api": provider["api"],
            "models": [
                {
                    "id": model,
                    "name": model,
                    "reasoning": False,
                    "input": ["text"],
                    "contextWindow": 128000,
                    "maxTokens": 16384,
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                }
                for model in provider["models"]
            ],
        }
        if provider.get("api_key"):
            definition["apiKey"] = f"${env_name}"
            env[env_name] = provider["api_key"]
        definitions["providers"][provider_id] = definition

    (agent_dir / "models.json").write_text(json.dumps(definitions, indent=2) + "\n")
    return agent_dir, env

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
    return {
        "api_keys": keys,  # bool only: has_key or not
        "model": config.get("model", "anthropic/claude-sonnet-5-20250929"),
        "thinking": config.get("thinking", "high"),
        "providers": PROVIDERS,
        "custom_providers": [_public_custom_provider(provider) for provider in _custom_providers(config)],
        "available_models": _available_models(config),
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
    _save_config(config)
    return {"ok": True, "provider": provider}


@router.put("/model")
async def set_model(body: ModelConfig):
    """Set default model and thinking level."""
    config = _load_config()
    config["model"] = body.model
    config["thinking"] = body.thinking
    _save_config(config)
    return {"ok": True, "model": body.model, "thinking": body.thinking}


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
