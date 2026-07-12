"""Settings API — manage API keys, model selection, and config."""

import json
import os
from pathlib import Path
from typing import Optional

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

@router.get("/mcp")
async def get_mcp_servers():
    """Get the list of enabled MCP servers."""
    config = _load_config()
    return {"servers": config.get("mcp_servers", [])}


@router.put("/mcp/{server_id}")
async def toggle_mcp_server(server_id: str, enabled: bool = Query(True)):
    """Enable or disable an MCP server."""
    config = _load_config()
    servers = set(config.get("mcp_servers", []))
    if enabled:
        servers.add(server_id)
    else:
        servers.discard(server_id)
    config["mcp_servers"] = sorted(servers)
    _save_config(config)
    return {"ok": True, "server": server_id, "enabled": enabled}
