"""Artifact Manifest publication and workspace-boundary tests."""

import pytest

from services.artifact_store import ArtifactStore


@pytest.mark.anyio
async def test_publish_is_idempotent_and_versioned(temp_workspace):
    output = temp_workspace / "result.csv"
    output.write_text("x,y\n1,2\n", encoding="utf-8")
    store = ArtifactStore(str(temp_workspace))

    first = await store.publish("result.csv", session_id="s1", tool="write")
    again = await store.publish("result.csv", session_id="s1", tool="write")
    assert first.artifact_id == again.artifact_id
    assert first.version == again.version == 1

    output.write_text("x,y\n1,3\n", encoding="utf-8")
    second = await store.publish("result.csv", session_id="s2", tool="edit")
    assert second.artifact_id == first.artifact_id
    assert second.version == 2
    assert second.sha256 != first.sha256


@pytest.mark.anyio
async def test_publish_rejects_escape_and_metadata(temp_workspace):
    store = ArtifactStore(str(temp_workspace))
    with pytest.raises(ValueError):
        await store.publish("../outside.txt")
    with pytest.raises(ValueError):
        await store.publish(".pi-science/provenance.jsonl")


@pytest.mark.anyio
async def test_artifact_api_publishes_and_queries(client, temp_workspace):
    output = temp_workspace / "plot.csv"
    output.write_text("value\n1\n", encoding="utf-8")
    cwd = str(temp_workspace)

    published = await client.post(
        f"/api/artifacts/publish?cwd={cwd}",
        json={"path": "plot.csv", "session_id": "session-1", "tool": "write"},
    )
    assert published.status_code == 200
    manifest = published.json()
    assert manifest["path"] == "plot.csv"
    assert manifest["verification"]["status"] == "passed"

    listed = await client.get(f"/api/artifacts?cwd={cwd}")
    assert listed.status_code == 200
    assert listed.json()["artifacts"][0]["artifact_id"] == manifest["artifact_id"]

    fetched = await client.get(f"/api/artifacts/{manifest['artifact_id']}?cwd={cwd}")
    assert fetched.status_code == 200
    assert fetched.json()["sha256"] == manifest["sha256"]

