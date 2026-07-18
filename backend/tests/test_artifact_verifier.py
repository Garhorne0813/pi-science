"""Deterministic artifact and claim verification tests."""

from pathlib import Path

import pytest

from services.artifact_verifier import check_claim_data, verify_file


def test_claim_direction_check():
    assert check_claim_data("increase", [1, 2], direction="positive")["status"] == "passed"
    assert check_claim_data("increase", [1, -2], direction="positive")["status"] == "failed"


def test_verify_text_file(tmp_path: Path):
    path = tmp_path / "result.csv"
    path.write_text("x\n1\n")
    report = verify_file(path)
    assert report["status"] == "passed"
    assert report["checks"]["readable"] is True


def test_verify_image_rejects_flat_output(tmp_path: Path):
    Image = pytest.importorskip("PIL.Image").Image

    path = tmp_path / "flat.png"
    Image.new("RGB", (10, 10), (255, 255, 255)).save(path)
    report = verify_file(path)
    assert report["status"] == "failed"
    assert "flat color" in " ".join(report["errors"])


@pytest.mark.anyio
async def test_artifact_verification_api(client, temp_workspace):
    output = temp_workspace / "result.csv"
    output.write_text("x\n1\n")
    cwd = str(temp_workspace)
    published = await client.post(f"/api/artifacts/publish?cwd={cwd}", json={"path": "result.csv"})
    artifact_id = published.json()["artifact_id"]
    verified = await client.post(f"/api/artifacts/verify?cwd={cwd}", json={"artifact_id": artifact_id})
    assert verified.status_code == 200
    assert verified.json()["verification"]["status"] == "passed"
    claim = await client.post("/api/artifacts/claim-check", json={"claim": "positive", "values": [1, 2], "direction": "positive"})
    assert claim.status_code == 200
    assert claim.json()["status"] == "passed"
