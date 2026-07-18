"""Shared test fixtures for pi-science backend."""

import os
import sys
import tempfile
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

# Ensure backend is on path
sys.path.insert(0, str(Path(__file__).parent.parent))

from main import app


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    """Async HTTP test client bound to the FastAPI app."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac


@pytest.fixture
def temp_workspace():
    """Temporary workspace directory for file tests."""
    with tempfile.TemporaryDirectory() as tmp:
        workspace = Path(tmp)
        # Match a real initialized workspace so cwd validation is exercised.
        (workspace / ".pi-science").mkdir()
        yield workspace


@pytest.fixture
def temp_csv(temp_workspace):
    """Create a temporary CSV file for testing."""
    csv_path = temp_workspace / "test.csv"
    csv_path.write_text("name,value,count\nalpha,1.5,10\nbeta,2.3,20\ngamma,0.8,30\n")
    return csv_path


@pytest.fixture
def temp_config_dir():
    """Temporary config directory, overriding ~/.pi-science."""
    with tempfile.TemporaryDirectory() as tmp:
        old_home = os.environ.get("PI_SCIENCE_HOME")
        os.environ["PI_SCIENCE_HOME"] = tmp
        yield Path(tmp)
        if old_home:
            os.environ["PI_SCIENCE_HOME"] = old_home
        else:
            del os.environ["PI_SCIENCE_HOME"]
