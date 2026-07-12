"""Health check endpoint tests."""

import pytest


@pytest.mark.anyio
async def test_health_ok(client):
    """GET /api/health returns status ok."""
    res = await client.get("/api/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert "active_pi_processes" in data
    assert "active_kernels" in data


@pytest.mark.anyio
async def test_docs_available(client):
    """OpenAPI docs are served."""
    res = await client.get("/docs")
    assert res.status_code == 200
