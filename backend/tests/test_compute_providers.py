"""Provider-neutral job contract tests."""

import pytest

from models.compute import ComputeRequirement
from services.compute_providers import FakeProvider
from services.job_coordinator import JobCoordinator


@pytest.mark.anyio
async def test_fake_provider_implements_job_contract():
    provider = FakeProvider()
    record = await provider.submit(["echo", "ok"], ComputeRequirement())
    assert (await provider.status(record.job_id)).status == "succeeded"
    assert (await provider.logs(record.job_id))[0] == "fake provider output"
    assert (await provider.cancel(record.job_id)).status == "cancelled"


@pytest.mark.anyio
async def test_job_coordinator_routes_through_provider(tmp_path):
    provider = FakeProvider()
    coordinator = JobCoordinator(str(tmp_path), providers=[provider])

    record = await coordinator.submit(["echo", "ok"], ComputeRequirement(), "fake")

    assert (await coordinator.status(record.job_id)).status == "succeeded"
    assert (await coordinator.logs(record.job_id))[0] == "fake provider output"
