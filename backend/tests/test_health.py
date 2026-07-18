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


@pytest.mark.anyio
async def test_compute_api_is_exposed(client):
    """The SSH/Slurm compute API is a real local feature and stays mounted."""
    schema = (await client.get("/openapi.json")).json()
    assert any(path.startswith("/api/compute") for path in schema["paths"])
    assert (await client.get("/api/compute/machines")).status_code == 200


@pytest.mark.anyio
async def test_workspace_rename_rejects_empty_name_and_unmanaged_path(client, tmp_path, monkeypatch):
    import api.workspaces as workspaces

    managed = tmp_path / "managed"
    managed.mkdir()
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", tmp_path)

    empty = await client.post("/api/workspaces/rename", json={"path": str(managed), "name": "   "})
    assert empty.status_code == 400

    unmanaged = tmp_path.parent / "unmanaged-workspace"
    unmanaged.mkdir()
    try:
        response = await client.post(
            "/api/workspaces/rename",
            json={"path": str(unmanaged), "name": "renamed"},
        )
        assert response.status_code == 403
    finally:
        unmanaged.rmdir()
