"""Multi-panel figure composition tests."""

from pathlib import Path

import pytest

from services import figure_composer


@pytest.mark.anyio
async def test_compose_publishes_artifact(client, temp_workspace):
    Image = pytest.importorskip("PIL.Image")
    Image.new("RGB", (20, 10), (255, 0, 0)).save(temp_workspace / "a.png")
    Image.new("RGB", (20, 10), (0, 0, 255)).save(temp_workspace / "b.png")
    response = await client.post(f"/api/figures/compose?cwd={temp_workspace}", json={"panels": ["a.png", "b.png"], "output": "figure.png", "columns": 2})
    assert response.status_code == 200
    assert (temp_workspace / "figure.png").exists()
    assert response.json()["artifact"]["producer"]["tool"] == "figure-composer"

