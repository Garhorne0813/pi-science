"""Managed model endpoint registration and health API."""

from fastapi import APIRouter, HTTPException

from api.settings import _load_config, _save_config
from models.compute import ModelEndpoint, ModelEndpointRequest
from services.model_endpoint_service import check_health, register

router = APIRouter(prefix="/api/endpoints", tags=["endpoints"])


def _load() -> list[dict]:
    config = _load_config()
    rows = config.get("model_endpoints", [])
    return rows if isinstance(rows, list) else []


def _save(rows: list[dict]) -> None:
    config = _load_config()
    config["model_endpoints"] = rows
    _save_config(config)


@router.get("")
async def list_endpoints():
    return {"endpoints": [ModelEndpoint.model_validate(item).model_dump() for item in _load()]}


@router.post("")
async def register_endpoint(body: ModelEndpointRequest):
    try:
        endpoint = register(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    rows = [row for row in _load() if row.get("endpoint_id") != endpoint.endpoint_id]
    rows.append(endpoint.model_dump())
    _save(rows)
    return endpoint.model_dump()


@router.post("/{endpoint_id}/health")
async def endpoint_health(endpoint_id: str):
    row = next((row for row in _load() if row.get("endpoint_id") == endpoint_id), None)
    if row is None:
        raise HTTPException(status_code=404, detail="Model endpoint not found")
    endpoint = await check_health(ModelEndpoint.model_validate(row))
    rows = [endpoint.model_dump() if item.get("endpoint_id") == endpoint_id else item for item in _load()]
    _save(rows)
    return endpoint.model_dump()


@router.put("/{endpoint_id}/enabled")
async def set_endpoint_enabled(endpoint_id: str, enabled: bool = True):
    rows = _load()
    for row in rows:
        if row.get("endpoint_id") == endpoint_id:
            row["enabled"] = enabled
            if not enabled:
                row["health"] = "blocked"
            _save(rows)
            return row
    raise HTTPException(status_code=404, detail="Model endpoint not found")
