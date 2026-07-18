"""Managed model endpoint registry tests."""

import pytest

from services import model_endpoint_service
from services.model_endpoint_service import register
from models.compute import ModelEndpointRequest


def test_endpoint_registration_does_not_store_secrets():
    endpoint = register(ModelEndpointRequest(name="Local gateway", base_url="https://llm.example/v1", protocol="openai", secret_ref="secret:llm"))
    assert endpoint.endpoint_id
    assert endpoint.secret_ref == "secret:llm"
    assert not hasattr(endpoint, "api_key")


@pytest.mark.anyio
async def test_endpoint_health_is_persisted(client, temp_config_dir, monkeypatch):
    monkeypatch.setattr(model_endpoint_service, "_health_sync", lambda endpoint: endpoint.model_copy(update={"health": "ready"}))
    saved = await client.post("/api/endpoints", json={"name": "Gateway", "base_url": "https://llm.example/v1", "protocol": "openai"})
    assert saved.status_code == 200
    endpoint_id = saved.json()["endpoint_id"]
    health = await client.post(f"/api/endpoints/{endpoint_id}/health")
    assert health.status_code == 200
    assert health.json()["health"] == "ready"
    disabled = await client.put(f"/api/endpoints/{endpoint_id}/enabled?enabled=false")
    assert disabled.status_code == 200
    assert disabled.json()["enabled"] is False

