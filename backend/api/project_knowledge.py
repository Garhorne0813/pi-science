"""Project knowledge, Reviewer inbox, and safe file-organization API."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from config import get_sessions_dir
from models import (
    BatchDecisionRequest,
    ProjectPolicy,
    ProjectPolicyUpdate,
    ProposalDecisionRequest,
    ProposalUpdateRequest,
    ReviewRequest,
    ReviewResponse,
)
from services.file_organizer import FilePlanError, WorkspaceFileOrganizer
from services.project_knowledge_store import ProjectKnowledgeStore
from services.reviewer_service import ReviewerError, ReviewerService
from services.session_reader import find_session_file
from services.session_repository import SessionRepository
from services.workspace_context import WorkspaceContext


router = APIRouter(prefix="/api/project-knowledge", tags=["project-knowledge"])


def _store(cwd: str) -> ProjectKnowledgeStore:
    try:
        workspace = WorkspaceContext.from_cwd(cwd)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    store = ProjectKnowledgeStore(workspace.root)
    store.initialize(create_base_directories=True)
    return store


def _proposal_or_404(store: ProjectKnowledgeStore, proposal_id: str):
    proposal = store.get_proposal(proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    return proposal


def _latest_session_id(cwd: str) -> Optional[str]:
    return SessionRepository(WorkspaceContext.from_cwd(cwd).root).latest_id()


@router.post("/initialize")
async def initialize_project(cwd: str = Query(...)):
    return _store(cwd).summary()


@router.get("/summary")
async def get_summary(cwd: str = Query(...)):
    return _store(cwd).summary()


@router.get("/project")
async def get_project_document(cwd: str = Query(...)):
    store = _store(cwd)
    return {
        **store.summary(),
        "content": store.project_file.read_text(encoding="utf-8", errors="replace"),
    }


@router.get("/project/versions")
async def get_project_versions(cwd: str = Query(...), limit: int = Query(100, ge=1, le=500)):
    return {"versions": _store(cwd).list_project_versions(limit)}


@router.post("/project/versions/{version_id}/restore")
async def restore_project_version(version_id: str, cwd: str = Query(...)):
    try:
        restored = _store(cwd).restore_project_version(version_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Project document version not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True, **restored}


@router.get("/items")
async def list_knowledge_items(
    cwd: str = Query(...),
    include_inactive: bool = Query(True),
):
    return {"items": [item.model_dump() for item in _store(cwd).list_items(include_inactive)]}


@router.get("/proposals")
async def list_proposals(
    cwd: str = Query(...),
    status: Optional[str] = Query(None),
):
    store = _store(cwd)
    proposals = store.list_proposals(status)
    return {
        "proposals": [proposal.model_dump() for proposal in proposals],
        "pending_count": sum(1 for proposal in store.list_proposals() if proposal.status == "pending"),
    }


@router.get("/proposals/count")
async def proposal_count(cwd: str = Query(...)):
    count = len(_store(cwd).list_proposals("pending"))
    return {"pending_count": count}


@router.post("/review", response_model=ReviewResponse)
async def review_project(body: ReviewRequest):
    try:
        workspace = str(WorkspaceContext.from_cwd(body.cwd))
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    session_id = body.session_id or _latest_session_id(workspace)
    if not session_id:
        raise HTTPException(status_code=404, detail="No session available to review")
    if find_session_file(session_id, workspace) is None:
        raise HTTPException(status_code=404, detail="Session not found in this workspace")
    try:
        result = await ReviewerService(workspace).review_session(
            session_id,
            include_files=body.include_files,
            force_full_session=body.force_full_session,
        )
    except ReviewerError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return ReviewResponse(**result)


@router.patch("/proposals/{proposal_id}")
async def update_proposal(
    proposal_id: str,
    body: ProposalUpdateRequest,
    cwd: str = Query(...),
):
    store = _store(cwd)
    proposal = _proposal_or_404(store, proposal_id)
    if proposal.status != "pending":
        raise HTTPException(status_code=409, detail="Only pending proposals can be edited")
    changes = body.model_dump(exclude_none=True)
    try:
        payload = proposal.model_dump()
        payload.update(changes)
        proposal = proposal.model_validate(payload)
        if proposal.proposal_type == "file_operation":
            WorkspaceFileOrganizer(cwd).preview_plan(proposal.operations)
    except (ValueError, FilePlanError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    proposal.fingerprint = ""  # edited proposals get a fresh fingerprint if re-proposed later
    return {"proposal": store.update_proposal(proposal).model_dump()}


@router.get("/proposals/{proposal_id}/preview")
async def preview_proposal(proposal_id: str, cwd: str = Query(...)):
    store = _store(cwd)
    proposal = _proposal_or_404(store, proposal_id)
    if proposal.proposal_type == "knowledge":
        return {
            "ok": True,
            "proposal_type": "knowledge",
            "before": "",
            "after": f"{proposal.title}\n{proposal.summary}",
            "conflicts_with": proposal.conflicts_with,
            "supersedes": proposal.supersedes,
        }
    try:
        return {
            "proposal_type": "file_operation",
            **WorkspaceFileOrganizer(cwd).preview_plan(proposal.operations),
        }
    except (ValueError, FilePlanError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/proposals/{proposal_id}/accept")
async def accept_proposal(
    proposal_id: str,
    body: ProposalDecisionRequest | None = None,
    cwd: str = Query(...),
):
    body = body or ProposalDecisionRequest()
    store = _store(cwd)
    proposal = _proposal_or_404(store, proposal_id)
    if proposal.status != "pending":
        raise HTTPException(status_code=409, detail="Proposal is not pending")
    try:
        if proposal.proposal_type == "knowledge":
            item = store.accept_knowledge_proposal(
                proposal,
                title=body.title,
                summary=body.summary,
            )
            return {"ok": True, "proposal_id": proposal_id, "knowledge_item": item.model_dump()}

        history = WorkspaceFileOrganizer(cwd).apply_plan(proposal.operations, proposal_id=proposal.id)
        # The organizer updates structured file references while preserving the
        # original operation plan. Reload before changing proposal status so
        # those reference updates are not overwritten by the stale API object.
        proposal = store.get_proposal(proposal.id) or proposal
        proposal.status = "accepted"
        proposal.applied_history_id = history["id"]
        if body.title:
            proposal.title = body.title
        if body.summary:
            proposal.summary = body.summary
        store.update_proposal(proposal)
        store.bump_policy_count("accepted", proposal)
        store.record_event("file_proposal.accepted", {
            "proposal_id": proposal.id,
            "history_id": history["id"],
        })
        return {"ok": True, "proposal_id": proposal_id, "file_operation": history}
    except (ValueError, FilePlanError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/proposals/{proposal_id}/reject")
async def reject_proposal(
    proposal_id: str,
    body: ProposalDecisionRequest | None = None,
    cwd: str = Query(...),
):
    body = body or ProposalDecisionRequest()
    store = _store(cwd)
    proposal = _proposal_or_404(store, proposal_id)
    try:
        updated = store.reject_proposal(proposal, body.reason)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True, "proposal": updated.model_dump()}


@router.post("/proposals/batch")
async def batch_decide(body: BatchDecisionRequest, cwd: str = Query(...)):
    results = []
    failures = []
    for proposal_id in body.proposal_ids:
        try:
            if body.action == "accept":
                result = await accept_proposal(proposal_id, ProposalDecisionRequest(reason=body.reason), cwd)
            else:
                result = await reject_proposal(proposal_id, ProposalDecisionRequest(reason=body.reason), cwd)
            results.append(result)
        except HTTPException as exc:
            failures.append({"proposal_id": proposal_id, "status": exc.status_code, "detail": exc.detail})
    return {"ok": not failures, "results": results, "failures": failures}


@router.get("/policy", response_model=ProjectPolicy)
async def get_policy(cwd: str = Query(...)):
    return _store(cwd).get_policy()


@router.patch("/policy", response_model=ProjectPolicy)
async def update_policy(body: ProjectPolicyUpdate, cwd: str = Query(...)):
    store = _store(cwd)
    policy = store.get_policy()
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(policy, field, value)
    try:
        policy = ProjectPolicy.model_validate(policy.model_dump())
        organizer = WorkspaceFileOrganizer(cwd)
        policy.locked_paths = [organizer._normalize_relative(path) for path in policy.locked_paths]
    except (ValueError, FilePlanError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return store.save_policy(policy)


@router.get("/files/views")
async def get_logical_file_views(cwd: str = Query(...)):
    return WorkspaceFileOrganizer(cwd).logical_views()


@router.post("/file-operations/{history_id}/undo")
async def undo_file_operation(history_id: str, cwd: str = Query(...)):
    try:
        result = WorkspaceFileOrganizer(cwd).undo(history_id)
    except FilePlanError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True, "undo": result}


@router.get("/history")
async def get_history(cwd: str = Query(...), limit: int = Query(100, ge=1, le=500)):
    return {"history": _store(cwd).list_history(limit)}
