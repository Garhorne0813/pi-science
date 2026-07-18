"""Read-only result review API."""

from fastapi import APIRouter, HTTPException, Query

from services.result_reviewer import review_session
from services.workspace_security import validate_workspace_cwd

router = APIRouter(prefix="/api/result-reviews", tags=["result-reviews"])


@router.post("")
async def create_result_review(session_id: str = Query(...), cwd: str = Query(".")):
    try:
        workspace = validate_workspace_cwd(cwd)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return await review_session(str(workspace), session_id)

