"""Model provider registry and Pi runtime materialization."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from services.pi_model_capabilities import get_pi_model_capability


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
    {"id": "anthropic", "name": "Anthropic", "models": ["claude-fable-5", "claude-opus-4-5", "claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"]},
    {"id": "openai", "name": "OpenAI", "models": ["gpt-5.1", "gpt-5.1-codex", "gpt-4o", "gpt-4.1", "gpt-4.1-mini"]},
    {"id": "google", "name": "Gemini", "models": ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-3-flash-preview"]},
    {"id": "deepseek", "name": "DeepSeek", "models": ["deepseek-v4-pro", "deepseek-v4-flash"]},
    {"id": "groq", "name": "Groq", "models": ["meta-llama/llama-4-scout-17b-16e-instruct", "llama-3.3-70b-versatile"]},
    {"id": "openrouter", "name": "OpenRouter", "models": ["anthropic/claude-sonnet-5", "openai/gpt-5.1"]},
    {"id": "cerebras", "name": "Cerebras", "models": ["gpt-oss-120b", "gemma-4-31b", "zai-glm-4.7"]},
    {"id": "xai", "name": "xAI", "models": ["grok-4.5", "grok-4.3", "grok-3"]},
    {"id": "mistral", "name": "Mistral", "models": ["devstral-latest", "devstral-medium-latest", "codestral-latest"]},
    {"id": "zai", "name": "Z.AI", "models": ["glm-5.2", "glm-5.1", "glm-4.7"]},
    {"id": "fireworks", "name": "Fireworks", "models": ["accounts/fireworks/models/deepseek-v4-pro"]},
    {"id": "together", "name": "Together", "models": ["Qwen/Qwen3.5-397B-A17B", "MiniMaxAI/MiniMax-M3"]},
    {"id": "vercel-ai-gateway", "name": "Vercel AI Gateway", "models": []},
    {"id": "nvidia", "name": "NVIDIA NIM", "models": ["meta/llama-3.3-70b-instruct", "minimaxai/minimax-m3"]},
    {"id": "cloudflare-workers-ai", "name": "Cloudflare Workers AI", "models": []},
    {"id": "kimi-coding", "name": "Kimi", "models": ["kimi-k2-thinking", "kimi-for-coding", "k2p7"]},
    {"id": "moonshotai", "name": "Moonshot", "models": ["kimi-k2.5", "kimi-k2-thinking-turbo"]},
    {"id": "minimax", "name": "MiniMax", "models": ["MiniMax-M3", "MiniMax-M2.7"]},
    {"id": "xiaomi", "name": "Xiaomi", "models": ["mimo-v2.5-pro", "mimo-v2-pro", "mimo-v2-flash"]},
]


THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]


def custom_provider_id(value: str) -> str:
    """Create a stable, shell/env-safe provider identifier."""
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return (slug or "custom-api")[:48]


def validate_custom_base_url(value: str) -> str:
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


def custom_providers(config: Optional[dict] = None) -> list[dict]:
    raw = (config or {}).get("custom_providers", [])
    if isinstance(raw, dict):
        raw = [dict(value, id=key) for key, value in raw.items() if isinstance(value, dict)]
    if not isinstance(raw, list):
        return []
    result = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            base_url = validate_custom_base_url(str(item.get("base_url", "")))
        except ValueError:
            continue
        models = [str(model).strip() for model in item.get("models", []) if str(model).strip()]
        result.append({
            "id": custom_provider_id(str(item.get("id") or item.get("name") or base_url)),
            "name": str(item.get("name") or "Custom API").strip()[:100],
            "base_url": base_url,
            "api_key": str(item.get("api_key") or ""),
            "api": item.get("api") if item.get("api") in {"openai-completions", "openai-responses", "anthropic-messages"} else "openai-completions",
            "models": list(dict.fromkeys(models)),
        })
    return result


def public_custom_provider(provider: dict) -> dict:
    return {
        "id": provider["id"],
        "name": provider["name"],
        "base_url": provider["base_url"],
        "api": provider["api"],
        "models": provider["models"],
        "has_key": bool(provider.get("api_key")),
    }


def fetch_custom_models(base_url: str, api_key: str = "") -> list[str]:
    """Discover model IDs from an OpenAI-style GET /models endpoint."""
    normalized = validate_custom_base_url(base_url)
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


def model_capability(provider_id: str, model_id: str, *, custom: bool, api: str | None = None) -> dict:
    capability = get_pi_model_capability(provider_id, model_id, api=api)
    if capability:
        return capability
    reasoning = custom_model_supports_reasoning(model_id) if custom else False
    levels = ["off", "minimal", "low", "medium", "high"] if reasoning else ["off"]
    if reasoning and custom_model_supports_max(model_id):
        levels.extend(["xhigh", "max"])
    return {
        "reasoning": reasoning,
        "thinking_levels": levels,
        "thinking_level_map": None,
        "capability_source": "heuristic" if custom else "fallback",
    }


def clamp_thinking_level(requested: str, supported: list[str]) -> str:
    if requested in supported:
        return requested
    requested_index = THINKING_LEVELS.index(requested) if requested in THINKING_LEVELS else 0
    for candidate in THINKING_LEVELS[requested_index:]:
        if candidate in supported:
            return candidate
    for candidate in reversed(THINKING_LEVELS[:requested_index]):
        if candidate in supported:
            return candidate
    return supported[0] if supported else "off"


def custom_model_supports_reasoning(model_id: str) -> bool:
    """Infer thinking support from common reasoning-model naming schemes."""
    value = model_id.strip().lower()
    if any(token in value for token in ("gpt-5", "reasoning", "thinking", "thinker", "deepseek-r1", "qwq", "qwen3")):
        return True
    if re.search(r"(^|[-_/])(o1|o3|o4|r1)([-_./]|$)", value):
        return True
    if "claude" in value and any(token in value for token in ("3-7", "3.7", "sonnet-4", "opus-4", "haiku-4")):
        return True
    if "gemini-2.5" in value or "gemini-3" in value:
        return True
    return False


def custom_model_supports_max(model_id: str) -> bool:
    """Conservatively identify custom models that accept a literal ``max``."""
    value = model_id.strip().lower()
    return any(token in value for token in (
        "gpt-5.6",
        "codex",
        "reasoning-max",
        "thinking-max",
        "deepseek-r1",
        "qwq",
        "qwen3",
    ))


def custom_model_definition(provider: dict, model_id: str) -> dict:
    capability = model_capability(
        f"custom-{provider['id']}",
        model_id,
        custom=True,
        api=provider["api"],
    )
    definition = {
        "id": model_id,
        "name": model_id,
        "reasoning": capability["reasoning"],
        "input": ["text"],
        "contextWindow": 128000,
        "maxTokens": 16384,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
    }
    if capability["reasoning"]:
        level_map = capability.get("thinking_level_map")
        if not isinstance(level_map, dict):
            levels = capability["thinking_levels"]
            if "max" in levels:
                level_map = {"xhigh": "max", "max": "max"}
            elif "xhigh" in levels:
                level_map = {"xhigh": "xhigh"}
        if level_map:
            definition["thinkingLevelMap"] = level_map
        if provider["api"] == "openai-completions":
            definition["compat"] = {"supportsReasoningEffort": True}
    return definition


def available_models(config: dict, active_keys: dict[str, bool]) -> list[dict]:
    models = []
    for provider in PROVIDERS:
        if not active_keys.get(provider["id"], False):
            continue
        for model in provider["models"]:
            models.append({
                "id": f"{provider['id']}/{model}",
                "provider": provider["id"],
                "model": model,
                "label": f"{provider['name']} · {model}",
                "custom": False,
                **model_capability(provider["id"], model, custom=False),
            })
    for provider in custom_providers(config):
        if not provider.get("api_key"):
            continue
        for model in provider["models"]:
            models.append({
                "id": f"custom-{provider['id']}/{model}",
                "provider": f"custom-{provider['id']}",
                "model": model,
                "label": f"{provider['name']} · {model}",
                "custom": True,
                **model_capability(
                    f"custom-{provider['id']}",
                    model,
                    custom=True,
                    api=provider["api"],
                ),
            })
    return models


def custom_models_runtime(
    config: dict,
    config_root: Path,
    cwd: Optional[str] = None,
) -> tuple[Optional[Path], dict[str, str]]:
    """Materialize custom providers as a pi models.json plus env-backed keys."""
    providers = custom_providers(config)
    if not providers:
        return None, {}

    key = hashlib.sha256(str(Path(cwd).expanduser().resolve() if cwd else "default").encode()).hexdigest()[:12]
    agent_dir = config_root / "pi-agent" / key
    agent_dir.mkdir(parents=True, exist_ok=True)
    definitions = {"providers": {}}
    env: dict[str, str] = {}
    for provider in providers:
        provider_id = f"custom-{provider['id']}"
        env_name = f"PI_SCIENCE_CUSTOM_{custom_provider_id(provider['id']).upper().replace('-', '_')}_API_KEY"
        definition = {
            "name": provider["name"],
            "baseUrl": provider["base_url"],
            "api": provider["api"],
            "models": [custom_model_definition(provider, model) for model in provider["models"]],
        }
        if provider.get("api_key"):
            definition["apiKey"] = f"${env_name}"
            env[env_name] = provider["api_key"]
        definitions["providers"][provider_id] = definition

    (agent_dir / "models.json").write_text(json.dumps(definitions, indent=2) + "\n")
    return agent_dir, env
