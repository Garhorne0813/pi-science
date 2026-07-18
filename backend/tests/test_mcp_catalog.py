"""MCP catalog and health tests without launching external servers."""

import pytest

from models.mcp import McpServerInfo
from services.mcp_catalog import catalog_from_definitions, check_health


def test_catalog_exposes_tool_and_egress_metadata():
    servers = catalog_from_definitions({
        "papers": {
            "url": "https://papers.example/api",
            "description": "Paper search",
            "required_env": ["PAPERS_TOKEN"],
            "tools": {"search": {"description": "Search papers"}},
            "terms_url": "https://papers.example/terms",
        },
        "local": {"command": "python", "tools": ["inspect"]},
    }, {"papers"})
    papers = next(item for item in servers if item.id == "papers")
    assert papers.transport == "http"
    assert papers.data_egress == "remote"
    assert papers.enabled is True
    assert papers.tools[0].name == "search"
    assert next(item for item in servers if item.id == "local").enabled is False


@pytest.mark.anyio
async def test_health_blocks_missing_auth():
    server = McpServerInfo(id="papers", name="papers", auth="missing", enabled=True)
    result = await check_health(server, {"url": "https://example.org"})
    assert result.health == "blocked"
    assert "credentials" in (result.error or "")


@pytest.mark.anyio
async def test_mcp_api_catalog_uses_workspace_config(client, temp_workspace):
    config = temp_workspace / ".mcp.json"
    config.write_text('{"mcpServers":{"local":{"command":"python","tools":["inspect"]}}}')
    response = await client.get("/api/mcp/catalog", params={"cwd": str(temp_workspace)})
    assert response.status_code == 200
    assert response.json()["servers"][0]["id"] == "local"
    health = await client.get("/api/mcp/health/local", params={"cwd": str(temp_workspace)})
    assert health.status_code == 200
    assert health.json()["health"] == "ready"


@pytest.mark.anyio
async def test_mcp_health_honors_workspace_egress_policy(client, temp_workspace):
    config = temp_workspace / ".mcp.json"
    config.write_text('{"mcpServers":{"remote":{"url":"https://papers.example/api"}}}')
    policy = temp_workspace / ".pi-science" / "policy.yaml"
    policy.write_text('{"external_services_allowed": false}')
    response = await client.get("/api/mcp/health/remote", params={"cwd": str(temp_workspace)})
    assert response.status_code == 200
    assert response.json()["health"] == "blocked"
    assert response.json()["policy_allowed"] is False
