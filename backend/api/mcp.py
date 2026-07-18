"""MCP server/tool catalog and health endpoints."""

from fastapi import APIRouter, HTTPException, Query

from api.settings import _load_config, _load_mcp_definitions, _mcp_source_path
from services.mcp_catalog import catalog_from_definitions, check_health
from services.egress_policy import check_remote_egress
from services.workspace_security import validate_workspace_cwd

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


def _catalog(cwd: str):
    if cwd != ".":
        try:
            cwd = str(validate_workspace_cwd(cwd))
        except ValueError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
    config = _load_config()
    source = _mcp_source_path(config, cwd)
    definitions = _load_mcp_definitions(source)
    configured = set(definitions)
    enabled = config.get("mcp_servers")
    enabled_names = configured if enabled is None else configured & set(enabled)
    return source, definitions, catalog_from_definitions(definitions, enabled_names), cwd


@router.get("/catalog")
async def get_catalog(cwd: str = Query(".")):
    source, definitions, servers, _workspace = _catalog(cwd)
    return {"servers": [item.model_dump() for item in servers], "config_path": str(source) if source else None}


@router.get("/health/{server_id}")
async def get_health(server_id: str, cwd: str = Query(".")):
    _source, definitions, servers, workspace = _catalog(cwd)
    server = next((item for item in servers if item.id == server_id), None)
    if server is None:
        raise HTTPException(status_code=404, detail="MCP server not found")
    definition = definitions[server_id]
    allowed, reason = check_remote_egress(str(workspace), definition.get("url"), definition.get("data_class")) if server.data_egress == "remote" else (True, None)
    if not allowed:
        from services.telemetry import record_metric
        await record_metric(workspace, "mcp_health", "blocked", metadata={"server_id": server_id})
        return server.model_copy(update={"health": "blocked", "policy_allowed": False, "error": reason}).model_dump()
    checked = await check_health(server, definition)
    from services.telemetry import record_metric
    await record_metric(workspace, "mcp_health", checked.health, metadata={"server_id": server_id})
    return checked.model_dump()


@router.get("/egress/{server_id}")
async def get_egress(server_id: str, cwd: str = Query(".")):
    _source, definitions, servers, _workspace = _catalog(cwd)
    server = next((item for item in servers if item.id == server_id), None)
    if server is None:
        raise HTTPException(status_code=404, detail="MCP server not found")
    return {
        "server": server_id,
        "data_egress": server.data_egress,
        "transport": server.transport,
        "terms_url": server.terms_url,
        "privacy_url": server.privacy_url,
        "tools": [item.model_dump() for item in server.tools],
        "warning": "Review the destination and data class before sending user files or sequences." if server.data_egress == "remote" else None,
    }
