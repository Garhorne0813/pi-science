"""Managed model endpoint registry using credential references only."""

from __future__ import annotations

import asyncio
import hashlib
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from models.compute import ModelEndpoint, ModelEndpointRequest


def endpoint_id(name: str, base_url: str) -> str:
    return hashlib.sha256(f"{name}:{base_url}".encode()).hexdigest()[:20]


def from_config(item: dict) -> ModelEndpoint:
    return ModelEndpoint.model_validate(item)


def register(request: ModelEndpointRequest) -> ModelEndpoint:
    base_url = request.base_url.strip().rstrip("/")
    if not base_url.startswith(("http://", "https://")):
        raise ValueError("model endpoint base_url must use http or https")
    return ModelEndpoint(
        endpoint_id=endpoint_id(request.name.strip(), base_url),
        name=request.name.strip()[:120],
        base_url=base_url,
        protocol=request.protocol,
        secret_ref=request.secret_ref,
        data_egress=request.data_egress,
        model_schema=request.model_schema,
        rate_limit=request.rate_limit,
    )


def _health_sync(endpoint: ModelEndpoint) -> ModelEndpoint:
    if not endpoint.enabled:
        return endpoint.model_copy(update={"health": "blocked", "error": "endpoint disabled"})
    try:
        url = endpoint.base_url
        if endpoint.protocol == "openai" and not url.endswith("/models"):
            url = urljoin(url + "/", "models")
        request = Request(url, headers={"Accept": "application/json", "User-Agent": "pi-science/0.1"}, method="GET")
        with urlopen(request, timeout=8) as response:
            status = int(getattr(response, "status", 200))
        return endpoint.model_copy(update={"health": "ready" if 200 <= status < 400 else "degraded", "error": None})
    except Exception as exc:
        return endpoint.model_copy(update={"health": "error", "error": str(exc)[:300]})


async def check_health(endpoint: ModelEndpoint) -> ModelEndpoint:
    return await asyncio.to_thread(_health_sync, endpoint)

