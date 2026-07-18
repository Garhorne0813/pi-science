"""Figure composition endpoint."""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from services.artifact_store import get_artifact_store
from services.figure_composer import compose
from services.workspace_security import validate_workspace_cwd

router = APIRouter(prefix="/api/figures", tags=["figures"])


class ComposeRequest(BaseModel):
    panels: list[str] = Field(min_length=1, max_length=20)
    output: str = Field(min_length=1, max_length=1000)
    columns: int = Field(default=2, ge=1, le=10)
    padding: int = Field(default=16, ge=0, le=200)
    session_id: str = ""


@router.post("/compose")
async def compose_figure(body: ComposeRequest, cwd: str = Query(".")):
    try:
        workspace = validate_workspace_cwd(cwd)
        result = compose(str(workspace), body.panels, body.output, columns=body.columns, padding=body.padding)
        manifest = await get_artifact_store(str(workspace)).publish(result["path"], session_id=body.session_id, tool="figure-composer", inputs=[{"path": item} for item in body.panels])
        return {"composition": result, "artifact": manifest.model_dump()}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Panel not found: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

