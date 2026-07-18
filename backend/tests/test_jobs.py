"""Provider-neutral local job contract tests."""

import asyncio

import pytest

from models.compute import ComputeRequirement
from services.compute_service import JobStore, check_capabilities


def test_capability_check_reports_missing_runtime():
    result = check_capabilities(ComputeRequirement(runtime="r"))
    # R is optional on some CI hosts; the result must still be structured.
    assert result.status in {"ready", "degraded", "blocked"}
    assert "runtime" in result.checks


@pytest.mark.anyio
async def test_local_job_runs_and_records_output(temp_workspace):
    store = JobStore(str(temp_workspace))
    record = await store.submit(["python3", "-c", "print('hello')"], ComputeRequirement(timeout_seconds=10))
    for _ in range(50):
        current = await store.get(record.job_id)
        if current and current.status in {"succeeded", "failed", "timed_out", "cancelled"}:
            break
        await asyncio.sleep(0.02)
    current = await store.get(record.job_id)
    assert current is not None
    assert current.status == "succeeded"
    assert "hello" in current.stdout


@pytest.mark.anyio
async def test_job_api_submit_and_logs(client, temp_workspace):
    cwd = str(temp_workspace)
    response = await client.post(
        f"/api/jobs?cwd={cwd}",
        json={"command": ["python3", "-c", "print('api')"], "requirement": {"timeout_seconds": 10}},
    )
    assert response.status_code == 200
    job_id = response.json()["job_id"]
    for _ in range(50):
        item = await client.get(f"/api/jobs/{job_id}?cwd={cwd}")
        if item.json()["status"] in {"succeeded", "failed", "timed_out", "cancelled"}:
            break
        await asyncio.sleep(0.02)
    logs = await client.get(f"/api/jobs/{job_id}/logs?cwd={cwd}")
    assert logs.status_code == 200
    assert "api" in logs.json()["stdout"]
