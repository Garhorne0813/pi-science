"""Internal-token middleware tests — the runtime can be made internal-only."""

import pytest


@pytest.fixture
def require_token(monkeypatch):
    """Turn the process into an internal-only runtime for one test."""
    monkeypatch.setenv("PI_SCIENCE_REQUIRE_INTERNAL_TOKEN", "1")
    monkeypatch.setenv("PI_SCIENCE_INTERNAL_TOKEN", "secret-token")


@pytest.mark.anyio
async def test_requests_without_token_are_rejected(client, require_token):
    res = await client.get("/api/kernels/status")
    assert res.status_code == 403
    assert res.json() == {"detail": "internal runtime authentication required"}


@pytest.mark.anyio
async def test_requests_with_wrong_token_are_rejected(client, require_token):
    res = await client.get("/api/kernels/status", headers={"x-pi-science-internal-token": "wrong"})
    assert res.status_code == 403


@pytest.mark.anyio
async def test_requests_with_the_expected_token_pass(client, require_token):
    res = await client.get("/api/kernels/status", headers={"x-pi-science-internal-token": "secret-token"})
    assert res.status_code == 200


@pytest.mark.anyio
async def test_health_is_exempt(client, require_token):
    res = await client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


@pytest.mark.anyio
async def test_missing_expected_token_rejects_everything_but_health(client, monkeypatch):
    """Enabling the guard without configuring a token denies by default."""
    monkeypatch.setenv("PI_SCIENCE_REQUIRE_INTERNAL_TOKEN", "1")
    monkeypatch.delenv("PI_SCIENCE_INTERNAL_TOKEN", raising=False)
    assert (await client.get("/api/kernels/status", headers={"x-pi-science-internal-token": ""})).status_code == 403
    assert (await client.get("/api/health")).status_code == 200


@pytest.mark.anyio
async def test_guard_is_off_by_default(client, monkeypatch):
    monkeypatch.delenv("PI_SCIENCE_REQUIRE_INTERNAL_TOKEN", raising=False)
    assert (await client.get("/api/kernels/status")).status_code == 200
