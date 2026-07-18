"""Transcript bookmark API."""

from fastapi import APIRouter, HTTPException, Query

from services.bookmarker import create_bookmarks
from services.workspace_security import validate_workspace_cwd

router = APIRouter(prefix="/api/bookmarks", tags=["bookmarks"])


@router.post("")
async def create_session_bookmarks(session_id: str = Query(...), cwd: str = Query(".")):
    try:
        workspace = validate_workspace_cwd(cwd)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return {"session_id": session_id, "bookmarks": await create_bookmarks(str(workspace), session_id)}

