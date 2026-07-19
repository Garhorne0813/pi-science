"""Read model reasoning capabilities from the installed pi-ai catalog."""

from __future__ import annotations

import json
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Any

from config import PI_CLI_PATH, PI_NODE_PATH


# Fallback capabilities for known providers whose model list may not yet
# be fully represented in the pi-ai catalog.
_PROVIDER_FALLBACK: dict[str, dict[str, Any]] = {
    "openai": {
        "reasoning": True,
        "thinking_levels": ["off", "minimal", "low", "medium", "high", "xhigh"],
        "thinking_level_map": {"off": None, "xhigh": "xhigh"},
        "capability_source": "pi-ai:openai",
    },
    "openai-codex": {
        "reasoning": True,
        "thinking_levels": ["off", "minimal", "low", "medium", "high", "xhigh"],
        "thinking_level_map": {"off": None, "xhigh": "xhigh"},
        "capability_source": "pi-ai:openai",
    },
    "anthropic": {
        "reasoning": True,
        "thinking_levels": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        "thinking_level_map": {"off": None, "xhigh": "xhigh", "max": "max"},
        "capability_source": "pi-ai:anthropic",
    },
    "google": {
        "reasoning": True,
        "thinking_levels": ["off", "minimal", "low", "medium", "high"],
        "thinking_level_map": None,
        "capability_source": "pi-ai:google",
    },
    "deepseek": {
        "reasoning": True,
        "thinking_levels": ["off", "minimal", "low", "medium", "high"],
        "thinking_level_map": None,
        "capability_source": "pi-ai:deepseek",
    },
}

_API_PROVIDER_PRIORITY: dict[str, tuple[str, ...]] = {
    "openai-completions": (
        "openai",
        "openai-codex",
        "azure-openai-responses",
        "cloudflare-ai-gateway",
        "github-copilot",
        "opencode",
    ),
    "openai-responses": (
        "openai",
        "openai-codex",
        "azure-openai-responses",
        "cloudflare-ai-gateway",
        "opencode",
        "github-copilot",
    ),
    "anthropic-messages": (
        "anthropic",
        "cloudflare-ai-gateway",
        "opencode",
        "github-copilot",
    ),
}


def _pi_ai_root() -> Path | None:
    cli_path = Path(PI_CLI_PATH).expanduser().resolve()
    # Search ancestor directories for @earendil-works/pi-ai (covers
    # npm-installed prod setups where pi lives under node_modules).
    for parent in cli_path.parents:
        if parent.name == "@earendil-works":
            candidate = parent / "pi-ai"
            if (candidate / "dist" / "index.js").is_file():
                return candidate
    # Dev mode: pi is a sibling directory, node_modules sits at pi repo root.
    dev_candidate = cli_path.parents[3] / "node_modules" / "@earendil-works" / "pi-ai"
    if (dev_candidate / "dist" / "index.js").is_file():
        return dev_candidate
    # Prod fallback: runtime fetched into repo.
    candidate = Path(__file__).resolve().parents[2] / "runtime" / "pi" / "node_modules" / "@earendil-works" / "pi-ai"
    return candidate if (candidate / "dist" / "index.js").is_file() else None


@lru_cache(maxsize=1)
def load_pi_model_capabilities() -> dict[str, Any]:
    root = _pi_ai_root()
    if root is None:
        return {"by_full_id": {}, "by_model_id": {}}
    script = Path(__file__).resolve().parents[1] / "scripts" / "pi_model_capabilities.mjs"
    try:
        completed = subprocess.run(
            [PI_NODE_PATH, str(script), str(root)],
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
        payload = json.loads(completed.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return {"by_full_id": {}, "by_model_id": {}}

    by_full_id: dict[str, dict[str, Any]] = {}
    by_model_id: dict[str, list[dict[str, Any]]] = {}
    for item in payload.get("models", []):
        if not isinstance(item, dict) or not item.get("provider") or not item.get("id"):
            continue
        record = {
            "provider": str(item["provider"]),
            "api": str(item.get("api") or ""),
            "reasoning": bool(item.get("reasoning")),
            "thinking_levels": [str(level) for level in item.get("thinking_levels", [])],
            "thinking_level_map": item.get("thinking_level_map"),
            "capability_source": f"pi-ai:{item['provider']}",
        }
        full_id = f"{item['provider']}/{item['id']}"
        by_full_id[full_id] = record
        by_model_id.setdefault(str(item["id"]), []).append(record)
    return {"by_full_id": by_full_id, "by_model_id": by_model_id}


def _public_capability(record: dict[str, Any], source: str | None = None) -> dict[str, Any]:
    return {
        "reasoning": record["reasoning"],
        "thinking_levels": list(record["thinking_levels"]),
        "thinking_level_map": record["thinking_level_map"],
        "capability_source": source or record["capability_source"],
    }


def get_pi_model_capability(provider: str, model_id: str, api: str | None = None) -> dict[str, Any] | None:
    catalog = load_pi_model_capabilities()
    exact = catalog["by_full_id"].get(f"{provider}/{model_id}")
    if exact:
        return _public_capability(exact)
    candidates = catalog["by_model_id"].get(model_id, [])
    if not candidates:
        return None

    # Custom provider IDs cannot match pi-ai's built-in IDs. Prefer the model
    # entry whose transport matches the configured endpoint, then use the
    # canonical vendor catalog for OpenAI-compatible endpoints whose pi-ai
    # model uses Responses internally.
    if api:
        matching_api = [item for item in candidates if item["api"] == api]
        search_pool = matching_api or candidates
        for preferred_provider in _API_PROVIDER_PRIORITY.get(api, ()):
            preferred = next(
                (item for item in search_pool if item["provider"] == preferred_provider),
                None,
            )
            if preferred:
                return _public_capability(preferred)

    signature = {(item["reasoning"], tuple(item["thinking_levels"])) for item in candidates}
    if len(signature) == 1:
        return _public_capability(candidates[0], "pi-ai:model-id")

    # 3. Protocol-based fallback: when api is provided, try the canonical
    #    provider's fallback (e.g. custom provider using openai-responses →
    #    get openai's default capabilities).
    if api:
        for preferred_provider in _API_PROVIDER_PRIORITY.get(api, ()):
            fallback = _PROVIDER_FALLBACK.get(preferred_provider)
            if fallback:
                return dict(fallback)

    # 4. Direct provider fallback: known providers with models not yet in catalog
    fallback = _PROVIDER_FALLBACK.get(provider)
    if fallback:
        return dict(fallback)
    return None
