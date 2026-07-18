"""Provider-neutral job contract tests."""

import pytest

from models.compute import ComputeRequirement
from services.compute_providers import FakeProvider


@pytest.mark.anyio
async def test_fake_provider_implements_job_contract():
    provider = FakeProvider()
    record = await provider.submit(["echo", "ok"], ComputeRequirement())
    assert (await provider.status(record.job_id)).status == "succeeded"
    assert (await provider.logs(record.job_id))[0] == "fake provider output"
    assert (await provider.cancel(record.job_id)).status == "cancelled"

