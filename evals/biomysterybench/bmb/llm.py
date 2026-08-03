"""LLM client abstraction.

`OpenAIClient` talks to any OpenAI-compatible /chat/completions endpoint
(base_url/api_key/model configured through the environment, see run_eval.py).
`FakeModel` produces deterministic pseudo-answers for offline smoke runs —
it never contacts the network.
"""

from __future__ import annotations

import hashlib
import time
from typing import Protocol

import requests

# Estimated USD per 1M tokens: {model-substring-prefix: (input, output)}.
# Entries are best-effort list prices as of 2026-07; unknown models -> None.
MODEL_PRICING: dict[str, tuple[float, float]] = {
    "claude-sonnet-4-5": (3.0, 15.0),
    "claude-sonnet-4": (3.0, 15.0),
    "claude-opus-4": (15.0, 75.0),
    "gpt-5": (1.25, 10.0),
    "gpt-4.1": (2.0, 8.0),
}


def estimate_cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float | None:
    for prefix, (input_rate, output_rate) in MODEL_PRICING.items():
        if model.startswith(prefix):
            return (prompt_tokens / 1_000_000) * input_rate + (completion_tokens / 1_000_000) * output_rate
    return None


class LLMClient(Protocol):
    model: str

    def complete(self, prompt: str, seed: int) -> tuple[str, dict, int, int]:
        """Return (response_text, usage_dict, started_at_epoch_ms, finished_at_epoch_ms)."""


class OpenAIClient:
    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = 120.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def complete(self, prompt: str, seed: int) -> tuple[str, dict, int, int]:
        started = int(time.time() * 1000)
        response = requests.post(
            f"{self.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            json={
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0,
                "seed": seed,
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        payload = response.json()
        finished = int(time.time() * 1000)
        text = payload["choices"][0]["message"]["content"] or ""
        usage = payload.get("usage") or {}
        return text, usage, started, finished


class FakeModel:
    """Deterministic offline stand-in: derives a fake answer from sample id + seed."""

    def __init__(self, model: str = "fake-model-smoke"):
        self.model = model

    def complete(self, prompt: str, seed: int) -> tuple[str, dict, int, int]:
        started = int(time.time() * 1000)
        digest = hashlib.sha256(f"{prompt}|{seed}".encode("utf-8")).hexdigest()
        text = f"[smoke] deterministic fake answer {digest[:16]}"
        usage = {"prompt_tokens": len(prompt.split()), "completion_tokens": len(text.split()), "total_tokens": 0}
        usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
        return text, usage, started, int(time.time() * 1000)
