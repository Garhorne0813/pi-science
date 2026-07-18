"""Artifact Manifest publication and query API."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from services.artifact_store import get_artifact_store
from services.artifact_verifier import check_claim_data, verify_file
from services.workspace_security import validate_workspace_cwd

router = APIRouter(prefix="/api/artifacts", tags=["artifacts"])


class PublishArtifactRequest(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    session_id: str = ""
    tool: str = "publish_artifact"
    model: str | None = None
    run_id: str | None = None
    inputs: list[dict[str, Any]] = Field(default_factory=list)
    environment: dict[str, Any] = Field(default_factory=dict)


class VerifyArtifactRequest(BaseModel):
    artifact_id: str
    version: int | None = Field(default=None, ge=1)


class ClaimCheckRequest(BaseModel):
    claim: str = Field(min_length=1, max_length=1000)
    values: list[float] = Field(min_length=1, max_length=10000)
    direction: str | None = None
    minimum: float | None = None
    maximum: float | None = None


def _workspace(cwd: str):
    try:
        return validate_workspace_cwd(cwd)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.get("")
async def list_artifacts(
    cwd: str = Query(".", description="Working directory"),
    artifact_id: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
):
    store = get_artifact_store(str(_workspace(cwd)))
    return {"artifacts": [item.model_dump() for item in await store.list(artifact_id, limit)]}


@router.post("/publish")
async def publish_artifact(
    body: PublishArtifactRequest,
    cwd: str = Query(".", description="Working directory"),
):
    store = get_artifact_store(str(_workspace(cwd)))
    try:
        manifest = await store.publish(
            body.path,
            session_id=body.session_id,
            tool=body.tool,
            model=body.model,
            run_id=body.run_id,
            inputs=body.inputs,
            environment=body.environment,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Artifact not found: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return manifest.model_dump()


@router.post("/verify")
async def verify_artifact(body: VerifyArtifactRequest, cwd: str = Query(".")):
    workspace = _workspace(cwd)
    store = get_artifact_store(str(workspace))
    manifest = await store.get(body.artifact_id, body.version)
    if manifest is None:
        raise HTTPException(status_code=404, detail="Artifact not found")
    path = workspace / manifest.path
    report = verify_file(path)
    return (await store.record_verification(manifest, report)).model_dump()


@router.post("/claim-check")
async def verify_claim(body: ClaimCheckRequest):
    if body.direction not in {None, "positive", "negative"}:
        raise HTTPException(status_code=400, detail="direction must be positive or negative")
    return check_claim_data(
        body.claim,
        body.values,
        direction=body.direction,
        minimum=body.minimum,
        maximum=body.maximum,
    )


@router.get("/{artifact_id}")
async def get_artifact(
    artifact_id: str,
    cwd: str = Query(".", description="Working directory"),
    version: int | None = Query(None, ge=1),
):
    store = get_artifact_store(str(_workspace(cwd)))
    manifest = await store.get(artifact_id, version)
    if manifest is None:
        raise HTTPException(status_code=404, detail="Artifact not found")
    return manifest.model_dump()
